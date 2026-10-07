// src/content/manifest.ts
// REQ-ECO-04, REQ-MAINT-01, REQ-GUIDE-01 — the ordered single-source manifest.
//
// Assembles every authored unit in stable emit order (guidance → skills → subagents; within a
// group, authored order is significant, fixing generated iteration order for determinism —
// REQ-PERF-02). `loadManifest()` asserts each unit targets exactly the first-class set
// (REQ-ECO-04); a unit with a different `targets` fails the build via `ContentValidationError`
// rather than silently under-emitting. This is the only source the emitters and
// `buildGuidancePack()` read.

import type { Manifest, ContentUnit } from "../emit/types.js";
import { FIRST_CLASS_ECOSYSTEMS } from "../emit/types.js";
import { ContentValidationError } from "../emit/errors.js";

import { vocabPrimer } from "./guidance/vocab-primer.js";
import { workflowGuide } from "./guidance/workflow-guide.js";
import { invariants } from "./guidance/invariants.js";
import { pointersIndex } from "./guidance/pointers-index.js";
import { estateAuthoring } from "./skills/estate-authoring.js";
import { renderValidateCoverage } from "./skills/render-validate-coverage.js";
import { coverageInterpretation } from "./skills/coverage-interpretation.js";
import { alertTriage } from "./subagents/alert-triage.js";
import { coverageInterpreter } from "./subagents/coverage-interpreter.js";

/**
 * Every authored unit, in stable emit order. Guidance → skills → subagents; within a group,
 * authored order is significant (determinism, REQ-PERF-02).
 */
const UNITS: readonly ContentUnit[] = [
  vocabPrimer,
  workflowGuide,
  invariants,
  pointersIndex,
  estateAuthoring,
  renderValidateCoverage,
  coverageInterpretation,
  alertTriage,
  coverageInterpreter,
];

/**
 * Assemble the single-source manifest. Enforces the v1 invariant that every unit targets exactly
 * the first-class ecosystems (REQ-ECO-04): a unit with a different `targets` fails the build via
 * `ContentValidationError` rather than silently under-emitting. The `"generic"` best-effort output
 * (REQ-ECO-03) is derived by the generic emitter from the same units, not by adding a target here.
 */
export function loadManifest(): Manifest {
  const expected = [...FIRST_CLASS_ECOSYSTEMS].sort().join(",");
  for (const u of UNITS) {
    const got = [...u.targets].sort().join(",");
    if (got !== expected) {
      throw new ContentValidationError(
        u.id,
        `targets must be the first-class set [${expected}]; got [${got}]`,
      );
    }
  }
  return { units: [...UNITS] };
}

export const manifest: Manifest = loadManifest();
