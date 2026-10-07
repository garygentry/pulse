// apps/web/tests/estate-bundle-reload.test.ts — the three-file hash-based bundle watcher of
// src/server/estate/watch.ts (rendered-model-v2, 06-reload-and-runtime-integration.md §§3-4,
// 08-testing-strategy.md §8.8). Writes all three members into one temporary directory and injects
// monotonic ISO clocks so `loadedAt` can be proven to change only for byte-distinct authority.
//
// Covers: unchanged-metadata no-op; the metadata pre-gate (a same-size same-mtime byte edit is not
// observed); touch-with-identical-bytes on each/all files; model-only, coverage-only, findings-only
// byte changes; optional sibling appearance/disappearance; model disappearance; optional non-ENOENT
// read failure; malformed and unsupported changed members; mismatched IDs and relationship
// disagreement (root-swap reads); success→error clearing; error→error; error→valid recovery; and a
// repeated unchanged error emitting no duplicate transition.

import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync, rmdirSync } from "node:fs";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createWatcher, maybeReload } from "../src/server/estate/watch.js";
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

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-reload-"));
  created.push(dir);
  return dir;
}

const MODEL = "web-estate-model.json";
const COVERAGE = "web-coverage.json";
const FINDINGS = "web-findings.json";

/** Write one member's bytes into `dir`. */
function put(dir: string, name: string, bytes: string): void {
  writeFileSync(join(dir, name), bytes);
}

/** Write all present members of a fixture into a fresh dir; returns the model path. */
function seed(dir: string, files: { model: string; coverage?: string | null; findings?: string | null }): string {
  put(dir, MODEL, files.model);
  if (files.coverage != null) put(dir, COVERAGE, files.coverage);
  if (files.findings != null) put(dir, FINDINGS, files.findings);
  return join(dir, MODEL);
}

/** Push a file's mtime one second forward so the cheap stat pre-gate trips. */
function bumpMtime(path: string): void {
  const st = statSync(path);
  const next = new Date(st.mtimeMs + 1000);
  utimesSync(path, next, next);
}

/** A clock returning one fixed instant on every call. */
function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

const T0 = "2026-09-10T00:00:00.000Z";
const T1 = "2026-09-10T00:00:10.000Z";
const T2 = "2026-09-10T00:00:20.000Z";

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── Initial examination (06 §3.1) ─────────────────────────────────────────────────────────────────

describe("createWatcher — initial off-side examination", () => {
  test("a null model path yields a missing model error, null paths, and absent signatures", async () => {
    const state = await createWatcher(null, fixedClock(T0));
    expect(state.paths).toBeNull();
    expect(state.current.ok).toBe(false);
    if (state.current.ok) throw new Error("expected error");
    expect(state.current.error).toBeInstanceOf(EstateBundleError);
    expect(state.current.error.kind).toBe("missing");
    expect(state.current.error.artifact).toBe("model");
    expect(state.signatures.model).toEqual({ present: false, mtimeMs: null, size: null, hash: null });
    expect(state.signatures.coverage.present).toBe(false);
    expect(state.signatures.findings.present).toBe(false);
  });

  test("a full valid bundle loads with all three signatures present and the injected loadedAt", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));
    expect(state.current.ok).toBe(true);
    if (!state.current.ok) throw new Error("expected ok");
    expect(state.current.bundle.loadedAt).toBe(T0);
    expect(state.current.bundle.coverage).not.toBeNull();
    for (const m of ["model", "coverage", "findings"] as const) {
      expect(state.signatures[m].present).toBe(true);
      expect(state.signatures[m].hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("a model-only bundle (siblings ENOENT) loads with null coverage/findings and absent signatures", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, { model: files.model });
    const state = await createWatcher(modelPath, fixedClock(T0));
    expect(state.current.ok).toBe(true);
    if (!state.current.ok) throw new Error("expected ok");
    expect(state.current.bundle.coverage).toBeNull();
    expect(state.current.bundle.findings).toBeNull();
    expect(state.signatures.coverage.present).toBe(false);
    expect(state.signatures.findings.present).toBe(false);
  });
});

