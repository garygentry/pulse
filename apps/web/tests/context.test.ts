// apps/web/tests/context.test.ts — ServerContext v2 capture + dispatch seams
// (05-http-routes-and-representations.md §§3–5, §7; item 034 evidence for AC-3/4/5). Covers the two
// seams no route-handler suite touches:
//   • getContext(identity) — one captured cycle + one per-request identity, shallow-frozen, with no
//     runtime-global identity mutation (§3 / §11 "Context captures one cycle and one per-request
//     identity; no global identity mutation exists").
//   • dispatch ordering — a non-GET calls the named no-op `dispatchMutation` then returns the shared
//     JSON 405 with zero body/upstream/audit work (§5, AC-3); unknown `/api/*` is JSON 404 while
//     non-API GET, assets, /healthz, /metrics, and the error shell retain existing behavior (AC-4).
// No port is bound — dispatch is called directly (the prober idiom).

import { join } from "node:path";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import type { Identity } from "@pulse/web-data/identity";

import { dispatch, dispatchMutation, type MutationDispatcher } from "../src/server/router.js";
import {
  createServerRuntime,
  setRuntimeStatus,
  type RuntimeStatus,
  type ServerRuntime,
} from "../src/server/refresh.js";
import { loadServerConfig } from "../src/server/config.js";
import type { ServerConfig } from "../src/server/config.js";
import type { ServerContext } from "../src/shared/registry.js";
import type { SourceHealth } from "../src/shared/snapshot.js";
import type { StaticAssets } from "../src/server/assets.js";
import { EstateBundleError } from "../src/shared/errors.js";

// ── Shared helpers ───────────────────────────────────────────────────────────────────────────────

const ALT_ESTATE = join(import.meta.dir, "fixtures", "alt-estate", "web-estate-model.json");

/** A full, required env map (the four engine URLs + a model path). */
function fullEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PULSE_VM_URL: "http://victoriametrics:8428",
    PULSE_ALERTMANAGER_URL: "http://alertmanager:9093",
    PULSE_GATUS_URL: "http://gatus:8080",
    PULSE_VMALERT_URL: "http://vmalert:8880",
    PULSE_WEB_ESTATE_MODEL: ALT_ESTATE,
    ...over,
  };
}

function health(over: Partial<SourceHealth> = {}): SourceHealth {
  return { ok: true, lastSuccess: "2026-08-22T12:00:00.000Z", error: null, ...over };
}

function status(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    sources: { metrics: health(), alerts: health(), checks: health() },
    model: { loaded: true, formatVersion: 1, error: null },
    lastSnapshotAt: Date.parse("2026-08-22T12:00:00.000Z"),
    ...over,
  };
}

const stubAssets: StaticAssets = {
  get: (p) => (p === "/assets/app.js" ? { body: new ArrayBuffer(3), contentType: "text/javascript" } : undefined),
  shell: () => "<!doctype html><div id=app></div>",
};

