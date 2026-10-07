// apps/web/tests/mutations-audit-details.test.ts — audit event construction and writer-bounded detail
// encoding (mutation-foundation 03-mutation-dispatcher.md §6; 00-core-definitions.md §6; 10-testing-strategy.md §3).
//
// Proves REQ-AUD-01 (every mutation event is writer-valid, including the 27-entry silence.create worst case)
// and REQ-AUD-05 (the actor is a 3-key copy, no sensitive key is ever emitted). The writer keeps its bounds
// and validator module-private, so the mirrored constants are pinned by parsing writer.ts source text and
// `isWriterValidEvent` is pinned against a real `createJsonlAuditWriter` over a shared corpus.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AuditEvent, type AuditWriter, createJsonlAuditWriter } from "@pulse/web-data/audit";
import type { Identity } from "@pulse/web-data/identity";

import {
  AUDIT_FIELD_MAX_BYTES,
  AUDIT_KEY_MAX_BYTES,
  AUDIT_MAX_ENTRIES,
  AUDIT_SENSITIVE_KEY_SUBSTRINGS,
  AUDIT_VALUE_MAX_BYTES,
  buildAuditEvent,
  canonicalMatchers,
  CHUNKED_DETAIL_KEYS,
  chunkUtf8,
  encodeAuditDetails,
  isWriterValidEvent,
  neutralizeControl,
  sha256Hex,
} from "../src/server/mutations/audit.js";
import type { AuditDetails } from "../src/server/mutations/registry.js";
import type { SilenceMatcherInput } from "../src/shared/mutations.js";

const utf8 = new TextEncoder();
const bytes = (s: string): number => utf8.encode(s).length;

const ALICE: Identity = { subject: "alice", displayName: "Alice Operator", source: "proxy-header" };
const AT = new Date("2026-09-29T12:00:00.000Z");

/** Encode or fail the test. */
function encoded(raw: AuditDetails): AuditDetails {
  const r = encodeAuditDetails(raw);
  if (!r.ok) throw new Error(`unexpected defect ${r.defect} on ${r.key}`);
  return r.details;
}

/** A writer-shaped event over encoded details. */
function eventWith(details: AuditDetails, outcome: AuditEvent["outcome"] = "succeeded"): AuditEvent {
  return buildAuditEvent({
    at: AT,
    actor: ALICE,
    action: "silence.create",
    capability: "silence",
    target: "alert:fp-1",
    outcome,
    requestId: "8f1f1c9e-5c2d-4b8e-9e1f-2a3b4c5d6e7f",
    details,
  });
}

/** Values of `<key>.1..n` in order. */
function chunksOf(details: AuditDetails, key: string): string[] {
  const out: string[] = [];
  for (let i = 1; Object.hasOwn(details, `${key}.${i}`); i += 1) out.push(details[`${key}.${i}`] as string);
  return out;
}

/** 24 matchers with 256-byte values (the schema maxima). */
function longMatchers(): SilenceMatcherInput[] {
  return [
    { name: "alertname", value: "A".repeat(256) },
    ...Array.from({ length: 23 }, (_, i) => ({ name: `label_${String(i).padStart(2, "0")}`, value: "v".repeat(256) })),
  ];
}

describe("neutralizeControl (REQ-AUD-01)", () => {
  test("\\n becomes ␤; C0, DEL and C1 become U+FFFD; everything else unchanged", () => {
    expect(neutralizeControl("a\nb")).toBe("a␤b");
    expect(neutralizeControl("\u0000\t\r\u001f")).toBe("�".repeat(4));
    expect(neutralizeControl("x\u007fy")).toBe("x�y");
    expect(neutralizeControl("\u0080\u0085\u009f")).toBe("�".repeat(3));
    expect(neutralizeControl("é 日本 😀  ")).toBe("é 日本 😀  ");
  });
});

describe("chunkUtf8 (REQ-AUD-01)", () => {
  test("empty string gives no chunks", () => {
    expect(chunkUtf8("", 256)).toEqual([]);
  });

  test("lossless and splits only on code-point boundaries (emoji / multibyte)", () => {
    const text = `${"😀".repeat(70)}é${"日".repeat(90)}a`;
    const chunks = chunkUtf8(text, AUDIT_VALUE_MAX_BYTES);
    expect(chunks.join("")).toBe(text);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(AUDIT_VALUE_MAX_BYTES);
      expect(c.length).toBeGreaterThan(0);
      // No lone surrogate at either edge: every chunk round-trips through UTF-8.
      expect(new TextDecoder().decode(utf8.encode(c))).toBe(c);
    }
    // 64 emoji fill exactly 256 bytes; the 65th starts a new chunk.
    expect(chunks[0]).toBe("😀".repeat(64));
  });
});

