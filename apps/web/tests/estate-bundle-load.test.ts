// apps/web/tests/estate-bundle-load.test.ts — the read → derive → parse → validate pipeline of the
// v2 bundle loader (rendered-model-v2, 05-bundle-loader-and-validation.md §§3, 4, 7, 8, 9).
//
// Exercises `deriveEstateBundlePaths` and `loadEstateBundle` against real temp-directory bytes built
// from the coherent v2 factory. Covers sibling path derivation, the deterministic model → coverage →
// findings read order, ENOENT-only optional absence, every non-ENOENT read as `unreadable`, injected
// clocks, mixed-generation `incoherent` rejection, and recovery after a coherent replacement. Deep
// per-field structural validation lives in estate-bundle-validation.test.ts; here the loader is the
// object under test, so validation is proven end-to-end from disk rather than field-by-field.

import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  deriveEstateBundlePaths,
  loadEstateBundle,
} from "../src/server/estate/load.js";
import { EstateBundleError } from "../src/shared/errors.js";
import {
  FIXTURE_BUNDLE_ID,
  makeEstateBundleFixture,
  makeWebCoverageArtifact,
  makeWebEstateModelV2,
  makeWebFindingsArtifact,
  serializeArtifact,
} from "./factories/estate-bundle.js";
import type { BundleId } from "@pulse/renderer";

// ── Temp-directory harness ────────────────────────────────────────────────────────────────────────

const created: string[] = [];

/** A fresh temp directory, torn down after each test. */
async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pulse-bundle-"));
  created.push(dir);
  return dir;
}

/** Write the three members into `dir`; `undefined`/`null` bytes omit the file (a real absence). */
async function writeMembers(
  dir: string,
  members: { model?: string | null; coverage?: string | null; findings?: string | null },
): Promise<string> {
  if (members.model != null) {
    await writeFile(join(dir, "web-estate-model.json"), members.model);
  }
  if (members.coverage != null) {
    await writeFile(join(dir, "web-coverage.json"), members.coverage);
  }
  if (members.findings != null) {
    await writeFile(join(dir, "web-findings.json"), members.findings);
  }
  return join(dir, "web-estate-model.json");
}

/** A fixed injectable clock producing one canonical instant. */
const FIXED_ISO = "2026-09-10T03:33:15.000Z";
const fixedClock = (): Date => new Date(FIXED_ISO);

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ── deriveEstateBundlePaths (05 §3) ─────────────────────────────────────────────────────────────

describe("deriveEstateBundlePaths — sibling derivation", () => {
  test("absolute model path derives fixed siblings in the same directory", () => {
    expect(deriveEstateBundlePaths("/rendered/web-estate-model.json")).toEqual({
      model: "/rendered/web-estate-model.json",
      coverage: "/rendered/web-coverage.json",
      findings: "/rendered/web-findings.json",
    });
  });

  test("the configured basename is used verbatim for the model", () => {
    expect(deriveEstateBundlePaths("/rendered/custom-model.json")).toEqual({
      model: "/rendered/custom-model.json",
      coverage: "/rendered/web-coverage.json",
      findings: "/rendered/web-findings.json",
    });
  });

  test("a relative model path derives siblings under its directory", () => {
    expect(deriveEstateBundlePaths("tree/custom-model.json")).toEqual({
      model: "tree/custom-model.json",
      coverage: "tree/web-coverage.json",
      findings: "tree/web-findings.json",
    });
  });

  test("a basename-only model path derives siblings in the current directory", () => {
    expect(deriveEstateBundlePaths("web-estate-model.json")).toEqual({
      model: "web-estate-model.json",
      coverage: "web-coverage.json",
      findings: "web-findings.json",
    });
  });
});

// ── Configuration and read semantics (05 §§4, 8) ──────────────────────────────────────────────────

