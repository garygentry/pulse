// apps/web/tests/browser/engine-browser.ts — shared support for the engine browser suites (08 §2.4,
// §4.4). NOT a test file. Names the engine fixture pages (tests/browser/fixtures/engine-*) and opens
// each one — built via the frozen _harness.buildFixturePage — in a real Chromium page for every theme,
// waiting until the real view has painted its scenario-specific hook.

import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright-core";

import { buildFixturePage, type FixturePage, type FixtureTheme, sharedBrowser } from "./_harness.js";

export const ENGINE_THEMES: readonly FixtureTheme[] = ["dark", "light"];

/** One engine fixture page (a bundled entry under fixtures/). */
export interface EngineFixtureDef {
  /** Page id; the entry is `fixtures/engine-<id>.tsx`. */
  readonly id: string;
  /** Selector that proves the scenario-specific content painted. */
  readonly ready: string;
}

/** Every engine fixture page (08 §2.4). The loading page is the engine-page root holding the busy
 *  LoadingState. */
export const ENGINE_FIXTURES: readonly EngineFixtureDef[] = [
  { id: "all-green", ready: '[data-verdict="ok"]' },
  { id: "degraded", ready: '[data-verdict="degraded"]' },
  { id: "loading", ready: '[data-slot="engine-page"][data-region="loading"] [aria-busy="true"]' },
  { id: "source-outage", ready: '[data-verdict="unknown"]' },
];

/** Absolute path of a fixture page entry. */
export function engineFixtureEntry(id: string): string {
  return resolve(import.meta.dir, "fixtures", `engine-${id}.tsx`);
}

/** A launched browser with every (fixture × theme) page open and painted. */
export interface EngineBrowserSession {
  page(id: string, theme: FixtureTheme): Page;
  close(): Promise<void>;
}

const jobs = ENGINE_FIXTURES.flatMap((def) => ENGINE_THEMES.map((theme) => ({ def, theme })));
let builtPagesOnce: Promise<FixturePage[]> | null = null;

function builtPages(): Promise<FixturePage[]> {
  builtPagesOnce ??= Promise.all(
    jobs.map(({ def, theme }) => buildFixturePage(engineFixtureEntry(def.id), { theme })),
  );
  return builtPagesOnce;
}

/** Attempts to open one fixture page before giving up (see openFixturePage). */
const OPEN_ATTEMPTS = 3;

/** Chromium's view of a loopback server that stopped answering. */
function refused(err: unknown): boolean {
  const text = String(err);
  return text.includes("ERR_CONNECTION_REFUSED") || text.includes("chrome-error://");
}

/**
 * Open a new page on the built fixture for job `i`. When the whole browser directory runs in one
 * process (alerts-axe → harness → engine-*), a freshly served fixture port was seen refusing
 * Chromium (net::ERR_CONNECTION_REFUSED) — a loopback-port clash with another suite's server
 * lifecycle in the frozen harness. The harness keeps the bundle memoised, so on a refusal we bind a
 * fresh loopback server for the same bundle and retry on a new page.
 */
async function openFixturePage(context: BrowserContext, built: FixturePage[], i: number): Promise<Page> {
  for (let attempt = 1; ; attempt += 1) {
    const page = await context.newPage();
    try {
      await page.goto(built[i]!.url, { waitUntil: "load" });
      return page;
    } catch (err) {
      await page.close();
      if (attempt >= OPEN_ATTEMPTS || !refused(err)) throw err;
      built[i]!.stop();
      const { def, theme } = jobs[i]!;
      built[i] = await buildFixturePage(engineFixtureEntry(def.id), { theme });
    }
  }
}

/**
 * Stop the engine fixture servers after every engine suite settles. The Chromium instance is the
 * process-shared one from _harness.sharedBrowser() and is never closed here.
 */
export async function closeEngineBrowser(): Promise<void> {
  const built = builtPagesOnce === null ? [] : await builtPagesOnce;
  for (const fixture of built) fixture.stop();
  builtPagesOnce = null;
}

process.once("exit", () => {
  void closeEngineBrowser();
});

/**
 * Build every engine fixture page (BEFORE launching Chromium, as the harness requires), launch
 * Chromium, and open each (fixture × theme) at `viewport`. `prepare` runs on each page after it
 * painted (e.g. to inject a grayscale filter or emulate reduced motion).
 */
export async function openEnginePages(opts: {
  readonly viewport?: { width: number; height: number };
  readonly prepare?: (page: Page) => Promise<void>;
}): Promise<EngineBrowserSession> {
  const [built, browser] = await Promise.all([builtPages(), sharedBrowser()]);
  const context: BrowserContext = await browser.newContext(
    opts.viewport !== undefined ? { viewport: opts.viewport } : {},
  );
  context.setDefaultTimeout(30_000);
  const pages = new Map<string, Page>();
  for (let i = 0; i < jobs.length; i += 1) {
    const { def, theme } = jobs[i]!;
    const page = await openFixturePage(context, built, i);
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    try {
      await page.waitForSelector("html[data-fixture-ready]");
      await page.waitForSelector(def.ready);
    } catch (err) {
      throw new Error(`engine-${def.id} (${theme}) never became ready: ${String(err)}\npage errors: ${errors.join("\n")}`);
    }
    if (opts.prepare !== undefined) await opts.prepare(page);
    pages.set(`${def.id}\0${theme}`, page);
  }

  return {
    page(id, theme) {
      const page = pages.get(`${id}\0${theme}`);
      if (page === undefined) throw new Error(`no engine fixture page ${id} (${theme})`);
      return page;
    },
    async close() {
      await context.close();
    },
  };
}
