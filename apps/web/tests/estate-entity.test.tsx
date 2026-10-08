// apps/web/tests/estate-entity.test.tsx — the per-entity pages. Seeds store.estate +
// store.route.value.params (params-only dispatch) and builds the EntityRouteTarget from the params
// exactly as view.tsx does — EntityPage parses no path. DOM assertions query by role / name / aria-* /
// data-* only.

import { expect, test } from "bun:test";
import type { EstatePayload, TargetIdentity } from "@pulse/web-data/wire";

import { createAppStore } from "../src/client/store/index.js";
import type { AppStore } from "../src/client/store/index.js";
import type { PathRouter } from "../src/client/router.js";
import { EntityPage, entityActionsGate } from "../src/client/views/estate/entity-page.js";
import {
  alertAge,
  findHost,
  findLiveTarget,
  findService,
  resolveAndJoin,
  toAttributedAlertRows,
} from "../src/client/views/estate/entity-model.js";
import type { EntityRouteTarget } from "../src/client/views/estate/entity-model.js";
import { describeUi, render, screen, userEvent, waitFor, within } from "./rtl.js";
import { currentAvailability, makeEstatePayloadFixture, makeLiveTarget } from "./factories/estate-payload.js";
import { stubAnimationFrame } from "./mutations-dialog-dom.js";

function makeRouter(): { router: PathRouter; calls: string[] } {
  const calls: string[] = [];
  const router = { navigate: (p: string) => void calls.push(p) } as unknown as PathRouter;
  return { router, calls };
}

/** Seed a store with the payload and route params. */
function seed(payload: EstatePayload | null, path: string, params: Record<string, string>): AppStore {
  const store = createAppStore({ storage: null, initialQuery: {} });
  store.estate.value = payload;
  store.route.value = { path, view: "estate", params, query: {} };
  return store;
}

/** view.tsx's dispatch mapping: params → typed target, keyed off the matched path prefix. */
function targetFromRoute(store: AppStore): EntityRouteTarget {
  const r = store.route.value;
  return r.path.startsWith("/estate/service/")
    ? { kind: "service", host: r.params["host"] ?? "", name: r.params["name"] ?? "" }
    : { kind: "host", name: r.params["name"] ?? "" };
}

const hostRoute = (name: string): [string, Record<string, string>] => [`/estate/host/${name}`, { name }];
const serviceRoute = (host: string, name: string): [string, Record<string, string>] => [
  `/estate/service/${host}/${name}`,
  { host, name },
];

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const byTestId = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const textOf = (id: string): string => byTestId(id)?.textContent ?? "";

const liveStatus = (): string | null =>
  byTestId("estate-entity-live-status")?.querySelector("[data-slot=status-badge]")?.getAttribute("data-status") ?? null;

/** The definition text paired with `term` in a key-value list. */
function factValue(list: HTMLElement, term: string): string | null {
  const dt = [...list.querySelectorAll("dt")].find((d) => d.textContent === term);
  return dt?.nextElementSibling?.textContent ?? null;
}

/** The level-2 Section named `title`. */
function section(title: string, level = 2): HTMLElement {
  const heading = screen.getByRole("heading", { level, name: title });
  const s = heading.closest("section");
  if (s === null) throw new Error(`no section for ${title}`);
  return s;
}

// ── pure resolution + join ───────────────────────────────────────────────────

test("findHost / findService match on the model's own identity fields; absent ⇒ null", () => {
  const { estate } = makeEstatePayloadFixture();
  expect(findHost(estate, "hostA-managed")?.drilldownId).toBe("host:hostA-managed");
  expect(findHost(estate, "nope")).toBeNull();
  expect(findService(estate, "hostA-managed", "grafana")?.drilldownId).toBe("svc:hostA-managed/grafana");
  // same service name on the wrong host does not match
  expect(findService(estate, "hostC-nas", "grafana")).toBeNull();
});

test("findLiveTarget requires BOTH kind and id === drilldownId", () => {
  const rows = [
    makeLiveTarget({ target: { kind: "service", id: "host:hostA-managed" } }),
    makeLiveTarget({ target: { kind: "host", id: "host:hostA-managed" }, name: "match" }),
  ];
  const id: TargetIdentity = { kind: "host", id: "host:hostA-managed" };
  expect(findLiveTarget(rows, id)?.name).toBe("match");
  expect(findLiveTarget(rows, { kind: "host", id: "host:other" })).toBeNull();
});

