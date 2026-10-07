// apps/web/tests/alerts-target-ref.test.tsx — GitHub #10: the alerts view shows a target's canonical
// wire id (`host:<name>`, `svc:<host>/<name>`) with its kind exactly once, in the Host / Service
// facet, its active-filter chips and the Target column, and the overview `?target=` deep link and
// pre-fix `hs=host:host:…` links filter to it. Fixtures carry the wire format (prefixed ids); DOM
// assertions are role queries only.

import { afterEach, describe, expect, test } from "bun:test";
import type { AlertsPayload } from "@pulse/web-data/wire";

import { createAppStore } from "../src/client/store/index.js";
import { routesFromViews } from "../src/client/router.js";
import type { PathRouter } from "../src/client/router.js";
import { VIEWS } from "../src/client/views/registry.js";
import { targetTriagePath } from "../src/client/views/overview/selectors.js";
import { normalizeTargetRef, targetRef } from "../src/client/target-ref.js";
import { describeUi, render, screen, within } from "./rtl.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { FIXTURE_FINGERPRINTS, makeAlertsPayload } from "./alerts-fixtures.js";

isolateDomGlobals();

const HOST_ID = "host:web-01";
const SERVICE_ID = "svc:web-01/backup";
const DOUBLED = /host:host:|service:svc:/;

describe("targetRef / normalizeTargetRef", () => {
  test("host and service ids are already canonical; endpoint names gain one endpoint: prefix", () => {
    expect(targetRef({ kind: "host", id: HOST_ID })).toBe(HOST_ID);
    expect(targetRef({ kind: "service", id: SERVICE_ID })).toBe(SERVICE_ID);
    expect(targetRef({ kind: "endpoint", id: "host:web-01" })).toBe("endpoint:host:web-01");
  });

  test("pre-#10 double-prefixed refs map to the canonical id; anything else is unchanged", () => {
    expect(normalizeTargetRef("host:host:web-01")).toBe(HOST_ID);
    expect(normalizeTargetRef("service:svc:web-01/backup")).toBe(SERVICE_ID);
    for (const ref of [HOST_ID, SERVICE_ID, "endpoint:web-01/grafana", "host:ghost", "web-01"]) {
      expect(normalizeTargetRef(ref)).toBe(ref);
    }
  });
});

describeUi("AlertsView target references (GitHub #10)", (dom) => {
  const routers: PathRouter[] = [];
  afterEach(() => {
    while (routers.length > 0) routers.pop()!.stop();
  });

  async function flush(): Promise<void> {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 10));
  }

  async function setup(href: string, payload: AlertsPayload = makeAlertsPayload({ scenario: "mixed" })) {
    const { createPathRouter } = await import("../src/client/router.js");
    const { default: AlertsView } = await import("../src/client/views/alerts/view.js");
    dom.win.history.replaceState({}, "", href);
    const router = createPathRouter({ routes: routesFromViews(VIEWS), fallback: "/overview", win: dom.win as unknown as Window });
    routers.push(router);
    const store = createAppStore({ storage: null, initialQuery: {} });
    store.alerts.value = payload;
    render(<AlertsView store={store} router={router} />);
    await flush();
    return { router, payload };
  }

  const hostServiceFacet = (): HTMLElement => screen.getByRole("toolbar", { name: "Host / Service" });

  /** The Target column's text per body row, in row order. */
  function targetCells(): string[] {
    const table = screen.getByRole("table");
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    const column = headers.indexOf("Target");
    expect(column).toBeGreaterThanOrEqual(0);
    return within(table)
      .getAllByRole("row")
      .map((row) => within(row).queryAllByRole("cell"))
      .filter((cells) => cells.length > 0)
      .map((cells) => cells[column]!.textContent ?? "");
  }

  test("facet chips and the Target column read each wire id once, never host:host:…", async () => {
    const { payload } = await setup("/alerts");
    const chips = within(hostServiceFacet()).getAllByRole("button").map((b) => b.textContent);
    expect(chips).toEqual([HOST_ID, SERVICE_ID]);

    const cells = targetCells();
    expect(cells).toEqual(payload.alerts.map((a) => (a.target === null ? "—" : a.target.id)));
    expect(cells).toContain(HOST_ID);
    expect(cells).toContain(SERVICE_ID);
    expect(cells.some((c) => DOUBLED.test(c))).toBe(false);
  });

  test("toggling a chip writes the canonical id to hs and filters to that target", async () => {
    const { router } = await setup("/alerts");
    within(hostServiceFacet()).getByRole("button", { name: SERVICE_ID }).click();
    await flush();
    expect(router.current().query["hs"]).toBe(SERVICE_ID);
    expect(targetCells()).toEqual([SERVICE_ID]);
    expect(screen.getByRole("button", { name: `Remove Host / Service filter ${SERVICE_ID}` })).toBeTruthy();
  });

  test("the overview ?target= deep link round-trips to one pressed chip and that target's rows", async () => {
    const href = targetTriagePath({ kind: "service", id: SERVICE_ID });
    expect(href).toBe(`/alerts?target=${encodeURIComponent(SERVICE_ID)}`);
    await setup(href);
    const pressed = within(hostServiceFacet()).getAllByRole("button", { pressed: true });
    expect(pressed.map((b) => b.textContent)).toEqual([SERVICE_ID]);
    expect(screen.getByRole("button", { name: `Remove Host / Service filter ${SERVICE_ID}` })).toBeTruthy();
    expect(targetCells()).toEqual([SERVICE_ID]);
  });

  test("a pre-#10 hs=host:host:… link still filters, shown as the canonical id", async () => {
    await setup(`/alerts?hs=${encodeURIComponent("host:host:web-01")}`);
    const pressed = within(hostServiceFacet()).getAllByRole("button", { pressed: true });
    expect(pressed.map((b) => b.textContent)).toEqual([HOST_ID]);
    expect(screen.queryByRole("button", { name: /host:host:/ })).toBeNull();
    const cells = targetCells();
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => c === HOST_ID)).toBe(true);
  });

  test("an unattributed alert keeps the '—' Target and contributes no chip", async () => {
    const { payload } = await setup("/alerts");
    const unattributed = payload.alerts.findIndex((a) => a.fingerprint === FIXTURE_FINGERPRINTS.unattributed);
    expect(unattributed).toBeGreaterThanOrEqual(0);
    expect(targetCells()[unattributed]).toBe("—");
    expect(within(hostServiceFacet()).queryByRole("button", { name: "—" })).toBeNull();
  });
});
