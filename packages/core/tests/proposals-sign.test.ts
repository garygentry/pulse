/** proposals-sign.test.ts — HMAC signing and verification (`src/proposals/sign.ts`, node-only).
 *
 *  Asserts: sign → verify round-trips for object, JSON-string and byte inputs (REQ-PROP-05); every
 *  tamper is caught by the ordered checks unparseable → schema → alg → schema → signature (REQ-SEC-05);
 *  verifyProposal never throws; a short secret is refused without its bytes ever appearing in an
 *  error, a file or output (REQ-SEC-04); and the secret is used as raw UTF-8 bytes, so the web
 *  (TextEncoder) and the CLI (Buffer) agree. */

import { describe, expect, test } from "bun:test";

import { ProposalSecretError, signProposal, verifyProposal } from "../src/proposals/sign.js";
import { SIGNATURE_VALUE_RE, newProposalId } from "../src/proposals/index.js";
import type { ProposalFileV1, ProposalPayload } from "../src/proposals/index.js";

const SECRET_TEXT = "test-secret-0123456789abcdefghijklmnop"; // 38 ASCII bytes
const SECRET = new TextEncoder().encode(SECRET_TEXT);
const OTHER_SECRET = new TextEncoder().encode("another-secret-0123456789abcdefghijk");

function payload(over: Partial<ProposalPayload> = {}): ProposalPayload {
  const now = new Date("2026-09-28T14:03:07.512Z");
  return {
    id: newProposalId(now, () => Uint8Array.of(0xde, 0xad, 0xbe, 0xef)),
    createdAt: now.toISOString(),
    requestId: "0b7c2f6e-1d7a-4c1e-9b8a-2f4d5e6a7b8c",
    proposer: { subject: "alice", displayName: "Alice Example" },
    target: { kind: "host", id: "host:nas01", name: "nas01" },
    changes: [{ field: "expectedChurn", seen: false, proposed: true }],
    rationale: "Host churns nightly by design.",
    ...over,
  };
}

/** A mutable deep copy of a signed file, for tampering. */
function clone(file: ProposalFileV1): Record<string, any> {
  return JSON.parse(JSON.stringify(file)) as Record<string, any>;
}

/** Flip one character of a base64url string, keeping the 43-char shape. */
function flipChar(value: string, index = 10): string {
  const c = value[index] === "A" ? "B" : "A";
  return value.slice(0, index) + c + value.slice(index + 1);
}

describe("sign → verify round-trip (REQ-PROP-05)", () => {
  test("a signed file verifies as an object, a JSON string and UTF-8 bytes", () => {
    const file = signProposal(payload(), SECRET);
    const text = JSON.stringify(file, null, 2) + "\n";
    for (const input of [file, text, new TextEncoder().encode(text)]) {
      const r = verifyProposal(input, SECRET);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.file).toEqual(file);
    }
  });

  test("the file has the v1 envelope and a 43-char base64url HMAC-SHA256 value", () => {
    const file = signProposal(payload(), SECRET);
    expect(file.format).toBe("pulse-proposal/v1");
    expect(file.signature.alg).toBe("HMAC-SHA256");
    expect(file.signature.value).toHaveLength(43);
    expect(SIGNATURE_VALUE_RE.test(file.signature.value)).toBe(true);
    expect(file.payload).toEqual(payload());
  });

  test("signing is deterministic and stable across key-order permutations of the payload", () => {
    const p = payload();
    const permuted = {
      rationale: p.rationale,
      changes: [{ proposed: true, seen: false, field: "expectedChurn" }],
      target: { name: "nas01", id: "host:nas01", kind: "host" },
      proposer: { displayName: "Alice Example", subject: "alice" },
      requestId: p.requestId,
      createdAt: p.createdAt,
      id: p.id,
    } as ProposalPayload;
    expect(signProposal(permuted, SECRET).signature.value).toBe(signProposal(p, SECRET).signature.value);
  });

  test("an invalid payload is refused with TypeError", () => {
    expect(() => signProposal(payload({ changes: [] }), SECRET)).toThrow(TypeError);
    expect(() => signProposal(payload({ rationale: "short" }), SECRET)).toThrow(TypeError);
  });
});