test("resolveAndJoin: a declared-but-not-live entity is unknown, never ok (I3)", () => {
  const payload = makeEstatePayloadFixture({ liveTargets: [] });
  const joined = resolveAndJoin(payload, { kind: "host", name: "hostA-managed" });
  expect(joined?.live).toBeNull();
  expect(joined?.status).toBe("unknown");
  expect(joined?.staleNote).not.toBeNull();
});

test("resolveAndJoin: a healthy current live row maps to ok; suppression overrides health", () => {
  const payload = makeEstatePayloadFixture();
  expect(resolveAndJoin(payload, { kind: "host", name: "hostA-managed" })?.status).toBe("ok");
  // hostE-excluded is declared-suppressed; its live row is healthy but suppression wins
  expect(resolveAndJoin(payload, { kind: "host", name: "hostE-excluded" })?.status).toBe("suppressed");
});

test("toAttributedAlertRows never fabricates name/severity/firedAt", () => {
  const rows = toAttributedAlertRows(makeLiveTarget({ alertFingerprints: ["fp-1", "fp-2"] }));
  expect(rows).toEqual([
    { fingerprint: "fp-1", name: null, severity: null, firedAt: null },
    { fingerprint: "fp-2", name: null, severity: null, firedAt: null },
  ]);
  expect(toAttributedAlertRows(null)).toEqual([]);
});

test("alertAge is null for absent/malformed timestamps and never throws", () => {
  expect(alertAge(null)).toBeNull();
  expect(alertAge("not-a-date")).toBeNull();
  expect(alertAge("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:05:00Z"))).toBe("5m");
});

/** A desk-density store with an optional session (null ⇒ no session yet), then `over` applied. */
function sessionStore(caps: Record<string, boolean> | null, over: (s: AppStore) => void = () => {}): AppStore {
  const store = createAppStore({ storage: null, initialQuery: {} });
  if (caps !== null) store.session.value = { identity: null, authMode: "proxy-header", capabilities: caps };
  store.density.value = "desk";
  over(store);
  return store;
}

test("EntityActions renders nothing when proposeEstateEdit is false/absent, or on wallboard/kiosk (REQ-AUTHZ-04/05)", () => {
  const declared = findHost(makeEstatePayloadFixture().estate, "hostA-managed");
  if (declared === null) throw new Error("fixture host hostA-managed missing");
  const identity: TargetIdentity = { kind: "host", id: declared.drilldownId };
  const stores = [
    sessionStore(null), // no session yet
    sessionStore({ silence: false, ack: false, proposeEstateEdit: false }), // all false
    sessionStore({}), // key absent
    sessionStore({ proposeEstateEdit: true }, (s) => {
      s.density.value = "wallboard";
    }),
    sessionStore({ proposeEstateEdit: true }, (s) => {
      s.route.value = { ...s.route.value, query: { kiosk: "1" } };
    }),
  ];
  for (const store of stores) expect(entityActionsGate({ store, identity, declared })).toBeNull();
});

test("EntityActions returns the propose-edit affordance when proposeEstateEdit is true on desk (REQ-AUTHZ-04)", () => {
  const declared = findHost(makeEstatePayloadFixture().estate, "hostA-managed");
  if (declared === null) throw new Error("fixture host hostA-managed missing");
  const store = sessionStore({ proposeEstateEdit: true });
  expect(entityActionsGate({ store, identity: { kind: "host", id: declared.drilldownId }, declared })).not.toBeNull();
});

// ── DOM ──────────────────────────────────────────────────────────────────────

