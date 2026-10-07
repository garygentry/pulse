// packages/renderer/src/format.ts
import { stringify as yamlStringify } from "yaml"; // yaml ^2.5.0 (01 §2.1)
import { compareString } from "./order.js";

/**
 * Recursively return a copy of `value` with every plain-object's keys reordered by
 * `compareString`. Arrays are copied element-wise (order preserved). Used by `toCanonicalJson`
 * so key order never depends on insertion order (REQ-RND-02).
 */
export function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((element) => sortKeysDeep(element)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareString)) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted as T;
  }
  return value;
}

/**
 * Serialize a value to canonical JSON: `JSON.stringify(sortKeysDeep(value), null, 2)` with a
 * single trailing newline. Object keys are emitted in raw code-point order at every depth
 * (REQ-RND-02); arrays keep their (already-sorted-by-the-emitter) order. No timestamps, PIDs,
 * hostnames, or absolute paths ever enter `value` (REQ-DET-01).
 *
 * @param value - A JSON-serializable value (must contain no `undefined`-valued keys; the
 *                emitters omit optional keys rather than set `undefined`).
 * @returns Canonical JSON text ending in exactly one `\n`.
 */
export function toCanonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2) + "\n";
}

/**
 * Serialize a value to canonical YAML via the `yaml` library with sorted keys and stable
 * scalar styles, plus a single trailing newline. Uses `sortMapEntries` with an explicit
 * `compareString` key sort and a fixed `lineWidth: 0` (wrapping disabled) so identical input
 * yields byte-identical YAML (REQ-RND-02). Same no-nondeterministic-content rule as JSON.
 *
 * @param value - A YAML-serializable value.
 * @returns Canonical YAML text ending in exactly one `\n`.
 */
export function toCanonicalYaml(value: unknown): string {
  const text = yamlStringify(value, {
    sortMapEntries: (a, b) => compareString(String(a.key), String(b.key)),
    lineWidth: 0,
    // The `yaml` library never emits anchors/aliases unless explicitly requested; keeping
    // aliasDuplicateObjects off guarantees no `&anchor`/`*alias` sneaks in on repeated refs.
    aliasDuplicateObjects: false,
  });
  // `yaml.stringify` already terminates with a single "\n"; normalize defensively so the
  // trailing-newline contract holds regardless of input shape (an empty doc yields "\n").
  return text.endsWith("\n") ? text : text + "\n";
}

/** True for a non-null, non-array plain object (the only shape whose keys we reorder). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