/** A minimal ServerRuntime around a fixed context + status (no live loop). */
function fakeRuntime(ctx: Partial<ServerContext>, st: RuntimeStatus): ServerRuntime {
  const context: ServerContext = {
    estate: null,
    cycle: null,
    history: {} as ServerContext["history"],
    events: {} as ServerContext["events"],
    sources: {} as ServerContext["sources"],
    // A minimal config carrying the identity block the session route reads (`config.identity.mode`).
    config: { identity: { mode: "none", headerName: "Remote-User", trustedProxies: [] } } as unknown as ServerConfig,
    identity: null,
    snapshot: null,
    ...ctx,
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

function get(path: string): Request {
  return new Request(`http://web:8080${path}`, { method: "GET" });
}
function method(path: string, verb: string, init: RequestInit = {}): Request {
  return new Request(`http://web:8080${path}`, { method: verb, ...init });
}

const IDENTITY_A: Identity = { subject: "alice", displayName: "Alice", source: "proxy-header" };
const IDENTITY_B: Identity = { subject: "bob", displayName: "Bob", source: "proxy-header" };

// ── getContext — per-request identity + captured cycle (§3, AC-5) ───────────────────────────────

describe("getContext — per-request identity + captured cycle (§3)", () => {
  test("returns a shallow-frozen context carrying exactly the passed identity", () => {
    const runtime = createServerRuntime(loadServerConfig(fullEnv()));
    const ctx = runtime.getContext(IDENTITY_A);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(ctx.identity).toBe(IDENTITY_A);
    expect(ctx.cycle).toBeNull(); // captured cycle is null before readiness (populated by item 039)
  });

  test("identity is per-request and never persists into runtime-global state", () => {
    const runtime = createServerRuntime(loadServerConfig(fullEnv()));
    // Resolve one request's identity, then a second with a DIFFERENT identity, then a third with none.
    const a = runtime.getContext(IDENTITY_A);
    const b = runtime.getContext(IDENTITY_B);
    const anon = runtime.getContext(null);
    // Each context keeps its own identity; the earlier request is unaffected by the later one, and no
    // identity leaks into a subsequent anonymous request (no global mutation).
    expect(a.identity).toBe(IDENTITY_A);
    expect(b.identity).toBe(IDENTITY_B);
    expect(anon.identity).toBeNull();
  });

  test("each request gets a fresh object but shares the process-wide singletons", () => {
    const runtime = createServerRuntime(loadServerConfig(fullEnv()));
    const c1 = runtime.getContext(null);
    const c2 = runtime.getContext(null);
    expect(c1).not.toBe(c2); // a distinct per-request projection each call
    // history / sources / config are constructed once and shared by reference (a shallow projection,
    // not a deep copy) — the route reads engine access from here, never re-constructing a URL (§3).
    expect(c1.history).toBe(c2.history);
    expect(c1.sources).toBe(c2.sources);
    expect(c1.config).toBe(c2.config);
  });
});

// ── Non-GET → named no-op mutation seam → JSON 405 (§5, AC-3) ────────────────────────────────────

describe("mutation seam + non-GET → 405 (§5)", () => {
  test("the default dispatchMutation is a no-op that returns null", async () => {
    await expect(dispatchMutation({ request: method("/api/overview", "POST"), pathname: "/api/overview", peerIp: null })).resolves.toBeNull();
  });

  test("a non-GET calls the mutation seam once then returns the shared JSON 405 with zero body/upstream work", async () => {
    // A runtime whose getContext THROWS proves the non-GET path never touches the context/sources
    // (the mutation branch precedes getContext) — zero upstream/audit work on a mutating verb.
    const exploding: ServerRuntime = {
      getContext: () => {
        throw new Error("getContext must not run for a non-GET request");
      },
      identityConfig: { mode: "none", headerName: "Remote-User", trustedProxies: [] },
      getStatus: () => status(),
      runOnce: async () => {},
      start: async () => {},
      close: () => {},
    };
    const seen: Array<{ pathname: string; peerIp: string | null; verb: string }> = [];
    const spyDispatcher: MutationDispatcher = async (c) => {
      seen.push({ pathname: c.pathname, peerIp: c.peerIp, verb: c.request.method });
      return null; // the M1 no-op default: fall through to 405
    };

    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
      const req = method("/api/overview", verb, { body: "should-not-be-read" });
      const res = await dispatch(req, "/api/overview", exploding, stubAssets, { peerIp: "10.0.0.9", disableTimeout() {} }, spyDispatcher);
      expect(res.status).toBe(405);
      expect(((await res.json()) as { code: string }).code).toBe("METHOD_NOT_ALLOWED");
      expect(req.bodyUsed).toBe(false); // the seam reads NO request body
    }
    // The seam was invoked once per non-GET request, with the safe bounded context (verb/pathname/peer).
    expect(seen).toHaveLength(4);
    expect(seen.every((s) => s.pathname === "/api/overview" && s.peerIp === "10.0.0.9")).toBe(true);
    expect(seen.map((s) => s.verb)).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
  });

  test("an injected dispatcher that returns a Response short-circuits before the 405 (future M2 seam)", async () => {
    const runtime = fakeRuntime({}, status());
    const dispatcher: MutationDispatcher = async () => new Response(null, { status: 202 });
    const res = await dispatch(method("/api/alerts", "POST"), "/api/alerts", runtime, stubAssets, undefined, dispatcher);
    expect(res.status).toBe(202);
  });

  test("router.ts imports no Alertmanager write / audit API (the M1 seam stays dark)", () => {
    // Static import proof (§5 / AC-3): the dispatch module cannot perform an M1 write because its
    // IMPORT statements pull in none of the write/audit surface. The full reachability meta-guard is
    // item 041. Scan only import lines so a prose mention of "write/audit" in a comment is not a match.
    const src = readFileSync(join(import.meta.dir, "..", "src", "server", "router.ts"), "utf8");
    const importLines = src.split("\n").filter((line) => line.trimStart().startsWith("import"));
    const importText = importLines.join("\n");
    for (const forbidden of ["createSilence", "expireSilence", "AlertmanagerWriteClient", "createAlertmanagerWriteClient", "audit"]) {
      expect(importText).not.toContain(forbidden);
    }
    // The dark-write symbols never appear anywhere in the module (not even in a comment).
    for (const forbidden of ["createSilence", "expireSilence", "AlertmanagerWriteClient"]) {
      expect(src).not.toContain(forbidden);
    }
  });
});

// ── Unknown /api/* → JSON 404; other surfaces retain behavior (§5–§7, AC-4) ─────────────────────

describe("unknown /api/* → JSON 404; other surfaces unchanged (§5–§7)", () => {
  test("an unknown /api/* GET is the shared JSON 404 API_NOT_FOUND (never an SPA shell)", async () => {
    const runtime = fakeRuntime({}, status());
    const res = await dispatch(get("/api/does-not-exist"), "/api/does-not-exist", runtime, stubAssets);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { code: string }).code).toBe("API_NOT_FOUND");
  });

  test("a nested unknown /api/* path is 404 JSON, not the shell", async () => {
    const runtime = fakeRuntime({}, status());
    const res = await dispatch(get("/api/history/unknown/path"), "/api/history/unknown/path", runtime, stubAssets);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("API_NOT_FOUND");
  });

  test("a non-API GET still receives the SPA shell", async () => {
    const runtime = fakeRuntime({}, status());
    const res = await dispatch(get("/deep/link"), "/deep/link", runtime, stubAssets);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("id=app");
  });

  test("assets are served with immutable caching", async () => {
    const runtime = fakeRuntime({}, status());
    const res = await dispatch(get("/assets/app.js"), "/assets/app.js", runtime, stubAssets);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });
});

