import type { FindingCode } from "./codes.js";

export type { FindingCode } from "./codes.js";

/** Finding severity (REQ-VAL-04). Any `error` forces LoadResult.ok === false; the
 *  severity→exit-code (0/1/2) mapping is owned by pulse-cli. */
export type Severity = "error" | "warning" | "info";

/** An agent-actionable finding (REQ-VAL-03). Names the file, the field/path, a
 *  human-readable problem, and a fix path. This is the primary, structured output of
 *  the contract (REQ-VAL-05). */
export interface Finding {
  /** Severity class (REQ-VAL-04). */
  severity: Severity;
  /** Stable machine code (REQ-VAL-05); one of FINDING_CODES. */
  code: FindingCode;
  /** Source file, relative to the loaded directory (matches Provenance.file). */
  file: string;
  /** snake_case YAML field path (§1). Empty string for a file/estate-level finding. */
  path: string;
  /** Human-readable problem statement. */
  message: string;
  /** What to change — the fix path (REQ-VAL-03, CON-04). */
  fix: string;
}
