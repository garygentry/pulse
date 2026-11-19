/**
 * The repo gate: the tracked public trees pass the public-safe lint with the committed exceptions. Local
 * planning specs are never scanned here; `bun run lint:public-safe` covers them on a developer machine.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadDenyTerms, loadExceptions } from "../../scripts/public-safe/exceptions.js";
import { formatViolation, scan } from "../../scripts/public-safe/rules.js";
import { TRACKED_ROOTS, walkScanSet } from "../../scripts/public-safe/walk.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

describe("public-safe: tracked set", () => {
  test("tracked roots are exactly contract/ and apps/ios/", () => {
    expect([...TRACKED_ROOTS]).toEqual(["contract", "apps/ios"]);
  });

  test(
    "tracked set passes with the committed exceptions",
    async () => {
      const report = await walkScanSet(REPO_ROOT, "tracked"); // never "tracked+local-specs"
      expect(report.files.some((f) => f.path.startsWith("specs/"))).toBe(false);
      expect(report.localSpecCount).toBeNull();
      expect(report.contractFileCount).toBeGreaterThan(0);
      const { exceptions } = await loadExceptions(REPO_ROOT);
      const { terms } = await loadDenyTerms(REPO_ROOT);
      const result = scan({
        files: report.files,
        exceptions,
        denyTerms: terms,
        contractFileCount: report.contractFileCount,
      });
      // formatViolation output is masked, so a failure message never prints a raw value.
      expect(result.violations.map(formatViolation), "use a placeholder (CONTRIBUTING.md) or add an exception").toEqual(
        [],
      );
    },
    { timeout: 5_000 }, // explicit budget for the lint's share of the suite, not bun's implicit default
  );
});