// ── Bundle-error mode: operational + session live; estate APIs 503; shell HTML (§7, AC-4) ────────

describe("bundle-error mode retains operational/session/asset behavior (§7)", () => {
  const err = new EstateBundleError("missing", "model", "/rendered/web-estate-model.json", "not found — run pulse render");
  const bundleErrorRuntime = () =>
    fakeRuntime({ estate: null, snapshot: null }, status({ model: { loaded: false, formatVersion: null, error: err } }));

  test("/healthz and /metrics stay live (operational passthrough)", async () => {
    setRuntimeStatus(status({ model: { loaded: false, formatVersion: null, error: err } }));
    const runtime = bundleErrorRuntime();
    const healthz = await dispatch(get("/healthz"), "/healthz", runtime, stubAssets);
    expect(healthz.status).toBe(200);
    expect(((await healthz.json()) as { status: string }).status).toBe("degraded"); // model not loaded

    const metrics = await dispatch(get("/metrics"), "/metrics", runtime, stubAssets);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("version=0.0.4");
  });

  test("a cycle-backed API returns the safe bundle 503 (no stale cycle)", async () => {
    const res = await dispatch(get("/api/estate"), "/api/estate", bundleErrorRuntime(), stubAssets);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; kind: string; path: string };
    expect(body.code).toBe("ESTATE_BUNDLE_MISSING");
    expect(body.kind).toBe("missing");
    expect(body.path).toBe("/rendered/web-estate-model.json");
  });

  test("/api/session still responds without a cycle in bundle-error mode", async () => {
    const res = await dispatch(get("/api/session"), "/api/session", bundleErrorRuntime(), stubAssets);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as { authMode: string; capabilities: Record<string, boolean> };
    expect(body.capabilities).toEqual({ silence: false, ack: false, proposeEstateEdit: false });
  });

  test("a non-API GET renders the error-page HTML and assets still load", async () => {
    const runtime = bundleErrorRuntime();
    const page = await dispatch(get("/"), "/", runtime, stubAssets);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("/rendered/web-estate-model.json");

    const asset = await dispatch(get("/assets/app.js"), "/assets/app.js", runtime, stubAssets);
    expect(asset.status).toBe(200);
  });
});
