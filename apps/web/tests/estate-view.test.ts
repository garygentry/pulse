// apps/web/tests/estate-view.test.ts — the estate view composition root (spec 01 §3–§6, 09 §4.1;
// REQ-INT-01, REQ-NAV-01/02, REQ-ENT-01). Seeds store.estate + store.route directly and asserts
// path-kind/params-identity dispatch, landing vs host/service pages, ?tab=/?q= URL sync, and the
// delivery gate (no surfaces without a payload).

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { EstatePayload } from "@pulse/web-data/wire";

import { createAppStore } from "../src/client/store/index.js";
import type { AppStore } from "../src/client/store/index.js";
import { startLiveState } from "../src/client/store/live-state.js";
import type { PathRouter } from "../src/client/router.js";
import EstateView from "../src/client/views/estate/view.js";
import { describeDom, renderWithStore } from "./dom.js";
import { makeEstatePayloadFixture } from "./factories/estate-payload.js";
import { setInputValue } from "./react-render.js";
import { installUiStubs } from "./rtl.js";

/** Radix (the inventory's relationship Tabs) needs requestAnimationFrame and friends in happy-dom. */
function withUiStubs(): void {
  let restore: (() => void) | null = null;
  beforeAll(() => {
    restore = installUiStubs();
  });
  afterAll(() => {
    restore?.();
    restore = null;
  });
}

interface NavCall {
  readonly path: string;
  readonly opts: { replace?: boolean } | undefined;
}

function makeRouter(): { router: PathRouter; calls: NavCall[] } {
  const calls: NavCall[] = [];
  const router = {
    navigate: (path: string, opts?: { replace?: boolean }) => void calls.push({ path, opts }),
    stop: () => {},
  } as unknown as PathRouter;
  return { router, calls };
}

function seed(
  payload: EstatePayload | null,
  path: string,
  params: Record<string, string> = {},
  query: Record<string, string> = {},
): AppStore {
  const store = createAppStore({ storage: null, initialQuery: {} });
  store.estate.value = payload;
  store.route.value = { path, view: "estate", params, query };
  return store;
}

