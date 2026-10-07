// apps/web/tests/router-patterns.test.ts — the compiled GET-route pattern engine
// (05-http-routes-and-representations.md §2, §10; item 034 evidence for AC-1). Exercises the
// module-private compiler internals in `src/server/routes/compile.ts` directly, without binding a
// port: `compileSegments` (structure validation), `assertRegistry` (whole-set ambiguity/duplicate
// rejection at startup), `matchRoutes` (exact static + decode-once parameter matching with the
// control/NUL/slash-after-decode + 512-byte bounds), and `validateQuery` (2 KiB + repeated-key +
// allowlist guard). These are the compiler seams no other suite covers.

import { afterEach, describe, expect, test } from "bun:test";

import {
  MAX_PARAM_BYTES,
  MAX_QUERY_BYTES,
  RouteCompileError,
  assertRegistry,
  compileSegments,
  matchRoutes,
  validateQuery,
  __resetCompileCacheForTest,
} from "../src/server/routes/compile.js";
import { defineRoute, type RouteDefinition } from "../src/shared/registry.js";
import { ROUTES } from "../src/server/routes/registry.js";

// A malformed-pattern test compiles throwaway patterns; reset the shared memo between tests so a
// cached compile from one test never masks another (compileSegments memoizes successful compiles).
afterEach(() => __resetCompileCacheForTest());

/** A GET route for `path` (the compiler only reads `.path`; the handler is never invoked here). */
function route<const P extends string>(path: P): RouteDefinition<P> {
  return defineRoute<P>({ method: "GET", path, handler: () => new Response(null, { status: 200 }) });
}

// ── compileSegments — structural validation (§2) ────────────────────────────────────────────────

describe("compileSegments — structure validation (§2)", () => {
  test("splits static and :param segments in order", () => {
    const segs = compileSegments("/api/history/estate/:queryId");
    expect(segs).toEqual([
      { kind: "static", value: "api" },
      { kind: "static", value: "history" },
      { kind: "static", value: "estate" },
      { kind: "param", name: "queryId" },
    ]);
  });

  test("a two-parameter pattern captures both names", () => {
    const segs = compileSegments("/api/history/target/:drilldownId/:queryId");
    expect(segs.filter((s) => s.kind === "param").map((s) => (s.kind === "param" ? s.name : ""))).toEqual([
      "drilldownId",
      "queryId",
    ]);
  });

  test("rejects a pattern without a leading slash", () => {
    expect(() => compileSegments("api/overview")).toThrow(RouteCompileError);
  });

  test("rejects an empty internal segment (//)", () => {
    expect(() => compileSegments("/api//overview")).toThrow(RouteCompileError);
  });

  test("rejects wildcard syntax", () => {
    expect(() => compileSegments("/assets/*")).toThrow(RouteCompileError);
  });

  test("rejects an empty parameter name (bare colon)", () => {
    expect(() => compileSegments("/api/:")).toThrow(RouteCompileError);
  });

  test("rejects a duplicate parameter name within one pattern", () => {
    expect(() => compileSegments("/api/history/target/:queryId/:queryId")).toThrow(RouteCompileError);
  });

  test("memoizes: the same pattern returns the identical frozen segment array", () => {
    const a = compileSegments("/api/overview");
    const b = compileSegments("/api/overview");
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });
});

// ── assertRegistry — whole-set ambiguity / duplicate rejection at startup (§2/§10) ──────────────

describe("assertRegistry — startup ambiguity/duplicate rejection (§2/§10)", () => {
  test("the real M1 registry compiles with no ambiguity", () => {
    expect(() => assertRegistry(ROUTES)).not.toThrow();
  });

  test("a distinct static set is accepted", () => {
    expect(() => assertRegistry([route("/api/overview"), route("/api/alerts"), route("/healthz")])).not.toThrow();
  });

  test("two identical patterns are rejected", () => {
    expect(() => assertRegistry([route("/api/overview"), route("/api/overview")])).toThrow(RouteCompileError);
  });

  test("two same-shape parameter patterns (different names) are ambiguous", () => {
    // Both compile to [static:api, static:history, static:estate, param] — some concrete path matches
    // both, and declaration order must never break the tie (§2).
    expect(() =>
      assertRegistry([route("/api/history/estate/:queryId"), route("/api/history/estate/:id")]),
    ).toThrow(RouteCompileError);
  });

  test("a parameter segment overlapping a static one at the same length is ambiguous", () => {
    // `/api/:kind` (param) and `/api/overview` (static) both match `/api/overview`.
    expect(() => assertRegistry([route("/api/:kind"), route("/api/overview")])).toThrow(RouteCompileError);
  });

  test("patterns of different lengths never collide", () => {
    expect(() =>
      assertRegistry([route("/api/history/estate/:queryId"), route("/api/history/alerts")]),
    ).not.toThrow();
  });
});

// ── matchRoutes — exact static + decode-once parameter matching (§2) ────────────────────────────

const HISTORY = [route("/api/history/estate/:queryId"), route("/api/history/checks/:endpoint")];

