// apps/web/tests/browser/overview-browser.ts — shared support for the overview browser suites
// (08-testing-strategy.md §§5.1–5.6). NOT a test file. Builds the overview fixture entry through the
// frozen _harness.buildFixturePage, opens one fixture page per fresh browser context (Chromium throttles
// animation frames on pages that are not in front, so each page owns its context), and waits for the
// fixture's readiness marker with a bounded timeout whose failure reports mode, theme, counts and the
// marker state (08 §5.6). Browser availability is governed by _harness.browserDescribe; the
// production performance suite is additionally opt-in through performanceDescribe (PULSE_REQUIRE_PERF).

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";

import {
  BROWSER_SKIP_MESSAGE,
  buildFixturePage,
  FIXTURE_BUILD_SCRIPT,
  chromiumAvailable,
  renderFixtureShell,
  serveDir,
  sharedBrowser,
  type FixturePage,
  type FixtureTheme,
} from "./_harness.js";

/**
 * Env var that opts in to the production performance suite (overview-performance.test.ts). Its p95
 * limits (08 §7) are only meaningful on a quiet/dedicated runner, so plain `bun test` on a shared host
 * skips it; `bun run perf` (and therefore `bun run ci`) sets it to `"1"`.
 */
export const REQUIRE_PERF_ENV = "PULSE_REQUIRE_PERF" as const;

/** Printed once when the performance suite is not opted in. */
export const PERF_SKIP_MESSAGE =
  `overview performance suite skipped: opt-in gate (set ${REQUIRE_PERF_ENV}=1 or run: bun run perf)` as const;

/**
 * The performance-suite gate. MUST be called synchronously at the file's module top.
 *
 * @returns `describe.skip` (with one stderr line) unless `process.env[REQUIRE_PERF_ENV] === "1"`;
 *   otherwise `describe` when Chromium is provisioned.
 * @throws {Error} `BROWSER_SKIP_MESSAGE` when the suite is opted in but Chromium is absent, so an
 *   opted-in run fails at collection instead of reporting a green skip.
 */
export function performanceDescribe(): typeof describe {
  if (process.env[REQUIRE_PERF_ENV] !== "1") {
    process.stderr.write(`${PERF_SKIP_MESSAGE}\n`);
    return describe.skip;
  }
  if (!chromiumAvailable()) throw new Error(BROWSER_SKIP_MESSAGE);
  return describe;
}

/** Absolute path of the overview fixture entry. */
export const OVERVIEW_FIXTURE_ENTRY = resolve(import.meta.dir, "overview-fixture.tsx");

export const OVERVIEW_THEMES: readonly FixtureTheme[] = ["dark", "light"];

/** Bounded readiness wait (08 §5.6). */
export const OVERVIEW_READY_TIMEOUT_MS = 20_000;

/** Roving targets (host triggers and service chips); the kiosk probe carries none. */
export const OVERVIEW_TARGETS = "[data-overview-target]";
export const OVERVIEW_HOST_TRIGGERS = '[data-overview-target][data-target-kind="host"]';
export const OVERVIEW_SERVICE_CHIPS = '[data-slot="overview-chip"][data-overview-target]';
/** Targets carrying a status-change marker (`data-changed="animated"|"static"`). */
export const OVERVIEW_MARKED = "[data-overview-target][data-changed]";

/** Closed fixture query (see overview-fixture.tsx header). */
export interface OverviewFixtureQuery {
  readonly mode?: "status" | "envelope" | "kiosk" | "motion" | "degraded";
  readonly density?: "desk" | "wallboard";
  readonly dwell?: number;
}

/** Options for one opened fixture page. */
export interface OpenOverviewOptions extends OverviewFixtureQuery {
  readonly theme: FixtureTheme;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly reducedMotion?: "reduce" | "no-preference";
  readonly hasTouch?: boolean;
}

/** One opened page with its own context; `close()` is idempotent and never throws. */
export interface OverviewPageHandle {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly label: string;
  close(): Promise<void>;
}

function queryString(q: OverviewFixtureQuery): string {
  const params = new URLSearchParams();
  if (q.mode !== undefined) params.set("mode", q.mode);
  if (q.density !== undefined) params.set("density", q.density);
  if (q.dwell !== undefined) params.set("dwell", String(q.dwell));
  const s = params.toString();
  return s === "" ? "" : `?${s}`;
}

/** Build (memoized per theme by the harness) the overview fixture for every theme. Call BEFORE launch. */
export function buildOverviewFixtures(): Promise<Map<FixtureTheme, FixturePage>> {
  return Promise.all(OVERVIEW_THEMES.map((theme) => buildFixturePage(OVERVIEW_FIXTURE_ENTRY, { theme }))).then(
    (built) => new Map(OVERVIEW_THEMES.map((theme, i) => [theme, built[i]!])),
  );
}

