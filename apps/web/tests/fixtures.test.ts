// apps/web/tests/fixtures.test.ts — assert each committed model fixture parses (or fails) exactly as
// intended (08-testing-strategy.md §2.3). These four fixtures are the ONLY intentionally-invalid or
// boundary artifacts web-app ships; later items consume them for the estate-load (006),
// estate-agnostic (010), and zero-host (005/009) paths, so their shapes are pinned here.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { SUPPORTED_WEB_MODEL_VERSIONS } from "../src/server/estate/versions.js";
import type { WebEstateModel } from "@pulse/renderer";

const FIXTURES = join(import.meta.dir, "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name, "web-estate-model.json"), "utf8");
}

/** A shallow structural gate mirroring what item 006's checkStructure will enforce. */
function isStructurallyValid(value: unknown): value is WebEstateModel {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  const estate = m.estate as Record<string, unknown> | undefined;
  return (
    typeof m.formatVersion === "number" &&
    typeof estate === "object" &&
    estate !== null &&
    typeof estate.name === "string" &&
    Array.isArray(m.hosts) &&
    Array.isArray(m.services)
  );
}

describe("committed model fixtures", () => {
  test("alt-estate parses to a valid, structurally-distinct model", () => {
    const parsed = JSON.parse(readFixture("alt-estate")) as WebEstateModel;
    expect(isStructurallyValid(parsed)).toBe(true);
    expect(SUPPORTED_WEB_MODEL_VERSIONS).toContain(parsed.formatVersion);
    // Structurally distinct from the seeded home-estate primary fixture (SC-8).
    expect(parsed.estate.name).not.toBe("home-estate");
    expect(parsed.hosts.length).toBeGreaterThan(0);
  });

  test("zero-hosts parses to a valid model with zero declared hosts (REQ-GRID-04)", () => {
    const parsed = JSON.parse(readFixture("zero-hosts")) as WebEstateModel;
    expect(isStructurallyValid(parsed)).toBe(true);
    expect(SUPPORTED_WEB_MODEL_VERSIONS).toContain(parsed.formatVersion);
    expect(parsed.hosts).toEqual([]);
    expect(parsed.services).toEqual([]);
  });

  test("bad-version parses but its formatVersion is outside the supported set (REQ-MODEL-02)", () => {
    const parsed = JSON.parse(readFixture("bad-version")) as WebEstateModel;
    // Structurally valid JSON — the ONLY defect is the version, exercising the kind:"version" path.
    expect(isStructurallyValid(parsed)).toBe(true);
    expect(SUPPORTED_WEB_MODEL_VERSIONS).not.toContain(parsed.formatVersion);
  });

  test("malformed fails JSON.parse (REQ-MODEL-03 unparseable path)", () => {
    const raw = readFixture("malformed");
    expect(() => JSON.parse(raw)).toThrow();
  });
});
