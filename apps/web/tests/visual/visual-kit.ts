// apps/web/tests/visual/visual-kit.ts — shared setup for the visual-regression specs (GitHub #4).
//
// The `visual-*.pw.ts` specs capture committed `toHaveScreenshot` baselines. Font rasterisation
// differs across hosts, so baselines are generated and verified on CI Linux only: locally every
// spec skips unless UPDATE_VISUALS is set (deck's mechanism). Refresh them with the `update_visuals`
// workflow_dispatch input of ci.yml (see docs/architecture/ui.md).
//
// Determinism, layer by layer:
//   - data: the dev server serves the pinned `degraded-mix` mock scenario with its WALL CLOCK frozen
//     at FROZEN_NOW (serve.ts + freeze-clock.ts), so snapshots, source health and Gatus results are
//     byte-stable; `--clock` sits 15 min earlier, so the scenario timeline has fully played out;
//   - history: the mock engine serves no range queries, so every `/api/history/**` request is
//     answered here with a series generated from (query, target, range) alone — charts render;
//   - browser clock: `page.clock.setFixedTime(FROZEN_NOW)`, so relative ages ("34m") never drift;
//   - timers: callbacks scheduled ≥ HOLD_TIMERS_MS out never fire (poll refreshes, kiosk paging), so
//     the capture is the first settled render;
//   - rendering: animations disabled, caret hidden, reduced motion, `document.fonts.ready` awaited,
//     timezone and locale pinned, and the build-id-bearing app version masked.

import { expect, type Locator, type Page, type Route } from "@playwright/test";

import { QUERY_CATALOG } from "../../../../packages/web-data/src/queries/catalog.js";
import { RANGE_SECONDS } from "../../../../packages/web-data/src/queries/ranges.js";
import type { QueryId } from "../../../../packages/web-data/src/wire/history.js";
import type { RangeId } from "../../../../packages/web-data/src/wire/common.js";
import { FROZEN_NOW_ISO } from "./scenario.js";

/** Visual baselines run on CI Linux, or anywhere UPDATE_VISUALS is set. */
export const VISUALS = Boolean(process.env["CI"] || process.env["UPDATE_VISUALS"]);
export const SKIP_REASON = "Visual baselines run on CI Linux only; set UPDATE_VISUALS=1 to run them";

export { FROZEN_NOW_ISO, SCENARIO, SCENARIO_CLOCK_ISO } from "./scenario.js";
export const FROZEN_NOW = new Date(FROZEN_NOW_ISO);

export const WIDTHS = [375, 768, 1280] as const;
export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
/** The wallboard viewport kiosk captures use. */
export const WALLBOARD = { width: 1920, height: 1080 } as const;

/** Timer callbacks scheduled at least this far out are held (never fire) during a capture. */
const HOLD_TIMERS_MS = 4000;

/** The shell chrome — side nav and top bar — hidden for view captures, so the capture is the page. */
const HIDE_SHELL = `
  [data-slot="sidebar"], [data-slot="sidebar-gap"], header[aria-label="Pulse"] { display: none !important; }
`;

export interface PrepareOptions {
  theme: Theme;
  width: number;
  height?: number;
}

/** Freeze the clock, pin the theme, hold long timers and feed history before the first navigation. */
export async function prepare(page: Page, { theme, width, height = 900 }: PrepareOptions): Promise<void> {
  await page.clock.setFixedTime(FROZEN_NOW);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await page.addInitScript(
    ({ theme, hold }) => {
      try {
        localStorage.setItem("pulse.web.theme", theme);
      } catch {
        // storage blocked: the emulated colour scheme still selects the theme ("system").
      }
      const realSetTimeout = window.setTimeout.bind(window);
      let held = -1;
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        (timeout ?? 0) >= hold ? held-- : realSetTimeout(handler, timeout, ...args)) as typeof window.setTimeout;
    },
    { theme, hold: HOLD_TIMERS_MS },
  );
  await page.route("**/api/history/**", fulfilHistory);
}

