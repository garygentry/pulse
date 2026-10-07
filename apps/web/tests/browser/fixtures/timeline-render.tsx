// apps/web/tests/browser/fixtures/timeline-render.tsx — shared mount for the timeline browser fixture
// pages (08 §2.4, §4.3, §6, §7). NOT an entry: each `timeline-<page>.tsx` entry calls
// mountTimelineFixture once (the alerts-render.tsx / engine-render.tsx precedent).
//
// Renders the REAL /timeline view (views/timeline/view.tsx — no stylesheet of its own, and the REAL
// lazy uPlot chart) inside a <main> landmark over the global stylesheet (styles/app.css), against a
// store seeded from tests/timeline-fixtures.ts (type-only wire imports, so it bundles for the browser).
// The bundle is theme-agnostic: renderFixtureShell stamps the theme on <html> (the .dark class).
//
// Clock: the fixture payloads are relative to TIMELINE_NOW_S, so Date.now() is pinned to that instant
// (advancing with performance.now()) BEFORE the view mounts; the lanes and charts then land where the
// scenario put them regardless of the wall clock.
//
// installHistoryStub answers /api/history/alerts, the engine.active-series coverage probe, the four
// curated host charts of every snapshot host and the check history of every endpoint the index lists
// (09 §1; every page also declares FIXTURE_DOMAIN, so its DNS check is stubbed too, 09 §3) in-page BEFORE the view renders, so no request reaches the loopback server; an unexpected
// request rejects loudly.
//
// Perf stamps (08 §6, REQ-PERF-02): a MutationObserver writes `performance.now()` into
// <html data-lanes-painted-at> the first time a lane block SVG and a swimlane SVG are both on the page;
// <html data-mount-at> is the time the view was handed to render() (navigation start is 0).

import { render } from "../../react-render.js";

import "../../../src/client/styles/app.css";

import TimelineView from "../../../src/client/views/timeline/view.js";
import { createAppStore } from "../../../src/client/store/index.js";
import { createPathRouter } from "../../../src/client/router.js";
import { HOST_CHART_QUERIES } from "../../../src/client/views/_shared/timeseries/query-meta.js";
import type { IntervalHistoryPayload, OverviewSnapshotV2, QueryId, TimelinePayload } from "@pulse/web-data/wire";
import { delivery, makeObservation } from "../../engine-fixtures.js";
import {
  TIMELINE_NOW_S, envelope, installHistoryStub, makeEndpointHistory, makeSeriesHistory,
} from "../../timeline-fixtures.js";
import type { StubRoute } from "../../timeline-fixtures.js";

/** A failing route: HTTP status and error code. */
export interface TimelineFailure {
  readonly status: number;
  readonly code: string;
}

export interface TimelineFixtureOptions {
  readonly scenario: {
    readonly snapshot: OverviewSnapshotV2;
    readonly index: TimelinePayload;
    readonly alerts: IntervalHistoryPayload;
  };
  /** Query string (no leading "?") for the /timeline deep link, e.g. `range=24h` or `kiosk=1`. */
  readonly query?: string;
  /** Artificial stub delay for every route (perf realism, 08 §6). */
  readonly delayMs?: number;
  /** Alerts failure instead of the scenario's alert history. */
  readonly alertsFailure?: TimelineFailure;
  /** Coverage-probe failure instead of a series payload. */
  readonly probeFailure?: TimelineFailure;
  /** Per host-chart failures, keyed by queryId (applied to every host). */
  readonly chartFailures?: Partial<Record<QueryId, TimelineFailure>>;
  /** Runs after render (e.g. to expand a host once the tree painted); fixture-ready waits for it. */
  readonly afterRender?: () => Promise<void>;
}

/** `data-*` stamps the perf suite reads from <html>. */
export const LANES_PAINTED_ATTR = "lanesPaintedAt";
export const MOUNT_AT_ATTR = "mountAt";

const LANES_SVG = '[data-slot="timeline-lanes"] [data-block] svg';
const SWIMLANE_SVG = '[data-slot="timeline-swimlane"] svg';

function failureReply(f: TimelineFailure): StubRoute["reply"] {
  return { status: f.status, body: envelope(f.code) };
}

/** The domain every fixture page declares, so axe/reflow/grayscale cover the Domains group (09 §3). */
export const FIXTURE_DOMAIN = "example.com";

/** The scenario index plus FIXTURE_DOMAIN (listed in `domains` and `checkHistory.endpoints`, like foldTimeline). */
function withFixtureDomain(index: TimelinePayload): TimelinePayload {
  const endpoint = `dns:${FIXTURE_DOMAIN}`;
  if (index.domains.some((d) => d.endpoint === endpoint)) return index;
  return {
    ...index,
    domains: [...index.domains, { domain: FIXTURE_DOMAIN, endpoint }],
    checkHistory: { ...index.checkHistory, endpoints: [...index.checkHistory.endpoints, endpoint].sort() },
  };
}

