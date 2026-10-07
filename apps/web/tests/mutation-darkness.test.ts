// apps/web/tests/mutation-darkness.test.ts — the seven M1 darkness meta-guards (09 §§10–11).
//
// A static-analysis meta-guard: it walks the server import graph from disk and dispatches synthetic
// requests. It touches no DOM (no `document`/`window` access, no `react` import), so it needs no
// happy-dom registration and does not opt out of the DOM guard.
//
// Proves the enumerated protection set of 09 §11: the M1 web tier has NO reachable production write
// path. The guard judges exactly the listed import/registry/runtime surfaces (not an unbounded
// "impossible to evade" objective; §11 non-goals): it deliberately does NOT prohibit test imports,
// the package's public `@pulse/web-data/audit` / AM-write exports, or M2 code on another branch.
//
//   1. production files reachable from `apps/web/src/server/index.ts` import no `@pulse/web-data/audit`;
//   2. …and select/import no `createSilence` / `expireSilence` (AM write) API;
//   3. `ROUTES` contains only literal-GET definitions;
//   4. the production `dispatchMutation` returns null and reads no request body;
//   5. no audit path / env var / default writer construction exists in app production code;
//   6. session capabilities are all literal false; (M2: derived, all false in none mode — see below)
//   7. HTTP POST/PUT/PATCH/DELETE observe no upstream or audit call.
//
// M2 re-scope (mutation-foundation 02-m1-compatibility.md §3, REQ-COMPAT-01/03, REQ-SEAM-02): the list
// above is the M1 intent; M2 keeps it for auth mode `none` and narrows "nowhere" to "nowhere outside the
// write zone". Legitimate write code lives only in `server/mutations/**` (audit import, AM write API,
// writer reference; audit env/path tokens also in `server/config.ts`); write objects are constructed only
// in `server/mutations/bootstrap.ts`; `buildWriteRuntime` is called only inside `index.ts`'s
// `if (config.identity.mode === "proxy-header") {…}` branch. Guard 6 now proves capabilities are DERIVED
// (all false in none mode even with a healthy write path); guard 7-b proves every mutation path is the
// M1 405 through the default dispatcher.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { dispatch, dispatchMutation, type MutationDispatcher } from "../src/server/router.js";
import { ROUTES } from "../src/server/routes/registry.js";
import type { ServerRuntime, RuntimeStatus } from "../src/server/refresh.js";
import type { ServerContext } from "../src/shared/registry.js";
import type { ServerConfig } from "../src/server/config.js";
import type { SourceHealth } from "../src/shared/snapshot.js";
import type { StaticAssets } from "../src/server/assets.js";
import type { Identity } from "@pulse/web-data/identity";
import { computeCapabilities } from "../src/server/mutations/capabilities.js";
import { resetWritePathProvider, setWritePathProvider } from "../src/server/mutations/session-provider.js";
import type { WritePathSnapshot } from "../src/server/mutations/write-path.js";

const APP = resolve(import.meta.dir, "..");
const SRC = resolve(APP, "src");
const SERVER_ENTRY = resolve(SRC, "server/index.ts");

// ── Static import-graph walker (mirrors prod-isolation.test.ts; §6.2) ────────────────────────────
// `Bun.Transpiler.scanImports` drops `import type` before we see it, so type-only edges are invisible
// and legal. A self-contained copy keeps this guard independent of the isolation suite.

