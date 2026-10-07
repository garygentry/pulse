// apps/web/tests/browser/overview-fixture.tsx — the overview browser fixture entry
// (08-testing-strategy.md §5.1; 06 §10.2). Bundled by _harness.buildFixturePage.
//
// Mounts the REAL overview composition (views/overview/view.tsx — its own styles.css plus the shared
// ui/viz/a11y components it imports) inside a <main> landmark over the global stylesheet (styles/app.css),
// a real createAppStore() and a real createPathRouter(). The loopback server has no API, so the
// drawer's liveness history is answered by an injected in-page transport built from the fixture
// factory; nothing else is requested.
//
// URL search parameters select ONLY closed, fixed choices — never arbitrary data or code:
//   mode    = status (default; 4 hosts, all five statuses across targets) | envelope (100 hosts ×
//             300 services) | kiosk (envelope under ?kiosk=1 paging) | motion (4 hosts, meant for
//             repeated cycle commits) | degraded (4 hosts, one source stale + retained stale delivery)
//   density = desk (default) | wallboard  (ignored by kiosk, which always implies wallboard)
//   dwell   = kiosk rotation dwell in ms, an integer in [1000, 600000]; absent → no rotation context
//             (the overview's own 30 s non-rotating cycle). Anything else is rejected.
//
// Test-only window hooks (declared below; they exist ONLY in this fixture, never in production):
//   __PULSE_OVERVIEW_READY__         true once cycle 1 is committed and its grid is in the DOM.
//   __PULSE_OVERVIEW_METRICS__       event-to-paint marks (performance.now()) plus render counters.
//   __PULSE_COMMIT_OVERVIEW_CYCLE__  commit deterministic cycle n (see cycleSnapshot).
// Paint timestamps are written in the SECOND requestAnimationFrame after the qualifying DOM state is
// observable. The readiness marker itself does NOT wait on rAF (Chromium throttles rAF on pages that
// are not in front), so a suite may open several pages in one context and still await readiness.
//
// Render counters come from the grid render observer: the grid's inner `HostCellView` /
// `ServiceChipView` components report each render (the same technique as
// overview-integration.test.ts). No production prop changes for this fixture.

import { batch, effect } from "@preact/signals-core";
import { render } from "../react-render.js";
import type { ReactElement } from "react";

import "../../src/client/styles/app.css";

import type {
  CycleObservation,
  OverviewSnapshotV2,
  SourceId,
  SourceObservation,
  ViewDeliveryState,
} from "@pulse/web-data/wire";
import type { ViewRotationContext } from "../../src/shared/registry.js";
import { createAppStore } from "../../src/client/store/index.js";
import type { AppStore } from "../../src/client/store/index.js";
import type { ConnectionState, Density } from "../../src/client/store/types.js";
import { createPathRouter } from "../../src/client/router.js";
import { applyDensity } from "../../src/client/theme/index.js";
import type { HistoryFetch, OverviewPreferenceStorage } from "../../src/client/views/overview/model.js";
import { OverviewComposition } from "../../src/client/views/overview/view.js";
import { setGridRenderObserver } from "../../src/client/views/overview/grid/render-probe.js";
import { FIXTURE_IDS } from "../fixtures/overview/expected.js";
import {
  cycleInstant,
  makeEnvelopeOverviewSnapshot,
  makeLivenessHistoryPayload,
  makeOverviewSnapshot,
  withTargetStatus,
} from "../fixtures/overview/factory.js";

// ---------------------------------------------------------------------------------------------
// Test-only window contract (08 §5.1)
// ---------------------------------------------------------------------------------------------

/** Fixture modes selectable through `?mode=` (08 §5.1). */
export type OverviewFixtureMode = "status" | "envelope" | "kiosk" | "motion" | "degraded";

