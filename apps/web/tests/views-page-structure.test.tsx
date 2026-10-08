// apps/web/tests/views-page-structure.test.tsx — every registered view's page structure, rendered.
//
// For every view the app registers (`VIEWS` plus the development-only `devViews`), every route it owns
// (its `/<id>` path, each tab, each deep route) is rendered through the registry's own `load()` with
// React Testing Library, against fixture payloads, in both a loaded and a no-data (loading) state.
// Each render must have:
//   • a page root carrying `data-slot="<…>-page"` as the view's outermost element;
//   • exactly one level-1 heading (`getAllByRole("heading", { level: 1 })`), rendered by PageHeader
//     (`data-slot="page-header"`), never one written by hand.
// A registered view with no entry in ROUTES fails the coverage test, so a new view cannot skip this
// suite. The browser suite (tests/browser/routes-a11y.test.ts) checks the same shape on the composed
// app over live mock data when Chromium is available; this one runs everywhere.

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { batch } from "@preact/signals-core";
import { createElement } from "react";
import type { ReactElement } from "react";

import type { ViewDefinition } from "../src/shared/registry.js";
import { createPathRouter, routesFromViews, type PathRouter } from "../src/client/router.js";
import { createAppStore, type AppStore } from "../src/client/store/index.js";
import { devViews } from "../src/client/views/dev-views.js";
import { VIEWS } from "../src/client/views/registry.js";
import { FIXTURE_FINGERPRINTS, makeAlertsPayload } from "./alerts-fixtures.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { delivery, makeEngineSnapshot, makeEnginePayload, makeObservation } from "./engine-fixtures.js";
import { makeEstatePayloadFixture } from "./factories/estate-payload.js";
import { makeOverviewSnapshot } from "./fixtures/overview/factory.js";
import { StubChart } from "./chart-stub.js";
import { act, describeUi, render, screen, within } from "./rtl.js";
import { makeHierarchySnapshot, makeTimelineIndex } from "./timeline-fixtures.js";

isolateDomGlobals();

// uPlot needs a canvas context happy-dom does not have; the lazy chart is stubbed as the timeline
// suites do (restored after this file).
const CHART = "../src/client/ui/viz/uplot-chart.js";
const realChart = { ...(await import(CHART)) };
mock.module(CHART, () => ({ default: StubChart }));
afterAll(() => {
  mock.module(CHART, () => realChart);
});

/** Every view the app can route to, as main.tsx registers them (development build). */
const ALL_VIEWS: readonly ViewDefinition[] = [...VIEWS, ...devViews("development")];

/** Seed a store with the payloads `view` reads. */
type Seed = (store: AppStore) => void;

/** A live connection with every view's delivery current, as live-state leaves it after a good cycle. */
function liveConnection(store: AppStore): void {
  const prev = store.connection.peek();
  const views = Object.fromEntries(Object.keys(prev.views).map((id) => [id, delivery("current")])) as typeof prev.views;
  const observation = makeObservation();
  store.connection.value = { ...prev, phase: "live", lastGoodAt: Date.parse(observation.observedAt), seq: 1, observation, views };
}

const SEEDS: Readonly<Record<string, Seed>> = {
  overview: (s) => {
    s.snapshot.value = makeOverviewSnapshot({ alerts: true, cycle: 1 });
  },
  alerts: (s) => {
    s.snapshot.value = makeOverviewSnapshot({ alerts: true, cycle: 1 });
    s.alerts.value = makeAlertsPayload({ scenario: "mixed" });
  },
  estate: (s) => {
    s.estate.value = makeEstatePayloadFixture();
  },
  engine: (s) => {
    s.snapshot.value = makeEngineSnapshot();
    s.engine.value = makeEnginePayload();
  },
  timeline: (s) => {
    const snapshot = makeHierarchySnapshot({ hosts: 2, servicesPerHost: 2 });
    s.snapshot.value = snapshot;
    s.timeline.value = makeTimelineIndex(snapshot);
  },
  "_ui": () => {},
};

