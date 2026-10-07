// apps/web/tests/browser/overview-performance.test.ts — 08-testing-strategy.md §7: the
// production-Chromium overview performance acceptance suite (not a happy-dom microbenchmark).
//
// Protocol (08 §7.1): the overview fixture (overview-fixture.tsx, `mode=envelope`: 100 hosts × 300
// services from makeEnvelopeOverviewSnapshot) is built ONCE in production mode
// (overview-browser.buildOverviewProductionFixture), unrecorded warm-up navigations run first, and
// every sample opens a FRESH page (new document and JS realm, closed afterwards) in the suite's one
// browser context, so the warm build — HTTP cache and V8 code cache primed by the warm-up
// navigations — is retained across samples (08 §7.1). A fresh context per sample would discard
// both and time cold compilation instead of the overview. Exactly 20
// successful runs are collected per metric; a failed or timed-out run fails the suite at once, it is
// never discarded or retried. Each metric reports all samples, median, nearest-rank p95 and max,
// build identity, Chromium version, viewport and fixture seed.
//
// Metrics (08 §7.2), all read from the fixture's window.__PULSE_OVERVIEW_METRICS__ (performance.now()
// timebase; paint marks are set in the second animation frame after the qualifying DOM state):
//   initial-paint   snapshotCommittedAt → gridPaintedAt: all 100 host cells and 300 chips present,
//                   no table fallback.                                               p95 ≤ 1000 ms
//   status-paint    snapshotCommittedAt (cycle 2 commit changing one fixed service) → changed target
//                   shows the expected data-status and change marker; the render counters prove only
//                   that service's chip and its owning host cell re-rendered.         p95 ≤ 100 ms
//   input-response  trusted Playwright input's event.timeStamp → second frame after a visible
//                   response (the target drawer opens). Keyboard (Enter) and pointer (click) are
//                   20 samples EACH with separate p95 assertions — never averaged.     p95 ≤ 100 ms
//
// If a limit fails, fix overview production code under apps/web/src/client/views/overview/** —
// never loosen a threshold here.
//
// OPT-IN (overview-browser.performanceDescribe): registers only when PULSE_REQUIRE_PERF=1 (`bun run
// perf`, part of `bun run ci`) and otherwise self-skips with one stderr line, so plain `bun test` on a
// shared dev host stays deterministic. Opted in without Chromium, it THROWS at collection.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";

import type { FixturePage, FixtureTheme } from "./_harness.js";
import {
  buildOverviewProductionFixture,
  launchOverviewBrowser,
  OVERVIEW_HOST_TRIGGERS,
  OVERVIEW_MARKED,
  OVERVIEW_SERVICE_CHIPS,
  performanceDescribe,
  waitForOverviewReady,
} from "./overview-browser.js";
import { ENVELOPE_HOST_COUNT, ENVELOPE_SERVICE_COUNT, OVERVIEW_FIXTURE_SEED } from "../fixtures/overview/factory.js";
import { FIXTURE_IDS } from "../fixtures/overview/expected.js";
import {
  P95_METHOD,
  PERFORMANCE_SAMPLE_COUNT,
  summarizeSamples,
  type PerformanceSampleSet,
} from "../fixtures/overview/percentile.js";

const THEME: FixtureTheme = "dark";
const VIEWPORT = { width: 1280, height: 900 } as const;
/** Enough loads for Chromium to produce and then consume the V8 code cache for the bundle. */
const WARM_UP_NAVIGATIONS = 3;
/** Bounded wait for one paint mark; exceeding it fails the run (never discarded). */
const PAINT_WAIT_MS = 10_000;
/** Mark polling interval (ms); marks are read after the fact, so polling latency never enters a sample. */
const MARK_POLL_MS = 25;

const INITIAL_PAINT_LIMIT_MS = 1_000;
const STATUS_PAINT_LIMIT_MS = 100;
const INPUT_RESPONSE_LIMIT_MS = 100;

/** The one service the refresh cycle changes (overview-fixture CHANGED_TARGET_ID) and its status. */
const CHANGED_TARGET_ID = FIXTURE_IDS.suppressedService;
const CHANGED_TARGET_STATUS = "warning";
/** Fixed visible input target: a host trigger whose activation opens the target drawer. */
const INPUT_TARGET_ID = "host:host-002";
const INPUT_TARGET = `${OVERVIEW_HOST_TRIGGERS}[data-target-id="${INPUT_TARGET_ID}"]`;
const DIALOG = '[role=dialog][aria-modal="true"]';