/** Navigate to `path` and wait for `root`, retrying a load that leaves the shell blank. */
export async function open(page: Page, path: string, root: Locator): Promise<void> {
  await expect(async () => {
    await page.goto(path);
    await expect(root).toBeVisible({ timeout: 30_000 });
  }).toPass({ timeout: 90_000, intervals: [1000, 2000, 4000] });
}

/** Wait for every loading placeholder inside `scope` to resolve. */
export async function settled(scope: Locator): Promise<void> {
  await expect(scope.locator('[data-slot="loading-state"], [data-slot="skeleton"]')).toHaveCount(0, {
    timeout: 20_000,
  });
}

/** Wait until `target`'s height holds across two animation-frame-separated reads (lazy content
 *  such as uPlot charts has landed); returns the settled height in CSS pixels. */
export async function stableHeight(target: Locator): Promise<number> {
  let last = -1;
  let height = 0;
  await expect(async () => {
    height = await target.evaluate(
      (el) =>
        new Promise<number>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done(Math.ceil(el.getBoundingClientRect().height)))),
        ),
    );
    const same = height === last;
    last = height;
    expect(same).toBe(true);
  }).toPass({ timeout: 20_000, intervals: [250, 500, 1000] });
  return height;
}

/** Hide the side nav and the top bar. */
export async function hideShell(page: Page): Promise<void> {
  await page.addStyleTag({ content: HIDE_SHELL });
  await expect(page.locator('header[aria-label="Pulse"]')).toBeHidden();
}

/** Locators whose content legitimately changes between commits (the build id in the app version). */
function volatile(page: Page): Locator[] {
  return [page.getByRole("article", { name: /^Pulse web app/ }).getByText(/\+[0-9a-f]{6,}|nobuild/)];
}

/** Await web fonts, then compare against the committed baseline `name`. */
export async function snap(
  page: Page,
  name: string,
  opts: { fullPage?: boolean; target?: Locator } = {},
): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await stableHeight(page.locator("main").first());
  const options = { animations: "disabled", caret: "hide", mask: volatile(page) } as const;
  if (opts.target !== undefined) {
    await expect(opts.target).toHaveScreenshot(name, options);
  } else {
    await expect(page).toHaveScreenshot(name, { ...options, fullPage: opts.fullPage ?? true });
  }
}

/** Every width × theme combination a view is captured at. */
export const VIEWPORTS: readonly { theme: Theme; width: number }[] = THEMES.flatMap((theme) =>
  WIDTHS.map((width) => ({ theme, width })),
);

// The specs call `test()` themselves (not through a helper here) so Playwright attributes each test
// to its spec file. Every describe title ends in "visual baselines" — the grep tag CI and docs use.

// ── Deterministic history ───────────────────────────────────────────────────────────────────────

