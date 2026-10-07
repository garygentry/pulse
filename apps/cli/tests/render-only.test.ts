// apps/cli/tests/render-only.test.ts — `pulse render --only web` (05 §5; 01 §2.3).
//
// After the item-010 cutover the CLI selects kinds through the public `renderOnly(model, kinds,
// { findings })` rather than rendering the full tree and filtering it. `--only web` must therefore
// emit exactly the three coordinated v2 web artifacts plus a partial manifest listing precisely
// those files, and `--check` over an unwritten/edited root must report drift without writing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runRender } from "../src/commands/render.js";

const FIXTURES = join(import.meta.dir, "fixtures");
const fixture = (name: string): string => join(FIXTURES, name);

const WEB_ARTIFACTS = ["web-coverage.json", "web-estate-model.json", "web-findings.json"] as const;

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "pulse-render-only-"));
});
afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

describe("render --only web (05 §5)", () => {
  test("writes exactly the three web artifacts plus a partial manifest over just those files", () => {
    const target = join(out, "rendered");
    const r = runRender(fixture("clean"), { outputRoot: target, mode: "write", only: ["web"] });

    expect(r.data).not.toBeNull();
    expect(r.data!.filesWritten).toEqual([
      ".rendered-manifest.json",
      "web-coverage.json",
      "web-estate-model.json",
      "web-findings.json",
    ]);

    // No non-web kind leaked into a web-only render.
    expect(existsSync(join(target, "scrape/file_sd/managed-linux.json"))).toBe(false);
    expect(existsSync(join(target, "gatus/config.yaml"))).toBe(false);
    for (const a of WEB_ARTIFACTS) expect(existsSync(join(target, a))).toBe(true);

    // The partial manifest names exactly the three web siblings (it excludes itself).
    const manifest = JSON.parse(
      readFileSync(join(target, ".rendered-manifest.json"), "utf8"),
    ) as { formatVersion: number; files: string[] };
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.files).toEqual([...WEB_ARTIFACTS]);
  });

  test("--only web --check reports no drift against a freshly written web-only tree, then drift after an edit", () => {
    const target = join(out, "rendered");
    runRender(fixture("clean"), { outputRoot: target, mode: "write", only: ["web"] });

    const green = runRender(fixture("clean"), { outputRoot: target, mode: "check", only: ["web"] });
    expect(green.data!.mode).toBe("check");
    expect(green.data!.filesWritten).toEqual([]); // check writes nothing
    expect(green.data!.drift).toEqual([]);
    expect(green.outcomeFailed).toBe(false);

    // Hand-edit a web artifact → a `changed` drift entry, still writing nothing.
    const edited = join(target, "web-estate-model.json");
    writeFileSync(edited, readFileSync(edited, "utf8").replace(/}\s*$/, ', "x":1}\n'), "utf8");
    const drifted = runRender(fixture("clean"), { outputRoot: target, mode: "check", only: ["web"] });
    expect(drifted.data!.drift!.some((d) => d.path === "web-estate-model.json")).toBe(true);
    expect(drifted.outcomeFailed).toBe(true);
    expect(readFileSync(edited, "utf8")).toContain('"x":1'); // the hand-edit is untouched
  });
});
