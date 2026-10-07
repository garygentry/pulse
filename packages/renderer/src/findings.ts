// packages/renderer/src/findings.ts
import type { Finding } from "@pulse/core";
import { compareString } from "./order.js";

/**
 * Total ordering over findings by `(file, path, code, severity, message)`, each compared by
 * code point — reproduced from core's `compareFindings` (`findings/collect.ts`, not on the
 * barrel) so renderer findings sort identically to loader findings when merged (REQ-DET-01).
 */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    compareString(a.file, b.file) ||
    compareString(a.path, b.path) ||
    compareString(a.code, b.code) ||
    compareString(a.severity, b.severity) ||
    compareString(a.message, b.message)
  );
}

/** Return a new, sorted copy of `findings` (input never mutated). */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(compareFindings);
}