describe("tamper detection by ordered checks (REQ-PROP-05, REQ-SEC-05)", () => {
  test("an edited payload field keeps the schema valid, so it yields 'signature'", () => {
    const signed = signProposal(payload(), SECRET);
    const edits: ((f: Record<string, any>) => void)[] = [
      (f) => { f["payload"].changes[0].proposed = false; f["payload"].changes[0].seen = true; },
      (f) => { f["payload"].rationale = "Host churns nightly by design!"; },
      (f) => { f["payload"].target = { kind: "host", id: "host:nas02", name: "nas02" }; },
      (f) => { f["payload"].proposer.displayName = "Mallory"; },
      (f) => { f["payload"].id = "p-20260928T140307Z-deadbeee"; },
    ];
    for (const edit of edits) {
      const f = clone(signed);
      edit(f);
      expect(verifyProposal(f, SECRET)).toEqual({ ok: false, reason: "signature" });
    }
  });

  test("a changed format fails the envelope literal, so it yields 'schema'", () => {
    const f = clone(signProposal(payload(), SECRET));
    f["format"] = "pulse-proposal/v2";
    expect(verifyProposal(f, SECRET)).toEqual({ ok: false, reason: "schema" });
  });

  test("an edited signature value: a 43-char flip → 'signature', a 42-char value → 'schema'", () => {
    const signed = signProposal(payload(), SECRET);
    const flipped = clone(signed);
    flipped["signature"].value = flipChar(signed.signature.value);
    expect(verifyProposal(flipped, SECRET)).toEqual({ ok: false, reason: "signature" });
    const short = clone(signed);
    short["signature"].value = signed.signature.value.slice(0, 42);
    expect(verifyProposal(short, SECRET)).toEqual({ ok: false, reason: "schema" });
  });

  test("alg 'HMAC-SHA512' → 'alg'", () => {
    const f = clone(signProposal(payload(), SECRET));
    f["signature"].alg = "HMAC-SHA512";
    expect(verifyProposal(f, SECRET)).toEqual({ ok: false, reason: "alg" });
  });

  test("an extra envelope key or an invalid payload → 'schema'", () => {
    const extra = clone(signProposal(payload(), SECRET));
    extra["extra"] = 1;
    expect(verifyProposal(extra, SECRET)).toEqual({ ok: false, reason: "schema" });
    const badPayload = clone(signProposal(payload(), SECRET));
    badPayload["payload"].changes = [];
    expect(verifyProposal(badPayload, SECRET)).toEqual({ ok: false, reason: "schema" });
  });

  test("a wrong secret → 'signature'", () => {
    expect(verifyProposal(signProposal(payload(), SECRET), OTHER_SECRET)).toEqual({ ok: false, reason: "signature" });
  });

  test("invalid JSON and invalid UTF-8 bytes → 'unparseable'", () => {
    const text = JSON.stringify(signProposal(payload(), SECRET));
    expect(verifyProposal(text.slice(0, -5), SECRET)).toEqual({ ok: false, reason: "unparseable" });
    expect(verifyProposal("", SECRET)).toEqual({ ok: false, reason: "unparseable" });
    expect(verifyProposal(Uint8Array.of(0x7b, 0xff, 0xfe, 0x7d), SECRET)).toEqual({ ok: false, reason: "unparseable" });
    // Valid JSON bytes with a lone continuation byte inside a string are still refused (fatal decode).
    const bytes = new TextEncoder().encode(text);
    const corrupt = new Uint8Array([...bytes.slice(0, 20), 0x80, ...bytes.slice(20)]);
    expect(verifyProposal(corrupt, SECRET)).toEqual({ ok: false, reason: "unparseable" });
  });

  test("verifyProposal never throws for undefined/null/number/array/huge/random inputs", () => {
    const huge = "x".repeat(2 * 1024 * 1024);
    const inputs: unknown[] = [
      undefined, null, 0, 42, Number.NaN, true, [], [1, 2], {}, huge, `"${huge}"`, `[${"1,".repeat(100_000)}1]`,
      new Uint8Array(1024 * 1024), { format: "pulse-proposal/v1", payload: null, signature: null },
      Object.create(null), () => 1, Symbol("s"), 1n,
    ];
    let seed = 7;
    for (let i = 0; i < 200; i += 1) {
      const n = (i * 37) % 300;
      const b = new Uint8Array(n);
      for (let j = 0; j < n; j += 1) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; b[j] = seed & 0xff; }
      inputs.push(b);
    }
    for (const input of inputs) {
      let r: ReturnType<typeof verifyProposal> | undefined;
      expect(() => { r = verifyProposal(input, SECRET); }).not.toThrow();
      expect(r?.ok).toBe(false);
    }
  });
});

