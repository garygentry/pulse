// apps/web/tests/router.test.ts — the SC-4 walkthrough for the History-API path router
// (07-path-router.md §3, §7, §8, §9, §17). happy-dom is registered in THIS file's own beforeAll
// (no bunfig.toml preload). The router is bound to the registered window explicitly so tests
// simulate Back/Forward with `history.replaceState + dispatchEvent(new Event("popstate"))`
// (07 §13) — happy-dom never dispatches `popstate` itself, and the router's popstate handler is
// deliberately event-object-free.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  CARRIED_QUERY_KEYS,
  RESERVED_PREFIXES,
  createPathRouter,
  matchRoute,
  normalizePath,
  parseLegacyHash,
  routesFromViews,
  type RouteDef,
  type RouteMatch,
  type PathRouter,
} from "../src/client/router.js";
import { dispatch, createFetchHandler, type MutationDispatcher } from "../src/server/router.js";
import { renderMetrics, __resetMetricsForTest } from "../src/server/routes/metrics.js";
import { setRuntimeStatus, type RuntimeStatus, type ServerRuntime } from "../src/server/refresh.js";
import type { ServerContext } from "../src/shared/registry.js";
import type { StaticAssets } from "../src/server/assets.js";
import type { ServerConfig } from "../src/server/config.js";
import { registerHappyDom, unregisterHappyDom } from "./happy-dom.js";

// ── happy-dom registration (this file's own beforeAll) ───────────────────────────────────────────
let win: ReturnType<typeof registerHappyDom>;

beforeAll(() => {
  win = registerHappyDom();
});

afterAll(async () => {
  await unregisterHappyDom();
});

// ── Route table used by most tests (07 §11 wave-3 shape) ────────────────────────────────────────

const ROUTES: RouteDef[] = [
  { pattern: "/overview", view: "overview" },
  { pattern: "/alerts", view: "alerts" },
  { pattern: "/alerts/:fingerprint", view: "alerts" },
  { pattern: "/hosts/:name", view: "hosts" },
  { pattern: "/estate/host/:name", view: "estate" },
  { pattern: "/estate/service/:host/:name", view: "estate" },
];

/** Reset the address bar and history state before a scenario (each test constructs its own router
 *  so nothing survives across tests). */
function resetLocation(url: string): void {
  win.history.replaceState({}, "", url);
}

/** Build a router for a scenario at `initialUrl`. Casts the happy-dom window to `Window` per
 *  07 §13's typing note. */
function buildRouter(
  initialUrl: string,
  opts: { routes?: readonly RouteDef[]; fallback?: string } = {},
): PathRouter {
  resetLocation(initialUrl);
  return createPathRouter({
    routes: opts.routes ?? ROUTES,
    fallback: opts.fallback ?? "/overview",
    win: win as unknown as Window,
  });
}

// ── §2 normalizePath (REQ-ROUTE-09) ─────────────────────────────────────────────────────────────

describe("normalizePath", () => {
  test("identity for a canonical path", () => {
    expect(normalizePath("/overview")).toBe("/overview");
  });
  test("strips a trailing slash except at the root", () => {
    expect(normalizePath("/overview/")).toBe("/overview");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("//")).toBe("/");
  });
  test("collapses repeated slashes and forces a leading slash", () => {
    expect(normalizePath("/estate//host///x/")).toBe("/estate/host/x");
    expect(normalizePath("alerts")).toBe("/alerts");
  });
  test("preserves case", () => {
    expect(normalizePath("/Alerts/")).toBe("/Alerts");
  });
  test("does not percent-decode", () => {
    expect(normalizePath("/estate/host/h%2Dweb")).toBe("/estate/host/h%2Dweb");
  });
});

// ── §3 matchRoute + `:param` decoding ───────────────────────────────────────────────────────────