describe("matchRoutes — static matching (§2)", () => {
  test("an exact static path matches its route", () => {
    const m = matchRoutes([route("/healthz")], "/healthz");
    expect(m.kind).toBe("match");
    if (m.kind === "match") expect(m.route.path).toBe("/healthz");
  });

  test("a length mismatch yields no match", () => {
    expect(matchRoutes([route("/healthz")], "/healthz/extra").kind).toBe("none");
  });

  test("a trailing slash does not match (trailing empty segment)", () => {
    expect(matchRoutes([route("/api/overview")], "/api/overview/").kind).toBe("none");
  });
});

describe("matchRoutes — parameter capture + decode-once (§2)", () => {
  test("captures a single decoded parameter", () => {
    const m = matchRoutes(HISTORY, "/api/history/estate/host.cpu");
    expect(m.kind).toBe("match");
    if (m.kind === "match") expect(m.params.queryId).toBe("host.cpu");
  });

  test("decodes a percent-encoded value exactly once", () => {
    // `%20` → one space; the value is decoded a single time (not re-decoded).
    const m = matchRoutes(HISTORY, "/api/history/estate/web%20load");
    expect(m.kind).toBe("match");
    if (m.kind === "match") expect(m.params.queryId).toBe("web load");
  });

  test("decode-once, not twice: %252F stays a literal %2F, never becomes a slash", () => {
    // A double decode would turn `%252F` into `/` and then be rejected; a single decode yields the
    // literal `%2F`, which is a valid parameter value.
    const m = matchRoutes(HISTORY, "/api/history/estate/a%252Fb");
    expect(m.kind).toBe("match");
    if (m.kind === "match") expect(m.params.queryId).toBe("a%2Fb");
  });

  test("an empty parameter segment does not match", () => {
    expect(matchRoutes(HISTORY, "/api/history/estate/").kind).toBe("none");
  });
});

describe("matchRoutes — malformed / bounded parameters → invalid (carries the template) (§2)", () => {
  test("malformed percent-encoding is invalid, not a match", () => {
    const m = matchRoutes(HISTORY, "/api/history/estate/%E0%A4%A");
    expect(m.kind).toBe("invalid");
    // The matched template is carried so the metric label / error detail use the pattern, never the
    // raw path (§2/§10).
    if (m.kind === "invalid") expect(m.route.path).toBe("/api/history/estate/:queryId");
  });

  test("a slash-after-decode value (%2F) is rejected", () => {
    expect(matchRoutes(HISTORY, "/api/history/estate/a%2Fb").kind).toBe("invalid");
  });

  test("control and NUL characters after decode are rejected", () => {
    for (const encoded of ["%00", "%01", "%1F", "%7F"]) {
      expect(matchRoutes(HISTORY, `/api/history/estate/${encoded}`).kind).toBe("invalid");
    }
  });

  test("a parameter of exactly 512 UTF-8 bytes is accepted; 513 is rejected", () => {
    const at = "a".repeat(MAX_PARAM_BYTES);
    const over = "a".repeat(MAX_PARAM_BYTES + 1);
    const ok = matchRoutes(HISTORY, `/api/history/estate/${at}`);
    expect(ok.kind).toBe("match");
    if (ok.kind === "match") expect(ok.params.queryId).toHaveLength(MAX_PARAM_BYTES);
    expect(matchRoutes(HISTORY, `/api/history/estate/${over}`).kind).toBe("invalid");
  });

  test("byte length, not code-point length: a multi-byte value over 512 bytes is rejected", () => {
    // "é" is 2 UTF-8 bytes; 256 of them decode-safely but total 512 bytes (boundary), 257 → 514 (over).
    const boundary = "é".repeat(256); // 512 bytes
    const over = "é".repeat(257); // 514 bytes
    expect(matchRoutes(HISTORY, `/api/history/estate/${encodeURIComponent(boundary)}`).kind).toBe("match");
    expect(matchRoutes(HISTORY, `/api/history/estate/${encodeURIComponent(over)}`).kind).toBe("invalid");
  });
});

// ── slashParams — per-param opt-in to a percent-encoded slash (amendment 12 §1) ─────────────────

