/** proposals-canonical.test.ts — canonical JSON and proposal ids (`src/proposals/{canonical,ids}.ts`).
 *
 *  Asserts: the canonical form sorts keys, has no whitespace and matches the 07 §4.1 example; `-0`
 *  normalizes to `0`; every non-canonicalizable value throws TypeError rather than being dropped
 *  (so signer and verifier always agree, REQ-PROP-05); value equality ignores key order; and the id
 *  helpers build the documented format and refuse traversal-bearing names. */

import { describe, expect, test } from "bun:test";

import {
  PROPOSAL_ID_RE,
  canonicalProposalJson,
  newProposalId,
  parseProposalFileName,
  proposalFileName,
  proposalValuesEqual,
  resultFileName,
} from "../src/proposals/index.js";

const DEADBEEF = (): Uint8Array => Uint8Array.of(0xde, 0xad, 0xbe, 0xef);

describe("canonical proposal JSON (REQ-PROP-05)", () => {
  test("output is independent of key order at every level", () => {
    const a = canonicalProposalJson({ x: 1, y: { p: true, q: [1, { b: 2, a: 1 }] } });
    const b = canonicalProposalJson({ y: { q: [1, { a: 1, b: 2 }], p: true }, x: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"x":1,"y":{"p":true,"q":[1,{"a":1,"b":2}]}}');
  });

  test("contains no whitespace outside string values", () => {
    const out = canonicalProposalJson({ k: [1, 2, { z: null }], s: "a b" });
    expect(out).toBe('{"k":[1,2,{"z":null}],"s":"a b"}');
    expect(out.replace(/"a b"/, "")).not.toMatch(/\s/);
  });

  test("reproduces the 07 §4.1 example", () => {
    expect(canonicalProposalJson({ b: [2, 1], a: { y: null, x: "é\n" } })).toBe('{"a":{"x":"é\\n","y":null},"b":[2,1]}');
  });

  test("-0 is written as 0; array order is preserved", () => {
    expect(canonicalProposalJson(-0)).toBe("0");
    expect(canonicalProposalJson({ n: -0 })).toBe('{"n":0}');
    expect(canonicalProposalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  test("literals: null, booleans, strings with JSON escapes", () => {
    expect(canonicalProposalJson(null)).toBe("null");
    expect(canonicalProposalJson(true)).toBe("true");
    expect(canonicalProposalJson(false)).toBe("false");
    expect(canonicalProposalJson('q"\\\u0001')).toBe('"q\\"\\\\\\u0001"');
  });

  test("NaN and ±Infinity throw TypeError", () => {
    expect(() => canonicalProposalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalProposalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalProposalJson({ n: Number.NEGATIVE_INFINITY })).toThrow(TypeError);
  });

  test("an undefined property or array element throws TypeError (never silently dropped)", () => {
    expect(() => canonicalProposalJson({ a: 1, b: undefined })).toThrow(TypeError);
    expect(() => canonicalProposalJson([1, undefined])).toThrow(TypeError);
  });

  test("Date, Map and class instances throw TypeError", () => {
    class Box { readonly v = 1; }
    expect(() => canonicalProposalJson(new Date(0))).toThrow(TypeError);
    expect(() => canonicalProposalJson(new Map([["a", 1]]))).toThrow(TypeError);
    expect(() => canonicalProposalJson({ box: new Box() })).toThrow(TypeError);
  });

  test("a null-prototype object is a plain object", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o["b"] = 1;
    o["a"] = 2;
    expect(canonicalProposalJson(o)).toBe('{"a":2,"b":1}');
  });

  test("a cycle throws TypeError; a shared (non-cyclic) reference does not", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(() => canonicalProposalJson(cyclic)).toThrow(TypeError);
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => canonicalProposalJson(arr)).toThrow(TypeError);
    const shared = { x: 1 };
    expect(canonicalProposalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  test("bigint, function, symbol and undefined throw TypeError", () => {
    expect(() => canonicalProposalJson(1n)).toThrow(TypeError);
    expect(() => canonicalProposalJson({ n: 1n })).toThrow(TypeError);
    expect(() => canonicalProposalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalProposalJson(Symbol("s"))).toThrow(TypeError);
    expect(() => canonicalProposalJson(undefined)).toThrow(TypeError);
  });

  test("proposalValuesEqual treats suppression marks with swapped keys as equal", () => {
    expect(proposalValuesEqual(
      { class: "excluded", rationale: "decommissioned rack" },
      { rationale: "decommissioned rack", class: "excluded" } as { class: "excluded"; rationale: string },
    )).toBe(true);
    expect(proposalValuesEqual(
      { class: "excluded", rationale: "decommissioned rack" },
      { class: "excluded", rationale: "other reason here" },
    )).toBe(false);
    expect(proposalValuesEqual(null, null)).toBe(true);
    expect(proposalValuesEqual(true, false)).toBe(false);
    expect(proposalValuesEqual("fast", "fast")).toBe(true);
    expect(proposalValuesEqual(null, false)).toBe(false);
  });
});

describe("proposal ids (REQ-PROP-05)", () => {
  test("newProposalId with an injected Date and bytes gives the documented id", () => {
    const id = newProposalId(new Date("2026-09-28T14:03:07.512Z"), DEADBEEF);
    expect(id).toBe("p-20260928T140307Z-deadbeef");
    expect(PROPOSAL_ID_RE.test(id)).toBe(true);
  });

  test("newProposalId pads single-digit random bytes and matches the id pattern by default", () => {
    expect(newProposalId(new Date("2026-01-02T03:04:05.000Z"), () => Uint8Array.of(0, 1, 2, 0x0f)))
      .toBe("p-20260102T030405Z-0001020f");
    expect(PROPOSAL_ID_RE.test(newProposalId())).toBe(true);
  });

  test("wrong-length random bytes or an invalid Date throw TypeError", () => {
    const now = new Date("2026-09-28T14:03:07.512Z");
    expect(() => newProposalId(now, () => Uint8Array.of(1, 2, 3))).toThrow(TypeError);
    expect(() => newProposalId(now, () => new Uint8Array(5))).toThrow(TypeError);
    expect(() => newProposalId(new Date(Number.NaN), DEADBEEF)).toThrow(TypeError);
  });

  test("proposalFileName/resultFileName build names for a valid id", () => {
    const id = "p-20260928T140307Z-deadbeef";
    expect(proposalFileName(id)).toBe(`${id}.proposal.json`);
    expect(resultFileName(id)).toBe(`${id}.result.json`);
  });

  test("proposalFileName/resultFileName refuse traversal-bearing or malformed ids", () => {
    for (const bad of ["../x", "p-20260928T140307Z-deadbeef/../x", "", "p-20260928T140307Z-DEADBEEF", "p-20260928T140307Z-deadbeef\n"]) {
      expect(() => proposalFileName(bad)).toThrow(TypeError);
      expect(() => resultFileName(bad)).toThrow(TypeError);
    }
  });

  test("parseProposalFileName extracts the id or returns null", () => {
    expect(parseProposalFileName("p-20260928T140307Z-deadbeef.proposal.json")).toBe("p-20260928T140307Z-deadbeef");
    expect(parseProposalFileName("p-20260928T140307Z-deadbeef.result.json")).toBeNull();
    expect(parseProposalFileName("../p-20260928T140307Z-deadbeef.proposal.json")).toBeNull();
    expect(parseProposalFileName("p-20260928T140307Z-deadbeef.proposal.json.tmp")).toBeNull();
    expect(parseProposalFileName("notes.txt")).toBeNull();
  });
});
