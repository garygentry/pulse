/// <reference path="./bun-test.d.ts" />
/**
 * golden.test.ts — REQ-VER-01 / REQ-FIX-05 / REQ-DET-01.
 *
 * Asserts `pulse render --check` is CLEAN (exit 0, no drift) for BOTH committed fixture
 * golden trees. Reuses the CLI's own `--check` (packages/renderer/src/diff.ts) rather than
 * a bespoke comparator (D2, 00 §4.1). Each run uses the fixture dir as CWD (§1.2, 00 §3) so
 * estate/rendered resolve inside the fixture. Drift ⇒ exit 1 ⇒ RED; fix is `bun run
 * golden:update` + git diff-review (REQ-MAINT-01, 00 §8).
 */
import { describe, expect, test } from "bun:test";
import { FIXTURES, STACK_FIXTURE_DIR, envelope, pulse, pulseAt } from "./helpers.js";

/** Assert the `render --check` envelope is clean (exit 0, empty drift) for one already-run CLI. */
function expectNoDrift(name: string, ran: ReturnType<typeof pulse>): void {
  // Exit 0 = clean; exit 1 = drift; exit 2 = tool fault (unreadable manifest/file).
  expect(
    ran.exitCode,
    `render --check drift for ${name}:\n${ran.stdout}\n${ran.stderr}\n` +
      "Fix: `bun run golden:update` then diff-review.",
  ).toBe(0);

  const env = envelope(ran);
  expect(env.ok).toBe(true);
  // The `render --check` data payload carries `drift: DriftEntry[]` (diff.ts); assert empty.
  const drift = (env.data as { drift?: unknown[] }).drift ?? [];
  expect(drift, `unexpected drift entries for ${name}: ${JSON.stringify(drift)}`).toEqual([]);
}

describe("golden: render --check is byte-for-byte clean (REQ-VER-01)", () => {
  for (const name of FIXTURES) {
    test(`${name} fixture has zero drift`, () => {
      // cwd = examples/<name>; no --config (estateDir is CWD-relative, not flag-overridable).
      expectNoDrift(name, pulse(name, "render", ["--check"]));
    });
  }

  // The source-backed stack rendered fixture (07 §3.1) lives under stack/tests/fixtures/, so it is
  // drift-checked with that directory as cwd rather than through the examples-only FIXTURES list.
  test("stack fixture has zero drift", () => {
    expectNoDrift("stack", pulseAt(STACK_FIXTURE_DIR, "render", ["--check"]));
  });
});