// ── Metadata pre-gate and touch no-ops (06 §3.3) ─────────────────────────────────────────────────

describe("maybeReload — metadata pre-gate and touch no-ops", () => {
  test("unchanged metadata returns a no-op with the exact prior result reference and no transition", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));
    const held = state.current;

    const outcome = await maybeReload(state, fixedClock(T1));
    expect(outcome.reloaded).toBe(false);
    expect(outcome.transition).toBeNull();
    expect(outcome.result).toBe(held); // same reference — no re-parse
    expect(state.current).toBe(held);
    if (!held.ok) throw new Error("expected ok");
    expect(held.bundle.loadedAt).toBe(T0); // loadedAt preserved
  });

  test("a same-size same-mtime byte edit is invisible (metadata is only a pre-gate)", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));
    const held = state.current;

    // Overwrite with a DIFFERENT-but-equal-length model, then restore the original mtime/atime so
    // the (present, mtimeMs, size) pre-gate sees no change and the watcher never reads the bytes.
    const st = statSync(modelPath);
    const edited = files.model.replace("home-estate", "home-3state"); // same byte length
    expect(edited).not.toBe(files.model);
    expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(files.model));
    writeFileSync(modelPath, edited);
    utimesSync(modelPath, st.atime, st.mtime);

    const outcome = await maybeReload(state, fixedClock(T1));
    expect(outcome.reloaded).toBe(false); // pre-gate matched → no read → change unnoticed (by contract)
    expect(outcome.result).toBe(held);
  });

  test("touching each file with identical bytes updates its mtime signature but preserves authority", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));
    const held = state.current;

    for (const [name, bytes] of [
      [MODEL, files.model],
      [COVERAGE, files.coverage!],
      [FINDINGS, files.findings!],
    ] as const) {
      const p = join(dir, name);
      const priorHash = signatureFor(state, name).hash;
      put(dir, name, bytes); // identical bytes
      bumpMtime(p);

      const outcome = await maybeReload(state, fixedClock(T1));
      expect(outcome.reloaded).toBe(false);
      expect(outcome.transition).toBeNull();
      expect(outcome.result).toBe(held); // authority + loadedAt preserved
      // Signature metadata advanced, but the byte hash is unchanged.
      expect(signatureFor(state, name).mtimeMs).toBe(statSync(p).mtimeMs);
      expect(signatureFor(state, name).hash).toBe(priorHash);
    }
    if (!held.ok) throw new Error("expected ok");
    expect(held.bundle.loadedAt).toBe(T0);
  });

  test("touching all three files at once with identical bytes is still a single no-op", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));
    const held = state.current;

    put(dir, MODEL, files.model);
    put(dir, COVERAGE, files.coverage!);
    put(dir, FINDINGS, files.findings!);
    bumpMtime(join(dir, MODEL));
    bumpMtime(join(dir, COVERAGE));
    bumpMtime(join(dir, FINDINGS));

    const outcome = await maybeReload(state, fixedClock(T1));
    expect(outcome.reloaded).toBe(false);
    expect(outcome.transition).toBeNull();
    expect(outcome.result).toBe(held);
  });
});

// ── Single-member byte changes → full reread (06 §§3.3, 4.3) ─────────────────────────────────────