describe("matchRoute — :param capture and case", () => {
  test("captured param keeps its case", () => {
    const found = matchRoute([{ pattern: "/hosts/:name", view: "hosts" }], "/hosts/Web-01");
    expect(found).not.toBeNull();
    expect(found!.params.name).toBe("Web-01");
  });
  test("static segments compare case-insensitively", () => {
    const found = matchRoute([{ pattern: "/hosts/:name", view: "hosts" }], "/HOSTS/x");
    expect(found).not.toBeNull();
    expect(found!.params.name).toBe("x");
  });
  test("percent-encoded values are decoded once", () => {
    const found = matchRoute([{ pattern: "/hosts/:name", view: "hosts" }], "/hosts/web%2001");
    expect(found).not.toBeNull();
    expect(found!.params.name).toBe("web 01");
  });
  test("malformed escape falls back to the raw segment (never throws)", () => {
    const found = matchRoute(
      [{ pattern: "/estate/service/:host/:name", view: "estate" }],
      "/estate/service/harbor-web-01/bad%E0",
    );
    expect(found).not.toBeNull();
    expect(found!.params.name).toBe("bad%E0");
  });
  test("segment-count mismatch yields null (drives the fallback replace)", () => {
    expect(matchRoute([{ pattern: "/hosts/:name", view: "hosts" }], "/hosts")).toBeNull();
    expect(matchRoute([{ pattern: "/overview", view: "overview" }], "/overview/extra")).toBeNull();
  });
  test("first declared route wins", () => {
    const r: RouteDef[] = [
      { pattern: "/x", view: "first" },
      { pattern: "/x", view: "second" },
    ];
    expect(matchRoute(r, "/x")!.view).toBe("first");
  });
});

// ── §5 parseLegacyHash ──────────────────────────────────────────────────────────────────────────

describe("parseLegacyHash", () => {
  test("returns null for non-legacy hashes", () => {
    for (const h of ["", "#", "#/", "#section", "#?x=1"]) {
      expect(parseLegacyHash(h)).toBeNull();
    }
  });
  test("parses #/view and #/view?query", () => {
    expect(parseLegacyHash("#/overview")).toEqual({ path: "/overview", query: {} });
    expect(parseLegacyHash("#/overview?kiosk=1")).toEqual({
      path: "/overview",
      query: { kiosk: "1" },
    });
  });
});

// ── §5 construction redirect: hash → path (SC-4 row 2, REQ-ROUTE-02) ────────────────────────────

describe("SC-4: legacy hash redirect", () => {
  test("#/overview?kiosk=1 boot lands on /overview?kiosk=1 as a single history entry", () => {
    const router = buildRouter("/#/overview?kiosk=1");
    try {
      expect(win.location.pathname).toBe("/overview");
      expect(win.location.search).toBe("?kiosk=1");
      expect(win.location.hash).toBe("");
      expect(router.current().view).toBe("overview");
      expect(router.current().query.kiosk).toBe("1");
    } finally {
      router.stop();
    }
  });

  test("?kiosk=0#/overview?kiosk=1 has location.search win the merge", () => {
    const router = buildRouter("/?kiosk=0#/overview?kiosk=1");
    try {
      expect(win.location.pathname).toBe("/overview");
      expect(win.location.search).toBe("?kiosk=0");
      expect(router.current().query.kiosk).toBe("0");
    } finally {
      router.stop();
    }
  });

  test("#/nonexistent is redirected then falls back to /overview (still one entry)", () => {
    const router = buildRouter("/#/nonexistent");
    try {
      expect(win.location.pathname).toBe("/overview");
      expect(router.current().view).toBe("overview");
    } finally {
      router.stop();
    }
  });
});

// ── §7 navigate: carry + push/replace + fallback (REQ-ROUTE-03/04/08) ───────────────────────────

describe("SC-4: navigate — kiosk/rotate carry across push, replace, fallback", () => {
  test("push carries kiosk from the current match", () => {
    const router = buildRouter("/overview?kiosk=1");
    try {
      router.navigate("/alerts");
      expect(win.location.pathname).toBe("/alerts");
      expect(win.location.search).toBe("?kiosk=1");
      expect(router.current().view).toBe("alerts");
      expect(router.current().query.kiosk).toBe("1");
    } finally {
      router.stop();
    }
  });

  test("replace also carries kiosk/rotate", () => {
    const router = buildRouter("/overview?kiosk=1&rotate=");
    try {
      router.navigate("/alerts", { replace: true });
      expect(win.location.pathname).toBe("/alerts");
      expect(win.location.search).toContain("kiosk=1");
      expect(win.location.search).toContain("rotate=");
    } finally {
      router.stop();
    }
  });

  test("unknown path fallback-replaces to /overview, carrying the query", () => {
    const router = buildRouter("/overview?kiosk=1");
    try {
      router.navigate("/nope");
      // After the push-then-fallback-replace, the URL is /overview?kiosk=1 again.
      expect(win.location.pathname).toBe("/overview");
      expect(win.location.search).toBe("?kiosk=1");
      expect(router.current().view).toBe("overview");
    } finally {
      router.stop();
    }
  });

  test("explicit ?kiosk=0 on navigate defeats the carry", () => {
    const router = buildRouter("/overview?kiosk=1");
    try {
      router.navigate("/alerts?kiosk=0");
      expect(win.location.search).toBe("?kiosk=0");
    } finally {
      router.stop();
    }
  });
});