export interface OverviewFixtureMetrics {
  /** Monotonic milliseconds immediately before the qualifying store commit. */
  snapshotCommittedAt: number | null;
  /** Monotonic milliseconds at the complete-grid paint boundary. */
  gridPaintedAt: number | null;
  /** Monotonic milliseconds at the changed-target paint boundary. */
  changedTargetPaintedAt: number | null;
  /** Monotonic milliseconds at the visible input-response paint boundary. */
  inputResponsePaintedAt: number | null;
  /** Fixture-only: `event.timeStamp` of the latest trusted keydown/pointerdown (same timebase). */
  inputStartedAt: number | null;
  /** Fixture-only: true when no visible response followed the latest trusted input within the bound. */
  inputTimedOut: boolean;
  /** Fixture-only: renders of the grid's `HostCellView` since page load (grid render observer). */
  hostRenders: number;
  /** Fixture-only: renders of the grid's `ServiceChipView` since page load (grid render observer). */
  serviceRenders: number;
  /** Fixture-only: the resolved mode, for readiness/failure reports. */
  mode: OverviewFixtureMode;
  /** Fixture-only: the most recently committed cycle (0 before the first commit). */
  cycle: number;
  /** Fixture-only: hosts in the committed snapshot. */
  hostCount: number;
  /** Fixture-only: services in the committed snapshot. */
  serviceCount: number;
}

declare global {
  interface Window {
    /** Fixture-only readiness marker set after the real overview is mounted. */
    __PULSE_OVERVIEW_READY__?: true;
    /** Fixture-only event-to-paint marks read by browser performance tests. */
    __PULSE_OVERVIEW_METRICS__?: OverviewFixtureMetrics;
    /** Fixture-only store action that commits the deterministic numbered refresh cycle. */
    __PULSE_COMMIT_OVERVIEW_CYCLE__?: (cycle: number) => void;
  }
}

// ---------------------------------------------------------------------------------------------
// Closed parameter parsing
// ---------------------------------------------------------------------------------------------

const MODES: readonly OverviewFixtureMode[] = ["status", "envelope", "kiosk", "motion", "degraded"];
const DENSITIES: readonly Density[] = ["desk", "wallboard"];
const MIN_DWELL_MS = 1_000;
const MAX_DWELL_MS = 600_000;

const params = new URLSearchParams(window.location.search);

function closedChoice<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const hit = allowed.find((value) => value === raw);
  if (hit === undefined) throw new Error(`[overview-fixture] unsupported ${name}=${raw}`);
  return hit;
}

function dwellParam(): number | null {
  const raw = params.get("dwell");
  if (raw === null) return null;
  if (!/^\d{1,6}$/.test(raw)) throw new Error(`[overview-fixture] unsupported dwell=${raw}`);
  const dwell = Number(raw);
  if (dwell < MIN_DWELL_MS || dwell > MAX_DWELL_MS) throw new Error(`[overview-fixture] dwell out of range: ${raw}`);
  return dwell;
}

const mode = closedChoice("mode", MODES, "status");
const density = closedChoice("density", DENSITIES, "desk");
const dwellMs = dwellParam();
const kiosk = mode === "kiosk";

// ---------------------------------------------------------------------------------------------
// Deterministic cycles
// ---------------------------------------------------------------------------------------------

/** The one target a refresh cycle changes: a suppressed service whose host rollup stays critical, so
 *  exactly one target (this chip) gets a change marker. Present in both the 4-host and 100-host sets. */
export const CHANGED_TARGET_ID = FIXTURE_IDS.suppressedService;
/** Status of {@link CHANGED_TARGET_ID} on even cycles (odd cycles restore the fixture's own status). */
export const CHANGED_TARGET_STATUS = "warning" as const;

/** One source whose evidence is stale in `degraded` mode (governs only this service and its host). */
const DEGRADED_TARGET_ID = FIXTURE_IDS.okService;