describe("maybeReload — single-member byte changes trigger a full reread and new authority", () => {
  test("a model-only coherent edit reloads and emits bundle_reloaded with a new loadedAt", async () => {
    const { model, files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));

    // Edit the model but keep its bundleId + relationships so coverage/findings stay coherent.
    const edited = { ...model, estate: { ...model.estate, name: "renamed-estate" } };
    put(dir, MODEL, serializeArtifact(edited));
    bumpMtime(modelPath);

    const outcome = await maybeReload(state, fixedClock(T1));
    expect(outcome.reloaded).toBe(true);
    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) throw new Error("expected ok");
    expect(outcome.result.bundle.model.estate.name).toBe("renamed-estate");
    expect(outcome.result.bundle.loadedAt).toBe(T1); // byte-distinct authority → new timestamp
    expect(outcome.transition).toEqual({
      kind: "bundle_reloaded",
      artifact: null,
      errorKind: null,
      bundleId: FIXTURE_BUNDLE_ID,
    });
    expect(state.current).toBe(outcome.result);
  });

  test("a findings-only coherent edit reloads and emits bundle_reloaded", async () => {
    const { findings, files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));

    const edited = { ...findings };
    edited.findings = findings.findings.map((f, i) => (i === 0 ? { ...f, message: "reworded finding" } : f));
    put(dir, FINDINGS, serializeArtifact(edited));
    bumpMtime(join(dir, FINDINGS));

    const outcome = await maybeReload(state, fixedClock(T1));
    expect(outcome.reloaded).toBe(true);
    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) throw new Error("expected ok");
    expect(outcome.result.bundle.findings?.findings[0]?.message).toBe("reworded finding");
    expect(outcome.transition?.kind).toBe("bundle_reloaded");
  });

  test("a coverage-only byte change is reread and, when incoherent, replaces authority with an error", async () => {
    const { model, files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));
    expect(state.current.ok).toBe(true);

    // Only the coverage bytes change (to a mismatched generation id) — proves the single-member
    // change is fully reread and installs new (error) authority rather than being ignored.
    const otherId = `sha256:${"c".repeat(64)}` as BundleId;
    put(dir, COVERAGE, serializeArtifact(makeWebCoverageArtifact(model, otherId)));
    bumpMtime(join(dir, COVERAGE));

    const outcome = await maybeReload(state, fixedClock(T1));
    expect(outcome.reloaded).toBe(true);
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("expected error");
    expect(outcome.result.error.kind).toBe("incoherent");
    expect(outcome.result.error.artifact).toBe("coverage");
    expect(outcome.transition).toEqual({
      kind: "bundle_error",
      artifact: "coverage",
      errorKind: "incoherent",
      bundleId: null,
    });
  });
});

// ── Presence changes (06 §3.2) ────────────────────────────────────────────────────────────────────

describe("maybeReload — optional sibling appearance and disappearance", () => {
  test("both optional siblings appearing reloads into a full valid bundle", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, { model: files.model }); // model only
    const state = await createWatcher(modelPath, fixedClock(T0));
    expect(state.current.ok).toBe(true);
    if (!state.current.ok) throw new Error("expected ok");
    expect(state.current.bundle.coverage).toBeNull();

    put(dir, COVERAGE, files.coverage!);
    put(dir, FINDINGS, files.findings!);

    const outcome = await maybeReload(state, fixedClock(T1));
    expect(outcome.reloaded).toBe(true);
    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) throw new Error("expected ok");
    expect(outcome.result.bundle.coverage).not.toBeNull();
    expect(outcome.result.bundle.findings).not.toBeNull();
    expect(outcome.transition?.kind).toBe("bundle_reloaded");
    expect(state.signatures.coverage.present).toBe(true);
  });

  test("an optional sibling disappearing reloads into a still-valid model-only bundle", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));

    unlinkSync(join(dir, COVERAGE));

    const outcome = await maybeReload(state, fixedClock(T1));
    expect(outcome.reloaded).toBe(true);
    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) throw new Error("expected ok");
    expect(outcome.result.bundle.coverage).toBeNull();
    expect(outcome.result.bundle.findings).not.toBeNull();
    expect(outcome.transition?.kind).toBe("bundle_reloaded");
    expect(state.signatures.coverage.present).toBe(false);
  });

  test("the mandatory model disappearing clears authority with a missing error", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));

    unlinkSync(modelPath);

    const outcome = await maybeReload(state, fixedClock(T1));
    expect(outcome.reloaded).toBe(true);
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("expected error");
    expect(outcome.result.error.kind).toBe("missing");
    expect(outcome.result.error.artifact).toBe("model");
    expect(outcome.transition).toEqual({
      kind: "bundle_error",
      artifact: "model",
      errorKind: "missing",
      bundleId: null,
    });
  });
});

