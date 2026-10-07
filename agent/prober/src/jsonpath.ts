// agent/prober/src/jsonpath.ts
//
// Bounded, wrapped JSONPath evaluation (02-deep-health-prober.md §4.2). The JSONPath
// dependency is pinned in the root/image dependency inputs (jsonpath-plus@10.3.0, matching
// the container install — REQ-BUNDLE-06) and used ONLY here, so it can be swapped without
// touching probe logic. The single project-owned contract enforced in one place is
// "one finite numeric scalar (or numeric string), or a miss".

import { JSONPath } from "jsonpath-plus"; // jsonpath-plus@10.3.0 — pinned (root package.json / image)

/**
 * Evaluate a JSONPath expression against a parsed JSON body and coerce the single result to a
 * finite number, or `undefined` if the path is missing, matches nothing, matches more than one
 * node, or matches a non-numeric / non-finite value (tech-spec §4.2). This is the ONLY place
 * the JSONPath dependency is used, so it can be swapped without touching probe logic.
 *
 * A numeric-looking string (e.g. `"4"`) is accepted and coerced (endpoints sometimes stringify
 * counts); a boolean, object, array, `null`, `NaN`, or `Infinity` is a miss.
 *
 * @param body - The parsed JSON response.
 * @param path - The JSONPath from `responseMapping` (e.g. "$.cameras.recording").
 * @returns The numeric value, or `undefined` for a miss (caller maps `undefined` → "path-miss").
 */
export function evalNumericPath(body: unknown, path: string): number | undefined {
  let result: unknown;
  try {
    // `wrap: false` → `undefined` for no match, the bare value for a single match, an array
    // (length > 1) when multiple nodes match. A malformed path expression throws → caught below.
    result = JSONPath({ path, json: body as object, wrap: false });
  } catch {
    return undefined; // a malformed path expression is treated as a miss (fail-visible)
  }
  if (Array.isArray(result)) {
    // Multiple matched nodes are ambiguous → miss. A single-node match is unwrapped and coerced.
    if (result.length !== 1) return undefined;
    result = result[0];
  }
  return toFiniteNumber(result);
}

/** Coerce a number or non-empty numeric string to a finite number; anything else → undefined. */
function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