describe("loadEstateBundle — configuration and reads", () => {
  test("null configuration returns model 'missing' with the exact message and no clock/read", async () => {
    let clockCalled = false;
    const result = await loadEstateBundle(null, () => {
      clockCalled = true;
      return new Date(FIXED_ISO);
    });
    expect(clockCalled).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toBeInstanceOf(EstateBundleError);
    expect(result.error.kind).toBe("missing");
    expect(result.error.artifact).toBe("model");
    expect(result.error.path).toBe("");
    expect(result.error.field).toBeNull();
    expect(result.error.message).toBe(
      "Estate model path is not configured. Set PULSE_WEB_ESTATE_MODEL to the read-only mount of " +
        "web-estate-model.json.",
    );
  });

  test("a missing mandatory model (ENOENT) returns model 'missing' naming the path", async () => {
    const dir = await freshDir();
    const modelPath = join(dir, "web-estate-model.json");
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("missing");
    expect(result.error.artifact).toBe("model");
    expect(result.error.path).toBe(modelPath);
    expect(result.error.message).toBe(
      `Required estate model is missing at ${modelPath}. Run 'pulse render' and verify the ` +
        `PULSE_WEB_ESTATE_MODEL mount.`,
    );
  });

  test("a non-ENOENT model read (a directory in its place) returns model 'unreadable'", async () => {
    const dir = await freshDir();
    const modelPath = join(dir, "web-estate-model.json");
    await mkdir(modelPath); // reading a directory rejects with EISDIR, not ENOENT.
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("unreadable");
    expect(result.error.artifact).toBe("model");
    expect(result.error.path).toBe(modelPath);
    expect(result.error.message).toBe(
      `Estate bundle model is unreadable at ${modelPath}. Verify the read-only rendered-tree mount ` +
        `and file permissions, then run 'pulse render' if needed.`,
    );
    // OS error text (EISDIR) must never leak into the public message.
    expect(result.error.message).not.toContain("EISDIR");
  });

  test("a non-ENOENT coverage read returns coverage 'unreadable' at the coverage path", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, { model: files.model });
    await mkdir(join(dir, "web-coverage.json")); // EISDIR on the optional sibling.
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("unreadable");
    expect(result.error.artifact).toBe("coverage");
    expect(result.error.path).toBe(join(dir, "web-coverage.json"));
  });

  test("a non-ENOENT findings read returns findings 'unreadable' at the findings path", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, { model: files.model, coverage: files.coverage });
    await mkdir(join(dir, "web-findings.json")); // EISDIR on the optional sibling.
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("unreadable");
    expect(result.error.artifact).toBe("findings");
    expect(result.error.path).toBe(join(dir, "web-findings.json"));
  });

  test("model ENOENT wins over a malformed coverage sibling (deterministic read order)", async () => {
    const dir = await freshDir();
    const modelPath = join(dir, "web-estate-model.json"); // model absent…
    await writeFile(join(dir, "web-coverage.json"), "{ not json"); // …coverage present + malformed.
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    // The model is read first, so its absence is the deterministic first error.
    expect(result.error.kind).toBe("missing");
    expect(result.error.artifact).toBe("model");
  });

  test("coverage unreadable wins over a simultaneously unreadable findings (read order)", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, { model: files.model });
    await mkdir(join(dir, "web-coverage.json"));
    await mkdir(join(dir, "web-findings.json"));
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.artifact).toBe("coverage");
  });
});

// ── Optional absence vs present-malformed (05 §4.2) ───────────────────────────────────────────────

describe("loadEstateBundle — optional siblings", () => {
  test("both siblings absent (ENOENT) loads a model-only bundle with null coverage/findings", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, { model: files.model });
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundle.coverage).toBeNull();
    expect(result.bundle.findings).toBeNull();
    expect(result.bundle.model.estate.name).toBe("home-estate");
    expect(result.bundle.loadedAt).toBe(FIXED_ISO);
  });

  test("a present JSON-null coverage sibling is malformed, not absent", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, { model: files.model, coverage: "null\n" });
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    // A present `null` root is a structure failure at `$`, never a null-absence.
    expect(result.error.artifact).toBe("coverage");
    expect(result.error.kind).toBe("structure");
    expect(result.error.field).toBe("$");
  });

  test("an empty coverage file is a present malformed member (unparseable)", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, { model: files.model, coverage: "" });
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.artifact).toBe("coverage");
    expect(result.error.kind).toBe("unparseable");
  });
});

// ── Full-bundle read / parse / version outcomes (05 §9) ───────────────────────────────────────────

describe("loadEstateBundle — member outcomes", () => {
  test("a valid full bundle returns { ok: true } with all three members", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, files);
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundle.model.bundleId).toBe(FIXTURE_BUNDLE_ID);
    expect(result.bundle.coverage?.bundleId).toBe(FIXTURE_BUNDLE_ID);
    expect(result.bundle.findings?.findings).toHaveLength(3);
    expect(result.bundle.loadedAt).toBe(FIXED_ISO);
  });

  test("a valid empty estate with absent siblings loads", async () => {
    const model = makeWebEstateModelV2({
      hosts: [],
      services: [],
      channels: [],
      routingOverrides: [],
      suppressions: [],
    });
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, { model: serializeArtifact(model) });
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundle.model.hosts).toEqual([]);
    expect(result.bundle.coverage).toBeNull();
  });

  test("a valid empty estate with three empty coverage buckets and empty findings loads", async () => {
    const model = makeWebEstateModelV2({
      hosts: [],
      services: [],
      channels: [],
      routingOverrides: [],
      suppressions: [],
    });
    const coverage = makeWebCoverageArtifact(model);
    const findings = makeWebFindingsArtifact(model.bundleId);
    findings.findings = [];
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, {
      model: serializeArtifact(model),
      coverage: serializeArtifact(coverage),
      findings: serializeArtifact(findings),
    });
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundle.coverage?.covered).toEqual([]);
    expect(result.bundle.findings?.findings).toEqual([]);
  });

  test("an invalid-JSON model is 'unparseable' at '$'", async () => {
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, { model: "{ not json" });
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("unparseable");
    expect(result.error.artifact).toBe("model");
    expect(result.error.field).toBe("$");
  });

  test("an unsupported model formatVersion is 'version' with foundVersion", async () => {
    const model = makeWebEstateModelV2();
    const bytes = serializeArtifact({ ...model, formatVersion: 1 });
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, { model: bytes });
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("version");
    expect(result.error.artifact).toBe("model");
    expect(result.error.field).toBe("formatVersion");
    expect(result.error.foundVersion).toBe(1);
  });

  test("a structurally malformed model surfaces the exact first field", async () => {
    const model = makeWebEstateModelV2();
    const broken = { ...model, estate: { ...model.estate, name: 42 } };
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, { model: serializeArtifact(broken) });
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("structure");
    expect(result.error.field).toBe("estate.name");
  });
});