// ── Read failures and malformed/unsupported members (06 §§3.2, 4.2) ──────────────────────────────

describe("maybeReload — read failures and malformed changed members", () => {
  test("an optional sibling that becomes a directory (non-ENOENT) is an unreadable error, never null", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));

    // Replace the coverage FILE with a directory of the same name → EISDIR on read (non-ENOENT).
    unlinkSync(join(dir, COVERAGE));
    mkdirSync(join(dir, COVERAGE));

    const outcome = await maybeReload(state, fixedClock(T1));
    expect(outcome.reloaded).toBe(true);
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("expected error");
    expect(outcome.result.error.kind).toBe("unreadable");
    expect(outcome.result.error.artifact).toBe("coverage");
    expect(outcome.result.error.message).not.toContain("EISDIR");
    rmdirSync(join(dir, COVERAGE)); // let afterEach clean the parent
  });

  test("a malformed changed member clears success authority with an unparseable error", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));
    expect(state.current.ok).toBe(true);

    put(dir, COVERAGE, "{ not json");
    bumpMtime(join(dir, COVERAGE));

    const outcome = await maybeReload(state, fixedClock(T1));
    expect(outcome.reloaded).toBe(true);
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("expected error");
    expect(outcome.result.error.kind).toBe("unparseable");
    expect(outcome.result.error.artifact).toBe("coverage");
    expect(state.current.ok).toBe(false); // no last-good bundle retained
    expect(outcome.transition?.kind).toBe("bundle_error");
  });

  test("an unsupported changed model version replaces authority with a version error", async () => {
    const { model, files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));

    put(dir, MODEL, serializeArtifact({ ...model, formatVersion: 1 }));
    bumpMtime(modelPath);

    const outcome = await maybeReload(state, fixedClock(T1));
    expect(outcome.reloaded).toBe(true);
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("expected error");
    expect(outcome.result.error.kind).toBe("version");
    expect(outcome.result.error.foundVersion).toBe(1);
    expect(outcome.transition?.errorKind).toBe("version");
  });
});

// ── Mixed-generation reads (06 §3.3, REQ-CONC-02) ────────────────────────────────────────────────

describe("maybeReload — mixed generations are rejected, not served", () => {
  test("a mismatched sibling bundleId (simulating a torn root swap) is incoherent", async () => {
    const { model, files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));

    const otherId = `sha256:${"a".repeat(64)}` as BundleId;
    put(dir, FINDINGS, serializeArtifact(makeWebFindingsArtifact(otherId)));
    bumpMtime(join(dir, FINDINGS));

    const outcome = await maybeReload(state, fixedClock(T1));
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("expected error");
    expect(outcome.result.error.kind).toBe("incoherent");
  });

  test("a coverage whose relationships disagree with the model is incoherent", async () => {
    const { model, files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));

    // Coverage recomputed from a model missing hostE → the on-disk model still has hostE, so the
    // partition is no longer exhaustive against the model.
    const trimmed = makeWebEstateModelV2({ hosts: model.hosts.slice(0, 4) });
    put(dir, COVERAGE, serializeArtifact(makeWebCoverageArtifact(trimmed, model.bundleId)));
    bumpMtime(join(dir, COVERAGE));

    const outcome = await maybeReload(state, fixedClock(T1));
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("expected error");
    expect(outcome.result.error.kind).toBe("incoherent");
    expect(outcome.result.error.artifact).toBe("coverage");
  });
});

// ── Error transitions, recovery, and duplicate suppression (06 §4.3) ──────────────────────────────

