/**
 * The one-pass finding accumulator plus the deterministic sort (05-findings.md §4, §6).
 * No I/O, no logging, no clock/PID reads — findings are the single observable output
 * (REQ-OBS-01). The sort lives here, in exactly one place, so ordering never depends on
 * which stage ran first or on any Map/Set iteration order (REQ-DET-01).
 */
import type { Finding } from "./index.js";
import type { ZodError } from "zod";
import type { ProvenanceIndex } from "../loader/index.js";
import { zodIssueToFindings } from "./from-zod.js";

/**
 * Code-point (UTF-16 code-unit) string comparison. Deterministic and locale-independent:
 * uses `<` / `>` rather than any locale-collating compare, whose result depends on the host
 * locale and would break byte-stability (REQ-DET-01).
 */
export function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Total ordering over findings: `(file, path, code, severity, message)`, each compared by
 * code point (`compareString`). The first three are the contract sort key; `severity` and
 * `message` are appended so that even findings sharing `(file, path, code)` order identically
 * across runs — the result is independent of the order findings were added (REQ-DET-01).
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

/** Return a new, sorted copy — the input is never mutated. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(compareFindings);
}

/**
 * One-pass accumulator for {@link Finding}s across the whole load+validate pipeline. A single
 * instance is constructed by `loadAndValidate` (03-loader-and-pipeline.md) and passed to the
 * loader, the version check (06), and the semantic/normalize pass (04). Every stage appends
 * findings as it discovers them; the final, sorted array is produced by {@link drain}.
 *
 * Internally an insertion-ordered array (never a Map/Set): iteration order of the buffer is an
 * implementation detail, normalized away by the sort in {@link drain} (REQ-DET-01). Performs
 * no I/O and no logging (REQ-OBS-01).
 */
export class FindingCollector {
  /** Insertion-ordered buffer. Not exposed; callers read via drain()/snapshot(). */
  readonly #buf: Finding[] = [];

  /** Append a single fully-formed finding. */
  add(finding: Finding): void {
    this.#buf.push(finding);
  }

  /** Append many findings in order. */
  addAll(findings: readonly Finding[]): void {
    for (const f of findings) this.#buf.push(f);
  }

  /**
   * Ingest a Zod `safeParse` error: map every `issue` to one or more agent-actionable findings
   * (§5) and append them. Each issue's source `file` is resolved from its path via
   * `prov.lookup(...)` (the merged content spans files).
   */
  addZodError(error: ZodError, prov: ProvenanceIndex): void {
    for (const issue of error.issues) {
      this.addAll(zodIssueToFindings(issue, prov));
    }
  }

  /** True iff at least one appended finding has severity `"error"` (drives LoadResult.ok). */
  hasErrors(): boolean {
    return this.#buf.some((f) => f.severity === "error");
  }

  /** Number of findings accumulated so far (any severity). */
  get size(): number {
    return this.#buf.length;
  }

  /** A non-destructive, sorted copy of the current findings. */
  snapshot(): Finding[] {
    return sortFindings(this.#buf);
  }

  /** Produce the final findings array: a deterministically sorted (§6) copy of the buffer. */
  drain(): Finding[] {
    return sortFindings(this.#buf);
  }
}
