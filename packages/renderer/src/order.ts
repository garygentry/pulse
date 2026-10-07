// packages/renderer/src/order.ts
import type { CollectionClass } from "@pulse/core";

/**
 * Code-point (UTF-16 code-unit) string comparison — raw `<`/`>`, NEVER locale collation
 * (REQ-RND-02, REQ-DET-01). Reproduced from `@pulse/core`'s internal `findings/collect.ts`
 * `compareString` (which is NOT exported on core's barrel — see 06-integration-points.md §4),
 * so the renderer matches core's ordering discipline exactly without a deep import.
 *
 * @param a - Left string.
 * @param b - Right string.
 * @returns `-1` if `a < b`, `1` if `a > b`, `0` if equal (by code point).
 */
export function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The fixed emission order of collection classes (mirrors core's `CollectionClass` order,
 * `model/index.ts:56`). `scrape.ts` groups hosts by class and emits files in THIS order, so no
 * `Map` iteration order ever leaks into the file set (REQ-RND-02). `excluded` is included for
 * completeness but never produces a file (§4.1).
 */
export const COLLECTION_CLASSES = [
  "managed-linux",
  "hypervisor-api",
  "nas-api",
  "probe-only",
  "excluded",
] as const satisfies readonly CollectionClass[];