function makeScalePayload(count = 320): EstatePayload {
  const base = makeEstatePayloadFixture();
  const seedHost = base.estate.hosts[0]!;
  const seedLive = base.liveTargets[0]!;
  const hosts = Array.from({ length: count }, (_, i) => ({
    ...seedHost,
    name: `scale-host-${i}`,
    drilldownId: `host:scale-host-${i}` as typeof seedHost.drilldownId,
  }));
  return {
    ...base,
    estate: { ...base.estate, hosts, services: [] },
    liveTargets: hosts.map((host) => ({
      ...seedLive,
      target: { kind: "host", id: host.drilldownId },
      name: host.name,
    })),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function click(el: Element): void {
  const Win = el.ownerDocument.defaultView as unknown as { MouseEvent: typeof MouseEvent };
  el.dispatchEvent(new Win.MouseEvent("click", { bubbles: true, cancelable: true }));
}

/** The selected landing tab's accessible name (Radix generates the tab ids). */
function activeTab(container: HTMLElement): string | null {
  return (
    container.querySelector('[aria-label="Estate sections"] [role="tab"][aria-selected="true"]')?.textContent?.trim() ??
    null
  );
}

function landingTab(container: HTMLElement, name: string): Element {
  const tab = [...container.querySelectorAll('[aria-label="Estate sections"] [role="tab"]')].find(
    (el) => el.textContent?.trim() === name,
  );
  if (tab === undefined) throw new Error(`no landing tab named ${name}`);
  return tab;
}

/** Radix tab triggers select on a primary-button mousedown. */
function selectTab(el: Element): void {
  const Win = el.ownerDocument.defaultView as unknown as { MouseEvent: typeof MouseEvent };
  el.dispatchEvent(new Win.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
}

describeDom("estate view: route dispatch", () => {
  withUiStubs();
  test("default export is the estate view component", () => {
    expect(typeof EstateView).toBe("function");
    expect(EstateView.name).toBe("EstateView");
  });

  test("/estate renders the landing (tabs + search), not an entity page", async () => {
    const { router } = makeRouter();
    const store = seed(makeEstatePayloadFixture(), "/estate");
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      expect(container.querySelector("[data-testid=estate-landing]")).not.toBeNull();
      const root = container.querySelector("[data-testid=estate-view]");
      expect(root?.getAttribute("data-slot")).toBe("estate-page");
      const h1s = [...container.querySelectorAll("h1")];
      expect(h1s.map((h) => h.textContent)).toEqual(["Estate"]);
      expect(container.querySelector(`section[aria-labelledby="${h1s[0]!.id}"]`)).not.toBeNull();
      expect(container.querySelectorAll('[aria-label="Estate sections"] [role="tab"]').length).toBe(3);
      // One tabpanel for the active tab, labelled by its trigger.
      const panels = container.querySelectorAll('[role="tabpanel"]');
      const landingPanels = [...panels].filter((p) => p.closest("[data-region=estate-secondary]") === null);
      expect(landingPanels.length).toBe(1);
      expect(container.querySelector(`#${landingPanels[0]!.getAttribute("aria-labelledby")}`)?.textContent?.trim()).toBe(
        "Inventory",
      );
      expect(container.querySelector('[role="search"] input[type="search"]')).not.toBeNull();
      expect(container.querySelector("[data-testid=estate-entity]")).toBeNull();
      // default tab mounts the inventory tree
      expect(activeTab(container)).toBe("Inventory");
      expect(container.querySelector("[data-testid=estate-host-row]")).not.toBeNull();
    } finally {
      unmount();
    }
  });

  test("/estate/host/:name renders the host entity page from route.params", async () => {
    const payload = makeEstatePayloadFixture();
    const host = payload.estate.hosts[0]!;
    const { router } = makeRouter();
    const store = seed(payload, `/estate/host/${host.name}`, { name: host.name });
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      const page = container.querySelector("[data-testid=estate-entity]");
      expect(page?.getAttribute("data-kind")).toBe("host");
      expect(page?.textContent).toContain(host.name);
      expect(container.querySelector("[data-testid=estate-view]")?.getAttribute("data-slot")).toBe("estate-page");
      expect([...container.querySelectorAll("h1")].map((h) => h.textContent)).toEqual([host.name]);
      expect(container.querySelector("[data-testid=estate-landing]")).toBeNull();
    } finally {
      unmount();
    }
  });

  test("/estate/service/:host/:name renders the service entity page from route.params", async () => {
    const payload = makeEstatePayloadFixture();
    const svc = payload.estate.services[0]!;
    const { router } = makeRouter();
    const store = seed(payload, `/estate/service/${svc.host}/${svc.name}`, { host: svc.host, name: svc.name });
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      const page = container.querySelector("[data-testid=estate-entity]");
      expect(page?.getAttribute("data-kind")).toBe("service");
      expect(page?.textContent).toContain(svc.name);
      expect([...container.querySelectorAll("h1")].map((h) => h.textContent)).toEqual([svc.name]);
      expect(container.querySelector("[data-testid=estate-entity-not-found]")).toBeNull();
    } finally {
      unmount();
    }
  });

  test("params drive dispatch — the path tail is never parsed for the entity name", async () => {
    const payload = makeEstatePayloadFixture();
    const host = payload.estate.hosts[0]!;
    const { router } = makeRouter();
    // Path tail disagrees with params: the page must resolve params.name.
    const store = seed(payload, "/estate/host/not-a-real-host", { name: host.name });
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      expect(container.querySelector("[data-testid=estate-entity-not-found]")).toBeNull();
      expect(container.querySelector("[data-testid=estate-entity]")?.textContent).toContain(host.name);
    } finally {
      unmount();
    }
  });

  test("re-renders on a store.route change (landing → entity page)", async () => {
    const payload = makeEstatePayloadFixture();
    const host = payload.estate.hosts[0]!;
    const { router } = makeRouter();
    const store = seed(payload, "/estate");
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      expect(container.querySelector("[data-testid=estate-landing]")).not.toBeNull();
      store.route.value = { path: `/estate/host/${host.name}`, view: "estate", params: { name: host.name }, query: {} };
      await tick();
      expect(container.querySelector("[data-testid=estate-landing]")).toBeNull();
      expect(container.querySelector("[data-testid=estate-entity]")?.getAttribute("data-kind")).toBe("host");
    } finally {
      unmount();
    }
  });
});

