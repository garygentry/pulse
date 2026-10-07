// apps/web/tests/alerts-deeplinks.test.ts — alert-triage's deep-link contract. The palette's
// entityPath() alert branch is owned by alert-triage under the charter 04 §2 carve-out (epic verify
// 2026-09-24 V-003), so its assertion lives here rather than in estate-explorer's estate-nav test.
// Also covers the overview → alerts navigation contract (V-001 option a): `/alerts/:fingerprint`
// and `/alerts?target=<TargetIdentity.id>` decode via url-state.ts decodeTriageRoute.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { AlertsPayload, OverviewAlertSummary } from "@pulse/web-data/wire";
import type { ReactElement } from "react";
import { buildIndex, entityPath } from "../src/client/shell/command-index.js";
import { matchRoute, routesFromViews } from "../src/client/router.js";
import type { PathRouter, RouteMatch } from "../src/client/router.js";
import { createAppStore } from "../src/client/store/index.js";
import { VIEWS } from "../src/client/views/registry.js";
import { alertTriagePath, targetTriagePath } from "../src/client/views/overview/selectors.js";
import { TARGET_ALIAS_KEY, decodeTriageRoute } from "../src/client/views/alerts/url-state.js";
import { describeDom } from "./dom.js";
import { installUiStubs } from "./rtl.js";
import { alertsTab, detailDialog, dialogTitle, selectTab, facetPopoverTrigger, facetToggles, openFacetOptions } from "./alerts-dom-helpers.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { FIXTURE_FINGERPRINTS, makeAlertsPayload, makeHistoryPayload } from "./alerts-fixtures.js";

isolateDomGlobals();

test("entityPath alert branch targets /alerts/<encoded fingerprint>", () => {
  expect(entityPath("alert", "a1")).toBe("/alerts/a1");
  expect(entityPath("alert", "ab/c d?#")).toBe("/alerts/" + encodeURIComponent("ab/c d?#"));
});

// ── registry (charter 04 §2 carve-out) ──────────────────────────────────────────────────────────

test("the alerts registry entry declares exactly the /alerts/:fingerprint deep route", () => {
  expect(VIEWS.find((v) => v.id === "alerts")?.routes).toEqual(["/alerts/:fingerprint"]);
});

// ── decodeTriageRoute ───────────────────────────────────────────────────────────────────────────

function routeMatch(
  params: Record<string, string>,
  query: Record<string, string>,
  path = "/alerts",
): RouteMatch {
  return { path, view: "alerts", params, query };
}

describe("decodeTriageRoute", () => {
  test("the fingerprint path param selects when sel is absent", () => {
    const s = decodeTriageRoute(routeMatch({ fingerprint: "fp-1" }, {}));
    expect(s.selected).toBe("fp-1");
    expect(s.facets.hostService).toEqual([]);
  });

  test("sel wins over the path param; an empty sel/param decodes to null", () => {
    expect(decodeTriageRoute(routeMatch({ fingerprint: "fp-1" }, { sel: "fp-2" })).selected).toBe("fp-2");
    expect(decodeTriageRoute(routeMatch({ fingerprint: "fp-1" }, { sel: "" })).selected).toBe("fp-1");
    expect(decodeTriageRoute(routeMatch({ fingerprint: "" }, {})).selected).toBeNull();
    expect(decodeTriageRoute(routeMatch({}, {})).selected).toBeNull();
  });

  test("target=<id> adds host:/service:/endpoint:<id> to the hostService facet", () => {
    const s = decodeTriageRoute(routeMatch({}, { [TARGET_ALIAS_KEY]: "web01" }));
    expect(TARGET_ALIAS_KEY).toBe("target");
    expect(s.facets.hostService).toEqual(["host:web01", "service:web01", "endpoint:web01"]);
    expect(s.selected).toBeNull();
    expect(decodeTriageRoute(routeMatch({}, { target: "" })).facets.hostService).toEqual([]);
  });

  test("target merges with hs, de-duplicated; other facets are untouched", () => {
    const s = decodeTriageRoute(routeMatch({}, { hs: "host:web01,host:db01", target: "web01", sev: "critical" }));
    expect(s.facets.hostService).toEqual(["host:web01", "host:db01", "service:web01", "endpoint:web01"]);
    expect(s.facets.severity).toEqual(["critical"]);
  });

  test("with the payload's host/service values, the target alias keeps only the matching kind", () => {
    const available = ["service:backup", "host:web01"];
    expect(decodeTriageRoute(routeMatch({}, { target: "backup" }), available).facets.hostService).toEqual([
      "service:backup",
    ]);
    // Explicit hs values are never pruned, only alias-derived ones.
    expect(
      decodeTriageRoute(routeMatch({}, { hs: "endpoint:zzz", target: "backup" }), available).facets.hostService,
    ).toEqual(["endpoint:zzz", "service:backup"]);
  });

  test("no payload, or no matching kind, keeps the full expansion", () => {
    const full = ["host:gone", "service:gone", "endpoint:gone"];
    expect(decodeTriageRoute(routeMatch({}, { target: "gone" }), null).facets.hostService).toEqual(full);
    expect(decodeTriageRoute(routeMatch({}, { target: "gone" }), ["host:web01"]).facets.hostService).toEqual(full);
  });
});