type MetricName = PerformanceSampleSet["name"];

interface Metrics {
  snapshotCommittedAt: number | null;
  gridPaintedAt: number | null;
  changedTargetPaintedAt: number | null;
  inputResponsePaintedAt: number | null;
  inputStartedAt: number | null;
  inputTimedOut: boolean;
  hostRenders: number;
  serviceRenders: number;
  cycle: number;
}

interface RenderedCounts {
  hosts: number;
  services: number;
  tables: number;
}

/** Everything a failure report names (08 §7.3). */
interface RunContext {
  metric: string;
  limitMs: number;
  targetId: string | null;
  samples: readonly number[];
}

performanceDescribe()("browser: overview production performance p95 (08 §7)", () => {
  let fixture: FixturePage | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let environment: Record<string, unknown> = {};

  /** Open a fresh envelope page in the warm context and wait (bounded) for fixture readiness. */
  async function open(): Promise<Page> {
    const page = await context!.newPage();
    try {
      await page.goto(`${fixture!.url}?mode=envelope`, { waitUntil: "load" });
      await waitForOverviewReady(page, `mode=envelope theme=${THEME} production`);
      return page;
    } catch (error) {
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  function readMetrics(page: Page): Promise<Metrics> {
    return page.evaluate(() => {
      const m = window.__PULSE_OVERVIEW_METRICS__!;
      return {
        snapshotCommittedAt: m.snapshotCommittedAt,
        gridPaintedAt: m.gridPaintedAt,
        changedTargetPaintedAt: m.changedTargetPaintedAt,
        inputResponsePaintedAt: m.inputResponsePaintedAt,
        inputStartedAt: m.inputStartedAt,
        inputTimedOut: m.inputTimedOut,
        hostRenders: m.hostRenders,
        serviceRenders: m.serviceRenders,
        cycle: m.cycle,
      };
    });
  }

  function renderedCounts(page: Page): Promise<RenderedCounts> {
    return page.evaluate(
      ([hostSelector, chipSelector]) => ({
        hosts: document.querySelectorAll(hostSelector!).length,
        services: document.querySelectorAll(chipSelector!).length,
        tables: document.querySelectorAll('[data-slot="overview-page"] table, [data-slot="overview-page"] [role="table"]').length,
      }),
      [OVERVIEW_HOST_TRIGGERS, OVERVIEW_SERVICE_CHIPS],
    );
  }

  /** Failure text per 08 §7.3: threshold, ordered samples, p95 method, target, counts, timeout flag. */
  async function describeFailure(page: Page | null, run: RunContext, reason: string, timedOut: boolean): Promise<string> {
    const counts = page === null ? null : await renderedCounts(page).catch(() => null);
    const metrics = page === null ? null : await readMetrics(page).catch(() => null);
    return [
      `${run.metric}: ${reason}`,
      `  threshold: p95 <= ${run.limitMs} ms`,
      `  ordered samples so far (${run.samples.length}/${PERFORMANCE_SAMPLE_COUNT}): ${JSON.stringify([...run.samples].sort((a, b) => a - b))}`,
      `  p95 method: ${P95_METHOD}`,
      `  target id: ${run.targetId ?? "(whole grid)"}`,
      `  rendered: ${JSON.stringify(counts)}`,
      `  timed out: ${timedOut}`,
      `  metrics: ${JSON.stringify(metrics)}`,
      `  environment: ${JSON.stringify(environment)}`,
    ].join("\n");
  }

  /** Wait (bounded) for a numeric metric mark; a timeout fails the run with the 08 §7.3 report. */
  async function awaitMark(page: Page, run: RunContext, mark: keyof Metrics): Promise<Metrics> {
    try {
      await page.waitForFunction(
        (key) => {
          const m = window.__PULSE_OVERVIEW_METRICS__ as unknown as Record<string, unknown> | undefined;
          return m !== undefined && (typeof m[key] === "number" || m["inputTimedOut"] === true);
        },
        mark,
        // Timer polling: the default rAF polling would run inside the very frames being timed.
        { timeout: PAINT_WAIT_MS, polling: MARK_POLL_MS },
      );
    } catch (error) {
      throw new Error(await describeFailure(page, run, `no ${mark} within ${PAINT_WAIT_MS} ms (${String(error)})`, true));
    }
    const metrics = await readMetrics(page);
    if (metrics.inputTimedOut && mark === "inputResponsePaintedAt") {
      throw new Error(await describeFailure(page, run, "input produced no visible response", true));
    }
    return metrics;
  }

  /** Two animation frames, so a sample starts from a settled page. */
  const settle = (page: Page): Promise<void> =>
    page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

  /** Run one sample in a fresh page, always closing it. */
  async function inFreshPage<T>(run: RunContext, body: (page: Page) => Promise<T>): Promise<T> {
    let page: Page | null = null;
    try {
      try {
        page = await open();
      } catch (error) {
        throw new Error(await describeFailure(null, run, `fixture page failed to open (${String(error)})`, true));
      }
      return await body(page);
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  function duration(run: RunContext, start: number | null, end: number | null): number {
    if (start === null || end === null) throw new Error(`${run.metric}: missing mark (start=${start}, end=${end})`);
    return end - start;
  }

  /** Summarize, report (median/p95/max + environment) and assert the inclusive p95 limit. */
  function report(name: MetricName, label: string, samples: readonly number[], limitMs: number, targetId: string | null): PerformanceSampleSet {
    const set = summarizeSamples(name, samples, limitMs);
    const ordered = [...set.samplesMs].sort((a, b) => a - b).map((ms) => Number(ms.toFixed(2)));
    const line =
      `[overview-performance] ${label}: median=${set.medianMs.toFixed(2)}ms p95=${set.p95Ms.toFixed(2)}ms ` +
      `max=${set.maximumMs.toFixed(2)}ms limit=${limitMs}ms (${P95_METHOD}) samples=${JSON.stringify(ordered)} ` +
      `target=${targetId ?? "(whole grid)"} env=${JSON.stringify(environment)}`;
    console.log(line);
    expect(set.samplesMs).toHaveLength(PERFORMANCE_SAMPLE_COUNT);
    expect(set.p95Ms, `${label} p95 over limit\n${line}`).toBeLessThanOrEqual(limitMs);
    return set;
  }

  beforeAll(async () => {
    fixture = await buildOverviewProductionFixture(THEME);
    browser = await launchOverviewBrowser();
    context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: "no-preference" });
    context.setDefaultTimeout(30_000);
    const bundle = readFileSync(join(fixture.dir, fixture.jsName));
    environment = {
      build: `production ${fixture.jsName} sha256:${new Bun.CryptoHasher("sha256").update(bundle).digest("hex").slice(0, 16)}`,
      chromium: browser.version(),
      viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
      theme: THEME,
      seed: `0x${OVERVIEW_FIXTURE_SEED.toString(16)}`,
      fixture: `envelope ${ENVELOPE_HOST_COUNT} hosts / ${ENVELOPE_SERVICE_COUNT} services`,
    };
    // Unrecorded warm-up navigations: the same path every sample takes, including one refresh cycle
    // and one drawer open.
    for (let i = 0; i < WARM_UP_NAVIGATIONS; i += 1) {
      const page = await open();
      try {
        await page.waitForFunction(() => window.__PULSE_OVERVIEW_METRICS__?.gridPaintedAt != null, null, {
          timeout: PAINT_WAIT_MS,
          polling: MARK_POLL_MS,
        });
        await page.evaluate(() => window.__PULSE_COMMIT_OVERVIEW_CYCLE__!(2));
        await page.focus(INPUT_TARGET);
        await page.keyboard.press("Enter");
        await page.waitForSelector(DIALOG);
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    fixture?.stop();
  });

  test("initial grid paint: 20 fresh-page samples, p95 <= 1000 ms, no table fallback", async () => {
    const samples: number[] = [];
    const run: RunContext = { metric: "initial-paint", limitMs: INITIAL_PAINT_LIMIT_MS, targetId: null, samples };
    for (let i = 0; i < PERFORMANCE_SAMPLE_COUNT; i += 1) {
      const sample = await inFreshPage(run, async (page) => {
        const metrics = await awaitMark(page, run, "gridPaintedAt");
        const counts = await renderedCounts(page);
        if (counts.hosts !== ENVELOPE_HOST_COUNT || counts.services !== ENVELOPE_SERVICE_COUNT || counts.tables !== 0) {
          throw new Error(await describeFailure(page, run, `incomplete grid or table fallback at paint: ${JSON.stringify(counts)}`, false));
        }
        return duration(run, metrics.snapshotCommittedAt, metrics.gridPaintedAt);
      });
      samples.push(sample);
    }
    report("initial-paint", "initial grid paint", samples, INITIAL_PAINT_LIMIT_MS, null);
  }, 180_000);

  test("refreshed status paint: 20 fresh-page samples, p95 <= 100 ms, unchanged targets not re-rendered", async () => {
    const samples: number[] = [];
    const run: RunContext = { metric: "status-paint", limitMs: STATUS_PAINT_LIMIT_MS, targetId: CHANGED_TARGET_ID, samples };
    for (let i = 0; i < PERFORMANCE_SAMPLE_COUNT; i += 1) {
      const sample = await inFreshPage(run, async (page) => {
        await awaitMark(page, run, "gridPaintedAt");
        await settle(page);
        const before = await readMetrics(page);
        await page.evaluate(() => window.__PULSE_COMMIT_OVERVIEW_CYCLE__!(2));
        const after = await awaitMark(page, run, "changedTargetPaintedAt");
        const target = await page.evaluate(
          ([id, marked]) => {
            const el = document.querySelector(`[data-overview-target][data-target-id="${CSS.escape(id!)}"]`);
            return {
              status: el?.getAttribute("data-status") ?? null,
              marked: el?.matches(marked!) ?? false,
              markedCount: document.querySelectorAll(marked!).length,
            };
          },
          [CHANGED_TARGET_ID, OVERVIEW_MARKED],
        );
        // Only the changed chip and its owning host cell re-render; every unchanged target's counter
        // contribution stays flat. The changed chip renders at most twice: the status commit plus
        // its change-marker state update. Any unchanged chip or host would push a delta past that.
        const hostDelta = after.hostRenders - before.hostRenders;
        const serviceDelta = after.serviceRenders - before.serviceRenders;
        if (target.status !== CHANGED_TARGET_STATUS || !target.marked || target.markedCount !== 1 || hostDelta > 1 || serviceDelta < 1 || serviceDelta > 2) {
          throw new Error(
            await describeFailure(page, run, `unexpected refresh result ${JSON.stringify({ target, hostDelta, serviceDelta })}`, false),
          );
        }
        return duration(run, after.snapshotCommittedAt, after.changedTargetPaintedAt);
      });
      samples.push(sample);
    }
    report("status-paint", "refreshed status paint", samples, STATUS_PAINT_LIMIT_MS, CHANGED_TARGET_ID);
  }, 180_000);

  /** One input-response sample: pre-focus the fixed trigger (untracked), then one trusted input. */
  async function inputSample(run: RunContext, modality: "keyboard" | "pointer"): Promise<number> {
    return inFreshPage(run, async (page) => {
      await awaitMark(page, run, "gridPaintedAt");
      await page.focus(INPUT_TARGET);
      await settle(page);
      if (modality === "keyboard") await page.keyboard.press("Enter");
      else await page.click(INPUT_TARGET);
      const metrics = await awaitMark(page, run, "inputResponsePaintedAt");
      const opened = await page.evaluate(
        ([dialog, id]) => {
          const el = document.querySelector(dialog!);
          return el !== null && (el.textContent ?? "").includes(id!.replace(/^host:/, ""));
        },
        [DIALOG, INPUT_TARGET_ID],
      );
      if (!opened) throw new Error(await describeFailure(page, run, "the target drawer did not open", false));
      return duration(run, metrics.inputStartedAt, metrics.inputResponsePaintedAt);
    });
  }

  for (const modality of ["keyboard", "pointer"] as const) {
    test(`visible input response (${modality}): 20 fresh-page samples, p95 <= 100 ms`, async () => {
      const samples: number[] = [];
      const run: RunContext = { metric: `input-response/${modality}`, limitMs: INPUT_RESPONSE_LIMIT_MS, targetId: INPUT_TARGET_ID, samples };
      for (let i = 0; i < PERFORMANCE_SAMPLE_COUNT; i += 1) samples.push(await inputSample(run, modality));
      report("input-response", `visible input response (${modality})`, samples, INPUT_RESPONSE_LIMIT_MS, INPUT_TARGET_ID);
    }, 180_000);
  }
});