describeDom("estate view: URL-synced landing state", () => {
  withUiStubs();
  test("?tab= drives the controlled Tabs activeId and the mounted surface", async () => {
    const { router } = makeRouter();
    const store = seed(makeEstatePayloadFixture(), "/estate", {}, { tab: "findings" });
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      expect(activeTab(container)).toBe("Findings");
      expect(container.querySelector("[data-testid=estate-findings]")).not.toBeNull();
      expect(container.querySelector("[data-testid=estate-host-row]")).toBeNull();

      store.route.value = { ...store.route.value, query: { tab: "coverage" } };
      await tick();
      expect(activeTab(container)).toBe("Coverage");
      expect(container.querySelector("[data-section=coverage]")).not.toBeNull();
      expect(container.querySelector("[data-testid=estate-findings]")).toBeNull();
    } finally {
      unmount();
    }
  });

  test("a throwing coverage region is localized and switching tabs restores another region", async () => {
    const payload = makeEstatePayloadFixture();
    Object.defineProperty(payload, "coverage", {
      configurable: true,
      get(): never {
        throw new Error("sensitive coverage failure");
      },
    });
    const { router } = makeRouter();
    const store = seed(payload, "/estate", {}, { tab: "coverage" });
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      const localized = container.querySelector("[data-region-error]");
      expect(localized?.textContent).toContain("coverage explorer");
      expect(localized?.textContent).not.toContain("sensitive coverage failure");
      expect(container.querySelector('[aria-label="Estate sections"]')).not.toBeNull();

      store.route.value = { ...store.route.value, query: { tab: "findings" } };
      await tick();
      expect(container.querySelector("[data-testid=estate-findings]")).not.toBeNull();
      expect(container.querySelector("[data-region-error]") === null).toBe(true);
    } finally {
      unmount();
    }
  });

  test("an unrecognized ?tab= falls back to inventory", async () => {
    const { router } = makeRouter();
    const store = seed(makeEstatePayloadFixture(), "/estate", {}, { tab: "bogus" });
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      expect(activeTab(container)).toBe("Inventory");
    } finally {
      unmount();
    }
  });

  test("tab onChange writes ?tab= preserving the rest of the query", async () => {
    const { router, calls } = makeRouter();
    const store = seed(makeScalePayload(), "/estate", {}, { q: "graf" });
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      const started = performance.now();
      selectTab(landingTab(container, "Coverage"));
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(100);
      expect(calls).toEqual([{ path: "/estate?tab=coverage&q=graf", opts: undefined }]);
      // Selecting inventory (the default) yields the canonical bare query.
      store.route.value = { ...store.route.value, query: { tab: "coverage" } };
      await tick();
      selectTab(landingTab(container, "Inventory"));
      expect(calls[1]).toEqual({ path: "/estate", opts: undefined });
    } finally {
      unmount();
    }
  });

  test("the search box writes ?q= via router.navigate (replace) with the full query rebuilt", async () => {
    const { router, calls } = makeRouter();
    const store = seed(makeEstatePayloadFixture(), "/estate", {}, { tab: "inventory", sev: "error" });
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      const input = container.querySelector('input[type="search"]') as HTMLInputElement;
      setInputValue(input, "hostA");
      const Win = input.ownerDocument.defaultView as unknown as { Event: typeof Event };
      input.dispatchEvent(new Win.Event("input", { bubbles: true }));
      expect(calls).toEqual([{ path: "/estate?q=hostA&sev=error", opts: { replace: true } }]);
    } finally {
      unmount();
    }
  });

  test("?q= feeds matchedIds to the inventory — non-matching hosts drop out of the tree", async () => {
    const payload = makeEstatePayloadFixture();
    const [first, ...rest] = payload.estate.hosts;
    expect(first).toBeDefined();
    expect(rest.length).toBeGreaterThan(0);
    const { router } = makeRouter();
    const store = seed(payload, "/estate", {}, { q: first!.name });
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      const shown = [...container.querySelectorAll("[data-testid=estate-host-row]")].map((el) =>
        el.getAttribute("data-host"),
      );
      expect(shown).toContain(first!.name);
      for (const h of rest) {
        if (!h.name.toLowerCase().includes(first!.name.toLowerCase())) expect(shown).not.toContain(h.name);
      }
      expect(container.querySelector('[role="search"] [role="status"]')?.textContent).toMatch(/match/);
    } finally {
      unmount();
    }
  });
});

