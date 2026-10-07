/** commands.test.ts — the three read-command handlers + the result seam (05 §4/§5/§6).
 *
 *  Each handler is loadAndValidate-first and returns a CommandResult<D>; none catches
 *  ConfigIoError/RenderIoError (letting them propagate realizes the exit-2 tool-fault
 *  contract). Estate fixtures live under tests/fixtures/; render output goes to a temp dir. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigIoError, loadAndValidate } from "@pulse/core";

import { runValidate } from "../src/commands/validate.js";
import { runRender } from "../src/commands/render.js";
import { runCoverage } from "../src/commands/coverage.js";

const FIXTURES = join(import.meta.dir, "fixtures");
const fixture = (name: string): string => join(FIXTURES, name);

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "pulse-render-"));
});
afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

describe("runValidate (05 §4)", () => {
  test("clean estate → findings [], data null, outcomeFailed false", () => {
    const r = runValidate(fixture("clean"));
    expect(r.findings).toEqual([]);
    expect(r.data).toBeNull();
    expect(r.outcomeFailed).toBe(false);
  });

  test("returns loadAndValidate findings VERBATIM and in the same order (no re-sort)", () => {
    const r = runValidate(fixture("error"));
    // Byte-identical, same order as core produced (REQ-VAL-02).
    expect(r.findings).toEqual(loadAndValidate(fixture("error")).findings);
    expect(r.findings.some((f) => f.severity === "error" && f.code === "missing_field")).toBe(true);
    expect(r.data).toBeNull();
    expect(r.outcomeFailed).toBe(false);
  });

  test("unsupported schema_version → exactly one unsupported_version error finding", () => {
    const r = runValidate(fixture("unsupported"));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.severity).toBe("error");
    expect(r.findings[0]!.code).toBe("unsupported_version");
    expect(r.data).toBeNull();
  });

  test("missing estate dir → ConfigIoError propagates (handler does not catch)", () => {
    expect(() => runValidate(fixture("does-not-exist"))).toThrow(ConfigIoError);
  });
});

describe("runRender (05 §5)", () => {
  test("validation error → findings surfaced, data null, outcomeFailed false, writes NOTHING", () => {
    const target = join(out, "rendered");
    const r = runRender(fixture("error"), { outputRoot: target, mode: "write" });
    expect(r.findings.some((f) => f.severity === "error" && f.code === "missing_field")).toBe(true);
    expect(r.data).toBeNull();
    expect(r.outcomeFailed).toBe(false);
    // Validation front: an invalid estate never reaches the writer.
    expect(existsSync(target)).toBe(false);
  });

  test("write mode → materializes the tree and lists filesWritten", () => {
    const target = join(out, "rendered");
    const r = runRender(fixture("clean"), { outputRoot: target, mode: "write" });
    expect(r.data).not.toBeNull();
    expect(r.data!.mode).toBe("write");
    expect(r.data!.drift).toBeUndefined();
    expect(r.data!.filesWritten).toContain("scrape/file_sd/managed-linux.json");
    expect(r.data!.filesWritten).toContain("gatus/config.yaml");
    expect(r.outcomeFailed).toBe(false);
    // Every listed path exists on disk under the output root.
    for (const p of r.data!.filesWritten) {
      expect(existsSync(join(target, p))).toBe(true);
    }
  });

  test("--check → green ([]) then drift after a hand-edit, still writing NOTHING", () => {
    const target = join(out, "rendered");
    // (1) Write, then (2) check the same estate → no drift.
    runRender(fixture("clean"), { outputRoot: target, mode: "write" });
    const green = runRender(fixture("clean"), { outputRoot: target, mode: "check" });
    expect(green.data!.mode).toBe("check");
    expect(green.data!.filesWritten).toEqual([]);
    expect(green.data!.drift).toEqual([]);
    expect(green.outcomeFailed).toBe(false);

    // (3) Hand-edit a rendered file, then (4) re-check → a `changed` drift entry.
    const edited = join(target, "gatus/config.yaml");
    writeFileSync(edited, readFileSync(edited, "utf8") + "\n# hand-edit\n", "utf8");
    const drifted = runRender(fixture("clean"), { outputRoot: target, mode: "check" });
    expect(drifted.data!.drift!.length).toBeGreaterThan(0);
    expect(drifted.data!.drift!.some((d) => d.path === "gatus/config.yaml" && d.kind === "changed")).toBe(true);
    expect(drifted.outcomeFailed).toBe(true);
    // --check writes nothing: the hand-edit is still on disk untouched.
    expect(readFileSync(edited, "utf8")).toContain("# hand-edit");
  });

  test("--only narrows the render to the named kinds (plus the partial manifest)", () => {
    const target = join(out, "rendered");
    const r = runRender(fixture("clean"), { outputRoot: target, mode: "write", only: ["gatus"] });
    // renderOnly emits the selected kind plus a manifest ledger over exactly that partial set.
    expect(r.data!.filesWritten).toEqual([".rendered-manifest.json", "gatus/config.yaml"]);
    // Non-listed kinds are not written under a narrowed render.
    expect(existsSync(join(target, "scrape/file_sd/managed-linux.json"))).toBe(false);
    expect(existsSync(join(target, "gatus/config.yaml"))).toBe(true);
  });

  test("--only agent writes the managed-linux agent config (plus the partial manifest)", () => {
    const target = join(out, "rendered");
    const r = runRender(fixture("clean"), { outputRoot: target, mode: "write", only: ["agent"] });
    expect(r.data!.filesWritten).toEqual([".rendered-manifest.json", "agent/web-01.yaml"]);
    expect(existsSync(join(target, "agent/web-01.yaml"))).toBe(true);
    expect(existsSync(join(target, "gatus/config.yaml"))).toBe(false);
  });

  test("secret literal → a secret_literal error finding surfaces (exit 1), writes NOTHING", () => {
    const target = join(out, "rendered");
    const r = runRender(fixture("secret-literal"), { outputRoot: target, mode: "write" });
    expect(r.findings.some((f) => f.severity === "error" && f.code === "secret_literal")).toBe(true);
    expect(r.data).toBeNull();
    expect(existsSync(target)).toBe(false);
  });

  test("unsupported schema_version → single unsupported_version finding, writes NOTHING", () => {
    const target = join(out, "rendered");
    const r = runRender(fixture("unsupported"), { outputRoot: target, mode: "write" });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.code).toBe("unsupported_version");
    expect(existsSync(target)).toBe(false);
  });

  test("missing estate dir → ConfigIoError propagates (handler does not catch)", () => {
    expect(() =>
      runRender(fixture("does-not-exist"), { outputRoot: join(out, "rendered"), mode: "write" }),
    ).toThrow(ConfigIoError);
  });
});

describe("runCoverage (05 §6)", () => {
  test("gap → outcomeFailed true; covered/suppressed classified; suppressed never a gap", () => {
    const r = runCoverage(fixture("gap"));
    const names = (bucket: { name: string }[]): string[] => bucket.map((e) => e.name);
    expect(names(r.data!.gaps)).toContain("web-01/orphan-svc");
    expect(names(r.data!.covered)).toContain("web-01");
    expect(names(r.data!.suppressed)).toContain("legacy-box");
    // A suppressed entity is NEVER in gaps (REQ-COV-02).
    expect(names(r.data!.gaps)).not.toContain("legacy-box");
    expect(r.outcomeFailed).toBe(true);
  });

  test("clean estate → no gaps, outcomeFailed false", () => {
    const r = runCoverage(fixture("clean"));
    expect(r.data!.gaps).toEqual([]);
    expect(r.outcomeFailed).toBe(false);
  });

  test("needs no prior render — classifies with no outputRoot read (REQ-COV-03)", () => {
    // runCoverage takes only estateDir; it has no outputRoot parameter and reads no rendered
    // tree. Running against a fixture whose sibling `rendered/` never existed still classifies.
    expect(existsSync(join(FIXTURES, "gap", "rendered"))).toBe(false);
    const r = runCoverage(fixture("gap"));
    expect(r.data!.covered.length + r.data!.gaps.length + r.data!.suppressed.length).toBeGreaterThan(0);
  });

  test("unsupported schema_version → single unsupported_version finding, data null", () => {
    const r = runCoverage(fixture("unsupported"));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.code).toBe("unsupported_version");
    expect(r.data).toBeNull();
    expect(r.outcomeFailed).toBe(false);
  });

  test("missing estate dir → ConfigIoError propagates (handler does not catch)", () => {
    expect(() => runCoverage(fixture("does-not-exist"))).toThrow(ConfigIoError);
  });
});
