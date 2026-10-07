// apps/web/tests/skeleton.test.ts — the two-sided extension-skeleton acceptance (REQ-EXT-01,
// 08-testing-strategy.md §8, 00-core-definitions.md §4). The mechanical proof of charter A8 / OQ-01:
// a NEW view is ONE client module + ONE server route module + TWO registry entries — nothing else.
//
// The test defines a stub view + a stub route in THIS test-only module, registers each through the
// PUBLIC seam types (`ViewDefinition` / `RouteDefinition`), appends each to the REAL registry array
// (`VIEWS` / `ROUTES` — the single sanctioned edit a new view makes, restored in afterAll), and
// asserts both are reachable through the UNMODIFIED router / dispatch with ZERO edits to router.ts,
// main.tsx, the existing registry entries, or any other route/view module.
//
// Enumerated objective (§8), exactly three claims — NOT an open-ended "nothing else changed":
//   1. A RouteDefinition-shaped entry appended to ROUTES is dispatched by the router to its handler.
//   2. A ViewDefinition-shaped entry appended to VIEWS is resolved by the hash router + mounted.
//   3. Both seams accept the stub through their public interface types only (no test-only backdoor).
//   4. (appended by mutation-foundation 02-m1-compatibility.md §7) The mutation mirror: the mutation
//      registry is proxy-header-only, append-only and POST-only; a registered stub is reachable through
//      the UNMODIFIED router's mutation seam, and the GET RouteDefinition type stays unwidened.
//
// happy-dom is registered in THIS file's own beforeAll (no bunfig.toml under apps/web).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { ComponentType, ReactElement } from "react";

import { ROUTES } from "../src/server/routes/registry.js";
import { VIEWS } from "../src/client/views/registry.js";
import type { RouteDefinition, ServerContext, ViewDefinition, ViewProps } from "../src/shared/registry.js";
import type { SourceHealth } from "../src/shared/snapshot.js";
import { dispatch } from "../src/server/router.js";
import type { RuntimeStatus, ServerRuntime } from "../src/server/refresh.js";
import type { StaticAssets } from "../src/server/assets.js";
import type { ServerConfig } from "../src/server/config.js";
import { createPathRouter, routesFromViews } from "../src/client/router.js";
import { createAppStore } from "../src/client/store/index.js";
import { registerHappyDom, unregisterHappyDom } from "./happy-dom.js";
import { makeWebEstateModelV2, NOW, overviewSnapshot } from "./factories.js";
import type { EstateBundle } from "../src/server/estate/load.js";
import { z } from "zod";
import { resolveIdentity } from "@pulse/web-data/identity";
import type { MutationDispatcher, RequestServices } from "../src/server/router.js";
import {
  createMutationRegistry,
  MutationRegistrationError,
  type MutationDefinition,
  type MutationRegistry,
} from "../src/server/mutations/registry.js";

// ── The stub route + stub view (the ONLY modules a second view adds — here, this test module) ──────

/** Side-channel the stub handler records into, so the test observes WHAT the handler saw without
 *  reading the response body via `.text()` — a sibling happy-dom suite clobbers the global `Response`
 *  and its `.text()` crashes once its window is closed, so we assert `res.status` (a plain getter,
 *  safe on any Response) plus this record instead. */
let stubSeen: { called: boolean; seenEstate: string | null } = { called: false, seenEstate: null };

/** A stub server route registered through the PUBLIC `RouteDefinition` seam (00 §4). `method` is the
 *  literal `"GET"` — a compile-time guarantee (a non-GET stub fails `tsc -b`); the runtime check below
 *  is a sanity assert, not the enforcement. The handler reads from `ServerContext` to prove the seam
 *  is exercised end to end (it never constructs an engine URL or re-reads the model). */
const stubRoute: RouteDefinition = {
  method: "GET",
  path: "/api/__stub",
  handler: (_req, ctx: ServerContext) => {
    stubSeen = { called: true, seenEstate: ctx.estate?.model.estate.name ?? null };
    return new Response(null, { status: 200 });
  },
};

