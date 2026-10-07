// apps/cli/src/commands/coverage.ts — declared-but-unmonitored is a failing check
// (05 §6, REQ-COV-01/02/03).

import { loadAndValidate } from "@pulse/core";
import type { EstateModel, LoadResult } from "@pulse/core";
import { computeCoverage } from "@pulse/renderer";
import type { CoverageReport } from "@pulse/renderer";

import type { CommandResult } from "./result.js";
import type { CoverageData } from "../envelope.js"; // 00 §5.1

/**
 * Run `pulse coverage` (REQ-COV-01/02/03).
 *
 *  1. `loadAndValidate(estateDir)` — validation FRONT (REQ-VAL-02). On `ok: false` STOP:
 *     emit findings, no `data`, exit 1. Coverage is meaningless over an invalid estate.
 *  2. On `ok: true`, `computeCoverage(model)` → `CoverageReport`: three disjoint, sorted
 *     buckets over every declared entity. It reuses the SAME estate→artifact mapping the
 *     renderer uses (REQ-COV-03) — no on-disk read under `outputRoot`.
 *  3. Map `CoverageReport` → `CoverageData` (identical field names, `00 §5.1`). A NON-empty
 *     `gaps` ⇒ `outcomeFailed = true` (exit 1, REQ-COV-01). `suppressed` entries are shown as
 *     deliberate and NEVER counted as gaps (REQ-COV-02); they never affect the exit code.
 *
 * @param estateDir - resolved estate directory.
 * @returns CommandResult<CoverageData> with the load findings verbatim and the three buckets.
 * @throws {ConfigIoError} PROPAGATED from `loadAndValidate` → shell exit 2 (05 §3.3).
 */
export function runCoverage(estateDir: string): CommandResult<CoverageData> {
  const loaded: LoadResult = loadAndValidate(estateDir);

  if (!loaded.ok) {
    return { findings: loaded.findings, data: null, outcomeFailed: false };
  }

  const model: EstateModel = loaded.model;
  const report: CoverageReport = computeCoverage(model);

  return {
    findings: loaded.findings, // warn/info only on ok:true; verbatim
    data: {
      covered: report.covered,
      gaps: report.gaps,
      suppressed: report.suppressed,
    },
    // A declared, non-suppressed, unmonitored entity is a FAILING check (REQ-COV-01).
    outcomeFailed: report.gaps.length > 0,
  };
}