function historyRoutes(opts: TimelineFixtureOptions, index: TimelinePayload): StubRoute[] {
  const delay = opts.delayMs !== undefined ? { delayMs: opts.delayMs } : {};
  const range = opts.scenario.alerts.range;
  const routes: StubRoute[] = [
    {
      path: "/api/history/alerts",
      reply: opts.alertsFailure !== undefined ? failureReply(opts.alertsFailure) : { status: 200, body: opts.scenario.alerts },
      ...delay,
    },
    {
      path: "/api/history/estate/engine.active-series",
      reply: opts.probeFailure !== undefined
        ? failureReply(opts.probeFailure)
        : { status: 200, body: makeSeriesHistory("engine.active-series", range) },
      ...delay,
    },
  ];
  // One shared body per curated host chart; the charts do not read the payload's target.
  const bodies = new Map<QueryId, unknown>();
  for (const q of HOST_CHART_QUERIES) bodies.set(q, makeSeriesHistory(q, range));
  for (const host of opts.scenario.snapshot.hosts) {
    for (const q of HOST_CHART_QUERIES) {
      const failure = opts.chartFailures?.[q];
      routes.push({
        path: `/api/history/target/${encodeURIComponent(host.drilldownId)}/${q}`,
        reply: failure !== undefined ? failureReply(failure) : { status: 200, body: bodies.get(q) },
        ...delay,
      });
    }
  }
  for (const endpoint of index.checkHistory.endpoints) {
    routes.push({
      path: `/api/history/checks/${encodeURIComponent(endpoint)}`,
      reply: { status: 200, body: makeEndpointHistory(endpoint) },
      ...delay,
    });
  }
  return routes;
}

/** Pin Date.now() to TIMELINE_NOW_S (advancing in real time) so the scenario lands in the live window. */
function pinClock(): void {
  const base = TIMELINE_NOW_S * 1000;
  const t0 = performance.now();
  Date.now = () => Math.floor(base + (performance.now() - t0));
}

/** Stamp performance.now() the first time the lane-block SVG and the swimlane SVG are both present. */
function stampLanesPainted(): void {
  const html = document.documentElement;
  const done = (): boolean => {
    if (document.querySelector(LANES_SVG) === null || document.querySelector(SWIMLANE_SVG) === null) return false;
    html.dataset[LANES_PAINTED_ATTR] = String(performance.now());
    return true;
  };
  const observer = new MutationObserver(() => {
    if (done()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/** Mount the real timeline view for one browser fixture page. Call once at the page entry's top. */
export function mountTimelineFixture(opts: TimelineFixtureOptions): void {
  const root = document.getElementById("app");
  if (root === null) throw new Error("[timeline-fixture] #app mount node missing");

  pinClock();
  const index = withFixtureDomain(opts.scenario.index);
  installHistoryStub(historyRoutes(opts, index));

  const query = opts.query ?? "";
  const kiosk = new URLSearchParams(query).get("kiosk") === "1";
  window.history.replaceState({}, "", query === "" ? "/timeline" : `/timeline?${query}`);
  const router = createPathRouter({ routes: [{ pattern: "/timeline", view: "timeline" }], fallback: "/timeline" });

  const store = createAppStore({ storage: null, initialQuery: kiosk ? { kiosk: "1" } : {} });
  const stampedTheme = (document.documentElement.classList.contains("dark") ? "dark" : "light");
  if (stampedTheme === "dark" || stampedTheme === "light") store.theme.value = stampedTheme;
  // The shell mirrors the density onto <html data-density> (index.html boot script + shell).
  document.documentElement.dataset["density"] = store.density.value;
  store.route.value = router.current();
  router.subscribe((match) => {
    store.route.value = match;
  });
  store.snapshot.value = opts.scenario.snapshot;
  store.timeline.value = index;
  store.connection.value = {
    ...store.connection.value,
    phase: "live",
    observation: makeObservation({ generation: "gen-1" }),
    views: { ...store.connection.value.views, timeline: delivery("current") },
  };

  stampLanesPainted();
  document.documentElement.dataset[MOUNT_AT_ATTR] = String(performance.now());
  render(
    <main className="fixture-timeline">
      <TimelineView store={store} router={router} rotation={null} />
    </main>,
    root,
  );
  // render() is synchronous; no rAF here — Chromium throttles rAF on background pages.
  const ready = (): void => {
    document.documentElement.dataset["fixtureReady"] = "1";
  };
  if (opts.afterRender === undefined) ready();
  else void opts.afterRender().then(ready);
}

/** Resolve with the first element matching `selector` (polling on timers; background-tab safe). */
export function waitFor<T extends Element>(selector: string, timeoutMs = 20_000): Promise<T> {
  const start = performance.now();
  return new Promise<T>((resolve, reject) => {
    const poll = (): void => {
      const el = document.querySelector<T>(selector);
      if (el !== null) return resolve(el);
      if (performance.now() - start > timeoutMs) return reject(new Error(`[timeline-fixture] ${selector} never appeared`));
      setTimeout(poll, 20);
    };
    poll();
  });
}