/** A trivial stub view component (built with `createElement` so this file stays `.ts`, no JSX). */
function StubView(_props: ViewProps): ReactElement {
  return createElement("div", { className: "stub-view", "data-stub": "mounted" }, "STUB VIEW MOUNTED") as ReactElement;
}

/** The stub client view registered through the PUBLIC `ViewDefinition` seam (v2). `id` doubles as
 *  its primary path segment (`/__stub`). `load()` resolves an already-materialised component so
 *  no chunk fetch happens under happy-dom. `nav` and `routes` are omitted to prove both optional. */
const stubView: ViewDefinition = {
  id: "__stub",
  label: "Stub",
  load: async () => StubView,
};

// The real registry arrays, viewed as mutable — appending one entry is exactly the sanctioned
// per-view edit (OQ-01's "two registry entries"); everything else stays untouched. Restored in
// afterAll so no sibling suite (e.g. routes.test.ts, which pins ROUTES to the three v1 paths) leaks.
const routesArr = ROUTES as unknown as RouteDefinition[];
const viewsArr = VIEWS as ViewDefinition[];
let originalRoutes: RouteDefinition[];
let originalViews: ViewDefinition[];

// ── happy-dom registration (shared registrar — item 013) + registry stubbing ─────────────────────
// registerHappyDom/unregisterHappyDom snapshot Bun's true natives at module-load time and restore them
// in afterAll, so the fetch/Response-based suites (sources/poll/routes) never observe happy-dom's
// clobbered globals once this file's window is closed.
let win: ReturnType<typeof registerHappyDom>;

beforeAll(() => {
  win = registerHappyDom();

  // Register the stub route + stub view (the append-only, single-edit registration).
  originalRoutes = [...routesArr];
  originalViews = [...viewsArr];
  routesArr.push(stubRoute);
  viewsArr.push(stubView);
});

afterAll(async () => {
  // Restore both registries to their exact committed contents (append-only proof, no leak).
  routesArr.splice(0, routesArr.length, ...originalRoutes);
  viewsArr.splice(0, viewsArr.length, ...originalViews);
  await unregisterHappyDom();
});

// ── Shared server-side helpers (no port binding — the prober idiom) ────────────────────────────────

function health(over: Partial<SourceHealth> = {}): SourceHealth {
  return { ok: true, lastSuccess: NOW, error: null, ...over };
}

/** A ServerRuntime around a fixed context + status (no live loop, no port). */
function fakeRuntime(): ServerRuntime {
  const base = makeWebEstateModelV2();
  const bundle: EstateBundle = {
    model: { ...base, estate: { ...base.estate, name: "skeleton-estate", domains: ["skeleton.example"] } },
    coverage: null,
    findings: null,
    loadedAt: NOW,
  };
  const context: ServerContext = {
    estate: bundle,
    cycle: null,
    history: {} as ServerContext["history"],
    events: {} as ServerContext["events"],
    sources: {} as ServerContext["sources"],
    config: {} as ServerConfig,
    identity: null,
    snapshot: null,
  };
  const st: RuntimeStatus = {
    sources: { metrics: health(), alerts: health(), checks: health() },
    model: { loaded: true, formatVersion: 1, error: null },
    lastSnapshotAt: null,
  };
  return {
    getContext: () => context,
    identityConfig: { mode: "none", headerName: "Remote-User", trustedProxies: [] },
    getStatus: () => st,
    runOnce: async () => {},
    start: async () => {},
    close: () => {},
  };
}

/** A minimal StaticAssets stub — the stub route never touches assets, but dispatch takes one. */
const stubAssets: StaticAssets = {
  get: () => undefined,
  shell: () => "<!doctype html><div id=app></div>",
};

/** A GET request whose only field dispatch reads is `.method`. */
const getReq = { method: "GET" } as unknown as Request;