// ── §7 same-target no-op and case normalisation ─────────────────────────────────────────────────

describe("navigate — no-op guard and case handling", () => {
  test("navigate to the same path+query is a no-op (no subscriber fires)", () => {
    const router = buildRouter("/overview");
    try {
      let calls = 0;
      router.subscribe(() => calls++);
      router.navigate("/overview");
      expect(calls).toBe(0);
    } finally {
      router.stop();
    }
  });

  test("/Alerts/ → navigate('/alerts') pushes (URL differs) but match key is unchanged", () => {
    const router = buildRouter("/Alerts/");
    try {
      let notified: RouteMatch | null = null;
      router.subscribe((m) => (notified = m));
      router.navigate("/alerts");
      expect(win.location.pathname).toBe("/alerts");
      // match key = view|path|query — path is canonical /alerts in both cases → no notification.
      expect(notified).toBeNull();
    } finally {
      router.stop();
    }
  });
});

// ── §7 scroll: push scrolls to top, replace does not (REQ-ROUTE-08) ─────────────────────────────

describe("scrollTo: push vs replace", () => {
  test("push calls scrollTo(0, 0); replace does not", () => {
    const router = buildRouter("/overview");
    try {
      const calls: Array<[number, number]> = [];
      const original = win.scrollTo.bind(win);
      (win as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo = (
        x: number,
        y: number,
      ) => {
        calls.push([x, y]);
      };
      try {
        router.navigate("/alerts");
        expect(calls).toContainEqual([0, 0]);
        const beforeReplace = calls.length;
        router.navigate("/overview", { replace: true });
        expect(calls.length).toBe(beforeReplace);
      } finally {
        (win as unknown as { scrollTo: unknown }).scrollTo = original;
      }
    } finally {
      router.stop();
    }
  });
});

// ── §8 Back/Forward via replaceState + dispatchEvent(new Event("popstate")) (07 §13) ───────────

describe("SC-4: Back/Forward via popstate simulation", () => {
  test("popstate re-matches from window.location (no page reload)", () => {
    const router = buildRouter("/overview");
    try {
      router.navigate("/alerts"); // push
      expect(router.current().view).toBe("alerts");

      // Simulate Back: replace the URL, dispatch a bare Event (happy-dom has no PopStateEvent).
      win.history.replaceState({}, "", "/overview");
      win.dispatchEvent(new win.Event("popstate"));

      expect(router.current().view).toBe("overview");
      expect(router.current().path).toBe("/overview");
    } finally {
      router.stop();
    }
  });

  test("popstate onto an unmatched URL fallback-replaces (Back never loops)", () => {
    const router = buildRouter("/overview");
    try {
      // Simulate landing on a stale bookmark that no longer maps.
      win.history.replaceState({}, "", "/does-not-exist?kiosk=1");
      win.dispatchEvent(new win.Event("popstate"));
      expect(router.current().view).toBe("overview");
      expect(win.location.pathname).toBe("/overview");
      expect(win.location.search).toBe("?kiosk=1"); // full popped query kept (§6)
    } finally {
      router.stop();
    }
  });

  test("popstate handler ignores the event object (no read of event.state)", () => {
    // If the handler ever read event.state, dispatching a bare Event without a `state` field would
    // crash or misroute. Proof: this test still passes.
    const router = buildRouter("/overview");
    try {
      router.navigate("/alerts");
      win.history.replaceState({}, "", "/overview");
      win.dispatchEvent(new win.Event("popstate"));
      expect(router.current().view).toBe("overview");
    } finally {
      router.stop();
    }
  });
});

// ── §9 anchor interception (REQ-ROUTE-06) ───────────────────────────────────────────────────────

describe("SC-4: anchor interception", () => {
  type AnchorLike = HTMLAnchorElement & {
    setAttribute(name: string, value: string): void;
    addEventListener(type: string, listener: (e: { preventDefault(): void }) => void): void;
    dispatchEvent(event: unknown): boolean;
  };

  function makeAnchor(attrs: Record<string, string>): AnchorLike {
    const doc = win.document as unknown as {
      createElement(name: string): AnchorLike;
      body: { appendChild(el: unknown): void };
    };
    const a = doc.createElement("a");
    for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
    doc.body.appendChild(a);
    return a;
  }

  /** Dispatch a plain-left click on `a` with the given mouse-init overrides. Returns whether the
   *  event was defaultPrevented (router-intercepted). */
  function clickAnchor(a: AnchorLike, init: Record<string, unknown> = {}): boolean {
    const MouseEventCtor = (win as unknown as {
      MouseEvent: new (type: string, init: Record<string, unknown>) => {
        defaultPrevented: boolean;
      };
    }).MouseEvent;
    const event = new MouseEventCtor("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...init,
    });
    a.dispatchEvent(event);
    return event.defaultPrevented;
  }

  test("plain left-click on same-origin anchor is intercepted → navigate", () => {
    const router = buildRouter("/overview");
    try {
      const a = makeAnchor({ href: "/alerts" });
      const prevented = clickAnchor(a);
      expect(prevented).toBe(true);
      expect(router.current().view).toBe("alerts");
    } finally {
      router.stop();
    }
  });

  test("ctrl/meta/shift/alt-click passes through", () => {
    const router = buildRouter("/overview");
    try {
      const a = makeAnchor({ href: "/alerts" });
      for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"] as const) {
        expect(clickAnchor(a, { [modifier]: true })).toBe(false);
      }
      expect(router.current().view).toBe("overview");
    } finally {
      router.stop();
    }
  });

  test("middle-click (button !== 0) passes through", () => {
    const router = buildRouter("/overview");
    try {
      const a = makeAnchor({ href: "/alerts" });
      expect(clickAnchor(a, { button: 1 })).toBe(false);
      expect(router.current().view).toBe("overview");
    } finally {
      router.stop();
    }
  });

  test("anchor with target attribute passes through", () => {
    const router = buildRouter("/overview");
    try {
      const a = makeAnchor({ href: "/alerts", target: "_blank" });
      expect(clickAnchor(a)).toBe(false);
      const a2 = makeAnchor({ href: "/alerts", target: "_self" });
      expect(clickAnchor(a2)).toBe(false);
      expect(router.current().view).toBe("overview");
    } finally {
      router.stop();
    }
  });

  test("anchor with download attribute passes through", () => {
    const router = buildRouter("/overview");
    try {
      const a = makeAnchor({ href: "/alerts", download: "" });
      expect(clickAnchor(a)).toBe(false);
      expect(router.current().view).toBe("overview");
    } finally {
      router.stop();
    }
  });

  test("pure-fragment href (#section) passes through", () => {
    const router = buildRouter("/overview");
    try {
      const a = makeAnchor({ href: "#section" });
      expect(clickAnchor(a)).toBe(false);
    } finally {
      router.stop();
    }
  });

  test("cross-origin absolute link passes through", () => {
    const router = buildRouter("/overview");
    try {
      const a = makeAnchor({ href: "https://grafana.example/d/abc" });
      expect(clickAnchor(a)).toBe(false);
    } finally {
      router.stop();
    }
  });

  test("reserved prefix (/api/, /assets/, /healthz, /metrics) is never intercepted", () => {
    const router = buildRouter("/overview");
    try {
      for (const path of ["/api/overview", "/assets/main.js", "/healthz", "/metrics"]) {
        const a = makeAnchor({ href: path });
        expect(clickAnchor(a)).toBe(false);
      }
      expect(router.current().view).toBe("overview");
    } finally {
      router.stop();
    }
  });

  test("handler that already called preventDefault passes through", () => {
    const router = buildRouter("/overview");
    try {
      const a = makeAnchor({ href: "/alerts" });
      a.addEventListener("click", (e) => e.preventDefault());
      clickAnchor(a);
      // Router did not navigate — current view stays.
      expect(router.current().view).toBe("overview");
    } finally {
      router.stop();
    }
  });
});