function baseSnapshot(cycle: number): OverviewSnapshotV2 {
  switch (mode) {
    case "envelope":
    case "kiosk":
      return makeEnvelopeOverviewSnapshot(cycle);
    case "degraded":
      return makeOverviewSnapshot({
        cycle,
        targetAvailability: {
          [DEGRADED_TARGET_ID]: {
            state: "stale",
            source: "victoriametrics-targets",
            lastGoodAt: cycleInstant(1),
            message: "Signals source stale",
          },
        },
      });
    default:
      return makeOverviewSnapshot({ cycle });
  }
}

/** Cycle n: odd → the fixture's own statuses; even → {@link CHANGED_TARGET_ID} is `warning`. */
function cycleSnapshot(cycle: number): OverviewSnapshotV2 {
  const base = baseSnapshot(cycle);
  return cycle % 2 === 0 ? withTargetStatus(base, CHANGED_TARGET_ID, CHANGED_TARGET_STATUS, cycle) : base;
}

// ---------------------------------------------------------------------------------------------
// Store connection (mirrors what live-state publishes; see overview-integration.test.ts)
// ---------------------------------------------------------------------------------------------

const SOURCE_IDS: readonly SourceId[] = [
  "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
  "alertmanager-alerts", "alertmanager-silences", "alertmanager-status",
  "alertmanager-receivers", "vmalert-rules", "gatus-statuses", "grafana-health",
];

const epochOf = (cycle: number): number => Date.parse(cycleInstant(cycle));

function observation(seq: number): CycleObservation {
  const at = cycleInstant(seq);
  const sources = {} as Record<SourceId, SourceObservation>;
  for (const id of SOURCE_IDS) sources[id] = { state: "current", lastAttemptAt: at, lastSuccess: at };
  return { generation: "11111111-1111-4111-8111-111111111111", seq, observedAt: at, appVersion: "0.0.0-dev", sources };
}

const delivery = (phase: ViewDeliveryState["phase"], identity: string): ViewDeliveryState => ({
  phase,
  identity: `sha256:${identity}` as ViewDeliveryState["identity"],
  failure: null,
});

function connectionWith(
  store: AppStore,
  over: Partial<Omit<ConnectionState, "views">>,
  overview: ViewDeliveryState,
): ConnectionState {
  const prev = store.connection.peek();
  return { ...prev, ...over, views: { ...prev.views, overview } };
}

// ---------------------------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------------------------

const root = document.getElementById("app");
if (root === null) throw new Error("[overview-fixture] #app mount node missing");

const query: Record<string, string> = kiosk ? { kiosk: "1" } : {};
window.history.replaceState({}, "", `/overview${window.location.search}`);
const router = createPathRouter({ routes: [{ pattern: "/overview", view: "overview" }], fallback: "/overview" });

const store = createAppStore({ storage: null, initialQuery: query });
const stampedTheme = (document.documentElement.classList.contains("dark") ? "dark" : "light");
if (stampedTheme === "dark" || stampedTheme === "light") store.theme.value = stampedTheme;
if (!kiosk) store.density.value = density;
store.route.value = { path: "/overview", view: "overview", params: {}, query };
// The shell normally owns the document-root density switch; this fixture has no shell.
effect(() => applyDensity(store.density.value));

const metrics: OverviewFixtureMetrics = {
  snapshotCommittedAt: null,
  gridPaintedAt: null,
  changedTargetPaintedAt: null,
  inputResponsePaintedAt: null,
  inputStartedAt: null,
  inputTimedOut: false,
  hostRenders: 0,
  serviceRenders: 0,
  mode,
  cycle: 0,
  hostCount: 0,
  serviceCount: 0,
};
window.__PULSE_OVERVIEW_METRICS__ = metrics;

setGridRenderObserver((kind) => {
  if (kind === "host") metrics.hostRenders += 1;
  else metrics.serviceRenders += 1;
});

