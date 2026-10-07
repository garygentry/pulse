/** version.test.ts — checkVersion truth table (06-versioning-and-compat.md, 07 §3.5 version).
 *
 *  Asserts: 1 → {ok:true,major:1}; undefined/"1"/1.5/NaN → MISSING_VERSION;
 *  2/0 → UNSUPPORTED_VERSION; never throws for ANY input (object/array/null included); every
 *  version finding is severity "error", path "estate.schema_version", file = the passed file. */

import { expect, test, describe } from "bun:test";

import { checkVersion } from "../src/version/index.js";
import { FINDING_CODES } from "../src/findings/codes.js";

const FILE = "estate.yaml";

describe("checkVersion — supported major", () => {
  test("1 → { ok:true, major:1 }", () => {
    const vc = checkVersion(1, FILE);
    expect(vc).toEqual({ ok: true, major: 1 });
  });
});

describe("checkVersion — MISSING_VERSION (absent / not an integer major)", () => {
  const cases: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ['"1" (string)', "1"],
    ["1.5 (non-integer)", 1.5],
    ["NaN", NaN],
  ];
  for (const [label, input] of cases) {
    test(`${label} → one MISSING_VERSION error finding`, () => {
      const vc = checkVersion(input, FILE);
      expect(vc.ok).toBe(false);
      if (vc.ok) return;
      expect(vc.finding.code).toBe(FINDING_CODES.MISSING_VERSION);
      expect(vc.finding.severity).toBe("error");
      expect(vc.finding.path).toBe("estate.schema_version");
      expect(vc.finding.file).toBe(FILE);
    });
  }
});

describe("checkVersion — UNSUPPORTED_VERSION (well-formed integer outside the set)", () => {
  for (const input of [2, 0, -1, 99]) {
    test(`${input} → one UNSUPPORTED_VERSION error finding naming supported version(s)`, () => {
      const vc = checkVersion(input, FILE);
      expect(vc.ok).toBe(false);
      if (vc.ok) return;
      expect(vc.finding.code).toBe(FINDING_CODES.UNSUPPORTED_VERSION);
      expect(vc.finding.severity).toBe("error");
      expect(vc.finding.path).toBe("estate.schema_version");
      expect(vc.finding.file).toBe(FILE);
      // Names the supported major (1) so the fix is actionable (06 §4.1).
      expect(vc.finding.fix).toContain("1");
    });
  }
});

describe("checkVersion — total function (never throws)", () => {
  const weird: unknown[] = [
    undefined,
    null,
    {},
    { schema_version: 1 },
    [],
    [1, 2],
    "",
    "two",
    Infinity,
    -Infinity,
    true,
    Symbol("x"),
    () => 1,
  ];
  for (const input of weird) {
    test(`does not throw for ${String(typeof input)} input`, () => {
      expect(() => checkVersion(input, FILE)).not.toThrow();
      // and always returns a well-formed VersionCheck
      const vc = checkVersion(input, FILE);
      expect(typeof vc.ok).toBe("boolean");
    });
  }

  test("the passed file is never rewritten to an absolute path", () => {
    const vc = checkVersion(2, "sub/estate.yaml");
    expect(vc.ok).toBe(false);
    if (vc.ok) return;
    expect(vc.finding.file).toBe("sub/estate.yaml");
  });
});
