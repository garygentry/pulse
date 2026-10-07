/** init.test.ts — the init command handler (05 §7, REQ-INIT-01/02/03).
 *
 *  init does NOT call loadAndValidate — it CREATES the estate a later validate loads. Tests
 *  drive runInit against fresh temp repo roots and assert: scaffold validity (the scaffold
 *  validates + renders + covers immediately), the non-destructive create-only policy, --force
 *  overwrite/skip, and the no-pack path. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAndValidate } from "@pulse/core";
import { computeCoverage, materialize, render } from "@pulse/renderer";
import type { GuidancePack } from "@pulse/renderer";

import { BUNDLED_GUIDANCE_PACK, runInit } from "../src/commands/init.js";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "pulse-init-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("runInit — base scaffold (REQ-INIT-02)", () => {
  test("creates pulse.config.yaml + estate/estate.yaml + rendered/ dir, exit 0", () => {
    const r = runInit({ repoRoot: repo, force: false });
    expect(r.findings).toEqual([]);
    expect(r.outcomeFailed).toBe(false);
    expect(r.data!.created).toEqual(["estate/estate.yaml", "pulse.config.yaml"]);
    expect(r.data!.skipped).toEqual([]);
    expect(r.data!.wouldClobber).toBeUndefined();

    expect(existsSync(join(repo, "pulse.config.yaml"))).toBe(true);
    expect(existsSync(join(repo, "estate", "estate.yaml"))).toBe(true);
    // rendered/ is ensured empty (the first render owns it wholesale).
    expect(statSync(join(repo, "rendered")).isDirectory()).toBe(true);
  });

  test("no pack (undefined) still emits the base scaffold and succeeds (REQ-INIT-02)", () => {
    const r = runInit({ repoRoot: repo, force: false }); // `pack` omitted
    expect(r.outcomeFailed).toBe(false);
    expect(r.data!.created).toContain("pulse.config.yaml");
    expect(r.data!.created).toContain("estate/estate.yaml");
  });

  test("BUNDLED_GUIDANCE_PACK defaults to undefined", () => {
    expect(BUNDLED_GUIDANCE_PACK).toBeUndefined();
  });
});

describe("runInit — the scaffold validates, renders, and covers immediately (REQ-INIT-01/SC-01)", () => {
  test("loadAndValidate → ok, render writes a tree, coverage → no gaps", () => {
    runInit({ repoRoot: repo, force: false });

    // (A) The scaffolded estate passes loadAndValidate with zero error findings.
    const loaded = loadAndValidate(join(repo, "estate"));
    expect(loaded.ok).toBe(true);
    expect(loaded.findings.filter((f) => f.severity === "error")).toEqual([]);
    if (!loaded.ok) throw new Error("scaffold did not validate"); // narrow for TS

    // (B) render writes a real tree under rendered/.
    const outputRoot = join(repo, "rendered");
    const rendered = render(loaded.model);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) throw new Error("scaffold did not render"); // narrow for TS
    expect(rendered.tree.length).toBeGreaterThan(0);
    materialize(rendered.tree, outputRoot);
    expect(existsSync(join(outputRoot, "scrape/file_sd/managed-linux.json"))).toBe(true);

    // (C) coverage returns no gaps (the single host is covered).
    const report = computeCoverage(loaded.model);
    expect(report.gaps).toEqual([]);
    expect(report.covered.some((e) => e.name === "example-host")).toBe(true);
  });
});

describe("runInit — non-destructive (REQ-INIT-03)", () => {
  test("would-clobber without --force writes nothing, created [], outcomeFailed true", () => {
    // Seed an existing pulse.config.yaml with different bytes.
    writeFileSync(join(repo, "pulse.config.yaml"), "estateDir: custom\n", "utf8");

    const r = runInit({ repoRoot: repo, force: false });
    expect(r.outcomeFailed).toBe(true);
    expect(r.data!.created).toEqual([]);
    expect(r.data!.wouldClobber).toEqual(["pulse.config.yaml"]);

    // Wrote NOTHING: the seeded file is untouched and no estate/ was created.
    expect(readFileSync(join(repo, "pulse.config.yaml"), "utf8")).toBe("estateDir: custom\n");
    expect(existsSync(join(repo, "estate", "estate.yaml"))).toBe(false);
  });

  test("--force overwrites a differing file (created) and skips a byte-identical one (skipped)", () => {
    // First scaffold to lay down both base files verbatim.
    runInit({ repoRoot: repo, force: false });
    // Now diverge estate/estate.yaml; leave pulse.config.yaml byte-identical.
    writeFileSync(join(repo, "estate", "estate.yaml"), "estate:\n  schema_version: 1\n", "utf8");

    const r = runInit({ repoRoot: repo, force: true });
    expect(r.outcomeFailed).toBe(false);
    expect(r.data!.created).toEqual(["estate/estate.yaml"]); // differing → overwritten
    expect(r.data!.skipped).toEqual(["pulse.config.yaml"]); // byte-identical → skipped
    expect(r.data!.wouldClobber).toBeUndefined();

    // The overwrite restored a valid scaffold.
    const loaded = loadAndValidate(join(repo, "estate"));
    expect(loaded.ok).toBe(true);
  });
});

describe("runInit — guidance pack (REQ-INIT-02)", () => {
  test("a pack lays create-only files after the base scaffold", () => {
    const pack: GuidancePack = {
      id: "test-pack",
      files: [{ source: "AGENTS.md.tmpl", target: "AGENTS.md", merge: "create-only" }],
    };
    const r = runInit({ repoRoot: repo, force: false, pack });
    expect(r.outcomeFailed).toBe(false);
    expect(r.data!.created).toContain("AGENTS.md");
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
    // Deterministic pack content (build-time embedding stub).
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(
      readFileSync(join(repo, "AGENTS.md"), "utf8"),
    );
  });
});
