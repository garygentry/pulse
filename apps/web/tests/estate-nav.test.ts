// apps/web/tests/estate-nav.test.ts — the two authorized cross-boundary edits (rev-13 ECR; spec 01
// §5, 08 §4, 09 §4.2): the estate registry entry's deep routes resolve through routesFromViews +
// createPathRouter into RouteMatch.params, and the palette's entityPath() host/service branch lands
// on those deep routes (the alert branch is owned by alert-triage — see alerts-deeplinks.test.ts;
// buildIndex gains no entries).

import { expect, test } from "bun:test";

import type { OverviewSnapshot } from "../src/shared/snapshot.js";
import { createPathRouter, routesFromViews } from "../src/client/router.js";
import { createAppStore } from "../src/client/store/index.js";
import { buildIndex, entityPath } from "../src/client/shell/command-index.js";
import { VIEWS } from "../src/client/views/registry.js";
import { ESTATE_ROUTES } from "../src/client/views/estate/types.js";
import { describeDom } from "./dom.js";

// ── registry entry (Edit 1) ─────────────────────────────────────────────────────────────────────

test("the estate registry entry carries exactly ESTATE_ROUTES; no entry other than estate/alerts declares routes", () => {
  const estate = VIEWS.find((v) => v.id === "estate");
  expect(estate?.routes).toEqual([...ESTATE_ROUTES]);
  // alerts' own routes (charter 04 §2 carve-out) are asserted in alert-triage's alerts-deeplinks.test.ts.
  for (const v of VIEWS) if (v.id !== "estate" && v.id !== "alerts") expect(v.routes).toBeUndefined();
});

// ── deep-link resolution (09 §4.2) ──────────────────────────────────────────────────────────────

describeDom("estate: deep-link resolution", (dom) => {
  function routerAt(path: string) {
    dom.win.history.replaceState({}, "", path);
    return createPathRouter({
      routes: routesFromViews([{ id: "estate", routes: ESTATE_ROUTES }]),
      fallback: "/estate",
      win: dom.win as unknown as Window,
    });
  }

  test("/estate/host/:name resolves into params.name", () => {
    const router = routerAt("/estate/host/hostA-managed");
    try {
      const m = router.current();
      expect(m.view).toBe("estate");
      expect(m.path).toBe("/estate/host/hostA-managed");
      expect(m.params).toEqual({ name: "hostA-managed" });
    } finally {
      router.stop();
    }
  });

  test("/estate/service/:host/:name resolves into params.host + params.name", () => {
    const router = routerAt("/estate/service/hostA-managed/grafana");
    try {
      const m = router.current();
      expect(m.view).toBe("estate");
      expect(m.params).toEqual({ host: "hostA-managed", name: "grafana" });
    } finally {
      router.stop();
    }
  });

  test("the registry's own route table (main.tsx parity) resolves the same deep routes", () => {
    dom.win.history.replaceState({}, "", "/estate/service/h1/s1");
    const router = createPathRouter({
      routes: routesFromViews(VIEWS),
      fallback: "/overview",
      win: dom.win as unknown as Window,
    });
    try {
      expect(router.current()).toMatchObject({ view: "estate", params: { host: "h1", name: "s1" } });
      router.navigate("/estate/host/h1");
      expect(router.current()).toMatchObject({ view: "estate", params: { name: "h1" } });
    } finally {
      router.stop();
    }
  });

  test("an entityPath() destination round-trips through the router into params", () => {
    const router = routerAt(entityPath("service", "db 01/pg#main"));
    try {
      expect(router.current().params).toEqual({ host: "db 01", name: "pg#main" });
    } finally {
      router.stop();
    }
  });
});

// ── palette destination (Edit 2) ────────────────────────────────────────────────────────────────

test("entityPath host/service land on the estate deep routes", () => {
  expect(entityPath("host", "h1")).toBe("/estate/host/h1");
  expect(entityPath("service", "h1/s1")).toBe("/estate/service/h1/s1");
});

test("buildIndex gains no new entries — hosts/services only change destination", () => {
  const store = createAppStore({ storage: null, initialQuery: {} });
  store.snapshot.value = {
    hosts: [{ name: "h1", rollup: "ok", services: [{ name: "s1", host: "h1" }] }],
  } as unknown as OverviewSnapshot;
  const index = buildIndex(store);
  expect(index).toHaveLength(VIEWS.length + 2);
  expect(index.find((e) => e.kind === "host")?.navPath).toBe("/estate/host/h1");
  expect(index.find((e) => e.kind === "service")?.navPath).toBe("/estate/service/h1/s1");
});