describe("secret handling (REQ-SEC-04)", () => {
  test("a 31-byte secret: signProposal throws ProposalSecretError(31) whose message omits the secret", () => {
    const shortText = "s".repeat(20) + "hidden-sec!"; // 31 bytes
    const short = new TextEncoder().encode(shortText);
    expect(short.byteLength).toBe(31);
    let caught: unknown;
    try { signProposal(payload(), short); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ProposalSecretError);
    const err = caught as ProposalSecretError;
    expect(err.length).toBe(31);
    expect(err.code).toBe("PROPOSAL_SECRET_TOO_SHORT");
    expect(err.name).toBe("ProposalSecretError");
    expect(err.message).not.toContain(shortText);
    expect(err.message).not.toContain("hidden-sec");
    expect(JSON.stringify(err)).not.toContain("hidden-sec");
    expect(String(err.stack)).not.toContain("hidden-sec");
  });

  test("a 31-byte secret makes verifyProposal return 'signature' even for a file it would otherwise match", () => {
    const file = signProposal(payload(), SECRET);
    expect(verifyProposal(file, SECRET.slice(0, 31))).toEqual({ ok: false, reason: "signature" });
    expect(verifyProposal(file, new Uint8Array(0))).toEqual({ ok: false, reason: "signature" });
  });

  test("a non-ASCII secret signs identically via TextEncoder and Buffer.from(s, 'utf8')", () => {
    const s = "sécrét-🔑-ünïcødé-0123456789-ßçñ"; // multibyte; ≥ 32 UTF-8 bytes
    const viaEncoder = new TextEncoder().encode(s);
    const viaBuffer = Buffer.from(s, "utf8");
    expect(viaEncoder.byteLength).toBeGreaterThanOrEqual(32);
    const a = signProposal(payload(), viaEncoder);
    const b = signProposal(payload(), viaBuffer);
    expect(a.signature.value).toBe(b.signature.value);
    expect(verifyProposal(a, viaBuffer).ok).toBe(true);
    expect(verifyProposal(b, viaEncoder).ok).toBe(true);
  });

  test("the serialized file never contains the secret (text, hex or base64 forms)", () => {
    const file = signProposal(payload(), SECRET);
    const text = JSON.stringify(file, null, 2);
    const forms = [
      SECRET_TEXT,
      Buffer.from(SECRET).toString("hex"),
      Buffer.from(SECRET).toString("base64"),
      Buffer.from(SECRET).toString("base64url"),
    ];
    for (const form of forms) expect(text).not.toContain(form);
    expect(Object.keys(file).sort()).toEqual(["format", "payload", "signature"]);
    expect(Object.keys(file.signature).sort()).toEqual(["alg", "value"]);
  });
});