// ── Shared client-side helpers ─────────────────────────────────────────────────────────────────

/** Mount `component` into a fresh container of THIS file's own (never-closed) window — the direct-mount
 *  idiom grid.test.ts uses, which avoids the App shell's `useEffect` timers (flaky under shared-process
 *  happy-dom) and reads/writes our own window's `document` rather than the shared, cumulatively-clobbered
 *  global. `render` is imported lazily so happy-dom globals are installed first. */
async function mount(component: ComponentType<ViewProps>): Promise<HTMLElement> {
  const { createElement: hh } = await import("react");
  const { render } = await import("./react-render.js");
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const router = createPathRouter({
    routes: routesFromViews(viewsArr),
    fallback: "/overview",
    win: win as unknown as Window,
  });
  const store = createAppStore({ storage: null, initialQuery: {} });
  store.snapshot.value = overviewSnapshot();
  render(hh(component, { store, router }), container as unknown as Element);
  return container as unknown as HTMLElement;
}

// ── (1) Server seam: the stub route is reachable via the UNMODIFIED router/dispatch ───────────────

describe("skeleton: server route seam (REQ-EXT-01, §8 objective 1)", () => {
  test("a stub RouteDefinition appended to ROUTES is dispatched to its handler", async () => {
    stubSeen = { called: false, seenEstate: null };
    const res = await dispatch(getReq, "/api/__stub", fakeRuntime(), stubAssets);
    // The UNMODIFIED router dispatched to the stub's handler and its response propagated.
    expect(res.status).toBe(200);
    expect(stubSeen.called).toBe(true);
    // The ServerContext seam is threaded end to end: the handler saw the loaded estate (00 §4).
    expect(stubSeen.seenEstate).toBe("skeleton-estate");
  });

  test("registration is append-only: the existing v1 routes are undisturbed (no edit to existing entries)", () => {
    // The stub was ADDED, not substituted — every original route path is still present, unchanged.
    for (const path of ["/api/overview", "/healthz", "/metrics"]) {
      expect(routesArr.some((r) => r.path === path)).toBe(true);
    }
    expect(routesArr.some((r) => r.path === "/api/__stub")).toBe(true);
  });

  test("the seam accepts the stub through its public type only: method is the literal GET (REQ-SEC-02)", () => {
    // Compile-time guaranteed by `RouteDefinition.method: "GET"`; asserted here as a sanity check.
    expect(stubRoute.method).toBe("GET");
    for (const r of routesArr) expect(r.method).toBe("GET");
  });
});

// ── (2) Client seam: the stub view is reachable via the UNMODIFIED hash router + shell ────────────

describe("skeleton: client view seam (REQ-EXT-01, §8 objective 2)", () => {
  test("a stub ViewDefinition appended to VIEWS is a known route + resolves + mounts via the shell path", async () => {
    // Registration: the stub is in the REAL VIEWS array (the single appended entry, no other edit).
    expect(viewsArr.some((v) => v.id === "__stub")).toBe(true);

    // The UNMODIFIED hash router is built over the registered ids — the stub is a KNOWN route (a hash
    // `#/__stub` parses to it, not the fallback). `navigate` recognises it (no fallback rewrite).
    const viewIds = viewsArr.map((v) => v.id);
    expect(viewIds).toContain("__stub");

    // The shell resolves the active view EXACTLY as app.tsx does: `views.find((v) => v.id === id)`.
    const active = viewsArr.find((v) => v.id === "__stub");
    expect(active).toBeDefined();

    // ...and that resolved component mounts with zero edits to router.ts / main.tsx / the overview view.
    const StubComponent = await active!.load();
    const container = await mount(StubComponent);
    const mounted = container.querySelector(".stub-view");
    expect(mounted).not.toBeNull();
    expect(mounted!.getAttribute("data-stub")).toBe("mounted");
    expect(mounted!.textContent).toBe("STUB VIEW MOUNTED");
  });

  test("registration is append-only: the existing overview view is still resolvable + mounts", async () => {
    // The stub did not displace the existing view — it still resolves by id and renders its own module.
    const overview = viewsArr.find((v) => v.id === "overview");
    expect(overview).toBeDefined();
    const OverviewComponent = await overview!.load();
    const container = await mount(OverviewComponent);
    expect(container.querySelector("[data-slot=overview-page]")).not.toBeNull();
    expect(container.querySelector(".stub-view")).toBeNull();
  });
});

