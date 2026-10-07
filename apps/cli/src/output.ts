// apps/cli/src/output.ts — the stdout/stderr / colour / verbosity discipline
// (REQ-CLI-03/05, REQ-OBS-02, REQ-A11Y-01, 04 §6).
//
// The one rule this file enforces: the `--json` machine payload is the ONLY thing ever
// written to stdout; every human-readable byte (progress, findings text, diagnostics)
// goes to stderr. So `--json` stdout is always a single pure, parseable object.

import { formatFindings } from "@pulse/core";
import type { Finding } from "@pulse/core";

/** Human-output detail level, derived from `--verbose`/`--quiet` (REQ-OBS-02). */
export type Verbosity = "quiet" | "normal" | "verbose";

/**
 * The shell's output writer. It owns BOTH streams so the stdout/stderr split is enforced in
 * exactly one place (REQ-CLI-03). Construct via {@link createOutputWriter}. `note`/`detail`/
 * `diagnostic` write to STDERR; `emitJson` is the ONLY method that writes to STDOUT.
 */
export interface OutputWriter {
  /** True when `--json` was passed (machine mode). */
  readonly json: boolean;
  /** Resolved detail level (REQ-OBS-02). */
  readonly verbosity: Verbosity;
  /** True when colour/control sequences are permitted (REQ-CLI-05). */
  readonly color: boolean;

  /**
   * Write the machine payload to STDOUT — the only stdout write in the process (REQ-CLI-03).
   * Called at most once, only in `--json` mode, with `serializeEnvelope(...)`. A no-op when
   * `json` is false (a text-mode run writes nothing to stdout).
   */
  emitJson(payload: string): void;

  /** A normal-priority human line to STDERR (shown at `normal`+; suppressed at `quiet`). */
  note(message: string): void;

  /** A verbose-only human line to STDERR (shown only at `verbose`; REQ-OBS-02). */
  detail(message: string): void;

  /** A diagnostic/finding block to STDERR, always shown (even at `quiet`). */
  diagnostic(message: string): void;
}

/**
 * Decide whether colour/control sequences may be emitted (REQ-CLI-05, REQ-A11Y-01). Colour is
 * OFF when `NO_COLOR` is present and non-empty (the no-color.org convention), OR when the
 * target stream is not a TTY (piped, redirected, CI). Pure — takes the two facts as inputs so
 * it is unit-testable without touching the real environment.
 *
 * @param noColor - `process.env.NO_COLOR` (may be `undefined`).
 * @param isTty   - `process.stderr.isTTY` (human output is on stderr).
 * @returns `true` iff colour is permitted.
 */
export function resolveColor(noColor: string | undefined, isTty: boolean): boolean {
  if (noColor !== undefined && noColor !== "") return false;
  return isTty;
}

/**
 * Render findings for humans and write them to STDERR (never stdout, REQ-CLI-03). Delegates
 * to core's `formatFindings` (no sort — the list is already core-sorted, REQ-VAL-02); a `""`
 * result (no findings) writes nothing. This is a no-op with respect to `--json` stdout, which
 * carries the same findings verbatim in the envelope.
 *
 * @param out - The active writer.
 * @param findings - The command's findings, pre-sorted.
 */
export function reportFindings(out: OutputWriter, findings: readonly Finding[]): void {
  const text = formatFindings(findings);
  if (text.length > 0) out.diagnostic(text);
}

/** Inputs for constructing the writer (all injectable for tests). */
export interface OutputInputs {
  json: boolean;
  verbosity: Verbosity;
  color: boolean;
  /** Sinks — real streams in production, buffers in tests. */
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

/**
 * Build an {@link OutputWriter} that enforces the stdout/stderr split (REQ-CLI-03). In
 * production the sinks are `(s) => process.stdout.write(s)` / `process.stderr.write(s)`; tests
 * inject buffers to assert purity.
 */
export function createOutputWriter(inputs: OutputInputs): OutputWriter {
  const { json, verbosity, color, stdout, stderr } = inputs;
  return {
    json,
    verbosity,
    color,
    emitJson(payload) {
      if (json) stdout(payload); // ONLY stdout write in the whole process (REQ-CLI-03)
    },
    note(message) {
      if (verbosity !== "quiet") stderr(`${message}\n`);
    },
    detail(message) {
      if (verbosity === "verbose") stderr(`${message}\n`);
    },
    diagnostic(message) {
      stderr(`${message}\n`); // always (even quiet): findings + faults are load-bearing
    },
  };
}

/** Map the parsed global flags to a detail level (REQ-OBS-02). `args.ts` already rejects both. */
export function verbosityOf(flags: { verbose: boolean; quiet: boolean }): Verbosity {
  if (flags.verbose) return "verbose";
  if (flags.quiet) return "quiet";
  return "normal";
}
