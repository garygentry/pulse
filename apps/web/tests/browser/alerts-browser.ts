// apps/web/tests/browser/alerts-browser.ts — shared support for the alerts browser suites
// NOT a test file. Names the alerts fixture pages (tests/browser/fixtures/alerts-*)
// and opens each one — built via the frozen _harness.buildFixturePage — in a real Chromium page for
// every theme, waiting until the real view has painted (and, for the detail page, the history strip).

import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright-core";

import { buildFixturePage, type FixturePage, type FixtureTheme, sharedBrowser } from "./_harness.js";

export const ALERTS_THEMES: readonly FixtureTheme[] = ["dark", "light"];

/** One alerts fixture page (a bundled entry under fixtures/). */
export interface AlertsFixtureDef {
  /** Page id; the entry is `fixtures/alerts-<id>.tsx`. */
  readonly id: string;
  /** Selector that proves the scenario-specific content painted. */
  readonly ready: string;
}

/** Every alerts fixture page — together they cover the firing/silenced/inhibited mix, a degraded
 *  source, the open detail pane (with its history strip), and both read-only tabs. */
export const ALERTS_FIXTURES: readonly AlertsFixtureDef[] = [
  { id: "mixed", ready: "[data-triage-table] [data-triage-open]" },
  { id: "am-down", ready: '[data-slot="callout"][data-availability]' },
  { id: "detail-open", ready: '[role="dialog"] g[data-lane]' },
  { id: "catalog", ready: '[role="tabpanel"][data-tab="catalog"] [data-slot="status-badge"][data-status]' },
  { id: "silences", ready: '[role="tabpanel"][data-tab="silences"] code[data-matcher]' },
];

/** Absolute path of a fixture page entry. */
export function alertsFixtureEntry(id: string): string {
  return resolve(import.meta.dir, "fixtures", `alerts-${id}.tsx`);
}

/** A launched browser with every (fixture × theme) page open and painted. */
export interface AlertsBrowserSession {
  page(id: string, theme: FixtureTheme): Page;
  close(): Promise<void>;
}

const jobs = ALERTS_FIXTURES.flatMap((def) => ALERTS_THEMES.map((theme) => ({ def, theme })));
let builtPagesOnce: Promise<FixturePage[]> | null = null;

function builtPages(): Promise<FixturePage[]> {
  builtPagesOnce ??= Promise.all(
    jobs.map(({ def, theme }) => buildFixturePage(alertsFixtureEntry(def.id), { theme })),
  );
  return builtPagesOnce;
}

/**
 * Stop the alerts fixture servers after every alerts suite settles. The Chromium instance is the
 * process-shared one from _harness.sharedBrowser() and is never closed here.
 */
export async function closeAlertsBrowser(): Promise<void> {
  const built = builtPagesOnce === null ? [] : await builtPagesOnce;
  for (const fixture of built) fixture.stop();
  builtPagesOnce = null;
}

process.once("exit", () => {
  void closeAlertsBrowser();
});

/**
 * Build every alerts fixture page (BEFORE launching Chromium, as the harness requires), launch
 * Chromium, and open each (fixture × theme) at `viewport`. `prepare` runs on each page after it
 * painted (e.g. to inject a grayscale filter).
 */
export async function openAlertsPages(opts: {
  readonly viewport?: { width: number; height: number };
  readonly prepare?: (page: Page) => Promise<void>;
}): Promise<AlertsBrowserSession> {
  const [built, browser] = await Promise.all([builtPages(), sharedBrowser()]);
  const context: BrowserContext = await browser.newContext(
    opts.viewport !== undefined ? { viewport: opts.viewport } : {},
  );
  context.setDefaultTimeout(30_000);
  const pages = new Map<string, Page>();
  for (let i = 0; i < jobs.length; i += 1) {
    const { def, theme } = jobs[i]!;
    const page = await context.newPage();
    await page.goto(built[i]!.url, { waitUntil: "load" });
    await page.waitForSelector("html[data-fixture-ready]");
    await page.waitForSelector(def.ready);
    if (opts.prepare !== undefined) await opts.prepare(page);
    pages.set(`${def.id}\0${theme}`, page);
  }

  return {
    page(id, theme) {
      const page = pages.get(`${id}\0${theme}`);
      if (page === undefined) throw new Error(`no alerts fixture page ${id} (${theme})`);
      return page;
    },
    async close() {
      await context.close();
    },
  };
}