// ── URL fragment: carried through navigate, the interceptor and popstate (#7) ────────────────────

describe("URL fragment (#hash)", () => {
  type ScrollCall = [number, number];

  /** Record `scrollTo` calls for the duration of `body`. */
  async function withScrollSpy(body: (calls: ScrollCall[]) => void | Promise<void>): Promise<void> {
    const calls: ScrollCall[] = [];
    const original = win.scrollTo.bind(win);
    (win as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo = (x, y) => {
      calls.push([x, y]);
    };
    try {
      await body(calls);
    } finally {
      (win as unknown as { scrollTo: unknown }).scrollTo = original;
    }
  }

  /** Let a few animation frames run (the router retries a not-yet-rendered target per frame). */
  const frames = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));

  /** Poll until `cond` holds (or ~900 ms pass, inside the router's 1 s wait), then return. */
  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 45 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  }

  /** Pretend the page is scrolled to `y` for the duration of `body`. */
  function atScrollY(y: number, body: () => void): void {
    Object.defineProperty(win, "scrollY", { value: y, configurable: true });
    try {
      body();
    } finally {
      delete (win as unknown as { scrollY?: number }).scrollY;
    }
  }

  const savedScrollY = (): unknown => (win.history.state as { scrollY?: unknown } | null)?.scrollY;

  /** Append an element with `id` whose `scrollIntoView` records into `hits`. */
  function section(id: string, hits: string[]): { remove(): void } {
    const doc = win.document as unknown as {
      createElement(name: string): HTMLElement & { remove(): void };
      body: { appendChild(el: unknown): void };
    };
    const el = doc.createElement("section");
    el.id = id;
    (el as unknown as { scrollIntoView: () => void }).scrollIntoView = () => hits.push(id);
    doc.body.appendChild(el);
    return el;
  }

  function anchor(href: string): {
    dispatchEvent(event: unknown): boolean;
    remove(): void;
  } {
    const doc = win.document as unknown as {
      createElement(name: string): HTMLAnchorElement & { remove(): void };
      body: { appendChild(el: unknown): void };
    };
    const a = doc.createElement("a");
    a.setAttribute("href", href);
    doc.body.appendChild(a);
    return a;
  }

  function click(a: { dispatchEvent(event: unknown): boolean }): boolean {
    const MouseEventCtor = (win as unknown as {
      MouseEvent: new (type: string, init: Record<string, unknown>) => { defaultPrevented: boolean };
    }).MouseEvent;
    const event = new MouseEventCtor("click", { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(event);
    return event.defaultPrevented;
  }

  test("an intercepted link keeps its fragment in location.hash", () => {
    const router = buildRouter("/overview");
    const a = anchor("/estate/host/nas-01?tab=disks#alerts");
    try {
      expect(click(a)).toBe(true);
      expect(win.location.pathname).toBe("/estate/host/nas-01");
      expect(win.location.search).toBe("?tab=disks");
      expect(win.location.hash).toBe("#alerts");
      expect(router.current().view).toBe("estate");
    } finally {
      a.remove();
      router.stop();
    }
  });

  test("a same-document fragment link (current path + query) stays browser-owned", () => {
    const router = buildRouter("/alerts?sort=age");
    const a = anchor("/alerts?sort=age#firing");
    try {
      expect(click(a)).toBe(false);
    } finally {
      a.remove();
      router.stop();
    }
  });

  test("a fragment link that also changes the query is intercepted", () => {
    const router = buildRouter("/alerts?sort=age");
    const a = anchor("/alerts?sort=name#firing");
    try {
      expect(click(a)).toBe(true);
      expect(win.location.search).toBe("?sort=name");
      expect(win.location.hash).toBe("#firing");
    } finally {
      a.remove();
      router.stop();
    }
  });

  test("navigate to another path carries the target fragment and kiosk", () => {
    const router = buildRouter("/overview?kiosk=1");
    try {
      router.navigate("/alerts#firing");
      expect(win.location.pathname).toBe("/alerts");
      expect(win.location.search).toBe("?kiosk=1");
      expect(win.location.hash).toBe("#firing");
    } finally {
      router.stop();
    }
  });

  test("navigate to another path without a fragment drops the current one (regression guard)", () => {
    const router = buildRouter("/alerts#firing");
    try {
      router.navigate("/overview");
      expect(win.location.pathname).toBe("/overview");
      expect(win.location.hash).toBe("");
    } finally {
      router.stop();
    }
  });

  test("a same-path query rewrite keeps the current fragment (push and replace)", () => {
    const router = buildRouter("/alerts?sort=age#firing");
    try {
      router.navigate("/alerts?sort=name", { replace: true });
      expect(win.location.search).toBe("?sort=name");
      expect(win.location.hash).toBe("#firing");
      router.navigate("/alerts?sort=age");
      expect(win.location.search).toBe("?sort=age");
      expect(win.location.hash).toBe("#firing");
      expect(router.current().query).toEqual({ sort: "age" });
    } finally {
      router.stop();
    }
  });

  test("a bare trailing # clears the fragment on a same-path navigate", () => {
    const router = buildRouter("/alerts?sort=age#firing");
    try {
      router.navigate("/alerts?sort=age#", { replace: true });
      expect(win.location.hash).toBe("");
      expect(win.location.search).toBe("?sort=age");
    } finally {
      router.stop();
    }
  });

  test("the same-URL dedupe compares fragments", () => {
    const router = buildRouter("/alerts#firing");
    try {
      const length = win.history.length;
      let calls = 0;
      router.subscribe(() => calls++);
      router.navigate("/alerts#firing");
      router.navigate("/alerts"); // same path, no fragment named → keeps #firing → same URL
      expect(win.history.length).toBe(length);
      // A different fragment on the same path+query is a real navigation (pushes, no re-render).
      router.navigate("/alerts#history");
      expect(win.location.hash).toBe("#history");
      expect(win.history.length).toBe(length + 1);
      expect(calls).toBe(0);
    } finally {
      router.stop();
    }
  });

  test("a fragment-only navigate pushes, scrolls to the target, and does not re-render", async () => {
    const router = buildRouter("/alerts");
    const hits: string[] = [];
    const el = section("firing", hits);
    try {
      await withScrollSpy((calls) => {
        const length = win.history.length;
        let notified = 0;
        router.subscribe(() => notified++);
        router.navigate("/alerts#firing");
        expect(win.location.hash).toBe("#firing");
        expect(win.history.length).toBe(length + 1);
        expect(notified).toBe(0);
        expect(hits).toEqual(["firing"]);
        expect(calls).toEqual([]); // jumped to the target, not the top
      });
    } finally {
      el.remove();
      router.stop();
    }
  });

  test("a fragment whose target is missing falls back to the top", async () => {
    const router = buildRouter("/alerts");
    try {
      await withScrollSpy((calls) => {
        router.navigate("/alerts#nowhere");
        expect(win.location.hash).toBe("#nowhere");
        expect(calls).toContainEqual([0, 0]);
      });
    } finally {
      router.stop();
    }
  });

  test("a push to a new page lands on the fragment target once the page renders it", async () => {
    const router = buildRouter("/overview");
    const hits: string[] = [];
    const stale = section("firing", hits); // same id on the outgoing page: must not be used
    let fresh: { remove(): void } | null = null;
    try {
      // The "view" renders after notify, replacing the outgoing page's DOM.
      router.subscribe(() => {
        stale.remove();
        setTimeout(() => (fresh = section("firing", hits)), 20);
      });
      await withScrollSpy(async (calls) => {
        router.navigate("/alerts#firing");
        expect(hits).toEqual([]);
        expect(calls).toEqual([[0, 0]]); // top while the new page renders
        await until(() => hits.length > 0);
        expect(hits).toEqual(["firing"]);
      });
    } finally {
      stale.remove();
      (fresh as { remove(): void } | null)?.remove();
      router.stop();
    }
  });

  test("a query-changing push with a fragment scrolls to its target", async () => {
    const router = buildRouter("/alerts");
    const hits: string[] = [];
    const el = section("spot2", hits);
    try {
      await withScrollSpy(async () => {
        router.navigate("/alerts?kiosk=1#spot2");
        expect(win.location.search).toBe("?kiosk=1");
        await until(() => hits.length > 0);
        expect(hits).toEqual(["spot2"]);
      });
    } finally {
      el.remove();
      router.stop();
    }
  });

  test("a superseded fragment wait does not scroll", async () => {
    const router = buildRouter("/overview");
    const hits: string[] = [];
    try {
      await withScrollSpy(async () => {
        router.navigate("/alerts#later");
        router.navigate("/overview");
        const el = section("later", hits);
        await frames();
        el.remove();
        expect(hits).toEqual([]);
      });
    } finally {
      router.stop();
    }
  });

  test("Forward onto another page's fragment entry re-matches and scrolls to the target once rendered", async () => {
    const router = buildRouter("/overview");
    const hits: string[] = [];
    let el: { remove(): void } | null = null;
    try {
      router.subscribe((m) => {
        if (m.view === "alerts") setTimeout(() => (el = section("firing", hits)), 20);
      });
      await withScrollSpy(async (calls) => {
        win.history.replaceState({}, "", "/alerts#firing"); // no saved offset
        win.dispatchEvent(new win.Event("popstate"));
        expect(router.current().view).toBe("alerts");
        expect(win.location.hash).toBe("#firing");
        expect(calls).toEqual([[0, 0]]);
        await until(() => hits.length > 0);
        expect(hits).toEqual(["firing"]);
      });
    } finally {
      (el as { remove(): void } | null)?.remove();
      router.stop();
    }
  });

  test("a fragment-less link clears the current fragment; navigate() keeps it", () => {
    const router = buildRouter("/alerts#spot");
    const a = anchor("/alerts?sort=x");
    try {
      router.navigate("/alerts?sort=y"); // programmatic: same path keeps #spot
      expect(win.location.hash).toBe("#spot");
      expect(click(a)).toBe(true); // a link names its whole URL
      expect(win.location.search).toBe("?sort=x");
      expect(win.location.hash).toBe("");
    } finally {
      a.remove();
      router.stop();
    }
  });

  test("a browser-owned fragment link saves the outgoing offset for Back", () => {
    for (const href of ["#spot", "/alerts?sort=age#spot"]) {
      const router = buildRouter("/alerts?sort=age");
      const a = anchor(href);
      try {
        expect(savedScrollY()).toBeUndefined();
        atScrollY(1500, () => {
          // happy-dom does not perform the default fragment navigation, so the current entry is
          // still the outgoing one here.
          expect(click(a)).toBe(false);
        });
        expect(savedScrollY()).toBe(1500);
      } finally {
        a.remove();
        router.stop();
      }
    }
  });

  test("popstate onto a same-page fragment entry without a saved offset scrolls to its target", async () => {
    const router = buildRouter("/alerts");
    const hits: string[] = [];
    const el = section("firing", hits);
    try {
      await withScrollSpy((calls) => {
        // e.g. Forward onto an entry the browser created for a fragment link (no scrollY).
        win.history.replaceState({}, "", "/alerts#firing");
        win.dispatchEvent(new win.Event("popstate"));
        expect(hits).toEqual(["firing"]);
        expect(calls).toEqual([]);

        // An entry that recorded an offset restores the offset instead.
        win.history.replaceState({ scrollY: 120 }, "", "/alerts#firing");
        win.dispatchEvent(new win.Event("popstate"));
        expect(calls).toEqual([[0, 120]]);
      });
    } finally {
      el.remove();
      router.stop();
    }
  });
});

