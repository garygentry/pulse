// agent-kit/tests/severity-contract.test.ts
// severity-taxonomy contract lock (06-testing-and-eval.md §5.5; REQ-INTEG-05).
//
// Reads alerting's published `severity-taxonomy.json` by path (05 §6.4) and asserts the severity
// slot the alert-triage subagent (REQ-SKILL-04/05) renders from matches it exactly: the same
// severities in taxonomy order, `deadman` NOT presented as a fourth severity (it is a rule
// family, not a routable severity — mirrors alerting's own tri-view conformance test), and a
// declared contractVersion equal to the artifact's. A taxonomy bump fails the build.
//
// Discipline (spec §1): GATING — reads the REAL artifact (no mock); a missing/malformed file
// throws (via severityTaxonomy) and the suite fails RED, never self-skips.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { severityTaxonomy, severityContractVersion } from "../src/slots/severity.js"; // authoritative (04 §4)

/** The real published artifact, read by path (never mocked). */
const TAXONOMY = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../../stack/alerting/contract/severity-taxonomy.json"),
    "utf8",
  ),
) as { contractVersion: number; severities: { name: string }[] };

// The severity slot the content renders from (readonly SeverityDef[], taxonomy order).
const severitySlot = severityTaxonomy();

describe("severity-contract (REQ-INTEG-05)", () => {
  test("slot enumerates exactly the taxonomy severities, in taxonomy order", () => {
    expect(severitySlot.map((s) => s.name)).toEqual(TAXONOMY.severities.map((s) => s.name));
    // The taxonomy is exactly the three response-oriented levels (critical/warning/info).
    expect(severitySlot.map((s) => s.name)).toEqual(["critical", "warning", "info"]);
  });

  test("deadman is NOT presented as a fourth severity", () => {
    expect(severitySlot.map((s) => s.name)).not.toContain("deadman");
    expect(severitySlot).toHaveLength(3);
  });

  test("declared contractVersion == taxonomy contractVersion", () => {
    expect(severityContractVersion()).toBe(TAXONOMY.contractVersion);
  });
});
