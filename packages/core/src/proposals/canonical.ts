/** Canonical JSON for proposal signing and value equality (browser-safe). */

import type { ProposalValue } from "./schema.js";

/**
 * Deterministic JSON for signing and deep equality. Rules:
 * - `null`, booleans: literal `null`/`true`/`false`.
 * - numbers: finite only (`NaN`/`±Infinity` → TypeError); `-0` → `0`; otherwise `JSON.stringify(n)`.
 * - strings: `JSON.stringify(s)` escaping (no Unicode normalization).
 * - arrays: element order preserved; `undefined` elements → TypeError.
 * - plain objects: keys sorted by UTF-16 code unit (`Array.prototype.sort()` default), `"k":v` joined by `,`;
 *   a property whose value is `undefined` → TypeError (never silently dropped, so signer and verifier agree).
 * - anything else (bigint, function, symbol, Date, Map, class instances, cycles) → TypeError.
 * No whitespace anywhere. Pure; browser-safe.
 * @throws TypeError on a non-canonicalizable value. That is a programming fault: callers pass zod-parsed data.
 */
export function canonicalProposalJson(value: unknown): string {
  const stack = new Set<object>();
  const walk = (v: unknown): string => {
    if (v === null) return "null";
    switch (typeof v) {
      case "boolean": return v ? "true" : "false";
      case "number":
        if (!Number.isFinite(v)) throw new TypeError("non-finite number");
        return Object.is(v, -0) ? "0" : JSON.stringify(v);
      case "string": return JSON.stringify(v);
      case "object": break;
      default: throw new TypeError(`unsupported type: ${typeof v}`);
    }
    const o = v as object;
    if (stack.has(o)) throw new TypeError("cycle");
    stack.add(o);
    let out: string;
    if (Array.isArray(o)) {
      out = `[${o.map((e) => { if (e === undefined) throw new TypeError("undefined element"); return walk(e); }).join(",")}]`;
    } else {
      const proto = Object.getPrototypeOf(o);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("non-plain object");
      const rec = o as Record<string, unknown>;
      out = `{${Object.keys(rec).sort().map((k) => {
        if (rec[k] === undefined) throw new TypeError(`undefined property: ${k}`);
        return `${JSON.stringify(k)}:${walk(rec[k])}`;
      }).join(",")}}`;
    }
    stack.delete(o);
    return out;
  };
  return walk(value);
}

/** Deep equality of two proposal values (key order irrelevant): canonical JSON equality. */
export function proposalValuesEqual(a: ProposalValue, b: ProposalValue): boolean {
  return canonicalProposalJson(a) === canonicalProposalJson(b);
}