describeDom("estate view: delivery gate", () => {
  withUiStubs();
  test("no payload → loading degrade state, no surfaces (landing)", async () => {
    const { router } = makeRouter();
    const store = seed(null, "/estate");
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      expect(container.querySelector("[data-degrade=loading]")).not.toBeNull();
      expect(container.querySelector("[data-testid=estate-landing]")).toBeNull();
      expect(container.querySelector('[role="tab"]')).toBeNull();
      expect([...container.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Estate"]);
    } finally {
      unmount();
    }
  });

  test("no payload → loading degrade state, no entity page (deep route)", async () => {
    const { router } = makeRouter();
    const store = seed(null, "/estate/host/hostA-managed", { name: "hostA-managed" });
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      expect(container.querySelector("[data-degrade=loading]")).not.toBeNull();
      expect([...container.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Estate"]);
      expect(container.querySelector("[data-testid=estate-entity]")).toBeNull();
      expect(container.querySelector("[data-testid=estate-entity-not-found]")).toBeNull();
    } finally {
      unmount();
    }
  });

  test("delivery failures and a completed cycle without a model render distinct states", async () => {
    const { router } = makeRouter();
    const store = seed(null, "/estate");
    store.connection.value = {
      ...store.connection.value,
      views: {
        ...store.connection.value.views,
        estate: {
          phase: "initial",
          identity: null,
          failure: { code: "NOT_READY", status: 503, message: "warming" },
        },
      },
    };
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      expect(container.querySelector("[data-degrade=not-ready]")).not.toBeNull();
      expect(container.querySelector("[data-degrade=not-ready] button")?.textContent).toContain("Retry");

      store.connection.value = {
        ...store.connection.value,
        views: {
          ...store.connection.value.views,
          estate: {
            phase: "initial",
            identity: null,
            failure: { code: "INTERNAL_ERROR", status: 500, message: "bounded failure" },
          },
        },
      };
      await tick();
      expect(container.querySelector("[data-degrade=error]")?.textContent).toContain("bounded failure");
      expect(container.querySelector("[data-degrade=error] button")?.textContent).toContain("Retry");

      store.connection.value = {
        ...store.connection.value,
        views: {
          ...store.connection.value.views,
          estate: {
            phase: "initial",
            identity: null,
            failure: { code: "ESTATE_BUNDLE_MISSING", status: 503, message: "bundle unavailable" },
          },
        },
      };
      await tick();
      expect(container.querySelector("[data-degrade=model-absent]")).not.toBeNull();
    } finally {
      unmount();
    }
  });

  test("the assembled Retry affordance reaches live-state and starts a new estate request", async () => {
    const { router } = makeRouter();
    const store = seed(null, "/estate");
    let estateRequests = 0;
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
      if (path === "/api/estate") estateRequests += 1;
      return new Response(JSON.stringify({ code: "NOT_READY", message: "warming" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const live = startLiveState(store, {
      transport: "poll",
      fetchImpl,
      activeView: () => "estate",
      intervalMs: 100_000,
      devBuildCheck: null,
      reload: () => {},
    });
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      await tick();
      await tick();
      expect(estateRequests).toBe(1);
      const retry = container.querySelector("[data-degrade=not-ready] button");
      expect(retry).not.toBeNull();
      click(retry!);
      await tick();
      expect(estateRequests).toBe(2);
    } finally {
      live.stop();
      unmount();
    }
  });

  test("payload arrival flips the gate to ready and mounts the surfaces", async () => {
    const { router } = makeRouter();
    const store = seed(null, "/estate");
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      expect(container.querySelector("[data-testid=estate-landing]")).toBeNull();
      store.estate.value = makeEstatePayloadFixture();
      await tick();
      expect(container.querySelector("[data-degrade=loading]")).toBeNull();
      expect(container.querySelector("[data-testid=estate-landing]")).not.toBeNull();
    } finally {
      unmount();
    }
  });

  test("replaces an already-populated payload reactively", async () => {
    const initial = makeEstatePayloadFixture();
    const originalName = initial.estate.hosts[0]!.name;
    const replacementHost = {
      ...initial.estate.hosts[0]!,
      name: "replacement-host",
      drilldownId: "host:replacement-host",
    };
    const replacement: EstatePayload = {
      ...initial,
      estate: { ...initial.estate, hosts: [replacementHost], services: [] },
      liveTargets: [],
    };
    const { router } = makeRouter();
    const store = seed(initial, "/estate");
    const { container, unmount } = await renderWithStore(EstateView, { store, router });
    try {
      expect(container.textContent).toContain(originalName);
      store.estate.value = replacement;
      await tick();
      expect(container.textContent).toContain("replacement-host");
      expect(container.textContent).not.toContain(originalName);
    } finally {
      unmount();
    }
  });
});