// ── §7 reserved-prefix navigate → location.assign ───────────────────────────────────────────────

describe("navigate — reserved prefixes leave the SPA", () => {
  test("navigate('/api/…') calls win.location.assign, no SPA state change", () => {
    const router = buildRouter("/overview");
    try {
      const seen: string[] = [];
      const originalAssign = win.location.assign.bind(win.location);
      (win.location as unknown as { assign: (u: string) => void }).assign = (u: string) => {
        seen.push(u);
      };
      try {
        router.navigate("/api/overview");
        router.navigate("/metrics");
        expect(seen).toEqual(["/api/overview", "/metrics"]);
        expect(router.current().view).toBe("overview");
      } finally {
        (win.location as unknown as { assign: (u: string) => void }).assign = originalAssign;
      }
    } finally {
      router.stop();
    }
  });
});

// ── §11 routesFromViews (REQ-VIEW-02) ───────────────────────────────────────────────────────────

describe("routesFromViews", () => {
  test("flattens id and extra routes in registry order", () => {
    const routes = routesFromViews([
      { id: "overview" },
      { id: "alerts", routes: ["/alerts/:fingerprint"] },
      { id: "estate", routes: ["/estate/host/:name", "/estate/service/:host/:name"] },
    ]);
    expect(routes).toEqual([
      { pattern: "/overview", view: "overview" },
      { pattern: "/alerts", view: "alerts" },
      { pattern: "/alerts/:fingerprint", view: "alerts" },
      { pattern: "/estate", view: "estate" },
      { pattern: "/estate/host/:name", view: "estate" },
      { pattern: "/estate/service/:host/:name", view: "estate" },
    ]);
  });

  test("single view produces a single primary route", () => {
    expect(routesFromViews([{ id: "overview" }])).toEqual([
      { pattern: "/overview", view: "overview" },
    ]);
  });
});

