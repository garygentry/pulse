/** golden.test.ts — one-pass multi-finding + committed golden files (07 §3.4, SC-02).
 *
 *  ── A NOTE ON "ALL FIVE IN ONE CALL" ────────────────────────────────────────────────────────
 *  07 §3.4 asks that `broken-min/` surface all five of UNKNOWN_FIELD, MISSING_FIELD,
 *  MISSING_RATIONALE, SECRET_LITERAL, UNRESOLVED_HOST in a single `loadAndValidate` call. The
 *  implemented pipeline (03 §4.6) SHORT-CIRCUITS on a shape
 *  failure — "Shape failure means no trustworthy body — return the findings collected so far" —
 *  so semantic validation (Phase 6) never runs when the document has a shape defect. Two of the
 *  five codes are shape-layer (UNKNOWN_FIELD, MISSING_FIELD) and three are semantic-layer, so no
 *  single fixture can emit all five in one call under this design (flagged in item 011's
 *  progress log). This suite therefore proves one-pass multi-finding at EACH layer and covers
 *  all five codes with file+path+fix across the pair:
 *    • broken-min/       → both shape codes in one call (real one-pass shape collection)
 *    • broken-semantic/  → the three semantic codes in one call (real one-pass semantic
 *                          collection; a shape-CLEAN document so Phase 6 runs)
 *  Golden files pin the serialized sorted findings and the valid-min model; drift fails. */

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadAndValidate, FINDING_CODES } from "../src/index.js";
import type { Finding } from "../src/index.js";

const FIXTURES = join(import.meta.dir, "fixtures");
const GOLDEN = join(import.meta.dir, "golden");

/** A path is snake_case iff it has no uppercase letters and only uses the YAML-path alphabet
 *  (`a-z0-9_`, dotted segments, `[n]` indices). */
const SNAKE_PATH = /^[a-z0-9_]+(\[\d+\]|\.[a-z0-9_]+)*(\.[a-z0-9_]+)*$/;

function byCode(findings: readonly Finding[], code: string): Finding | undefined {
  return findings.find((f) => f.code === code);
}

/** Assert a finding exists and carries a non-empty file, a snake_case path, and a fix. */
function expectActionable(findings: readonly Finding[], code: string): void {
  const f = byCode(findings, code);
  expect(f, `expected a finding with code ${code}`).toBeDefined();
  if (!f) return;
  expect(f.file.length).toBeGreaterThan(0);
  expect(f.path.length).toBeGreaterThan(0);
  expect(f.path).toMatch(SNAKE_PATH);
  expect(f.fix.length).toBeGreaterThan(0);
}

/** Compare a fresh serialization to a committed golden; drift fails (a golden is regenerated
 *  only as a deliberate, reviewed act). */
function expectMatchesGolden(actual: unknown, goldenFile: string): void {
  const serialized = JSON.stringify(actual, null, 2);
  const committed = readFileSync(join(GOLDEN, goldenFile), "utf8").trimEnd();
  expect(serialized).toBe(committed);
}

describe("broken-min — both shape codes in one pass (SC-02, shape layer)", () => {
  const res = loadAndValidate(join(FIXTURES, "broken-min"));

  test("ok is false", () => {
    expect(res.ok).toBe(false);
  });

  test("UNKNOWN_FIELD and MISSING_FIELD both surface, each actionable", () => {
    expectActionable(res.findings, FINDING_CODES.UNKNOWN_FIELD);
    expectActionable(res.findings, FINDING_CODES.MISSING_FIELD);
    // The missing field is the managed-linux host's exporter_ports.
    expect(byCode(res.findings, FINDING_CODES.MISSING_FIELD)!.path).toContain("exporter_ports");
  });

  test("serialized sorted findings match the committed golden", () => {
    expectMatchesGolden(res.findings, "broken-min.findings.golden.json");
  });
});

describe("broken-semantic — the three semantic codes in one pass (SC-02, semantic layer)", () => {
  const res = loadAndValidate(join(FIXTURES, "broken-semantic"));

  test("ok is false", () => {
    expect(res.ok).toBe(false);
  });

  test("MISSING_RATIONALE, SECRET_LITERAL, UNRESOLVED_HOST all surface, each actionable", () => {
    expectActionable(res.findings, FINDING_CODES.MISSING_RATIONALE);
    expectActionable(res.findings, FINDING_CODES.SECRET_LITERAL);
    expectActionable(res.findings, FINDING_CODES.UNRESOLVED_HOST);
  });

  test("serialized sorted findings match the committed golden", () => {
    expectMatchesGolden(res.findings, "broken-semantic.findings.golden.json");
  });
});

describe("all five broken-config codes are covered with file+path+fix (SC-02)", () => {
  test("across the broken-min + broken-semantic pair", () => {
    const shape = loadAndValidate(join(FIXTURES, "broken-min")).findings;
    const semantic = loadAndValidate(join(FIXTURES, "broken-semantic")).findings;
    const all = [...shape, ...semantic];
    for (const code of [
      FINDING_CODES.UNKNOWN_FIELD,
      FINDING_CODES.MISSING_FIELD,
      FINDING_CODES.MISSING_RATIONALE,
      FINDING_CODES.SECRET_LITERAL,
      FINDING_CODES.UNRESOLVED_HOST,
    ]) {
      expectActionable(all, code);
    }
  });
});

describe("valid-min model golden (determinism-backed golden testing)", () => {
  test("the normalized EstateModel matches the committed golden", () => {
    const res = loadAndValidate(join(FIXTURES, "valid-min"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expectMatchesGolden(res.model, "valid-min.model.golden.json");
  });
});
