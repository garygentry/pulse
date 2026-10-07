/** exit.test.ts — the outcome→exit-code mapping (00 §2, REQ-CLI-02).
 *
 *  Asserts computeOutcomeExit over the full table: clean → 0; an error finding → 1;
 *  outcomeFailed → 1; a warning without --strict → 0, with --strict → 1; info never
 *  trips 1; and it never returns 2 (total, pure). */

import { expect, test, describe } from "bun:test";

import type { Finding } from "@pulse/core";

import { computeOutcomeExit } from "../src/exit.js";

function finding(severity: Finding["severity"]): Finding {
  return {
    severity,
    code: "secret_literal",
    file: "estate/estate.yaml",
    path: "hosts[0]",
    message: "test finding",
    fix: "do the thing",
  };
}

describe("computeOutcomeExit", () => {
  test("clean → 0", () => {
    expect(computeOutcomeExit({ findings: [], outcomeFailed: false, strict: false })).toBe(0);
  });

  test("any error finding → 1 (even without strict / outcomeFailed)", () => {
    expect(
      computeOutcomeExit({ findings: [finding("error")], outcomeFailed: false, strict: false }),
    ).toBe(1);
  });

  test("outcomeFailed → 1 with no findings", () => {
    expect(computeOutcomeExit({ findings: [], outcomeFailed: true, strict: false })).toBe(1);
  });

  test("a warning without --strict → 0", () => {
    expect(
      computeOutcomeExit({ findings: [finding("warning")], outcomeFailed: false, strict: false }),
    ).toBe(0);
  });

  test("a warning with --strict → 1", () => {
    expect(
      computeOutcomeExit({ findings: [finding("warning")], outcomeFailed: false, strict: true }),
    ).toBe(1);
  });

  test("info never trips 1, even with --strict", () => {
    expect(
      computeOutcomeExit({ findings: [finding("info")], outcomeFailed: false, strict: true }),
    ).toBe(0);
  });

  test("error precedence beats a strict-warning path", () => {
    expect(
      computeOutcomeExit({
        findings: [finding("warning"), finding("error")],
        outcomeFailed: false,
        strict: true,
      }),
    ).toBe(1);
  });

  test("never returns 2 across the table", () => {
    for (const outcomeFailed of [false, true]) {
      for (const strict of [false, true]) {
        for (const findings of [[], [finding("info")], [finding("warning")], [finding("error")]]) {
          const code = computeOutcomeExit({ findings, outcomeFailed, strict });
          expect(code === 0 || code === 1).toBe(true);
        }
      }
    }
  });

  test("pure — does not mutate its inputs", () => {
    const findings = [finding("warning")];
    computeOutcomeExit({ findings, outcomeFailed: false, strict: true });
    expect(findings.length).toBe(1);
    expect(findings[0]!.severity).toBe("warning");
  });
});