/** Resolve a RELATIVE `.js` specifier to the real `.ts`/`.tsx` on disk, or null for bare/CSS/unknown. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  if (specifier.endsWith(".css")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface FileImports {
  readonly file: string;
  readonly specifiers: readonly string[];
}

/** Every production file reachable from `entry` by a value import, with each file's import specifiers. */
function reachableProduction(entry: string): { files: FileImports[]; unresolved: string[] } {
  const seen = new Map<string, readonly string[]>();
  const unresolved: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    const loader = file.endsWith(".tsx") ? "tsx" : "ts";
    const scanner = new Bun.Transpiler({ loader });
    const source = readFileSync(file, "utf8");
    const specifiers = scanner.scanImports(source).map((i) => i.path);
    seen.set(file, specifiers);
    for (const spec of specifiers) {
      if (!spec.startsWith(".")) continue;
      const next = resolveRelative(file, spec);
      if (next === null) {
        if (!spec.endsWith(".css")) unresolved.push(`${file} → ${spec}`);
      } else {
        queue.push(next);
      }
    }
  }
  return { files: [...seen].map(([file, specifiers]) => ({ file, specifiers })), unresolved };
}

/** Remove block and line comments so an identifier scan judges code, not prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const rel = (f: string): string => f.slice(APP.length + 1);

const GRAPH = reachableProduction(SERVER_ENTRY);

// ── Write-zone allowlist (02-m1-compatibility.md §3.1) ──
const WRITE_ZONE = `${resolve(SRC, "server/mutations")}/`;
const CONFIG_FILE = resolve(SRC, "server/config.ts");
const CONSTRUCTION_SITE = resolve(SRC, "server/mutations/bootstrap.ts");
const PROXY_BRANCH = 'if (config.identity.mode === "proxy-header") {';
const CONSTRUCTORS = [
  "createMutationRegistry", "createMutationDispatcher", "createJsonlAuditWriter", "createAlertmanagerWriteClient",
  "createWritePath", "createAckStore", "createProposalStore", "createIdempotencyStore",
] as const;
const inWriteZone = (file: string): boolean => file.startsWith(WRITE_ZONE);
/** A call site (not the declaration `function name(`). Fresh RegExp per use: no lastIndex state. */
const callSite = (name: string): RegExp => new RegExp(String.raw`(?<!function\s+)\b${name}\s*\(`, "g");
/** [start, end] offsets of the brace block opened at the end of `header`, or null when absent. */
function blockAfter(code: string, header: string): { start: number; end: number } | null {
  const at = code.indexOf(header);
  if (at < 0) return null;
  const open = at + header.length - 1;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}" && --depth === 0) return { start: open, end: i };
  }
  return null;
}
const OK = { ok: true, reason: null } as const;
const HEALTHY: WritePathSnapshot = { audit: OK, acks: OK, proposals: OK, secret: OK, alertmanager: OK };
const ALL_FALSE = { silence: false, ack: false, proposeEstateEdit: false };

// ── Runtime/dispatch harness (self-contained; no port bind) ──────────────────────────────────────

function health(over: Partial<SourceHealth> = {}): SourceHealth {
  return { ok: true, lastSuccess: "2026-09-17T09:00:00.000Z", error: null, ...over };
}
function status(): RuntimeStatus {
  return {
    sources: { metrics: health(), alerts: health(), checks: health() },
    model: { loaded: true, formatVersion: 1, error: null },
    lastSnapshotAt: Date.parse("2026-09-17T09:00:00.000Z"),
  };
}
const stubAssets: StaticAssets = {
  get: () => undefined,
  shell: () => "<!doctype html><div id=app></div>",
};
function sessionRuntime(): ServerRuntime {
  const context: ServerContext = {
    estate: null,
    cycle: null,
    history: {} as ServerContext["history"],
    events: {} as ServerContext["events"],
    sources: {} as ServerContext["sources"],
    config: { identity: { mode: "none", headerName: "Remote-User", trustedProxies: [] } } as unknown as ServerConfig,
    identity: null,
    snapshot: null,
  };
  return {
    getContext: () => context,
    identityConfig: { mode: "none", headerName: "Remote-User", trustedProxies: [] },
    getStatus: () => status(),
    runOnce: async () => {},
    start: async () => {},
    close: () => {},
  };
}
function req(path: string, verb: string, init: RequestInit = {}): Request {
  return new Request(`http://web:8080${path}`, { method: verb, ...init });
}