// ── (3) Mutation mirror (REQ-SEAM-07, REQ-COMPAT-02/03) ───────────────────────────────────────────

// The stub path is `/api/mutations/stub` (not `__stub`): 03 §2.2's MUTATION_PATH_RE admits only
// lowercase `[a-z0-9]` words joined by `-` or `/`, so an underscore path is (correctly) rejected.
const stubBody = z.object({ note: z.string().max(16) }).strict();
type StubBody = z.infer<typeof stubBody>;
type StubResult = { readonly ok: true };
/** Side channel, not res.json(): see the happy-dom note on stubSeen above. */
let mutationSeen: { called: boolean; actor: string | null } = { called: false, actor: null };

const stubMutation: MutationDefinition<StubBody, StubResult> = {
  method: "POST",
  path: "/api/mutations/stub",
  capability: "ack",
  action: "ack.set",
  body: stubBody,
  auditTarget: (b) => `stub:${b.note}`,
  auditDetails: () => ({}),
  handler: async (_body, _ctx, actor) => {
    mutationSeen = { called: true, actor: actor.subject };
    return { outcome: "succeeded", status: 200, result: { ok: true } };
  },
};

/** Compile-time proof: a non-POST definition is rejected by the type (REQ-SEAM-07). */
function putDefinition(): MutationDefinition<StubBody, StubResult> {
  return {
    ...stubMutation,
    // @ts-expect-error — MutationDefinition.method is the literal "POST"
    method: "PUT",
  };
}
/** Compile-time proof: RouteDefinition was not widened (REQ-COMPAT-02). */
function postRoute(): RouteDefinition {
  return {
    ...stubRoute,
    // @ts-expect-error — RouteDefinition.method is the literal "GET"
    method: "POST",
  };
}
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const routeIsGetOnly: Equals<RouteDefinition["method"], "GET"> = true;
const mutationIsPostOnly: Equals<MutationDefinition<unknown, unknown>["method"], "POST"> = true;

const trusted: RequestServices = { peerIp: "10.0.0.7", disableTimeout() {} };
function proxyRuntime(): ServerRuntime {
  return { ...fakeRuntime(), identityConfig: { mode: "proxy-header", headerName: "Remote-User", trustedProxies: ["10.0.0.0/24"] } };
}
function mutationReq(path: string, verb = "POST"): Request {
  return new Request(`http://web:8080${path}`, {
    method: verb,
    headers: { "Remote-User": "alice", "content-type": "application/json" },
    body: JSON.stringify({ note: "x" }),
  });
}
/** Mirrors 03 §7 steps 1 and 3 only; see 02-m1-compatibility.md §7.2. */
function mirrorDispatcher(registry: MutationRegistry, runtime: ServerRuntime): MutationDispatcher {
  return async ({ request, pathname, peerIp }) => {
    const def = registry.match(pathname);
    if (def === undefined || request.method !== def.method) return null; // → router's unchanged M1 405
    const actor = resolveIdentity(request, peerIp, runtime.identityConfig);
    if (actor === null) return new Response(null, { status: 403 });
    const outcome = await def.handler(def.body.parse(await request.json()), runtime.getContext(actor), actor, {
      requestId: "mirror",
      now: new Date(),
    });
    return new Response(null, { status: outcome.status });
  };
}

