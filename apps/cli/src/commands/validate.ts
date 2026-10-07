// apps/cli/src/commands/validate.ts — the trust gate (05 §4, REQ-VAL-01/02/03).

import { loadAndValidate } from "@pulse/core";
import type { LoadResult } from "@pulse/core";

import type { CommandResult } from "./result.js";
import type { ValidateData } from "../envelope.js"; // = null (00 §5.1)

/**
 * Run `pulse validate` (REQ-VAL-01): load-and-validate the estate directory and report the
 * resulting findings verbatim.
 *
 * `loadAndValidate` returns a discriminated `LoadResult`:
 *   - `{ ok: true;  model; findings }`  — zero error-severity findings (may carry warn/info).
 *   - `{ ok: false; findings }`         — ≥1 error finding; NO `model` key.
 * `validate` ignores `model` entirely — it only reports findings. Findings arrive already
 * sorted by core `(file, path, code, severity, message)` and are passed through WITHOUT
 * re-sorting (REQ-VAL-02, determinism).
 *
 * `outcomeFailed` is always `false` — validate has no non-finding exit-1 outcome.
 *
 * @param estateDir - resolved estate config directory (`04` config.ts).
 * @returns CommandResult with `data: null` and the core findings verbatim.
 * @throws {ConfigIoError} PROPAGATED from `loadAndValidate` for a usage fault (missing /
 *   not-a-dir / unreadable / invalid-arg) → the shell maps it to exit 2 (REQ-VAL-03). NOT
 *   caught here.
 */
export function runValidate(estateDir: string): CommandResult<ValidateData> {
  const result: LoadResult = loadAndValidate(estateDir);
  // Both arms of LoadResult expose `findings`; no `ok` narrowing is needed to read them.
  return {
    findings: result.findings, // verbatim, pre-sorted — do NOT re-sort (REQ-VAL-02)
    data: null, // ValidateData
    outcomeFailed: false,
  };
}