/** Every route of every registered view: the view's own path, each tab, each deep route. */
const ROUTES: Readonly<Record<string, readonly string[]>> = {
  overview: ["/overview"],
  alerts: ["/alerts", "/alerts?tab=catalog", "/alerts?tab=silences", `/alerts/${FIXTURE_FINGERPRINTS.hostDown}`],
  estate: [
    "/estate",
    "/estate?tab=coverage",
    "/estate?tab=findings",
    "/estate/host/hostA-managed",
    "/estate/service/hostA-managed/grafana",
  ],
  engine: ["/engine"],
  timeline: ["/timeline"],
  "_ui": ["/_ui"],
};

const originalFetch = globalThis.fetch;

describeUi("views: page root data-slot and one PageHeader h1 per route", () => {
  let routers: PathRouter[] = [];

  beforeEach(() => {
    // On-demand fetches (history, sessions) stay pending: structure must not depend on them.
    globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const r of routers) r.stop();
    routers = [];
    globalThis.fetch = originalFetch;
  });

  async function renderRoute(view: ViewDefinition, path: string, loaded: boolean): Promise<HTMLElement> {
    const win = (globalThis as unknown as { window: Window }).window;
    win.history.replaceState({}, "", path);
    const router = createPathRouter({ routes: routesFromViews(ALL_VIEWS), fallback: "/overview", win });
    routers.push(router);
    const store = createAppStore({ storage: null, initialQuery: router.current().query });
    batch(() => {
      store.route.value = router.current();
      if (loaded) {
        SEEDS[view.id]?.(store);
        liveConnection(store);
      }
    });
    expect(store.route.value.view, `${path} routes to ${view.id}`).toBe(view.id);
    const View = await view.load();
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(createElement(View, { store, router }) as ReactElement));
    });
    // Let lazy children and signal-driven re-renders settle.
    for (let i = 0; i < 4; i++) await act(() => new Promise<void>((r) => setTimeout(r, 10)));
    return container;
  }

  function expectPageStructure(container: HTMLElement, label: string): void {
    const root = container.firstElementChild;
    expect(root?.getAttribute("data-slot") ?? null, `${label}: page root data-slot`).toMatch(/-page$/);
    // `hidden: true`: a deep link opens a modal detail Sheet, and Radix hides the page behind it
    // (aria-hidden) while it is open; the page still renders its one h1 underneath.
    const h1s = screen.queryAllByRole("heading", { level: 1, hidden: true });
    expect(h1s.length, `${label}: exactly one h1`).toBe(1);
    expect(h1s[0]!.closest('[data-slot="page-header"]'), `${label}: the h1 comes from PageHeader`).not.toBeNull();
    expect(within(root as HTMLElement).getByRole("heading", { level: 1, hidden: true })).toBe(h1s[0]!);
  }

  test("every registered view has routes and a seed here", () => {
    for (const view of ALL_VIEWS) {
      expect(ROUTES[view.id], `add ${view.id}'s routes to ROUTES`).toBeDefined();
      expect(SEEDS[view.id], `add a ${view.id} seed to SEEDS`).toBeDefined();
      // Deep routes the registry declares are each covered by a concrete path.
      for (const pattern of view.routes ?? []) {
        const re = new RegExp(`^${pattern.replace(/:[^/]+/g, "[^/?]+")}(?:\\?|$)`);
        expect(ROUTES[view.id]!.some((p) => re.test(p)), `${view.id}: cover ${pattern}`).toBe(true);
      }
    }
    expect(Object.keys(ROUTES).sort()).toEqual(ALL_VIEWS.map((v) => v.id).sort());
  });

  for (const view of ALL_VIEWS) {
    for (const path of ROUTES[view.id] ?? []) {
      for (const loaded of [true, false]) {
        const state = loaded ? "loaded" : "no data";
        test(`${path} (${state}): data-slot page root, one PageHeader h1`, async () => {
          expectPageStructure(await renderRoute(view, path, loaded), `${path} (${state})`);
        }, 30_000);
      }
    }
  }
});