/** In-page liveness history transport (the loopback server has no API). */
const historyFetch: HistoryFetch = async (path) => {
  const id = decodeURIComponent(path.split("/")[4] ?? "");
  const hosts = store.snapshot.peek()?.hosts ?? [];
  const kind = hosts.some((host) => host.drilldownId === id)
    ? ("host" as const)
    : hosts.some((host) => host.services.some((service) => service.drilldownId === id))
      ? ("service" as const)
      : null;
  if (kind === null) throw new Error(`[overview-fixture] no history for ${id}`);
  const target = { kind, id };
  return { status: "ok", value: makeLivenessHistoryPayload(target, { nullEvery: 9 }), etag: null, identity: null, observation: null };
};

const memory = new Map<string, string>();
const storage: OverviewPreferenceStorage = {
  get: (key) => memory.get(key) ?? null,
  set: (key, value) => void memory.set(key, value),
  remove: (key) => void memory.delete(key),
};

const rotation: ViewRotationContext | null =
  dwellMs === null ? null : { entry: { viewId: "overview", dwellMs }, index: 0, total: 1, epoch: 1 };

/** Kiosk chrome: the shell's kiosk top bar (`h-14`, 56px) sits above the outlet, so the page must
 *  fit the space below it (overview-reflow's kiosk-fit case measures against this bar). */
const KIOSK_CHROME_PX = 56;

render(
  <>
    {kiosk ? (
      <header data-fixture-chrome="" style={{ height: `${KIOSK_CHROME_PX}px`, flex: "none" }}>
        Pulse
      </header>
    ) : null}
    <main className="fixture-overview">
      <OverviewComposition
        store={store}
        router={router}
        rotation={rotation}
        storage={storage}
        historyFetch={historyFetch}
        onReload={() => undefined}
      />
    </main>
  </>,
  root,
);

// ---------------------------------------------------------------------------------------------
// Paint boundaries
// ---------------------------------------------------------------------------------------------

/**
 * Run `then` in the second animation frame after `condition()` first holds (polled via timers). With a
 * `deadline` (performance.now() ms), gives up and calls `onTimeout` instead once it passes; `live()`
 * returning false (a newer request superseded this one) stops polling silently.
 */
function afterPaint(
  condition: () => boolean,
  then: (at: number) => void,
  bound?: { deadline: number; onTimeout: () => void; live: () => boolean },
): void {
  const check = (): void => {
    if (bound !== undefined && !bound.live()) return;
    if (!condition()) {
      if (bound !== undefined && performance.now() > bound.deadline) bound.onTimeout();
      else setTimeout(check, 0);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame((at) => then(at)));
  };
  check();
}

/** Resolve on the first macrotask where `condition()` holds (no rAF, see header). */
function whenObservable(condition: () => boolean, then: () => void): void {
  const check = (): void => (condition() ? then() : void setTimeout(check, 0));
  check();
}

const serviceTotal = (snapshot: OverviewSnapshotV2): number =>
  snapshot.hosts.reduce((sum, host) => sum + host.services.length, 0);
const renderedHosts = (): number => document.querySelectorAll('[data-slot="overview-page"] [data-overview-target][data-target-kind="host"]').length;
const renderedChips = (): number => document.querySelectorAll('[data-slot="overview-page"] [data-slot="overview-chip"][data-overview-target]').length;

function gridComplete(snapshot: OverviewSnapshotV2): boolean {
  if (document.querySelector('[data-slot="overview-page"][data-surface]') === null) return false;
  if (kiosk) return document.querySelector('[data-slot="overview-kiosk-page"]') !== null;
  return renderedHosts() === snapshot.hosts.length && renderedChips() === serviceTotal(snapshot);
}