// ── cross-view round trip (overview selectors → registry routes → decodeTriageRoute) ───────────

describe("overview → alerts round trip", () => {
  const routes = [...routesFromViews(VIEWS), { pattern: "/", view: "overview" }];

  /** Resolve an app-relative href the way the router does (path match + parsed query). */
  function resolve(href: string): RouteMatch {
    const url = new URL(href, "http://pulse.test");
    const found = matchRoute(routes, url.pathname);
    expect(found).not.toBeNull();
    return {
      path: url.pathname,
      view: found!.view,
      params: found!.params,
      query: Object.fromEntries(url.searchParams),
    };
  }

  test("alertTriagePath with a reserved-character fingerprint opens that alert", () => {
    const alert: OverviewAlertSummary = {
      fingerprint: "ab/c d?#%&=",
      name: "HostDown",
      severity: "critical",
      startsAt: "2026-09-24T00:00:00Z",
      target: { kind: "host", id: "web01" },
    };
    const m = resolve(alertTriagePath(alert));
    expect(m.view).toBe("alerts");
    expect(decodeTriageRoute(m).selected).toBe(alert.fingerprint);
  });

  test("targetTriagePath filters the hostService facet to that target", () => {
    const m = resolve(targetTriagePath({ kind: "host", id: "web01" }));
    expect(m.view).toBe("alerts");
    expect(decodeTriageRoute(m).facets.hostService).toContain("host:web01");
    const reserved = resolve(targetTriagePath({ kind: "service", id: "a/b c&d" }));
    expect(decodeTriageRoute(reserved).facets.hostService).toContain("service:a/b c&d");
  });
});

// ── palette → alerts round trip (shell/command-index alert branch) ─────────────────────────────

describe("palette alert entries", () => {
  const routes = [...routesFromViews(VIEWS), { pattern: "/", view: "overview" }];

  function paletteAlerts(payload: AlertsPayload) {
    const store = createAppStore({ storage: null, initialQuery: {} });
    store.alerts.value = payload;
    return buildIndex(store).filter((e) => e.kind === "alert");
  }

  test("buildIndex over a real AlertsPayload lists every firing/silenced/inhibited alert", () => {
    const payload = makeAlertsPayload({ scenario: "mixed" });
    const entries = paletteAlerts(payload);
    expect(entries.map((e) => e.id)).toEqual(payload.alerts.map((a) => a.fingerprint));
    const hostDown = payload.alerts.find((a) => a.fingerprint === FIXTURE_FINGERPRINTS.hostDown)!;
    expect(entries.find((e) => e.id === hostDown.fingerprint)).toMatchObject({
      label: hostDown.name,
      sublabel: hostDown.target!.id,
    });
    const unattributed = entries.find((e) => e.id === FIXTURE_FINGERPRINTS.unattributed)!;
    expect(unattributed.sublabel).toBeUndefined();
    expect(paletteAlerts(makeAlertsPayload({ scenario: "empty-healthy" }))).toEqual([]);
  });

  test("selecting an alert entry resolves to the alerts view with that alert selected", () => {
    const base = makeAlertsPayload({ scenario: "mixed" });
    const payload: AlertsPayload = {
      ...base,
      alerts: base.alerts.map((a) => (a.fingerprint === FIXTURE_FINGERPRINTS.hostDown ? { ...a, fingerprint: "ab/c d?#%" } : a)),
    };
    for (const entry of paletteAlerts(payload)) {
      const url = new URL(entry.navPath, "http://pulse.test");
      const found = matchRoute(routes, url.pathname);
      expect(found?.view).toBe("alerts");
      const m: RouteMatch = {
        path: url.pathname,
        view: found!.view,
        params: found!.params,
        query: Object.fromEntries(url.searchParams),
      };
      expect(decodeTriageRoute(m).selected).toBe(entry.id);
    }
  });
});

// ── DOM: the mounted view honours the deep links ────────────────────────────────────────────────

const RESERVED_FP = "ab/c d";
const originalFetch = globalThis.fetch;