// ── Guard 1 & 2 & 5 — the reachable production graph is write/audit-free ──────────────────────────

describe("guard 1/2/5 — no reachable production write or audit surface", () => {
  test("the graph walk is non-vacuous and fully resolved", () => {
    expect(GRAPH.unresolved).toEqual([]);
    const files = GRAPH.files.map((f) => f.file);
    // Positive control: the real server graph must include the router + refresh + registry.
    expect(files.some((f) => f.endsWith("/server/router.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("/server/refresh.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("/server/routes/registry.ts"))).toBe(true);
    expect(GRAPH.files.length).toBeGreaterThan(10);
  });

  test("guard 1 — no production file outside server/mutations/** imports @pulse/web-data/audit", () => {
    const offenders = GRAPH.files
      .filter((f) => !inWriteZone(f.file))
      .filter((f) => f.specifiers.some((s) => s === "@pulse/web-data/audit" || s.startsWith("@pulse/web-data/audit")))
      .map((f) => rel(f.file));
    expect(offenders, `audit importers: ${offenders.join(", ")}`).toEqual([]);
  });

  test("guard 2 — no production file outside server/mutations/** selects createSilence / expireSilence (AM write)", () => {
    const banned = ["createSilence", "expireSilence", "AlertmanagerWriteClient", "createAlertmanagerWriteClient"];
    const offenders: string[] = [];
    for (const { file } of GRAPH.files) {
      if (inWriteZone(file)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      for (const symbol of banned) {
        if (code.includes(symbol)) offenders.push(`${rel(file)} :: ${symbol}`);
      }
    }
    expect(offenders, `write-API references: ${offenders.join(", ")}`).toEqual([]);
  });

  test("guard 5 — no production file outside the write zone constructs an audit writer or reads an audit path/env var", () => {
    const offenders: string[] = [];
    for (const { file } of GRAPH.files) {
      const code = stripComments(readFileSync(file, "utf8"));
      if (!inWriteZone(file) && code.includes("createJsonlAuditWriter")) {
        offenders.push(`${rel(file)} :: createJsonlAuditWriter`);
      }
      // Audit env/path tokens are legitimate in the write zone and in config.ts (REQ-CFG-01 parse).
      if (inWriteZone(file) || file === CONFIG_FILE) continue;
      // No audit path / env var construction (PULSE_*AUDIT*, *AUDIT_PATH*, "audit.jsonl").
      if (/PULSE_[A-Z0-9_]*AUDIT/.test(code)) offenders.push(`${rel(file)} :: audit env var`);
      if (/AUDIT[A-Z0-9_]*(PATH|FILE|DIR)/.test(code)) offenders.push(`${rel(file)} :: audit path token`);
      if (code.includes("audit.jsonl")) offenders.push(`${rel(file)} :: audit.jsonl literal`);
    }
    expect(offenders, `audit construction: ${offenders.join(", ")}`).toEqual([]);
  });

  test("the walker's identifier scan is non-vacuous (catches a synthetic reference)", () => {
    expect(stripComments("const x = createSilence();").includes("createSilence")).toBe(true);
    // …but ignores the same word inside a comment.
    expect(stripComments("// call createSilence here").includes("createSilence")).toBe(false);
    expect(stripComments("/* createSilence */ const y = 1;").includes("createSilence")).toBe(false);
  });

  test("guard 1/2/5-a — write objects are constructed only in server/mutations/bootstrap.ts (REQ-SEAM-02)", () => {
    const offenders: string[] = [];
    for (const { file } of GRAPH.files) {
      if (file === CONSTRUCTION_SITE) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      for (const name of CONSTRUCTORS) if (callSite(name).test(code)) offenders.push(`${rel(file)} :: ${name}(`);
    }
    expect(offenders, `write construction outside bootstrap: ${offenders.join(", ")}`).toEqual([]);
  });

  test("guard 1/2/5-b — buildWriteRuntime runs only in index.ts's proxy-header branch (REQ-SEAM-02, REQ-SEAM-05)", () => {
    const elsewhere = GRAPH.files
      .filter((f) => f.file !== SERVER_ENTRY && callSite("buildWriteRuntime").test(stripComments(readFileSync(f.file, "utf8"))))
      .map((f) => rel(f.file));
    expect(elsewhere).toEqual([]);
    const code = stripComments(readFileSync(SERVER_ENTRY, "utf8"));
    const calls = [...code.matchAll(callSite("buildWriteRuntime"))].map((m) => m.index ?? -1);
    expect(calls.length).toBe(1); // 04 §8: exactly one call, inside the proxy-header branch
    const branch = blockAfter(code, PROXY_BRANCH);
    for (const at of calls) {
      expect(branch, "buildWriteRuntime present but the proxy-header branch is missing").not.toBeNull();
      expect(at > branch!.start && at < branch!.end).toBe(true);
    }
    expect(code).toContain("createFetchHandler(runtime)"); // none arm: M1 default dispatcher → 405
    // Proxy-header arm (V-001): no test boots it through main(), so pin the wiring statically. Dropping
    // the dispatcher would 405 every mutation; dropping runtimeDeps/attachRuntime disables ack reconcile.
    expect(code).toContain("createFetchHandler(runtime, undefined, write.dispatcher)");
    expect(code).toContain("write?.runtimeDeps");
    expect(code).toContain("write?.attachRuntime(runtime)");
  });
});

// ── Guard 3 — ROUTES are all literal GET ─────────────────────────────────────────────────────────

describe("guard 3 — the registry is GET-only", () => {
  test("every registered route has method === GET", () => {
    expect(ROUTES.length).toBeGreaterThan(0);
    const nonGet = ROUTES.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
    expect(nonGet, `non-GET routes: ${nonGet.join(", ")}`).toEqual([]);
  });

  test("the registry source declares only method: \"GET\"", () => {
    const src = readFileSync(resolve(SRC, "server/routes/registry.ts"), "utf8");
    // The registry only lists route modules; each route module declares method: "GET". Assert no
    // method literal other than GET appears in any reachable route module.
    const routeModules = GRAPH.files.filter((f) => f.file.includes("/server/routes/"));
    const offenders: string[] = [];
    for (const { file } of routeModules) {
      const code = stripComments(readFileSync(file, "utf8"));
      const methods = [...code.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
      for (const m of methods) if (m !== "GET") offenders.push(`${rel(file)} :: ${m}`);
    }
    expect(offenders, `non-GET method literals: ${offenders.join(", ")}`).toEqual([]);
    expect(src).toContain("assertRegistry"); // startup whole-set validation is wired
  });
});

// ── Guard 4 — the production dispatchMutation is a bodyless no-op ─────────────────────────────────

describe("guard 4 — production dispatchMutation is a bodyless no-op", () => {
  test("returns null for every non-GET verb and reads no request body", async () => {
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
      const request = req("/api/overview", verb, { body: "must-not-be-read" });
      const result = await dispatchMutation({ request, pathname: "/api/overview", peerIp: "10.0.0.7" });
      expect(result).toBeNull();
      expect(request.bodyUsed).toBe(false);
    }
  });
});

// ── Guard 6 — session capabilities are false with auth mode none ─────────────────────────────────

describe("guard 6 — session capabilities are false with auth mode none (REQ-COMPAT-01, REQ-AUTHZ-02)", () => {
  afterEach(() => resetWritePathProvider()); // no provider may leak into sibling files (same bun process)

  test("GET /api/session returns all-false capabilities", async () => {
    const res = await dispatch(req("/api/session", "GET"), "/api/session", sessionRuntime(), stubAssets);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as { capabilities: Record<string, boolean> };
    expect(body.capabilities).toEqual({ silence: false, ack: false, proposeEstateEdit: false });
  });

  test("the session source derives capabilities and never hard-codes true", () => {
    const code = stripComments(readFileSync(resolve(SRC, "server/routes/session.ts"), "utf8"));
    expect(code).toContain("currentCapabilities(");
    expect(code).not.toMatch(/(silence|ack|proposeEstateEdit):\s*true/);
  });

  test("guard 6-b — none mode stays all-false even with a fully healthy write path installed (REQ-CFG-03)", async () => {
    setWritePathProvider(() => HEALTHY);
    const request = req("/api/session", "GET", { headers: { "Remote-User": "alice" } });
    const res = await dispatch(request, "/api/session", sessionRuntime(), stubAssets, { peerIp: "10.0.0.7", disableTimeout() {} });
    expect(((await res.json()) as { capabilities: Record<string, boolean> }).capabilities).toEqual(ALL_FALSE);
  });

  test("guard 6-c — computeCapabilities denies every capability by mode when auth mode is none", () => {
    const alice: Identity = { subject: "alice", displayName: "alice", source: "proxy-header" };
    const { flags, denials } = computeCapabilities(alice, "none", HEALTHY);
    expect(flags).toEqual(ALL_FALSE);
    expect(denials).toEqual({ silence: { kind: "mode" }, ack: { kind: "mode" }, proposeEstateEdit: { kind: "mode" } });
  });
});

// ── Guard 7 — POST/PUT/PATCH/DELETE observe no upstream or audit call ─────────────────────────────

describe("guard 7 — non-GET performs zero upstream/audit work", () => {
  test("each mutating verb → shared JSON 405, no getContext, no fetch, no body read", async () => {
    // A runtime whose getContext THROWS proves the non-GET path never reaches the source clients or
    // captured context (the mutation branch precedes getContext). A global fetch spy proves no
    // upstream/audit network call happens on a mutating verb.
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
    const seenSeam: string[] = [];
    const spySeam: MutationDispatcher = async (c) => {
      seenSeam.push(c.request.method);
      return null; // the M1 no-op default — fall through to 405
    };

    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      return realFetch(...args);
    }) as typeof fetch;
    try {
      for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
        const request = req("/api/overview", verb, { body: "should-not-be-read" });
        const res = await dispatch(request, "/api/overview", exploding, stubAssets, { peerIp: "10.0.0.9", disableTimeout() {} }, spySeam);
        expect(res.status).toBe(405);
        expect(((await res.json()) as { code: string }).code).toBe("METHOD_NOT_ALLOWED");
        expect(request.bodyUsed).toBe(false);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seenSeam).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
    expect(fetchCalls).toBe(0); // zero upstream/audit calls on any mutating verb
  });

  test("guard 7-b — with the default dispatcher every mutation path is the M1 405 (REQ-COMPAT-03)", async () => {
    const MUTATION_PATHS = [
      "/api/mutations/silences", "/api/mutations/silences/expire",
      "/api/mutations/acks", "/api/mutations/acks/remove", "/api/mutations/proposals",
    ]; // 01 §3.4
    const exploding: ServerRuntime = {
      ...sessionRuntime(),
      getContext: () => { throw new Error("getContext must not run for a non-GET request"); },
    };
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { fetchCalls += 1; return realFetch(...args); }) as typeof fetch;
    try {
      for (const path of MUTATION_PATHS) {
        for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
          const request = req(path, verb, {
            headers: { "Remote-User": "alice", "content-type": "application/json", "Idempotency-Key": "k".repeat(22) },
            body: "{}",
          });
          // No 6th argument → router's default dispatchMutation, exactly what none-mode index.ts passes.
          const res = await dispatch(request, path, exploding, stubAssets, { peerIp: "10.0.0.7", disableTimeout() {} });
          expect(res.status).toBe(405);
          expect(((await res.json()) as { code: string }).code).toBe("METHOD_NOT_ALLOWED");
          expect(request.bodyUsed).toBe(false);
        }
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetchCalls).toBe(0);
  });
});
