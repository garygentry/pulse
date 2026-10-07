/** agnostic.test.ts — estate-agnostic by construction (07 §3.3, REQ-MODEL-02, REQ-DET-02,
 *  SC-01).
 *
 *  Two independent, structurally different valid estates (valid-min/ and agnostic-min/) both
 *  load to a fully-typed EstateModel with the SAME src/ — the loader names no specific estate.
 *  The mere existence of this test over agnostic-min/ IS the agnostic assertion; the source
 *  guard below reinforces it by proving no fixture estate's names/domains are hard-coded in
 *  src/. */

import { expect, test, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadAndValidate } from "../src/index.js";
import type { EstateModel } from "../src/index.js";

const FIXTURES = join(import.meta.dir, "fixtures");
const SRC = join(import.meta.dir, "..", "src");

describe("agnostic-min loads to a fully-typed EstateModel with zero src change (SC-01)", () => {
  const res = loadAndValidate(join(FIXTURES, "agnostic-min"));

  test("ok is true", () => {
    expect(res.ok).toBe(true);
  });

  test("the model is a fully-populated, typed EstateModel over a different estate", () => {
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Typed access proves the EstateModel surface holds for a structurally different estate.
    const model: EstateModel = res.model;
    expect(model.schemaMajor).toBe(1);
    expect(model.estate.name).toBe("helios-lab"); // a DIFFERENT estate than valid-min's acme-core
    expect(model.estate).not.toHaveProperty("dnsResolver");
    expect(model.hosts.length).toBeGreaterThan(0);
    // Its collection classes differ from valid-min's — the union normalizes either estate.
    const classes = new Set(model.hosts.map((h) => h.collectionClass));
    expect(classes.has("probe-only")).toBe(true);
    expect(classes.has("nas-api")).toBe(true);
    // A SecretRef is a reference, never a resolved value (REQ-SEC-01).
    expect(model.estate.deadmanHook).toMatchObject({ kind: "op" });
  });
});

describe("source guard — no estate-specific literal appears under src/ (REQ-MODEL-02, CON-01)", () => {
  /** A curated deny-list of the fixture estates' names/domains. None may appear in src/. */
  const DENY_LIST = [
    "acme-core",
    "acme.internal",
    "helios-lab",
    "helios.example",
    "lab.helios.example",
    "semantic-broken",
    "scale-estate",
  ];

  /** Every .ts file under src/, recursively. */
  function srcFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...srcFiles(p));
      else if (name.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  const files = srcFiles(SRC);

  test("src/ has .ts files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("no denied estate literal is present anywhere under src/", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const literal of DENY_LIST) {
        expect(text.includes(literal), `${file} must not name "${literal}"`).toBe(false);
      }
    }
  });
});