describe("maybeReload — error authority, recovery, and repeated errors", () => {
  test("valid → error → coherent replacement emits bundle_recovered without restart", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));

    // Break coverage → error authority.
    put(dir, COVERAGE, "{ not json");
    bumpMtime(join(dir, COVERAGE));
    const broke = await maybeReload(state, fixedClock(T1));
    expect(broke.result.ok).toBe(false);
    expect(broke.transition?.kind).toBe("bundle_error");

    // Restore the coherent generation → recovery.
    put(dir, COVERAGE, files.coverage!);
    bumpMtime(join(dir, COVERAGE));
    const healed = await maybeReload(state, fixedClock(T2));
    expect(healed.reloaded).toBe(true);
    expect(healed.result.ok).toBe(true);
    if (!healed.result.ok) throw new Error("expected recovery");
    expect(healed.result.bundle.loadedAt).toBe(T2);
    expect(healed.transition).toEqual({
      kind: "bundle_recovered",
      artifact: null,
      errorKind: null,
      bundleId: FIXTURE_BUNDLE_ID,
    });
    expect(state.current).toBe(healed.result);
  });

  test("error → a byte-distinct different error stays in error authority and re-emits bundle_error", async () => {
    const { model, files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));

    put(dir, COVERAGE, "{ not json"); // unparseable coverage
    bumpMtime(join(dir, COVERAGE));
    const first = await maybeReload(state, fixedClock(T1));
    expect(first.result.ok).toBe(false);
    if (first.result.ok) throw new Error("expected error");
    expect(first.result.error.kind).toBe("unparseable");

    // Now break the model with a version error too (a distinct byte tuple).
    put(dir, MODEL, serializeArtifact({ ...model, formatVersion: 1 }));
    bumpMtime(modelPath);
    const second = await maybeReload(state, fixedClock(T2));
    expect(second.reloaded).toBe(true);
    expect(second.result.ok).toBe(false);
    if (second.result.ok) throw new Error("expected error");
    expect(second.result.error.kind).toBe("version"); // model read first
    expect(second.transition?.kind).toBe("bundle_error");
  });

  test("a repeated unchanged error is a no-op with no duplicate transition", async () => {
    const { files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));

    put(dir, COVERAGE, "{ not json");
    bumpMtime(join(dir, COVERAGE));
    const broke = await maybeReload(state, fixedClock(T1));
    expect(broke.result.ok).toBe(false);
    const heldError = state.current;

    // No further disk change → the metadata pre-gate holds → no read, no transition.
    const again = await maybeReload(state, fixedClock(T2));
    expect(again.reloaded).toBe(false);
    expect(again.transition).toBeNull();
    expect(again.result).toBe(heldError);
  });
});

// ── loadedAt monotonicity (06 §8) ─────────────────────────────────────────────────────────────────

describe("maybeReload — loadedAt changes only for byte-distinct authority", () => {
  test("no-ops and touches preserve loadedAt; a real reload advances it", async () => {
    const { model, files } = makeEstateBundleFixture();
    const dir = freshDir();
    const modelPath = seed(dir, files);
    const state = await createWatcher(modelPath, fixedClock(T0));
    if (!state.current.ok) throw new Error("expected ok");
    expect(state.current.bundle.loadedAt).toBe(T0);

    // No-op keeps T0.
    await maybeReload(state, fixedClock(T1));
    if (!state.current.ok) throw new Error("expected ok");
    expect(state.current.bundle.loadedAt).toBe(T0);

    // Touch keeps T0.
    put(dir, MODEL, files.model);
    bumpMtime(modelPath);
    await maybeReload(state, fixedClock(T1));
    if (!state.current.ok) throw new Error("expected ok");
    expect(state.current.bundle.loadedAt).toBe(T0);

    // A real byte change advances loadedAt to the reload's clock.
    put(dir, MODEL, serializeArtifact({ ...model, estate: { ...model.estate, name: "z-estate" } }));
    bumpMtime(modelPath);
    await maybeReload(state, fixedClock(T2));
    if (!state.current.ok) throw new Error("expected ok");
    expect(state.current.bundle.loadedAt).toBe(T2);
  });
});

/** Read one member's live signature from the watcher state by its filename. */
function signatureFor(
  state: Awaited<ReturnType<typeof createWatcher>>,
  name: string,
): { present: boolean; mtimeMs: number | null; size: number | null; hash: string | null } {
  if (name === MODEL) return state.signatures.model;
  if (name === COVERAGE) return state.signatures.coverage;
  return state.signatures.findings;
}