function changedTargetVisible(cycle: number): boolean {
  const el = document.querySelector(`[data-overview-target][data-target-id="${CSS.escape(CHANGED_TARGET_ID)}"]`);
  const expected = cycle % 2 === 0 ? CHANGED_TARGET_STATUS : null;
  if (el === null) return kiosk; // a kiosk page may not show the target
  const status = el.getAttribute("data-status");
  const statusOk = expected === null ? status !== CHANGED_TARGET_STATUS : status === expected;
  const marked = el.matches("[data-changed]");
  return statusOk && marked;
}

/** Commit deterministic cycle `n` as one current live delivery (one atomic store commit). */
function commitCycle(cycle: number): void {
  if (!Number.isInteger(cycle) || cycle < 1) throw new Error(`[overview-fixture] invalid cycle ${cycle}`);
  const snapshot = cycleSnapshot(cycle);
  const first = metrics.cycle === 0;
  metrics.cycle = cycle;
  metrics.hostCount = snapshot.hosts.length;
  metrics.serviceCount = serviceTotal(snapshot);
  if (first) metrics.gridPaintedAt = null;
  else metrics.changedTargetPaintedAt = null;
  metrics.snapshotCommittedAt = performance.now();
  batch(() => {
    store.snapshot.value = snapshot;
    store.connection.value = connectionWith(
      store,
      { phase: "live", lastGoodAt: epochOf(cycle), seq: cycle, failingSince: null, observation: observation(cycle) },
      delivery("current", `cycle${cycle}`),
    );
  });
  if (first) {
    afterPaint(() => gridComplete(snapshot), (at) => (metrics.gridPaintedAt = at));
  } else {
    afterPaint(() => changedTargetVisible(cycle), (at) => (metrics.changedTargetPaintedAt = at));
  }
}

/** `degraded`: the accepted snapshot is retained after a failed delivery (stale surface + last-good). */
function commitFailedDelivery(): void {
  const prev = store.connection.peek();
  store.connection.value = connectionWith(
    store,
    { phase: "stale", failingSince: epochOf(2) },
    delivery("stale", prev.views.overview.identity ?? "none"),
  );
}

window.__PULSE_COMMIT_OVERVIEW_CYCLE__ = commitCycle;

// Visible input response (08 §7.2): the second frame after a trusted keyboard/pointer input has a
// visible effect — focus moved, the target drawer opened/closed, or the kiosk page changed. The start
// is the event's own timeStamp (performance.now() timebase), so input queueing is included.
const INPUT_RESPONSE_BOUND_MS = 2_000;
const DRAWER_DIALOG = '[role=dialog][aria-modal="true"]';

function responseState(): readonly [Element | null, Element | null, string | null] {
  return [
    document.activeElement,
    document.querySelector(DRAWER_DIALOG),
    document.querySelector('[data-slot="overview-kiosk-page"]')?.getAttribute("data-page-index") ?? null,
  ];
}

let inputToken = 0;
for (const type of ["keydown", "pointerdown"] as const) {
  document.addEventListener(
    type,
    (event) => {
      if (!event.isTrusted) return;
      const token = ++inputToken;
      const before = responseState();
      metrics.inputStartedAt = event.timeStamp;
      metrics.inputResponsePaintedAt = null;
      metrics.inputTimedOut = false;
      afterPaint(
        () => responseState().some((value, i) => value !== before[i]),
        (at) => {
          if (token === inputToken) metrics.inputResponsePaintedAt = at;
        },
        {
          deadline: performance.now() + INPUT_RESPONSE_BOUND_MS,
          onTimeout: () => void (metrics.inputTimedOut = true),
          live: () => token === inputToken,
        },
      );
    },
    { capture: true },
  );
}

commitCycle(1);
if (mode === "degraded") commitFailedDelivery();
const committed = store.snapshot.peek()!;
whenObservable(
  () =>
    gridComplete(committed) &&
    (mode !== "degraded" || document.querySelector('[data-slot="overview-page"][data-surface="stale"]') !== null),
  () => {
    window.__PULSE_OVERVIEW_READY__ = true;
    document.documentElement.dataset["fixtureReady"] = "1";
  },
);