// ── Mixed-generation reads and recovery (05 §§6.1, 7; REQ-CONC-02, REQ-REL-04) ────────────────────

describe("loadEstateBundle — coherence and recovery", () => {
  test("a coverage sibling from a different generation is 'incoherent'", async () => {
    const model = makeWebEstateModelV2();
    const otherId = `sha256:${"f".repeat(64)}` as BundleId;
    const coverage = makeWebCoverageArtifact(model, otherId);
    const findings = makeWebFindingsArtifact(model.bundleId);
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, {
      model: serializeArtifact(model),
      coverage: serializeArtifact(coverage),
      findings: serializeArtifact(findings),
    });
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("incoherent");
    expect(result.error.artifact).toBe("coverage");
    expect(result.error.field).toBe("bundleId");
  });

  test("a mismatched coverage wins over a mismatched findings", async () => {
    const model = makeWebEstateModelV2();
    const otherId = `sha256:${"a".repeat(64)}` as BundleId;
    const coverage = makeWebCoverageArtifact(model, otherId);
    const findings = makeWebFindingsArtifact(otherId);
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, {
      model: serializeArtifact(model),
      coverage: serializeArtifact(coverage),
      findings: serializeArtifact(findings),
    });
    const result = await loadEstateBundle(modelPath, fixedClock);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.artifact).toBe("coverage");
  });

  test("replacing an incoherent coverage with the coherent generation loads on the next read", async () => {
    const model = makeWebEstateModelV2();
    const otherId = `sha256:${"b".repeat(64)}` as BundleId;
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, {
      model: serializeArtifact(model),
      coverage: serializeArtifact(makeWebCoverageArtifact(model, otherId)),
      findings: serializeArtifact(makeWebFindingsArtifact(model.bundleId)),
    });

    const bad = await loadEstateBundle(modelPath, fixedClock);
    expect(bad.ok).toBe(false);

    // The rendered tree is re-mounted as one coherent unit.
    await writeFile(join(dir, "web-coverage.json"), serializeArtifact(makeWebCoverageArtifact(model)));
    const good = await loadEstateBundle(modelPath, fixedClock);
    expect(good.ok).toBe(true);
    if (!good.ok) throw new Error("expected ok");
    expect(good.bundle.coverage?.bundleId).toBe(model.bundleId);
  });
});

// ── Clock injection (05 §§4.1, 7) ─────────────────────────────────────────────────────────────────

describe("loadEstateBundle — clock", () => {
  test("loadedAt is the injected canonical instant, set only after reads succeed", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, files);
    const stamp = "2026-01-02T03:04:05.678Z";
    const result = await loadEstateBundle(modelPath, () => new Date(stamp));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundle.loadedAt).toBe(stamp);
  });

  test("an Invalid Date clock returns the clock failure as data (model 'unreadable', loadedAt)", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, files);
    const result = await loadEstateBundle(modelPath, () => new Date("not a date"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("unreadable");
    expect(result.error.artifact).toBe("model");
    expect(result.error.field).toBe("loadedAt");
    expect(result.error.path).toBe(modelPath);
    expect(result.error.message).toBe(
      `Estate bundle load time could not be recorded for ${modelPath}. Verify the server clock and ` +
        `retry the load.`,
    );
  });

  test("a throwing clock is caught and returned as the clock failure", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = await freshDir();
    const modelPath = await writeMembers(dir, files);
    const result = await loadEstateBundle(modelPath, () => {
      throw new Error("clock exploded");
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.field).toBe("loadedAt");
    expect(result.error.message).not.toContain("clock exploded");
  });
});

// ── Loader isolation (05 §1; item 008 AC#5) ───────────────────────────────────────────────────────

describe("loadEstateBundle — isolation", () => {
  test("load.ts imports no estate YAML/source loader and no network/engine access", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "server", "estate", "load.ts"), "utf8");
    // Never reaches into estate source loading (PRD CON-01/CON-08; spec §1).
    expect(source).not.toContain("loadAndValidate");
    expect(source).not.toMatch(/@pulse\/core\/.*load/);
    // No network/engine I/O in the pure rendered-JSON read boundary.
    expect(source).not.toContain("node:net");
    expect(source).not.toContain("node:http");
    expect(source).not.toMatch(/\bfetch\(/);
  });
});