// ── construction guards (§15) ──────────────────────────────────────────────────────────────────

describe("construction guards", () => {
  test("throws when fallback does not match any declared route", () => {
    resetLocation("/overview");
    expect(() =>
      createPathRouter({
        routes: [{ pattern: "/overview", view: "overview" }],
        fallback: "/nope",
        win: win as unknown as Window,
      }),
    ).toThrow(/fallback/);
  });
});

// ── stop() clears listeners ─────────────────────────────────────────────────────────────────────

describe("stop()", () => {
  test("after stop, popstate and anchor click no longer change current()", () => {
    const router = buildRouter("/overview");
    router.navigate("/alerts");
    router.stop();

    win.history.replaceState({}, "", "/overview");
    win.dispatchEvent(new win.Event("popstate"));
    // current() returns the cached last match; a fresh router would rebuild — the assertion is that
    // no crash / no listener re-fire happens (subscribe listeners were cleared).
    expect(router.current().view).toBe("alerts");
  });
});

// ── constants sanity ──────────────────────────────────────────────────────────────────────────

describe("constants", () => {
  test("RESERVED_PREFIXES per 00 §5", () => {
    expect(RESERVED_PREFIXES).toEqual(["/api/", "/assets/", "/healthz", "/metrics"]);
  });
  test("CARRIED_QUERY_KEYS per 00 §5", () => {
    expect(CARRIED_QUERY_KEYS).toEqual(["kiosk", "rotate"]);
  });
});

