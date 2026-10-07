/** identity.test.ts — canonical encoding + representation identity evidence (item 009,
 *  04-cycle-and-current-view-folds.md §5). Imports package source (`../../src/...`) so the
 *  suite runs before `tsc -b` emits `dist` (the same order-safe convention the other
 *  web-data suites use). */

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";

import {
  CanonicalJsonError,
  canonicalJson,
  deterministicGzip,
  sha256Id,
} from "../../src/canonical.js";
import { materializeView } from "../../src/cycle/identity.js";
import type { MaterializedPayload } from "../../src/cycle/types.js";
import { CURRENT_MAX_GZIP_BYTES, CURRENT_MAX_PLAIN_BYTES } from "../../src/wire/common.js";

const decoder = new TextDecoder();
const text = (bytes: Uint8Array): string => decoder.decode(bytes);

describe("canonicalJson — determinism", () => {
  test("sorts object keys recursively regardless of insertion order", () => {
    const a = { b: 1, a: { d: 4, c: 3 }, z: [3, 2, 1] };
    const b = { z: [3, 2, 1], a: { c: 3, d: 4 }, b: 1 };
    expect(text(canonicalJson(a))).toBe('{"a":{"c":3,"d":4},"b":1,"z":[3,2,1]}');
    expect(text(canonicalJson(a))).toBe(text(canonicalJson(b)));
  });

  test("preserves array order (fold-defined ordering is not re-sorted)", () => {
    expect(text(canonicalJson(["c", "a", "b"]))).toBe('["c","a","b"]');
    expect(text(canonicalJson([{ k: 2 }, { k: 1 }]))).toBe('[{"k":2},{"k":1}]');
  });

  test("handles primitives, null, empties, and nested structures", () => {
    expect(text(canonicalJson(null))).toBe("null");
    expect(text(canonicalJson(true))).toBe("true");
    expect(text(canonicalJson(0))).toBe("0");
    expect(text(canonicalJson(-0))).toBe("0");
    expect(text(canonicalJson("hi\n\"x\""))).toBe('"hi\\n\\"x\\""');
    expect(text(canonicalJson({}))).toBe("{}");
    expect(text(canonicalJson([]))).toBe("[]");
  });

  test("emits UTF-8 bytes for multi-byte characters", () => {
    const bytes = canonicalJson({ name: "café—✓" });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(text(bytes))).toEqual({ name: "café—✓" });
  });

  test("shared (acyclic) references are legal and encode twice", () => {
    const shared = { v: 1 };
    expect(text(canonicalJson({ a: shared, b: shared }))).toBe('{"a":{"v":1},"b":{"v":1}}');
  });
});

describe("canonicalJson — rejections", () => {
  test("rejects a direct cycle", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(CanonicalJsonError);
  });

  test("rejects a cycle through an array", () => {
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => canonicalJson(arr)).toThrow(CanonicalJsonError);
  });

  test("rejects non-finite numbers", () => {
    expect(() => canonicalJson(NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Infinity)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(-Infinity)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ x: NaN })).toThrow(CanonicalJsonError);
  });

  test("rejects undefined, bigint, functions, and symbols", () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(10n)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(() => 0)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Symbol("s"))).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ x: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([undefined])).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ x: 1n })).toThrow(CanonicalJsonError);
  });

  test("rejects non-plain objects (Date, Map, class instances)", () => {
    expect(() => canonicalJson(new Date())).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Map())).toThrow(CanonicalJsonError);
    class Widget {
      readonly x = 1;
    }
    expect(() => canonicalJson(new Widget())).toThrow(CanonicalJsonError);
  });
});