describe("slashParams — opted-in params accept a structurally-valid %2F (amendment 12 §1)", () => {
  /** The real registry's two opted-in routes plus the (not opted-in) estate route. */
  const REAL = ROUTES.filter((r) => r.path.startsWith("/api/history/"));

  test("only the target and checks history routes declare slashParams, with the exact names", () => {
    const declared = ROUTES.filter((r) => r.slashParams !== undefined).map((r) => [r.path, r.slashParams]);
    expect(declared).toEqual([
      ["/api/history/target/:drilldownId/:queryId", ["drilldownId"]],
      ["/api/history/checks/:endpoint", ["endpoint"]],
    ]);
  });

  test("a slashParams name that is not a parameter of the route throws at registration", () => {
    const bad = defineRoute({
      method: "GET",
      path: "/api/history/checks/:endpoint",
      slashParams: ["drilldownId"],
      handler: () => new Response(null, { status: 200 }),
    });
    expect(() => assertRegistry([bad])).toThrow(RouteCompileError);
    const staticBad = defineRoute({
      method: "GET",
      path: "/api/overview",
      slashParams: ["overview"],
      handler: () => new Response(null, { status: 200 }),
    });
    expect(() => assertRegistry([staticBad])).toThrow(RouteCompileError);
  });

  test("the checks route returns the decoded slash-bearing endpoint name", () => {
    const m = matchRoutes(REAL, "/api/history/checks/web%2Fapp");
    expect(m.kind).toBe("match");
    if (m.kind === "match") {
      expect(m.route.path).toBe("/api/history/checks/:endpoint");
      expect(m.params.endpoint).toBe("web/app");
    }
  });

  test("the target route returns the decoded svc:<host>/<name> drilldown id", () => {
    const m = matchRoutes(REAL, "/api/history/target/svc%3Aweb%2Fapp/service.deep-health");
    expect(m.kind).toBe("match");
    if (m.kind === "match") {
      expect(m.route.path).toBe("/api/history/target/:drilldownId/:queryId");
      expect(m.params.drilldownId).toBe("svc:web/app");
      expect(m.params.queryId).toBe("service.deep-health");
    }
  });

  test("the non-opted-in queryId of the target route still rejects a slash", () => {
    expect(matchRoutes(REAL, "/api/history/target/host%3Agov/a%2Fb").kind).toBe("invalid");
  });

  test("structurally invalid slash values are rejected on both opted-in params", () => {
    const bad = ["%2Fa", "a%2F", "a%2F%2Fb", "a%2F..%2Fb", "a%2F.%2Fb", "..%2Fa", "a%2F..", "a%5Cb", "a%5C%2Fb"];
    for (const value of bad) {
      const checks = matchRoutes(REAL, `/api/history/checks/${value}`);
      expect(checks.kind).toBe("invalid");
      if (checks.kind === "invalid") expect(checks.route.path).toBe("/api/history/checks/:endpoint");
      expect(matchRoutes(REAL, `/api/history/target/${value}/host.cpu`).kind).toBe("invalid");
    }
  });

  test("control/NUL characters are still rejected on the opted-in params", () => {
    for (const encoded of ["%00", "%01", "%1F", "%7F"]) {
      expect(matchRoutes(REAL, `/api/history/checks/web%2F${encoded}app`).kind).toBe("invalid");
      expect(matchRoutes(REAL, `/api/history/target/svc%3Aweb%2F${encoded}/host.cpu`).kind).toBe("invalid");
    }
  });

  test("malformed encoding is still rejected on the opted-in params", () => {
    expect(matchRoutes(REAL, "/api/history/checks/web%2F%E0%A4%A").kind).toBe("invalid");
  });

  test("the 512-byte bound still applies to a slash-bearing value", () => {
    const at = `${"a".repeat(255)}/${"b".repeat(256)}`; // 512 bytes
    const over = `${"a".repeat(256)}/${"b".repeat(256)}`; // 513 bytes
    const ok = matchRoutes(REAL, `/api/history/checks/${encodeURIComponent(at)}`);
    expect(ok.kind).toBe("match");
    if (ok.kind === "match") expect(ok.params.endpoint).toBe(at);
    expect(matchRoutes(REAL, `/api/history/checks/${encodeURIComponent(over)}`).kind).toBe("invalid");
  });

  test("the estate route (no slashParams) still rejects a%2Fb", () => {
    expect(matchRoutes(REAL, "/api/history/estate/a%2Fb").kind).toBe("invalid");
  });
});

// ── validateQuery — 2 KiB cap, repeated keys, and the per-handler allowlist (§2) ─────────────────

describe("validateQuery — bounds, repeated keys, allowlist (§2)", () => {
  test("an empty query is valid", () => {
    expect(validateQuery("").ok).toBe(true);
    expect(validateQuery("?").ok).toBe(true);
  });

  test("a query at exactly 2 KiB is valid; 2 KiB + 1 is rejected", () => {
    const at = `?q=${"a".repeat(MAX_QUERY_BYTES - 2)}`; // raw (after '?') is exactly 2048 bytes
    expect(at.length - 1).toBe(MAX_QUERY_BYTES);
    expect(validateQuery(at).ok).toBe(true);
    expect(validateQuery(`${at}a`).ok).toBe(false);
  });

  test("a repeated key is rejected even when allowed", () => {
    expect(validateQuery("?range=1h&range=6h", ["range"]).ok).toBe(false);
  });

  test("with no allowlist, any distinct keys are accepted (only repetition/length gate)", () => {
    expect(validateQuery("?a=1&b=2").ok).toBe(true);
  });

  test("with an allowlist, an unknown key is rejected and the allowed key passes", () => {
    expect(validateQuery("?range=6h", ["range"]).ok).toBe(true);
    expect(validateQuery("?step=30", ["range"]).ok).toBe(false);
    // Current routes allow NO keys — any key is rejected.
    expect(validateQuery("?range=6h", []).ok).toBe(false);
  });
});