describeUi("estate entity page", () => {
  function renderPage(store: AppStore, router: PathRouter = makeRouter().router) {
    return render(<EntityPage store={store} router={router} target={targetFromRoute(store)} />);
  }

  test("a host page: one h1 + breadcrumbs, the four level-2 sections, the live badge in the header", () => {
    renderPage(seed(makeEstatePayloadFixture(), ...hostRoute("hostA-managed")));
    const page = byTestId("estate-entity")!;
    expect(page.getAttribute("data-slot")).toBe("estate-page");
    expect(page.getAttribute("data-kind")).toBe("host");
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s.map((h) => h.textContent)).toEqual(["hostA-managed"]);
    expect(page.getAttribute("aria-labelledby")).toBe(h1s[0]!.id);

    const crumbs = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Estate" }).getAttribute("href")).toBe("/estate");
    expect(within(crumbs).getByText("hostA-managed").getAttribute("aria-current")).toBe("page");

    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Declared",
      "Live state",
      "Monitoring artifacts",
      "Attributed alerts",
    ]);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Scrape targets",
      "Rendered artifacts",
    ]);
    const meta = page.querySelector("[data-slot=page-header-meta] [data-slot=status-badge]");
    expect(meta?.getAttribute("data-status")).toBe("ok");
    expect(meta?.textContent).toContain("OK");
  });

  test("a service page's breadcrumbs pass through its host", () => {
    renderPage(seed(makeEstatePayloadFixture(), ...serviceRoute("hostA-managed", "grafana")));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("grafana");
    const crumbs = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "hostA-managed" }).getAttribute("href")).toBe(
      "/estate/host/hostA-managed",
    );
    expect(within(crumbs).getByText("grafana").getAttribute("aria-current")).toBe("page");
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Gatus endpoints",
      "Declared endpoint alerts",
      "Rendered artifacts",
    ]);
  });

  test("/estate/host/:name joins the declared host to its live row by drilldownId", () => {
    const payload = makeEstatePayloadFixture({
      liveTargets: [
        makeLiveTarget({
          target: { kind: "host", id: "host:hostA-managed" },
          name: "hostA-managed",
          state: "unhealthy",
          alertFingerprints: ["fp-a", "fp-b"],
        }),
      ],
    });
    renderPage(seed(payload, ...hostRoute("hostA-managed")));
    expect(byTestId("estate-entity")?.getAttribute("data-kind")).toBe("host");
    expect(liveStatus()).toBe("critical");
    expect(within(section("Live state")).getByText("2 attributed")).toBeTruthy();
  });

  test("/estate/service/:host/:name resolves the service and joins by service kind", () => {
    const payload = makeEstatePayloadFixture({
      liveTargets: [
        // a host row carrying the service's id must NOT join (kind mismatch)
        makeLiveTarget({ target: { kind: "host", id: "svc:hostA-managed/grafana" }, state: "unhealthy" }),
        makeLiveTarget({ target: { kind: "service", id: "svc:hostA-managed/grafana" }, state: "healthy" }),
      ],
    });
    renderPage(seed(payload, ...serviceRoute("hostA-managed", "grafana")));
    expect(byTestId("estate-entity")?.getAttribute("data-kind")).toBe("service");
    expect(liveStatus()).toBe("ok");
    const identity = byTestId("estate-entity-identity")!;
    expect(identity.getAttribute("data-slot")).toBe("key-value-list");
    expect(factValue(identity, "Service")).toBe("grafana");
    expect(factValue(identity, "Host")).toBe("hostA-managed");
    expect(factValue(identity, "Kind")).toBe("dashboard");
  });

  test("a declared-but-not-live entity renders unknown, never ok", () => {
    // default fixture has host rows only — no live row for any service
    renderPage(seed(makeEstatePayloadFixture(), ...serviceRoute("hostA-managed", "loki")));
    expect(liveStatus()).toBe("unknown");
    expect(byTestId("estate-entity-no-live")?.textContent).toBe("No live state has been reported for this entity yet.");
    expect(document.querySelector('[data-status="ok"]') === null).toBe(true);
  });

  test("a stale live row renders unknown with a staleness note", () => {
    const payload = makeEstatePayloadFixture({
      liveTargets: [
        makeLiveTarget({
          target: { kind: "host", id: "host:hostA-managed" },
          availability: currentAvailability({ state: "stale" }),
        }),
      ],
    });
    renderPage(seed(payload, ...hostRoute("hostA-managed")));
    expect(liveStatus()).toBe("unknown");
    expect(textOf("estate-entity-live-status")).toContain("Live state is stale");
  });

  test("declared facts: class, ProvenanceChip under 'Declared at', class-specific detail", () => {
    renderPage(seed(makeEstatePayloadFixture(), ...hostRoute("hostA-managed")));
    const identity = byTestId("estate-entity-identity")!;
    expect(factValue(identity, "Collection class")).toBe("managed-linux");
    const declaredAt = [...identity.querySelectorAll("dt")].find((d) => d.textContent === "Declared at");
    const chip = declaredAt?.nextElementSibling?.querySelector("button[data-provenance-file]");
    expect(chip?.textContent).toContain("hosts/hostA.yml:1");
    const detail = byTestId("estate-entity-detail")!;
    expect(detail.getAttribute("data-slot")).toBe("key-value-list");
    expect(factValue(detail, "Exporter ports")).toContain("9100");
    expect(factValue(detail, "Delivery form")).toBe("compose");
    expect(byTestId("estate-entity-command-signals")?.textContent).toContain("df -h");
  });

  test("probe-only and nas-api 'not configured' detail variants render", () => {
    const probe = renderPage(seed(makeEstatePayloadFixture(), ...hostRoute("hostD-probe")));
    expect(textOf("estate-entity-detail")).toContain("10.0.0.9:22");
    probe.unmount();

    const payload = makeEstatePayloadFixture();
    const nas = payload.estate.hosts.find((x) => x.name === "hostC-nas")!;
    const hosts = payload.estate.hosts.map((x) =>
      x === nas ? { ...nas, collectionClass: "nas-api" as const, detail: { apiEndpoint: null, credential: null } } : x,
    );
    renderPage(seed({ ...payload, estate: { ...payload.estate, hosts } }, ...hostRoute("hostC-nas")));
    expect(factValue(byTestId("estate-entity-detail")!, "API")).toBe("not configured");
  });

  test("credentials render their .display string only", () => {
    for (const [name, display] of [
      ["hostB-hyper", "${PVE_TOKEN}"],
      ["hostC-nas", "op://vault/item/field"],
    ] as const) {
      const r = renderPage(seed(makeEstatePayloadFixture(), ...hostRoute(name)));
      const detail = byTestId("estate-entity-detail")!;
      expect(factValue(detail, "Credential")).toBe(display);
      // the credential `kind` discriminant is never dumped alongside, nor is the object serialized
      expect(detail.textContent).not.toContain('"display"');
      expect(detail.textContent).not.toContain("[object Object]");
      r.unmount();
    }
  });

  test("suppression renders a suppressed status badge, its class and rationale", () => {
    renderPage(seed(makeEstatePayloadFixture(), ...serviceRoute("hostC-nas", "restic")));
    const note = byTestId("estate-entity-suppression")!;
    expect(note.textContent).toContain("expected-churn");
    expect(note.textContent).toContain("ephemeral backups");
    expect(note.querySelector("[data-slot=status-badge]")?.getAttribute("data-status")).toBe("suppressed");
    expect(liveStatus()).toBe("suppressed");
  });

  test("monitoring artifacts: host scrape targets table + artifacts; service gatus + declared alerts", () => {
    const host = renderPage(seed(makeEstatePayloadFixture(), ...hostRoute("hostA-managed")));
    const scrape = byTestId("estate-entity-scrape-targets")!;
    const table = within(scrape).getByRole("table", { name: "Scrape targets" });
    expect(within(table).getByRole("columnheader", { name: "Job" })).toBeTruthy();
    expect(table.textContent).toContain("node");
    expect(table.textContent).toContain("10.0.0.1:9100");
    const rendered = byTestId("estate-entity-rendered-artifacts")!;
    expect(within(rendered).getByRole("list", { name: "Rendered artifacts" }).textContent).toContain("scrape/hostA.yml");
    host.unmount();

    const svc = renderPage(seed(makeEstatePayloadFixture(), ...serviceRoute("hostA-managed", "grafana")));
    expect(within(byTestId("estate-entity-gatus")!).getByRole("listitem").textContent).toContain("hostA-managed/grafana");
    expect(textOf("estate-entity-declared-alerts")).toContain("gatus");
    expect(textOf("estate-entity-rendered-artifacts")).toContain("gatus/grafana.yml");
    svc.unmount();

    // empty arrays are a declared fact, not a blank region
    renderPage(seed(makeEstatePayloadFixture(), ...serviceRoute("hostA-managed", "loki")));
    const gatus = byTestId("estate-entity-gatus")!;
    expect(gatus.textContent).toContain("None declared.");
    expect(within(gatus).queryByRole("list") === null).toBe(true);
  });

  test("attributed alerts: a card List, one row per fingerprint, severity unknown, no age, deep-link", async () => {
    const payload = makeEstatePayloadFixture({
      liveTargets: [
        makeLiveTarget({
          target: { kind: "host", id: "host:hostA-managed" },
          name: "hostA-managed",
          alertFingerprints: ["fp-abc123", "fp-def456"],
        }),
      ],
    });
    const { router, calls } = makeRouter();
    renderPage(seed(payload, ...hostRoute("hostA-managed")), router);
    const list = within(section("Attributed alerts")).getByRole("list", { name: "Attributed alerts" });
    expect(list.getAttribute("data-variant")).toBe("card");
    const rows = [...list.querySelectorAll('[data-testid="estate-entity-alert-row"]')];
    expect(rows.map((r) => r.getAttribute("data-fingerprint"))).toEqual(["fp-abc123", "fp-def456"]);
    for (const row of rows) {
      const item = row.closest("[data-slot=list-item]")!;
      const badge = item.querySelector("[data-slot=status-badge]");
      expect(badge?.getAttribute("data-status")).toBe("unknown");
      expect(badge?.textContent).toContain("unknown");
      expect(item.querySelector("[data-alert-age]") === null).toBe(true);
    }
    expect(rows[0]!.textContent).toContain("fp-abc123");

    const open = within(list).getByRole("button", { name: "Open alert fp-abc123 in triage" });
    expect(open.contains(rows[0]!)).toBe(true);
    await userEvent.click(open);
    expect(calls).toEqual(["/alerts/fp-abc123"]);
  });

  test("an unregistered /alerts route that throws in navigate does not crash the page", async () => {
    const payload = makeEstatePayloadFixture({
      liveTargets: [makeLiveTarget({ target: { kind: "host", id: "host:hostA-managed" }, alertFingerprints: ["fp-x"] })],
    });
    const router = {
      navigate: () => {
        throw new Error("no route");
      },
    } as unknown as PathRouter;
    renderPage(seed(payload, ...hostRoute("hostA-managed")), router);
    await userEvent.click(screen.getByRole("button", { name: "Open alert fp-x in triage" }));
    expect(byTestId("estate-entity")).not.toBeNull();
  });

  test("no attributed alerts renders the explicit empty state", () => {
    renderPage(seed(makeEstatePayloadFixture(), ...hostRoute("hostA-managed")));
    expect(document.querySelectorAll('[data-testid="estate-entity-alert-row"]').length).toBe(0);
    const empty = within(section("Attributed alerts")).getByRole("status");
    expect(empty.textContent).toContain("No attributed alerts");
    expect(empty.textContent).toContain("No alerts are currently attributed to this entity.");
  });

  test("an absent name renders not-found under one h1, distinct from any load-failure degrade", () => {
    for (const [path, params] of [hostRoute("does-not-exist"), serviceRoute("hostA-managed", "nope")]) {
      const r = renderPage(seed(makeEstatePayloadFixture(), path, params));
      const nf = byTestId("estate-entity-not-found")!;
      expect(nf.getAttribute("data-slot")).toBe("estate-page");
      expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([params["name"] ?? ""]);
      const empty = within(nf).getByRole("status");
      expect(empty.textContent).toContain("Not in the current estate");
      expect(empty.textContent).toContain("This is not a load failure");
      expect(document.querySelector("[data-degrade]") === null).toBe(true);
      expect(byTestId("estate-entity") === null).toBe(true);
      r.unmount();
    }
  });

  test("the page body is wrapped in RegionErrorBoundary: a malformed entity yields a localized callout", async () => {
    const payload = makeEstatePayloadFixture();
    // a malformed managed-linux host whose detail is missing its arrays makes a render path throw
    const hosts = payload.estate.hosts.map((x) =>
      x.name === "hostA-managed" ? ({ ...x, detail: {} } as unknown as typeof x) : x,
    );
    renderPage(seed({ ...payload, estate: { ...payload.estate, hosts } }, ...hostRoute("hostA-managed")));
    await tick();
    const card = document.querySelector("[data-region-error]");
    expect(card?.getAttribute("data-region-error")).toBe("entity page");
    expect(card!.textContent).toContain("This entity page could not be displayed.");
    // the page frame (its single h1) survives the contained throw
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["hostA-managed"]);
  });

  test("the declared-facts actions slot is empty when proposeEstateEdit is false", () => {
    const store = seed(makeEstatePayloadFixture(), ...hostRoute("hostA-managed"));
    store.session.value = { identity: null, authMode: "none", capabilities: { silence: false, ack: false, proposeEstateEdit: false } };
    renderPage(store);
    const slot = within(section("Declared")).getByTestId("estate-entity-actions");
    expect(slot.childElementCount).toBe(0);
    expect(slot.querySelectorAll("button, a, input, select, textarea").length).toBe(0);
  });

  test("with proposeEstateEdit true on desk the slot shows 'Propose edit…' and a 'Proposals' disclosure", async () => {
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ enabled: true, proposals: [], invalidCount: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const restoreRaf = stubAnimationFrame(); // the proposal disclosure schedules a frame on mount
    try {
      const store = seed(makeEstatePayloadFixture(), ...hostRoute("hostA-managed"));
      store.density.value = "desk";
      store.session.value = { identity: null, authMode: "proxy-header", capabilities: { silence: false, ack: false, proposeEstateEdit: true } };
      renderPage(store);
      const slot = within(section("Declared")).getByTestId("estate-entity-actions");
      expect(within(slot).getByRole("button", { name: "Propose edit…" })).toBeTruthy();
      await waitFor(() => {
        expect(within(slot).getByRole("button", { name: /^Proposals ?, 0 items$/ })).toHaveAttribute("aria-expanded", "false");
      });
      // a seeded session is never refetched; only the proposal list is loaded
      expect(urls).toEqual(["/api/proposals?kind=host&id=host%3AhostA-managed"]);
    } finally {
      globalThis.fetch = realFetch;
      restoreRaf();
    }
  });
});
