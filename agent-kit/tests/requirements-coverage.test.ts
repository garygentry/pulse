// agent-kit/tests/requirements-coverage.test.ts
// Traceability META-GUARD (06-testing-and-eval.md §5.7).
//
// This suite protects the *traceability* of the authored content — not any behavior. Per the
// archetype meta-guard anti-churn norm it is given an ENUMERATED protection set and EXPLICIT
// non-goals below; it is deliberately NOT an open-ended completeness objective. A reviewer
// judges its completeness against the declared `KNOWN_REQ_IDS` / `REQUIRED_P0` sets only.
//
// ── Enumerated protection set (what this guard asserts, and only this) ──────────────────────
//   1. ID validity   — every id in every `ContentUnit.requirements` matches `REQ_ID_RE` and is
//                       in `KNOWN_REQ_IDS` (a committed mirror of the real PRD §3–§4 ids).
//   2. No dangling    — a unit may only claim a requirement this feature actually owns; a typo'd
//                       or invented id (or one belonging to another feature) fails.
//   3. P0 coverage    — every id in `REQUIRED_P0` (the P0 GUIDE/SKILL requirements a content
//                       unit's `requirements[]` array is responsible for) is claimed by >=1 unit.
//
// ── Explicit non-goals (this guard does NOT police, by declaration) ─────────────────────────
//   • It does NOT verify a unit's PROSE satisfies the requirement it claims — that is the job of
//     the per-surface contract locks (§5.3/§5.4/§5.5) and the eval harness (§6).
//   • It does NOT assert coverage of P1/P2 requirements (e.g. REQ-GUIDE-05, REQ-SKILL-05,
//     REQ-ECO-03) — those are optional-by-priority; their absence is a legitimate authoring call.
//   • It does NOT require the STRUCTURAL P0s that no content unit's `requirements[]` owns:
//     REQ-GUIDE-01 (pack production), REQ-GUIDE-06 (create-only), REQ-GUIDE-07 (zero-priming),
//     REQ-SKILL-06 (delivery in native form). Those are proven by `pack-scaffold.test.ts` (§5.5)
//     and the eval harness (§6), not by a `requirements[]` claim — so they are intentionally
//     excluded from `REQUIRED_P0` to keep this guard's universe exactly the content surface.
//   • Its universe is exactly the `ContentUnit.requirements` arrays and the `KNOWN_REQ_IDS` set;
//     it does NOT police requirement ids mentioned in prose or comments anywhere else.

import { describe, expect, test } from "bun:test";
import { manifest } from "../src/content/manifest.js";
import { REQ_ID_RE } from "../src/emit/types.js";

/**
 * The closed set of real agent-kit requirement ids — a committed mirror of PRD §3–§4. Any id a
 * content unit claims must be in this set (no dangling / cross-feature claim). This is the guard's
 * declared universe; it is NOT a completeness objective over P1/P2 requirements.
 */
const KNOWN_REQ_IDS = new Set<string>([
  // §3.1 Guidance Pack
  "REQ-GUIDE-01", "REQ-GUIDE-02", "REQ-GUIDE-03", "REQ-GUIDE-04",
  "REQ-GUIDE-05", "REQ-GUIDE-06", "REQ-GUIDE-07",
  // §3.2 Operator Skills & Subagents
  "REQ-SKILL-01", "REQ-SKILL-02", "REQ-SKILL-03",
  "REQ-SKILL-04", "REQ-SKILL-05", "REQ-SKILL-06",
  // §3.3 Ecosystem Targeting
  "REQ-ECO-01", "REQ-ECO-02", "REQ-ECO-03", "REQ-ECO-04",
  // §3.4 Drift Control & Versioning
  "REQ-DRIFT-01", "REQ-DRIFT-02", "REQ-DRIFT-03", "REQ-DRIFT-04", "REQ-DRIFT-05",
  // §3.5 Eval Harness
  "REQ-EVAL-01", "REQ-EVAL-02", "REQ-EVAL-03", "REQ-EVAL-04",
  // §3.6 Integration Points
  "REQ-INTEG-01", "REQ-INTEG-02", "REQ-INTEG-03", "REQ-INTEG-04", "REQ-INTEG-05",
  // §4.1 Performance
  "REQ-PERF-01", "REQ-PERF-02",
  // §4.2 Security
  "REQ-SEC-01", "REQ-SEC-02", "REQ-SEC-03",
  // §4.3 Observability
  "REQ-OBS-01", "REQ-OBS-02",
  // §4.x Accessibility / Maintainability / Scale
  "REQ-A11Y-01", "REQ-MAINT-01", "REQ-SCALE-01",
]);

/**
 * ENUMERATED: the P0 GUIDE/SKILL requirements a content unit's `requirements[]` array is
 * responsible for claiming (each maps to authored prose in a unit). The structural P0s
 * (GUIDE-01/06/07, SKILL-06) are covered by other suites and are excluded by declaration above.
 */
const REQUIRED_P0 = [
  "REQ-GUIDE-02", "REQ-GUIDE-03", "REQ-GUIDE-04",
  "REQ-SKILL-01", "REQ-SKILL-02", "REQ-SKILL-03", "REQ-SKILL-04",
] as const;

describe("requirements-coverage (meta-guard, enumerated set)", () => {
  const claimed = new Set(manifest.units.flatMap((u) => u.requirements));

  test("every claimed id is well-formed and a real (known) requirement id", () => {
    for (const u of manifest.units) {
      for (const id of u.requirements) {
        expect(id, `unit ${u.id}: malformed requirement id`).toMatch(REQ_ID_RE);
        expect(KNOWN_REQ_IDS.has(id), `unit ${u.id} claims unknown/dangling id ${id}`).toBe(true);
      }
    }
  });

  test("every enumerated P0 GUIDE/SKILL requirement is covered by >=1 unit", () => {
    for (const req of REQUIRED_P0) {
      expect([...claimed], `no unit claims required P0 ${req}`).toContain(req);
    }
  });
});