describe("skeleton: mutation seam mirror (REQ-SEAM-07)", () => {
  test("1. auth mode none: createMutationRegistry throws auth-mode — nothing can register", () => {
    let thrown: unknown;
    try { createMutationRegistry("none"); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(MutationRegistrationError);
    expect((thrown as MutationRegistrationError).rule).toBe("auth-mode");
    expect((thrown as MutationRegistrationError).code).toBe("MUTATION_REGISTRATION");
  });

  test("2. auth mode none: the stub path is the M1 405 through the default dispatcher", async () => {
    mutationSeen = { called: false, actor: null };
    const res = await dispatch(mutationReq("/api/mutations/stub"), "/api/mutations/stub", fakeRuntime(), stubAssets, trusted);
    expect(res.status).toBe(405);
    expect(mutationSeen.called).toBe(false);
  });

  test("3. proxy-header: a registered stub is dispatched to its handler with the trusted actor", async () => {
    const runtime = proxyRuntime();
    const registry = createMutationRegistry("proxy-header");
    registry.register(stubMutation);
    mutationSeen = { called: false, actor: null };
    const res = await dispatch(mutationReq("/api/mutations/stub"), "/api/mutations/stub", runtime, stubAssets, trusted, mirrorDispatcher(registry, runtime));
    expect(res.status).toBe(200);
    expect(mutationSeen).toEqual({ called: true, actor: "alice" });
  });

  test("4. proxy-header: unmatched or non-POST requests keep the M1 405 (REQ-COMPAT-03)", async () => {
    const runtime = proxyRuntime();
    const registry = createMutationRegistry("proxy-header");
    registry.register(stubMutation);
    const seam = mirrorDispatcher(registry, runtime);
    mutationSeen = { called: false, actor: null };
    for (const [path, verb] of [["/api/overview", "POST"], ["/api/mutations/unknown", "POST"], ["/api/mutations/stub", "PUT"], ["/api/mutations/stub", "DELETE"]] as const) {
      const res = await dispatch(mutationReq(path, verb), path, runtime, stubAssets, trusted, seam);
      expect(res.status).toBe(405);
    }
    expect(mutationSeen.called).toBe(false);
  });

  test("5. registration is append-only: duplicate throws, no remove API, frozen ordered snapshot", () => {
    const registry = createMutationRegistry("proxy-header");
    registry.register(stubMutation);
    registry.register({ ...stubMutation, path: "/api/mutations/stub2" });
    let thrown: unknown;
    try { registry.register(stubMutation); } catch (err) { thrown = err; }
    expect((thrown as MutationRegistrationError).rule).toBe("duplicate-path");
    expect((thrown as MutationRegistrationError).path).toBe("/api/mutations/stub");
    for (const member of ["remove", "unregister", "delete", "clear"]) expect(member in registry).toBe(false);
    const snapshot = registry.list();
    expect(snapshot.map((d) => d.path)).toEqual(["/api/mutations/stub", "/api/mutations/stub2"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(registry.match("/api/mutations/stub")).toBe(snapshot[0]);
  });

  test("6. a mutation's method is POST only; the path must sit under /api/mutations/", () => {
    const registry = createMutationRegistry("proxy-header");
    let thrown: unknown;
    try { registry.register(putDefinition()); } catch (err) { thrown = err; }
    expect((thrown as MutationRegistrationError).rule).toBe("method");
    thrown = undefined;
    try { registry.register({ ...stubMutation, path: "/api/__stub" as `/api/mutations/${string}` }); } catch (err) { thrown = err; }
    expect((thrown as MutationRegistrationError).rule).toBe("path-prefix");
    expect(registry.list()).toEqual([]); // failed registrations leave no trace
  });

  test("7. the GET route type is unwidened (REQ-COMPAT-02)", () => {
    expect(routeIsGetOnly).toBe(true);
    expect(postRoute().method as string).toBe("POST"); // runtime value is irrelevant; the proof is the ts-expect-error
    for (const r of routesArr) expect(r.method).toBe("GET");
  });

  test("8. the mutation type is POST-only (REQ-SEAM-07)", () => {
    expect(mutationIsPostOnly).toBe(true);
  });
});