describe("canonicalMatchers / sha256Hex", () => {
  test("sorted by (name, value) and joined as name=value", () => {
    const text = canonicalMatchers([
      { name: "b", value: "2" },
      { name: "a", value: "z" },
      { name: "a", value: "y" },
    ]);
    expect(text).toBe("a=y,a=z,b=2");
  });

  test("sha256Hex is lowercase hex of the UTF-8 bytes", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("encodeAuditDetails chunking (REQ-AUD-01)", () => {
  test("a multi-line rationale is neutralized, chunked and gives a writer-valid event", () => {
    const rationale = `line one\nline two 😀\n${"x".repeat(300)}`;
    const d = encoded({ rationale });
    expect(Object.hasOwn(d, "rationale")).toBe(false);
    expect(chunksOf(d, "rationale").join("")).toBe(neutralizeControl(rationale));
    expect(isWriterValidEvent(eventWith(d))).toBe(true);
  });

  test("a 500-code-point multibyte rationale fits in ≤ 8 chunks", () => {
    const d = encoded({ rationale: "😀".repeat(500) });
    const chunks = chunksOf(d, "rationale");
    expect(chunks.length).toBe(8);
    expect(chunks.join("")).toBe("😀".repeat(500));
  });

  test("a 280-char multibyte note gives ≤ 5 lossless chunks", () => {
    for (const note of ["😀".repeat(280), "日".repeat(280), `é\n${"😀".repeat(278)}`]) {
      const d = encoded({ hasNote: true, note });
      const chunks = chunksOf(d, "note");
      expect(chunks.length).toBeLessThanOrEqual(CHUNKED_DETAIL_KEYS.note);
      expect(chunks.join("")).toBe(neutralizeControl(note));
      expect(isWriterValidEvent(eventWith(d))).toBe(true);
    }
  });

  test("24 long matchers → 12 chunks, matchersTruncated true, matchersSha256 of the raw text", () => {
    const raw = canonicalMatchers(longMatchers());
    const d = encoded({ matchers: raw });
    expect(chunksOf(d, "matchers").length).toBe(12);
    expect(d.matchersTruncated).toBe(true);
    expect(d.matchersSha256).toBe(sha256Hex(raw));
    expect(d.matchersSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(isWriterValidEvent(eventWith(d))).toBe(true);
  });

  test("a short matchers text is not truncated", () => {
    const d = encoded({ matchers: "alertname=HighCPU" });
    expect(chunksOf(d, "matchers")).toEqual(["alertname=HighCPU"]);
    expect(d.matchersTruncated).toBe(false);
  });

  test("a 512-byte silenceId → silenceId.1 and silenceId.2; a short one is still chunked", () => {
    const id = "s".repeat(512);
    const d = encoded({ silenceId: id });
    expect(Object.keys(d).sort()).toEqual(["silenceId.1", "silenceId.2"]);
    expect(`${d["silenceId.1"] as string}${d["silenceId.2"] as string}`).toBe(id);
    expect(encoded({ silenceId: "abc" })).toEqual({ "silenceId.1": "abc" });
  });

  test("other strings are neutralized; scalars pass through", () => {
    const d = encoded({ endsAt: "2026-09-29T14:00:00.000Z", staleField: "a\nb", removed: true, n: 3, z: null });
    expect(d).toEqual({ endsAt: "2026-09-29T14:00:00.000Z", staleField: "a␤b", removed: true, n: 3, z: null });
  });
});

describe("encodeAuditDetails defects (REQ-AUD-01)", () => {
  test("chunked-not-string", () => {
    expect(encodeAuditDetails({ note: 5 })).toEqual({ ok: false, defect: "chunked-not-string", key: "note" });
    expect(encodeAuditDetails({ rationale: null })).toEqual({ ok: false, defect: "chunked-not-string", key: "rationale" });
  });

  test("chunk-cap-exceeded (never for matchers)", () => {
    expect(encodeAuditDetails({ note: "😀".repeat(400) })).toEqual({ ok: false, defect: "chunk-cap-exceeded", key: "note" });
    expect(encodeAuditDetails({ silenceId: "s".repeat(513) })).toEqual({
      ok: false,
      defect: "chunk-cap-exceeded",
      key: "silenceId",
    });
    expect(encodeAuditDetails({ matchers: "x".repeat(10_000) }).ok).toBe(true);
  });

  test("reserved-key", () => {
    expect(encodeAuditDetails({ "x.1": "a" })).toEqual({ ok: false, defect: "reserved-key", key: "x.1" });
    expect(encodeAuditDetails({ matchersSha256: "a" })).toEqual({ ok: false, defect: "reserved-key", key: "matchersSha256" });
    expect(encodeAuditDetails({ matchersTruncated: false })).toEqual({
      ok: false,
      defect: "reserved-key",
      key: "matchersTruncated",
    });
  });

  test("non-finite-number", () => {
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(encodeAuditDetails({ durationSeconds: n })).toEqual({
        ok: false,
        defect: "non-finite-number",
        key: "durationSeconds",
      });
    }
  });
});

describe("worst-case budget and sensitive keys (REQ-AUD-01, REQ-AUD-05)", () => {
  const worst = (): AuditDetails =>
    encoded({
      endsAt: "2026-10-06T12:00:00.000Z",
      durationSeconds: 604_800,
      matcherCount: 24,
      matchers: canonicalMatchers(longMatchers()),
      rationale: `why\n${"😀".repeat(496)}`,
      silenceId: "s".repeat(512),
    });

  test("the 27-entry silence.create finalize event is writer-valid", () => {
    const d = worst();
    expect(Object.keys(d).length).toBe(27);
    expect(Object.keys(d).length).toBeLessThanOrEqual(AUDIT_MAX_ENTRIES);
    expect(isWriterValidEvent(eventWith(d, "succeeded"))).toBe(true);
  });

  test("no emitted key (any action's details) contains a sensitive substring", () => {
    const all = [
      worst(),
      encoded({ hasNote: true, note: "n" }),
      encoded({ removed: false }),
      encoded({ fields: "expectedChurn,suppressed", rationale: "r", proposalId: "p-20260928T140307Z-deadbeef" }),
      encoded({ reason: "stale-proposal", staleField: "cadvisor" }),
    ];
    for (const d of all) {
      for (const key of Object.keys(d)) {
        const lower = key.toLowerCase();
        for (const s of AUDIT_SENSITIVE_KEY_SUBSTRINGS) expect(lower.includes(s)).toBe(false);
      }
    }
  });
});

describe("buildAuditEvent (REQ-AUD-01, REQ-AUD-05)", () => {
  test("3-key actor copy, correlationId null, capability set, target neutralized", () => {
    const leaky = { ...ALICE, header: "Remote-User: alice", peerIp: "10.0.0.1" } as unknown as Identity;
    const e = buildAuditEvent({
      at: AT,
      actor: leaky,
      action: "ack.set",
      capability: "ack",
      target: "alert:fp\n1",
      outcome: "attempted",
      requestId: "req-1",
      details: {},
    });
    expect(e).toEqual({
      at: "2026-09-29T12:00:00.000Z",
      actor: { subject: "alice", displayName: "Alice Operator", source: "proxy-header" },
      action: "ack.set",
      capability: "ack",
      target: "alert:fp␤1",
      outcome: "attempted",
      requestId: "req-1",
      correlationId: null,
      details: {},
    });
    expect(Object.keys(e.actor)).toHaveLength(3);
    expect(JSON.stringify(e)).not.toContain("10.0.0.1");
    expect(JSON.stringify(e)).not.toContain("Remote-User");
    expect(isWriterValidEvent(e)).toBe(true);
  });

  test("an invalid Date throws RangeError", () => {
    expect(() =>
      buildAuditEvent({
        at: new Date(Number.NaN),
        actor: ALICE,
        action: "ack.set",
        capability: "ack",
        target: "alert:x",
        outcome: "attempted",
        requestId: "r",
        details: {},
      }),
    ).toThrow(RangeError);
  });
});

describe("mirrored writer constants equal writer.ts source (REQ-AUD-01)", () => {
  const src = readFileSync(join(import.meta.dir, "../../../packages/web-data/src/audit/writer.ts"), "utf8");
  const num = (name: string): number => {
    const m = new RegExp(`const ${name} = (\\d+);`).exec(src);
    if (m === null) throw new Error(`${name} not found in writer.ts`);
    return Number(m[1]);
  };

  test("the four MAX_* bounds", () => {
    expect(AUDIT_FIELD_MAX_BYTES).toBe(num("MAX_FIELD_BYTES"));
    expect(AUDIT_MAX_ENTRIES).toBe(num("MAX_DETAIL_ENTRIES"));
    expect(AUDIT_KEY_MAX_BYTES).toBe(num("MAX_DETAIL_KEY_BYTES"));
    expect(AUDIT_VALUE_MAX_BYTES).toBe(num("MAX_DETAIL_VALUE_BYTES"));
  });

  test("SENSITIVE_KEY_SUBSTRINGS", () => {
    const m = /const SENSITIVE_KEY_SUBSTRINGS: readonly string\[\] = \[([^\]]*)\]/.exec(src);
    if (m === null) throw new Error("SENSITIVE_KEY_SUBSTRINGS not found in writer.ts");
    const parsed = [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    expect(parsed).toHaveLength(13);
    expect([...AUDIT_SENSITIVE_KEY_SUBSTRINGS]).toEqual(parsed as string[]);
  });
});

describe("isWriterValidEvent parity with createJsonlAuditWriter (REQ-AUD-01, REQ-AUD-05)", () => {
  let dir: string;
  let writer: AuditWriter;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pulse-audit-parity-"));
    writer = createJsonlAuditWriter({ absolutePath: join(dir, "audit.jsonl") });
  });
  afterAll(async () => {
    await writer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const base = eventWith({ hasNote: false });
  const mk = (over: Record<string, unknown>): AuditEvent => ({ ...base, ...over }) as unknown as AuditEvent;
  const many = (n: number): Record<string, number> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
  class Details {
    readonly a = 1;
  }

  const corpus: ReadonlyArray<readonly [string, AuditEvent]> = [
    // valid
    ["base", base],
    ["worst-case finalize", eventWith(encoded({ matchers: canonicalMatchers(longMatchers()), rationale: "😀".repeat(500), silenceId: "s".repeat(512), endsAt: "2026-10-06T12:00:00.000Z", durationSeconds: 1, matcherCount: 24 }))],
    ["no capability", (() => { const { capability: _c, ...rest } = base; return rest as AuditEvent; })()],
    ["string correlationId", mk({ correlationId: "corr-1" })],
    ["32 entries", mk({ details: many(32) })],
    ["256-byte value", mk({ details: { v: "é".repeat(128) } })],
    ["128-byte key", mk({ details: { ["k".repeat(128)]: 1 } })],
    ["empty string value", mk({ details: { v: "" } })],
    ["null-proto details", mk({ details: Object.assign(Object.create(null) as object, { a: 1 }) })],
    ["256-byte target", mk({ target: "t".repeat(256) })],
    // invalid
    ["unparseable at", mk({ at: "not-a-date" })],
    ["empty action", mk({ action: "" })],
    ["target with newline", mk({ target: "alert:a\nb" })],
    ["257-byte target", mk({ target: "t".repeat(257) })],
    ["bad outcome", mk({ outcome: "done" })],
    ["257-byte requestId", mk({ requestId: "r".repeat(257) })],
    ["empty correlationId", mk({ correlationId: "" })],
    ["undefined correlationId", mk({ correlationId: undefined })],
    ["actor 4 keys", mk({ actor: { ...ALICE, peer: "x" } })],
    ["actor wrong source", mk({ actor: { ...ALICE, source: "none" } })],
    ["actor null", mk({ actor: null })],
    ["actor array", mk({ actor: ["a", "b", "c"] })],
    ["actor control char", mk({ actor: { ...ALICE, displayName: "a\u0085" } })],
    ["33 entries", mk({ details: many(33) })],
    ["257-byte value", mk({ details: { v: "v".repeat(257) } })],
    ["129-byte key", mk({ details: { ["k".repeat(129)]: 1 } })],
    ["empty key", mk({ details: { "": 1 } })],
    ["control in value", mk({ details: { v: "a\u007f" } })],
    ["control in key", mk({ details: { "a\tb": 1 } })],
    ["sensitive key", mk({ details: { userToken: "x" } })],
    ["sensitive key x-forwarded", mk({ details: { "X-Forwarded-For": "x" } })],
    ["__proto__ key", mk({ details: JSON.parse('{"__proto__": 1}') as object })],
    ["constructor key", mk({ details: { constructor: 1 } })],
    ["nested value", mk({ details: { v: { a: 1 } } })],
    ["array value", mk({ details: { v: [1] } })],
    ["NaN value", mk({ details: { v: Number.NaN } })],
    ["undefined value", mk({ details: { v: undefined } })],
    ["class-instance details", mk({ details: new Details() })],
    ["details null", mk({ details: null })],
    ["details array", mk({ details: [] })],
  ];

  test("writer {ok:true} iff the mirror returns true, over the whole corpus", async () => {
    let valid = 0;
    for (const [name, event] of corpus) {
      const mirror = isWriterValidEvent(event);
      const result = await writer.append(event);
      expect({ name, ok: result.ok }).toEqual({ name, ok: mirror });
      if (mirror) valid += 1;
    }
    // The corpus exercises both sides.
    expect(valid).toBe(10);
    expect(corpus.length - valid).toBeGreaterThan(20);
  });

  test("the mirror never throws on non-object or hostile input", () => {
    const hostile = {
      ...base,
      get details(): never {
        throw new Error("boom");
      },
    } as unknown as AuditEvent;
    for (const e of [null, undefined, 42, "x", [], hostile] as unknown as AuditEvent[]) {
      expect(() => isWriterValidEvent(e)).not.toThrow();
      expect(isWriterValidEvent(e)).toBe(false);
    }
  });
});
