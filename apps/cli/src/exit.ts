// apps/cli/src/exit.ts — the 0/1/2 exit-code contract and the outcome→exit mapping (00 §2).

import type { Finding } from "@pulse/core";

/**
 * The 0/1/2 exit-code contract (REQ-CLI-02, charter invariant 7). This is a PUBLIC
 * contract a scheduled/automated run keys on:
 *   0 — clean: no error finding, no coverage gap, no drift, no render refusal, no clobber.
 *   1 — findings/outcome present: ≥1 error-severity finding, OR a coverage gap, drift, or
 *       init would-clobber. With `--strict`, warning-severity is promoted to 1 (REQ-CLI-02a).
 *   2 — tool fault ONLY: a thrown `ConfigIoError`, any unexpected exception, or invalid CLI
 *       usage (unknown verb/flag) (REQ-CLI-02b). NEVER produced by `computeOutcomeExit`.
 */
export type ExitCode = 0 | 1 | 2;

/**
 * The inputs that drive the outcome exit code. `findings` are core `Finding[]` verbatim;
 * `outcomeFailed` is the non-finding exit-1 signal (a coverage gap, `--check` drift, or an
 * init would-clobber — none of which is a `Finding`); `strict` promotes warnings to exit 1.
 */
export interface OutcomeInputs {
  /** The command's core findings (verbatim, pre-sorted). */
  findings: readonly Finding[];
  /** A non-finding exit-1 outcome (gap / drift / would-clobber). */
  outcomeFailed: boolean;
  /** When true, a warning-severity finding is promoted to exit 1 (REQ-CLI-02a). */
  strict: boolean;
}

/**
 * Map an outcome to its exit code (REQ-CLI-02). Total and pure: NEVER returns 2 (tool faults
 * are thrown and caught at the CLI's single top-level catch, which owns exit 2). Precedence:
 *   1. any error-severity finding      → 1
 *   2. an `outcomeFailed` signal        → 1
 *   3. `strict` && any warning finding  → 1
 *   4. otherwise                        → 0
 * `info` findings never trip exit 1.
 */
export function computeOutcomeExit(inputs: OutcomeInputs): 0 | 1 {
  if (inputs.findings.some((f) => f.severity === "error")) return 1;
  if (inputs.outcomeFailed) return 1;
  if (inputs.strict && inputs.findings.some((f) => f.severity === "warning")) return 1;
  return 0;
}