describeDom("AlertsView deep links", (dom) => {
  let live: { router: PathRouter; unmount(): void }[] = [];
  let restoreStubs: (() => void) | null = null;
  beforeAll(() => {
    restoreStubs = installUiStubs();
  });
  afterAll(() => {
    restoreStubs?.();
  });

  beforeEach(() => {
    globalThis.fetch = (() =>
      Promise.resolve({ json: () => Promise.resolve(makeHistoryPayload({ kind: "ready" })) })) as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const m of live) {
      m.unmount();
      m.router.stop();
    }
    live = [];
    globalThis.fetch = originalFetch;
  });

  async function flush(): Promise<void> {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 10));
  }

  /** The mixed fixture with hostDown's fingerprint swapped for one containing reserved characters. */
  function payloadWithReservedFp(): AlertsPayload {
    const base = makeAlertsPayload({ scenario: "mixed" });
    return {
      ...base,
      alerts: base.alerts.map((a) =>
        a.fingerprint === FIXTURE_FINGERPRINTS.hostDown ? { ...a, fingerprint: RESERVED_FP } : a,
      ),
    };
  }

  async function setup(href: string, payload: AlertsPayload | null) {
    const { createElement: h } = await import("react");
    const { createPathRouter } = await import("../src/client/router.js");
    const { default: AlertsView } = await import("../src/client/views/alerts/view.js");
    dom.win.history.replaceState({}, "", href);
    const router = createPathRouter({ routes: routesFromViews(VIEWS), fallback: "/overview", win: dom.win as unknown as Window });
    const store = createAppStore({ storage: null, initialQuery: {} });
    store.alerts.value = payload;
    const { container, unmount } = await dom.mount(h(AlertsView, { store, router }) as unknown as ReactElement);
    await flush();
    const m = { container, router, unmount, store };
    live.push(m);
    return m;
  }

  test("/alerts/<fp> opens the detail pane; closing it navigates away from the fingerprint and stays closed", async () => {
    const payload = payloadWithReservedFp();
    const hostDown = payload.alerts.find((a) => a.fingerprint === RESERVED_FP)!;
    const m = await setup(`/alerts/${encodeURIComponent(RESERVED_FP)}`, payload);
    expect(m.router.current().view).toBe("alerts");
    expect(m.router.current().params["fingerprint"]).toBe(RESERVED_FP);
    const dialog = detailDialog();
    expect(dialog).not.toBeNull();
    expect(dialogTitle(dialog!)).toBe(hostDown.name);

    dialog!.querySelector<HTMLElement>('button[aria-label="Close alert details"]')!.click();
    await flush();
    const after = m.router.current();
    expect(after.path).toBe("/alerts");
    expect(after.params).toEqual({});
    expect(after.query["sel"]).toBeUndefined();
    expect(dom.win.location.pathname + dom.win.location.search).not.toContain(encodeURIComponent(RESERVED_FP));
    await flush();
    expect(detailDialog()).toBeNull();
  });

  test("/alerts/<fp> selection survives an unrelated interaction (folded into canonical sel)", async () => {
    const payload = payloadWithReservedFp();
    const m = await setup(`/alerts/${encodeURIComponent(RESERVED_FP)}`, payload);
    expect(detailDialog()).not.toBeNull();

    // Toggle any facet chip: the pane must stay open and the URL becomes /alerts?…&sel=<fp>.
    m.container.querySelector<HTMLButtonElement>('[data-slot="facet-filter"] button[aria-pressed]')!.click();
    await flush();
    const after = m.router.current();
    expect(after.path).toBe("/alerts");
    expect(after.query["sel"]).toBe(RESERVED_FP);
    expect(detailDialog()).not.toBeNull();
  });

  const firingRowIds = (container: Element): (string | null)[] =>
    [...container.querySelectorAll("[data-triage-table] [data-triage-open]")].map((b) => b.getAttribute("data-triage-open"));

  interface FacetOptionHandle {
    readonly text: string;
    readonly selected: boolean;
    readonly el: HTMLElement;
  }

  /** The Host / Service options, whichever FacetFilter variant renders them: inline toggles
   *  (aria-pressed) for ≤4 options, otherwise the popover's portalled options (aria-checked). */
  async function hostServiceChips(container: Element): Promise<FacetOptionHandle[]> {
    if (facetPopoverTrigger(container, "Host / Service") !== null) {
      return (await openFacetOptions(container, "Host / Service")).map((el) => ({
        text: el.textContent ?? "",
        selected: el.getAttribute("aria-checked") === "true",
        el,
      }));
    }
    return facetToggles(container, "Host / Service").map((el) => ({
      text: el.textContent ?? "",
      selected: el.getAttribute("aria-pressed") === "true",
      el,
    }));
  }

  test("/alerts?target=<id> filters rows; clearing its chip restores every row and leaves no hidden filter", async () => {
    const payload = makeAlertsPayload({ scenario: "mixed" });
    const allRows = firingRowIds((await setup("/alerts", payload)).container);
    const m = await setup("/alerts?target=backup", payload);
    expect(firingRowIds(m.container)).toEqual([FIXTURE_FINGERPRINTS.backupAge]);

    // Only the matching kind is selected, so exactly one chip is pressed.
    const pressed = (await hostServiceChips(m.container)).filter((b) => b.selected);
    expect(pressed.map((b) => b.text)).toEqual(["service:backup"]);

    // Deselect it: the alias must not re-apply and no unmatchable value may linger (V-001 impl verify).
    pressed[0]!.el.click();
    await flush();
    const q = m.router.current().query;
    expect(q["target"]).toBeUndefined();
    expect(q["hs"]).toBeUndefined();
    expect(firingRowIds(m.container)).toEqual(allRows);
  });

  test("a target with no current alerts shows its values as pressed, clearable chips", async () => {
    const payload = makeAlertsPayload({ scenario: "mixed" });
    const m = await setup("/alerts?target=nowhere", payload);
    expect(firingRowIds(m.container)).toEqual([]);
    // Alerts are firing but filtered out: say so, never the estate-wide all-clear.
    expect(m.container.textContent).toContain("No alerts match these filters");
    expect(m.container.textContent).not.toContain("All monitored targets are healthy");
    const orphan = (await hostServiceChips(m.container)).filter((b) => b.text.endsWith(":nowhere"));
    expect(orphan.map((b) => b.selected)).toEqual([true, true, true]);
    // Each is also listed as a removable active-filter chip.
    for (const text of ["host:nowhere", "service:nowhere", "endpoint:nowhere"]) {
      expect(m.container.querySelector(`[aria-label="Remove Host / Service filter ${text}"]`)).not.toBeNull();
    }
    for (const text of ["host:nowhere", "service:nowhere", "endpoint:nowhere"]) {
      (await hostServiceChips(m.container)).find((b) => b.text === text)!.el.click();
      await flush();
    }
    expect(m.router.current().query["hs"]).toBeUndefined();
    expect(firingRowIds(m.container).length).toBeGreaterThan(0);
  });

  test("a target link opened before the payload arrives is pruned once it lands", async () => {
    const m = await setup("/alerts?target=backup", null);
    // An interaction before the payload must not freeze the unpruned expansion into hs.
    const catalog = alertsTab(m.container, "Catalog");
    expect(catalog).not.toBeNull();
    selectTab(catalog!);
    await flush();
    expect(m.router.current().query["tab"]).toBe("catalog");
    expect(m.router.current().query["target"]).toBe("backup");
    m.router.navigate("/alerts?target=backup");
    await flush();
    m.store.alerts.value = makeAlertsPayload({ scenario: "mixed" });
    await flush();
    const pressed = (await hostServiceChips(m.container)).filter((b) => b.selected);
    expect(pressed.map((b) => b.text)).toEqual(["service:backup"]);
    expect(firingRowIds(m.container)).toEqual([FIXTURE_FINGERPRINTS.backupAge]);
  });

  test("a repeated hand-typed value renders one clearable chip", async () => {
    const m = await setup("/alerts?hs=host:ghost,host:ghost", makeAlertsPayload({ scenario: "mixed" }));
    const ghosts = (await hostServiceChips(m.container)).filter((b) => b.text === "host:ghost");
    expect(ghosts.length).toBe(1);
    expect(ghosts[0]!.selected).toBe(true);
    ghosts[0]!.el.click();
    await flush();
    expect(m.router.current().query["hs"]).toBeUndefined();
  });

  test("/alerts/<unknown fp> renders the no-longer-firing state; closing clears it", async () => {
    const payload = makeAlertsPayload({ scenario: "mixed" });
    const m = await setup(`/alerts/${encodeURIComponent("fp-gone")}`, payload);
    const dialog = detailDialog();
    expect(dialog).not.toBeNull();
    expect(dialog!.querySelector('[data-slot="empty-state"]')?.textContent).toContain("This alert is no longer firing");
    dialog!.querySelector<HTMLElement>('button[aria-label="Close alert details"]')!.click();
    await flush();
    expect(m.router.current().path).toBe("/alerts");
    expect(m.router.current().query["sel"]).toBeUndefined();
    await flush();
    expect(detailDialog()).toBeNull();
  });
});
