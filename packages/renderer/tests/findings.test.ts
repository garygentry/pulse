/** findings.test.ts — the renderer-side finding comparator and sort (02 §6.3).
 *
 *  Asserts: compareFindings is a total order over the 5-key tuple (file, path, code, severity,
 *  message), each by code point; sortFindings returns a new sorted copy and never mutates its
 *  input. */

import { expect, test, describe } from "bun:test";
import type { Finding } from "@pulse/core";

import { compareFindings, sortFindings } from "../src/findings.js";

/** Build a Finding with sensible defaults (tests are transpiled, not type-checked). */
function finding(o: Partial<Finding>): Finding {
  return {
    severity: "error",
    code: "secret_literal",
    file: "estate.yaml",
    path: "",
    message: "",
    fix: "",
    ...o,
  } as Finding;
}

describe("compareFindings", () => {
  test("orders by file first", () => {
    expect(compareFindings(finding({ file: "a.yaml" }), finding({ file: "b.yaml" }))).toBe(-1);
    expect(compareFindings(finding({ file: "b.yaml" }), finding({ file: "a.yaml" }))).toBe(1);
  });

  test("falls through file -> path -> code -> severity -> message in order", () => {
    const base = { file: "f", path: "p", code: "secret_literal" as const, severity: "error" as const, message: "m" };
    // equal on the first four keys, differ on message
    expect(compareFindings(finding({ ...base, message: "a" }), finding({ ...base, message: "b" }))).toBe(-1);
    // differ on severity (code-point: 'error' < 'warning'), earlier keys equal
    expect(
      compareFindings(
        finding({ ...base, severity: "error", message: "z" }),
        finding({ ...base, severity: "warning", message: "a" }),
      ),
    ).toBe(-1);
    // differ on path, later keys should not matter
    expect(
      compareFindings(
        finding({ ...base, path: "a", message: "z" }),
        finding({ ...base, path: "b", message: "a" }),
      ),
    ).toBe(-1);
  });

  test("returns 0 for two identical findings", () => {
    expect(compareFindings(finding({}), finding({}))).toBe(0);
  });

  test("compares each key by code point, not locale", () => {
    // 'Z' < 'a' by code point in the file key
    expect(compareFindings(finding({ file: "Z" }), finding({ file: "a" }))).toBe(-1);
  });
});

describe("sortFindings", () => {
  test("returns a new sorted copy ordered by the 5-key tuple", () => {
    const input = [
      finding({ file: "b.yaml", path: "x" }),
      finding({ file: "a.yaml", path: "z" }),
      finding({ file: "a.yaml", path: "a" }),
    ];
    const out = sortFindings(input);
    expect(out.map((f) => [f.file, f.path])).toEqual([
      ["a.yaml", "a"],
      ["a.yaml", "z"],
      ["b.yaml", "x"],
    ]);
  });

  test("does not mutate the input array", () => {
    const input = [finding({ file: "b.yaml" }), finding({ file: "a.yaml" })];
    const snapshot = input.map((f) => f.file);
    const out = sortFindings(input);
    expect(input.map((f) => f.file)).toEqual(snapshot); // original order intact
    expect(out).not.toBe(input); // fresh array
  });

  test("accepts a readonly input", () => {
    const input: readonly Finding[] = [finding({ file: "b" }), finding({ file: "a" })];
    expect(sortFindings(input).map((f) => f.file)).toEqual(["a", "b"]);
  });
});
