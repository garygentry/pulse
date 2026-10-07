/// <reference path="./bun-test.d.ts" />
/**
 * estate.test.ts — REQ-VER-02 / REQ-FIX-02 / REQ-FIX-03.
 *
 * Asserts each committed fixture estate `validate`s with zero findings and `coverage`s
 * clean via the CLI's 0/1/2 exit contract (00 §2.2). Each run uses the fixture dir as CWD
 * (§1.2, 00 §3). An error finding or a coverage gap ⇒ exit 1 ⇒ RED (fix estate.yaml, 00 §8).
 * Drives Pulse only through documented verbs (D9, CON-02, REQ-RUN-10).
 */
import { describe, expect, test } from "bun:test";
import { FIXTURES, envelope, pulse } from "./helpers.js";

describe("estate: validate is clean (REQ-VER-02, REQ-FIX-02)", () => {
  for (const name of FIXTURES) {
    test(`${name} fixture validates with zero findings`, () => {
      const ran = pulse(name, "validate");
      expect(ran.exitCode, `validate findings for ${name}:\n${ran.stdout}`).toBe(0);
      const env = envelope(ran);
      expect(env.ok).toBe(true);
      expect(env.findings, `unexpected findings for ${name}`).toEqual([]);
    });
  }
});

describe("estate: coverage is clean (REQ-VER-02, REQ-FIX-03)", () => {
  for (const name of FIXTURES) {
    test(`${name} fixture has no coverage gaps`, () => {
      const ran = pulse(name, "coverage");
      expect(ran.exitCode, `coverage gap for ${name}:\n${ran.stdout}`).toBe(0);
      const env = envelope(ran);
      expect(env.ok).toBe(true);
      // coverage `data.gaps` is the declared-but-unmonitored set (apps/cli/src/commands/coverage.ts);
      // suppressed entries are deliberate and NEVER gaps (REQ-COV-02). Assert gaps empty.
      const gaps = (env.data as { gaps?: unknown[] }).gaps ?? [];
      expect(gaps, `coverage gaps for ${name}: ${JSON.stringify(gaps)}`).toEqual([]);
    });
  }
});