// ── §14 server-side `spa` label unchanged (REQ-ROUTE-10) ────────────────────────────────────────

describe("server-side spa label (REQ-ROUTE-10)", () => {
  function health() {
    return { ok: true, lastSuccess: "2026-08-22T12:00:00.000Z", error: null };
  }
  function statusValue(): RuntimeStatus {
    return {
      sources: { metrics: health(), alerts: health(), checks: health() },
      model: { loaded: true, formatVersion: 1, error: null },
      lastSnapshotAt: Date.parse("2026-08-22T12:00:00.000Z"),
    };
  }
  const stubAssets: StaticAssets = {
    get: () => undefined,
    shell: () => "<!doctype html><div id=app></div>",
  };
  function fakeRuntime(): ServerRuntime {
    const ctx: ServerContext = {
      estate: null,
      cycle: null,
      history: {} as ServerContext["history"],
      events: {} as ServerContext["events"],
      sources: {} as ServerContext["sources"],
      config: {} as ServerConfig,
      identity: null,
      snapshot: null,
    };
    return {
      getContext: () => ctx,
      identityConfig: { mode: "none", headerName: "Remote-User", trustedProxies: [] },
      getStatus: () => statusValue(),
      runOnce: async () => {},
      start: async () => {},
      close: () => {},
    };
  }
  function req(path: string): Request {
    return new Request(`http://web:8080${path}`, { method: "GET" });
  }

  test("dispatch serves the shell for /alerts/abc123 and /estate/host/x", async () => {
    const runtime = fakeRuntime();
    for (const p of ["/alerts/abc123", "/estate/host/x"]) {
      const res = await dispatch(req(p), p, runtime, stubAssets);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("id=app");
    }
  });

  test("both deep links collapse to route=\"spa\" in pulse_web_http_requests_total", async () => {
    __resetMetricsForTest();
    setRuntimeStatus(statusValue());
    const runtime = fakeRuntime();
    const handler = createFetchHandler(runtime, stubAssets);
    await handler(req("/alerts/abc123"));
    await handler(req("/estate/host/x"));
    const text = renderMetrics(statusValue(), Date.parse("2026-08-22T12:00:00.000Z"));
    expect(text).toContain('pulse_web_http_requests_total{route="spa",status="200"} 2');
    // Neither deep path leaks into the label set.
    expect(text).not.toContain("/alerts/abc123");
    expect(text).not.toContain("/estate/host/x");
    __resetMetricsForTest();
  });

  // Mutation seam injection through createFetchHandler (the M2 wiring point; epic verify 2026-09-25 V-001).
  test("an injected dispatcher receives non-GET requests; GET requests never reach it", async () => {
    setRuntimeStatus(statusValue());
    const seen: string[] = [];
    const dispatcher: MutationDispatcher = async ({ request, pathname }) => {
      seen.push(`${request.method} ${pathname}`);
      return new Response("handled", { status: 202 });
    };
    const handler = createFetchHandler(fakeRuntime(), stubAssets, dispatcher);
    const post = await handler(new Request("http://localhost/api/mutations/silences", { method: "POST" }));
    expect(post.status).toBe(202);
    expect(await post.text()).toBe("handled");
    const get = await handler(req("/alerts"));
    expect(get.status).toBe(200);
    expect(seen).toEqual(["POST /api/mutations/silences"]);
  });

  test("without an injected dispatcher a non-GET falls through to the JSON 405 (M1 default)", async () => {
    setRuntimeStatus(statusValue());
    const handler = createFetchHandler(fakeRuntime(), stubAssets);
    const res = await handler(new Request("http://localhost/api/overview", { method: "POST" }));
    expect(res.status).toBe(405);
  });
});