/**
 * The process-scoped headless Chromium shared by every browser suite (_harness.sharedBrowser; the
 * harness has already gated availability). Suites close their own contexts but NEVER this browser.
 * One launch per `bun test` process keeps bun 1.3.9's Playwright pipe from wedging after large replies
 * (axe results, screenshots) — see _harness.sharedBrowser.
 */
export function launchOverviewBrowser(): Promise<Browser> {
  return sharedBrowser();
}

const productionBuilds = new Map<FixtureTheme, Promise<{ dir: string; jsName: string; cssName: string | null }>>();

/**
 * Build the overview fixture in PRODUCTION mode (NODE_ENV=production, syntax + whitespace
 * minification) for the performance suite (08 §7.1), memoized per theme and served on loopback like
 * _harness.buildFixturePage (whose build is unminified). Identifiers stay unmangled, matching the
 * build the timings were baselined on. Same subprocess build as the harness, for the same
 * resolver-reliability reason.
 */
export function buildOverviewProductionFixture(theme: FixtureTheme): Promise<FixturePage> {
  let pending = productionBuilds.get(theme);
  if (pending === undefined) {
    pending = (async () => {
      const dir = mkdtempSync(join(tmpdir(), "pulse-web-overview-perf-"));
      const proc = Bun.spawnSync({
        // `--production` minus identifier mangling: syntax and whitespace minification only.
        cmd: ["bun", FIXTURE_BUILD_SCRIPT, OVERVIEW_FIXTURE_ENTRY, dir, "--minify"],
        cwd: resolve(import.meta.dir, "../../../.."),
        stdout: "pipe",
        stderr: "pipe",
      });

      if (proc.exitCode !== 0) {
        throw new Error(`overview production fixture build failed (exit ${proc.exitCode}):\n${proc.stderr.toString()}`);
      }
      const files = readdirSync(dir);
      const jsName = files.find((f) => f.endsWith(".js"));
      const cssName = files.find((f) => f.endsWith(".css")) ?? null;
      if (jsName === undefined) throw new Error(`overview production fixture produced no .js output in ${dir}`);
      writeFileSync(join(dir, "index.html"), renderFixtureShell(jsName, cssName, theme), "utf8");
      return { dir, jsName, cssName };
    })();
    productionBuilds.set(theme, pending);
  }
  return pending.then((bundle) => {
    const server = serveDir(bundle.dir);
    let stopped = false;
    return {
      ...bundle,
      url: server.url,
      stop(): void {
        if (stopped) return;
        stopped = true;
        server.stop();
      },
    };
  });
}

/**
 * Wait for `window.__PULSE_OVERVIEW_READY__` with a bounded timeout. On timeout, throws an error naming
 * the fixture label (mode/theme) plus the current metrics, surface and rendered host/service counts.
 */
export async function waitForOverviewReady(page: Page, label: string, timeout = OVERVIEW_READY_TIMEOUT_MS): Promise<void> {
  try {
    await page.waitForFunction(() => window.__PULSE_OVERVIEW_READY__ === true, null, { timeout });
  } catch (error) {
    const state = await page
      .evaluate(() => ({
        ready: window.__PULSE_OVERVIEW_READY__ ?? null,
        metrics: window.__PULSE_OVERVIEW_METRICS__ ?? null,
        surface: document.querySelector('[data-slot="overview-page"]')?.getAttribute("data-surface") ?? null,
        hosts: document.querySelectorAll('[data-overview-target][data-target-kind="host"]').length,
        services: document.querySelectorAll('[data-slot="overview-chip"][data-overview-target]').length,
      }))
      .catch((e: unknown) => ({ evaluateFailed: String(e) }));
    throw new Error(`overview fixture not ready after ${timeout}ms (${label}): ${JSON.stringify(state)}\n${String(error)}`);
  }
}

/** Open one fixture page in a fresh context and wait until it is ready. */
export async function openOverviewPage(
  browser: Browser,
  fixtures: ReadonlyMap<FixtureTheme, FixturePage>,
  options: OpenOverviewOptions,
): Promise<OverviewPageHandle> {
  const fixture = fixtures.get(options.theme);
  if (fixture === undefined) throw new Error(`no overview fixture built for theme ${options.theme}`);
  const label = `mode=${options.mode ?? "status"} theme=${options.theme}${options.density !== undefined ? ` density=${options.density}` : ""}${options.dwell !== undefined ? ` dwell=${options.dwell}` : ""}`;
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 900 },
    reducedMotion: options.reducedMotion ?? "no-preference",
    ...(options.hasTouch === true ? { hasTouch: true } : {}),
  });
  context.setDefaultTimeout(30_000);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await context.close().catch(() => undefined);
  };
  try {
    const page = await context.newPage();
    await page.goto(fixture.url + queryString(options), { waitUntil: "load" });
    await waitForOverviewReady(page, label);
    return { page, context, label, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Stop every fixture server (idempotent). */
export function stopOverviewFixtures(fixtures: ReadonlyMap<FixtureTheme, FixturePage> | undefined): void {
  for (const fixture of fixtures?.values() ?? []) fixture.stop();
}
