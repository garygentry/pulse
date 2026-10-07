// apps/cli/tests/render.test.ts — the item-010 render composition (05 §5; 01 §2.3; 07 §2.2).
//
// After the format-v2 cutover the CLI calls the public `renderOnly(model, kinds, { findings })`:
// it threads the loader/validation findings into the renderer EXACTLY ONCE (no CLI-local merge),
// narrows the discriminated `RenderResult.ok` before diff/materialize, and on a fatal projection
// writes and diffs nothing. These tests assert that threading, the coordinated three-file web
// output, and the no-write-on-failure contract. Broader write/check/--only coverage lives in
// commands.test.ts; the `--only web` selection lives in render-only.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAndValidate } from "@pulse/core";
import type { Finding } from "@pulse/core";

import { runRender } from "../src/commands/render.js";

const FIXTURES = join(import.meta.dir, "fixtures");
const fixture = (name: string): string => join(FIXTURES, name);

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "pulse-render-it-"));
});
afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

/** Parse the written web-findings.json under an output root. */
function readWebFindings(root: string): Finding[] {
  const parsed = JSON.parse(readFileSync(join(root, "web-findings.json"), "utf8")) as {
    findings: Finding[];
  };
  return parsed.findings;
}

describe("runRender threads findings once into the coordinated web artifacts (05 §5, 07 §2.2)", () => {
  test("a successful render writes all three v2 web artifacts plus the manifest", () => {
    const target = join(out, "rendered");
    const r = runRender(fixture("clean"), { outputRoot: target, mode: "write" });

    expect(r.data).not.toBeNull();
    for (const a of ["web-coverage.json", "web-estate-model.json", "web-findings.json"]) {
      expect(r.data!.filesWritten).toContain(a);
      expect(existsSync(join(target, a))).toBe(true);
    }
    // All three web artifacts carry the one coherent bundleId the renderer stamped.
    const model = JSON.parse(readFileSync(join(target, "web-estate-model.json"), "utf8")) as {
      bundleId: string;
    };
    const coverage = JSON.parse(readFileSync(join(target, "web-coverage.json"), "utf8")) as {
      bundleId: string;
    };
    const findings = JSON.parse(readFileSync(join(target, "web-findings.json"), "utf8")) as {
      bundleId: string;
    };
    expect(/^sha256:[0-9a-f]{64}$/.test(model.bundleId)).toBe(true);
    expect(coverage.bundleId).toBe(model.bundleId);
    expect(findings.bundleId).toBe(model.bundleId);
  });

  test("the result findings are exactly the renderer's merged set (web-findings.json), no CLI re-merge", () => {
    const target = join(out, "rendered");
    const r = runRender(fixture("web-sanitize"), { outputRoot: target, mode: "write" });

    // The renderer raised a web-safety warning for the omitted sensitive channel option.
    const warn = r.findings.filter((f) => f.code === "web_sensitive_channel_option_omitted");
    expect(warn.length).toBe(1); // threaded ONCE, not duplicated by a second CLI merge
    expect(warn[0]!.severity).toBe("warning");

    // The command result findings equal the coordinated web-findings.json artifact on disk: the
    // CLI reports exactly what the renderer merged (loader ∪ renderer), in the same canonical order.
    expect(r.findings).toEqual(readWebFindings(target));
  });

  test("loader findings are threaded verbatim and exactly once (no duplication)", () => {
    const target = join(out, "rendered");
    const loaded = loadAndValidate(fixture("clean"));
    expect(loaded.ok).toBe(true);
    const r = runRender(fixture("clean"), { outputRoot: target, mode: "write" });

    // Every loader finding appears in the result exactly as many times as the loader produced it.
    for (const lf of loaded.findings) {
      const inResult = r.findings.filter((f) => f.code === lf.code && f.message === lf.message);
      const inLoader = loaded.findings.filter((f) => f.code === lf.code && f.message === lf.message);
      expect(inResult.length).toBe(inLoader.length);
    }
    // And the on-disk findings artifact carries the same set the result reports.
    expect(readWebFindings(target)).toEqual(r.findings);
  });
});

describe("runRender performs no diff/write when rendering does not succeed (05 §5, 07 §2.2)", () => {
  test("a validation error surfaces findings, returns no data, and writes nothing", () => {
    const target = join(out, "rendered");
    const r = runRender(fixture("error"), { outputRoot: target, mode: "write" });
    expect(r.findings.some((f) => f.severity === "error")).toBe(true);
    expect(r.data).toBeNull();
    expect(existsSync(target)).toBe(false); // the writer is never reached
  });

  test("a validation error in check mode also diffs nothing and writes nothing", () => {
    const target = join(out, "rendered");
    const r = runRender(fixture("error"), { outputRoot: target, mode: "check" });
    expect(r.data).toBeNull(); // no diff payload produced
    expect(existsSync(target)).toBe(false);
  });
});