describe("sha256Id", () => {
  test("produces a stable sha256: identity over exact bytes", async () => {
    const id = await sha256Id(canonicalJson({ a: 1 }));
    // Reference SHA-256 of the canonical text {"a":1}.
    expect(id).toBe("sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("differs for different bytes and matches for identical bytes", async () => {
    const a = await sha256Id(canonicalJson({ a: 1 }));
    const b = await sha256Id(canonicalJson({ a: 2 }));
    const aAgain = await sha256Id(canonicalJson({ a: 1 }));
    expect(a).not.toBe(b);
    expect(a).toBe(aAgain);
  });
});

describe("deterministicGzip", () => {
  test("is deterministic and round-trips", async () => {
    const bytes = canonicalJson({ msg: "hello world".repeat(50) });
    const g1 = await deterministicGzip(bytes);
    const g2 = await deterministicGzip(bytes);
    expect(Buffer.compare(g1, g2)).toBe(0);
    expect<Uint8Array>(new Uint8Array(gunzipSync(g1))).toEqual(bytes);
  });

  test("zeroes the gzip mtime header for reproducibility", async () => {
    const g = await deterministicGzip(canonicalJson({ a: 1 }));
    expect([...g.slice(4, 8)]).toEqual([0, 0, 0, 0]);
  });
});

// A minimal semantic-material factory: the value with observation-only metadata excluded.
interface DemoValue {
  readonly generatedAt: string;
  readonly status: string;
  readonly count: number;
}
const semanticOf = (v: DemoValue): { status: string; count: number } => ({
  status: v.status,
  count: v.count,
});

describe("materializeView — reuse on non-material change", () => {
  test("sequence-only / success-time-only change reuses object, bytes, generatedAt, identity, and both ETags", async () => {
    const first = await materializeView<DemoValue>(
      "overview",
      null,
      { generatedAt: "2026-09-16T00:00:00.000Z", status: "healthy", count: 3 },
      semanticOf({ generatedAt: "2026-09-16T00:00:00.000Z", status: "healthy", count: 3 }),
    );
    expect(first.ok).toBe(true);
    const prior = (first as { payload: MaterializedPayload<DemoValue> }).payload;

    // Later cycle: only generatedAt (materialization time) changes; semantic material is identical.
    const next = await materializeView<DemoValue>(
      "overview",
      prior,
      { generatedAt: "2026-09-16T00:00:10.000Z", status: "healthy", count: 3 },
      semanticOf({ generatedAt: "2026-09-16T00:00:10.000Z", status: "healthy", count: 3 }),
    );
    expect(next.ok).toBe(true);
    const reused = (next as { payload: MaterializedPayload<DemoValue> }).payload;

    expect(reused).toBe(prior); // same object identity
    expect(reused.value).toBe(prior.value); // retained value, retained generatedAt
    expect(reused.value.generatedAt).toBe("2026-09-16T00:00:00.000Z");
    expect(reused.identity).toBe(prior.identity);
    expect(reused.plain.bytes).toBe(prior.plain.bytes);
    expect(reused.gzip.bytes).toBe(prior.gzip.bytes);
    expect(reused.plain.etag).toBe(prior.plain.etag);
    expect(reused.gzip.etag).toBe(prior.gzip.etag);
  });
});

describe("materializeView — material change", () => {
  test("generates deterministic plain/gzip bytes with distinct strong SHA-256 ETags", async () => {
    const prior = (
      (await materializeView<DemoValue>(
        "alerts",
        null,
        { generatedAt: "t0", status: "healthy", count: 1 },
        semanticOf({ generatedAt: "t0", status: "healthy", count: 1 }),
      )) as { payload: MaterializedPayload<DemoValue> }
    ).payload;

    const changed = await materializeView<DemoValue>(
      "alerts",
      prior,
      { generatedAt: "t1", status: "unhealthy", count: 2 },
      semanticOf({ generatedAt: "t1", status: "unhealthy", count: 2 }),
    );
    expect(changed.ok).toBe(true);
    const p = (changed as { payload: MaterializedPayload<DemoValue> }).payload;

    expect(p).not.toBe(prior);
    expect(p.identity).not.toBe(prior.identity);
    expect(p.value.generatedAt).toBe("t1"); // fresh materialization time retained
    // Distinct strong ETags over the exact selected representation.
    expect(p.plain.etag).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(p.gzip.etag).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(p.plain.etag).not.toBe(p.gzip.etag);
    // ETags are exactly the hash of the selected bytes.
    expect(p.plain.etag).toBe(await sha256Id(p.plain.bytes));
    expect(p.gzip.etag).toBe(await sha256Id(p.gzip.bytes));
    // gzip round-trips back to the plain canonical bytes.
    expect<Uint8Array>(new Uint8Array(gunzipSync(p.gzip.bytes))).toEqual(p.plain.bytes);
  });

  test("deep-freezes the retained value (development/test mode)", async () => {
    const p = (
      (await materializeView<{ generatedAt: string; nested: { x: number } }>(
        "engine",
        null,
        { generatedAt: "t", nested: { x: 1 } },
        { nested: { x: 1 } },
      )) as { payload: MaterializedPayload<{ generatedAt: string; nested: { x: number } }> }
    ).payload;
    expect(Object.isFrozen(p.value)).toBe(true);
    expect(Object.isFrozen(p.value.nested)).toBe(true);
  });

  test("restart (previous=null) rematerializes even for identical content", async () => {
    const value = { generatedAt: "t0", status: "healthy", count: 1 } satisfies DemoValue;
    const a = (
      (await materializeView<DemoValue>("estate", null, value, semanticOf(value))) as {
        payload: MaterializedPayload<DemoValue>;
      }
    ).payload;
    const b = (
      (await materializeView<DemoValue>("estate", null, { ...value }, semanticOf(value))) as {
        payload: MaterializedPayload<DemoValue>;
      }
    ).payload;
    expect(a.identity).toBe(b.identity); // same semantic identity
    expect(a).not.toBe(b); // but a fresh object, not a cache reuse
  });
});

describe("materializeView — classified construction failures (never reject)", () => {
  test("canonicalization failure in the value is classified without partial materialization", async () => {
    const result = await materializeView<unknown>(
      "timeline",
      null,
      { generatedAt: "t", bad: 10n }, // bigint → unsupported
      { bad: "ok" }, // semantic material is fine, so failure is on the value/plain path
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("canonicalization");
      expect(result.error.view).toBe("timeline");
      expect(result.error.message).toBe("The latest current-data cycle could not be materialized.");
    }
  });

  test("canonicalization failure in the semantic material is classified", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = await materializeView<unknown>("overview", null, { generatedAt: "t" }, cyclic);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("canonicalization");
  });

  test("plain payload over 5 MiB is a classified payload-limit failure", async () => {
    const big = "x".repeat(CURRENT_MAX_PLAIN_BYTES + 10);
    const result = await materializeView<unknown>(
      "estate",
      null,
      { generatedAt: "t", blob: big },
      { blob: big },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("payload-limit");
      expect(result.error.view).toBe("estate");
    }
  });

  test("gzip payload over 1 MiB is a classified payload-limit failure", async () => {
    // Genuinely incompressible data (random bytes as base64): stays under 5 MiB plain but
    // exceeds 1 MiB gzip, so the gzip limit — not the plain limit — is exercised.
    const blob = randomBytes(1.5 * 1024 * 1024).toString("base64");
    const plainSize = canonicalJson({ blob }).byteLength;
    expect(plainSize).toBeLessThanOrEqual(CURRENT_MAX_PLAIN_BYTES);
    const gzSize = (await deterministicGzip(canonicalJson({ blob }))).byteLength;
    expect(gzSize).toBeGreaterThan(CURRENT_MAX_GZIP_BYTES);

    const result = await materializeView<unknown>("engine", null, { generatedAt: "t", blob }, { blob });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("payload-limit");
  });
});
