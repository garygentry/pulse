// apps/web/tests/browser/fixtures/engine-render.tsx — shared mount for the engine browser fixture
// pages (08 §2.4, §4.3, §6). NOT an entry: each `engine-<page>.tsx` entry calls mountEngineFixture
// once (the alerts-render.tsx precedent).
//
// Renders the REAL /engine view (views/engine/view.tsx — its own view.css plus the ui-kit CSS it pulls
// in) inside a <main> landmark over the global stylesheet (styles/app.css), against a store seeded from
// tests/engine-fixtures.ts (type-only wire imports, so it bundles for the browser). The bundle is
// theme-agnostic: renderFixtureShell stamps the theme on <html> (the .dark class) and the tokens
// resolve from that stamp.
//
// installHistoryStub answers the five curated trend requests in-page BEFORE the view renders, so no
// request ever reaches the loopback server (which has no API; an unknown path rejects loudly). The
// page sets `data-fixture-ready` on <html> once the view has rendered, for the suites to await.
//
// window.__engineFixture.loadEnvelope() is the perf hook (08 §6, REQ-PERF-01/REQ-SCALE-02): it assigns
// the 500-target envelope payload and resolves the in-page performance.now() delta until the verdict
// banner and the last payload region have painted (one requestAnimationFrame after the mutation).

import { render } from "../../react-render.js";

import "../../../src/client/styles/app.css";

import EngineView from "../../../src/client/views/engine/view.js";
import { createAppStore } from "../../../src/client/store/index.js";
import type { ConnectionPhase } from "../../../src/client/store/types.js";
import { createPathRouter } from "../../../src/client/router.js";
import { CLIENT_QUERY_META, ENGINE_TREND_QUERIES } from "../../../src/client/views/_shared/timeseries/query-meta.js";
import type { EnginePayload, QueryId, ViewDeliveryState } from "@pulse/web-data/wire";
import {
  ENGINE_SCENARIOS, delivery, makeEngineSnapshot, makeObservation,
} from "../../engine-fixtures.js";
import { envelope, installHistoryStub, makeSeriesHistory } from "../../timeline-fixtures.js";
import type { StubRoute } from "../../timeline-fixtures.js";

/** A failing trend route: HTTP status, error code, optional Retry-After seconds. */
export interface EngineTrendFailure {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
}

export interface EngineFixtureOptions {
  /** Payload seeded into store.engine (null → no payload yet). */
  readonly engine: EnginePayload | null;
  /** The engine view's delivery phase (default "current"). */
  readonly deliveryPhase?: ViewDeliveryState["phase"];
  /** Connection phase (default "live"). */
  readonly connectionPhase?: ConnectionPhase;
  /** Trend queries that fail instead of answering 200 with a series payload. */
  readonly trendFailures?: Partial<Record<QueryId, EngineTrendFailure>>;
}

/** The perf hook exposed on window (read by engine-perf.test.ts). */
export interface EngineFixtureHandle {
  /** Assign ENGINE_SCENARIOS.envelope(); resolve the ms until the verdict and last region painted. */
  loadEnvelope(): Promise<number>;
}

declare global {
  interface Window {
    __engineFixture?: EngineFixtureHandle;
  }
}

function trendRoutes(failures: EngineFixtureOptions["trendFailures"]): StubRoute[] {
  return ENGINE_TREND_QUERIES.map((id): StubRoute => {
    const failure = failures?.[id];
    if (failure !== undefined) {
      return {
        path: `/api/history/estate/${id}`,
        reply: {
          status: failure.status,
          body: envelope(failure.code),
          ...(failure.retryAfter !== undefined ? { retryAfter: failure.retryAfter } : {}),
        },
      };
    }
    return {
      path: `/api/history/estate/${id}`,
      reply: { status: 200, body: makeSeriesHistory(id, CLIENT_QUERY_META[id]?.defaultRange ?? "6h") },
    };
  });
}

/** Resolve on the next animation frame (the paint after a DOM mutation). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Mount the real engine view for one browser fixture page. Call once at the page entry's top. */
export function mountEngineFixture(opts: EngineFixtureOptions): void {
  const root = document.getElementById("app");
  if (root === null) throw new Error("[engine-fixture] #app mount node missing");

  installHistoryStub(trendRoutes(opts.trendFailures));

  // The view reads its kiosk flag from the route; move the page to /engine (no reload).
  window.history.replaceState({}, "", "/engine");
  const router = createPathRouter({ routes: [{ pattern: "/engine", view: "engine" }], fallback: "/engine" });

  const store = createAppStore({ storage: null });
  const stampedTheme = (document.documentElement.classList.contains("dark") ? "dark" : "light");
  if (stampedTheme === "dark" || stampedTheme === "light") store.theme.value = stampedTheme;
  store.route.value = router.current();
  router.subscribe((match) => {
    store.route.value = match;
  });
  store.engine.value = opts.engine;
  store.snapshot.value = makeEngineSnapshot();
  store.connection.value = {
    ...store.connection.value,
    phase: opts.connectionPhase ?? "live",
    observation: makeObservation(),
    views: { ...store.connection.value.views, engine: delivery(opts.deliveryPhase ?? "current") },
  };

  window.__engineFixture = {
    loadEnvelope(): Promise<number> {
      const payload = ENGINE_SCENARIOS.envelope();
      const jobs = payload.scrapeJobs.length;
      const groups = payload.ruleGroups.length;
      const painted = (): boolean =>
        document.querySelector("[data-verdict]") !== null &&
        document.querySelectorAll('[data-region="scrape"] [data-job]').length === jobs &&
        document.querySelectorAll('[data-region="rules"] [data-group]').length === groups &&
        document.querySelector('[data-region="capacity"]') !== null;
      const start = performance.now();
      store.engine.value = payload;
      return new Promise<number>((resolve) => {
        const check = (): void => {
          if (painted()) {
            void nextFrame().then(() => resolve(performance.now() - start));
            return;
          }
          requestAnimationFrame(check);
        };
        check();
      });
    },
  };

  render(
    <main className="fixture-engine">
      <h1>Engine</h1>
      <EngineView store={store} router={router} rotation={null} />
    </main>,
    root,
  );
  // render() is synchronous; no rAF here — Chromium throttles rAF on background pages.
  document.documentElement.dataset["fixtureReady"] = "1";
}