/** A stable 32-bit hash of `text` (FNV-1a), the seed of a generated series. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const UNIT_SCALE: Record<string, { base: number; amp: number }> = {
  percent: { base: 45, amp: 25 },
  count: { base: 1200, amp: 400 },
  seconds: { base: 2, amp: 1.5 },
  milliseconds: { base: 120, amp: 60 },
  bytes: { base: 4e9, amp: 1e9 },
  scalar: { base: 1, amp: 0.6 },
};

function rangeOf(url: URL, fallback: RangeId): RangeId {
  const raw = url.searchParams.get("range");
  return raw !== null && raw in RANGE_SECONDS ? (raw as RangeId) : fallback;
}

/** `count` evenly spaced instants ending at FROZEN_NOW, in epoch ms. */
function instants(range: RangeId, stepSeconds: number): number[] {
  const end = FROZEN_NOW.getTime();
  const n = Math.min(240, Math.floor(RANGE_SECONDS[range] / stepSeconds));
  const step = Math.floor((RANGE_SECONDS[range] * 1000) / n);
  return Array.from({ length: n + 1 }, (_, i) => end - (n - i) * step);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function seriesPayload(queryId: QueryId, targetId: string | null, range: RangeId): object {
  const def = QUERY_CATALOG[queryId];
  const seed = hash(`${queryId}|${targetId ?? "estate"}|${range}`);
  const stepSeconds = Math.max(def.preferredStepSeconds, Math.floor(RANGE_SECONDS[range] / 240));
  const times = instants(range, stepSeconds);
  const scale = UNIT_SCALE[def.unit] ?? { base: 1, amp: 0 };
  const phase = (seed % 628) / 100;
  const points = times.map((t, i) => {
    if (def.unit === "state") return [t, (seed + i) % 37 === 0 ? 0 : 1] as const;
    const v = scale.base + scale.amp * Math.sin(phase + i / 9) * Math.cos(i / 31);
    return [t, Math.round(v * 100) / 100] as const;
  });
  const target =
    targetId === null
      ? null
      : { kind: targetId.startsWith("svc:") ? "service" : def.targetKind === "endpoint" ? "endpoint" : "host", id: targetId };
  return {
    queryId,
    target,
    range,
    fetchedAt: FROZEN_NOW_ISO,
    effectiveStepSeconds: stepSeconds,
    unit: def.unit,
    stale: false,
    series: [{ labels: {}, points }],
  };
}

function alertIntervalsPayload(range: RangeId): object {
  const end = FROZEN_NOW.getTime();
  const span = RANGE_SECONDS[range] * 1000;
  const lane = (n: number, alertname: string, severity: string, host: string, fracs: [number, number][]) => ({
    id: `sha256:${n.toString(16).padStart(64, "0")}`,
    alertname,
    severity,
    target: { kind: "host", id: `host:${host}` },
    attribution: "matched",
    labels: { alertname, severity, host, service: null, instance: `${host}:9100` },
    provenance: "vmalert",
    intervals: fracs.map(([a, b]) => ({
      start: iso(end - span * a),
      end: iso(end - span * b),
      state: "firing",
      provenance: "vmalert",
    })),
  });
  return {
    operation: "alert-intervals",
    target: null,
    range,
    fetchedAt: FROZEN_NOW_ISO,
    effectiveStepSeconds: 60,
    unit: "state",
    stale: false,
    lanes: [
      lane(1, "HypervisorUnreachable", "critical", "harbor-hv-01", [[0.1, 0]]),
      lane(2, "NasCapacityHigh", "warning", "harbor-nas-01", [[0.6, 0.45], [0.2, 0]]),
    ],
  };
}

function endpointPayload(endpoint: string, range: RangeId): object {
  const seed = hash(`${endpoint}|${range}`);
  const times = instants(range, Math.max(60, Math.floor(RANGE_SECONDS[range] / 120)));
  const results = times.map((t, i) => ({
    timestamp: iso(t),
    success: (seed + i) % 29 !== 0,
    durationMs: 80 + ((seed >> (i % 16)) % 90),
  }));
  return {
    operation: "endpoint-history",
    endpoint,
    target: null,
    range,
    fetchedAt: FROZEN_NOW_ISO,
    effectiveStepSeconds: null,
    unit: "milliseconds",
    stale: false,
    provenance: "gatus",
    results,
    incidents: [],
  };
}

/** Answer one `/api/history/**` request with a generated payload (or 404 for an unknown query). */
async function fulfilHistory(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  const parts = url.pathname.split("/").slice(3).map(decodeURIComponent); // after /api/history/
  const [op] = parts;
  let body: object | null = null;
  if (op === "alerts") {
    body = alertIntervalsPayload(rangeOf(url, QUERY_CATALOG["alerts.firing"].defaultRange));
  } else if (op === "checks" && parts[1] !== undefined) {
    body = endpointPayload(parts.slice(1).join("/"), rangeOf(url, "1h"));
  } else if (op === "estate" || op === "target") {
    const queryId = parts[parts.length - 1] as QueryId;
    const targetId = op === "target" ? parts.slice(1, -1).join("/") : null;
    if (queryId in QUERY_CATALOG) {
      body = seriesPayload(queryId, targetId, rangeOf(url, QUERY_CATALOG[queryId].defaultRange));
    }
  }
  if (body === null) {
    await route.fulfill({ status: 404, json: { code: "QUERY_NOT_FOUND", message: "Unknown history query." } });
  } else {
    await route.fulfill({ status: 200, json: body, headers: { "cache-control": "private, no-cache" } });
  }
}
