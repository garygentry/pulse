// apps/web/tests/estate-reload.test.ts — MIGRATED to the rendered-model-v2 bundle watcher
// (06-reload-and-runtime-integration.md; 08-testing-strategy.md §4.1; items 009, 010). The v2
// three-file watcher now owns `createWatcher`/`maybeReload`; the exhaustive positive/behavioral
// matrix lives in estate-bundle-reload.test.ts. After the item-010 format cutover the sole surviving
// v1 value is the dedicated `bad-version` fixture, so this file is retained ONLY as explicit
// rejection evidence: the v2 watcher refuses v1-format model bytes with a `version` error and never
// surfaces a v1 model as a valid bundle. (The legacy v1 single-model watcher, still driving
// refresh.ts until item 011, is exercised via routes.test.ts.)

import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createWatcher, maybeReload } from "../src/server/estate/watch.js";
import { EstateBundleError } from "../src/shared/errors.js";

const FIXTURES = join(import.meta.dir, "fixtures");

/** The raw bytes of a committed fixture, to seed a mutable temp model. */
function fixtureBytes(name: string): string {
  return readFileSync(join(FIXTURES, name, "web-estate-model.json"), "utf8");
}

/** A byte-distinct but still format-v1 variant of the bad-version fixture (different estate name),
 *  used to prove an error → error swap re-emits a version rejection. */
function altV1Bytes(): string {
  const model = JSON.parse(fixtureBytes("bad-version")) as Record<string, unknown>;
  return JSON.stringify({ ...model, estate: { name: "other-estate", domains: ["other.example"] } });
}

/** Push a file's mtime forward so the cheap stat pre-gate trips. */
function bumpMtime(path: string): void {
  const st = statSync(path);
  const next = new Date(st.mtimeMs + 1000);
  utimesSync(path, next, next);
}

let dir: string;
let modelPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "estate-reload-"));
  modelPath = join(dir, "web-estate-model.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("v2 watcher rejects v1-format model bytes (explicit rejection fixture)", () => {
  test("a committed v1 model loads as a version error, never a valid bundle", async () => {
    writeFileSync(modelPath, fixtureBytes("bad-version"));
    const state = await createWatcher(modelPath);
    expect(state.current.ok).toBe(false);
    if (state.current.ok) throw new Error("expected a version rejection");
    expect(state.current.error).toBeInstanceOf(EstateBundleError);
    expect(state.current.error.kind).toBe("version");
    expect(state.current.error.artifact).toBe("model");
    expect(state.current.error.foundVersion).toBe(1);
  });

  test("re-checking the unchanged v1 model is a no-op with no duplicate transition", async () => {
    writeFileSync(modelPath, fixtureBytes("bad-version"));
    const state = await createWatcher(modelPath);
    const held = state.current;

    const outcome = await maybeReload(state);
    expect(outcome.reloaded).toBe(false);
    expect(outcome.transition).toBeNull();
    expect(outcome.result).toBe(held);
  });

  test("swapping in a different v1 model re-emits a version error (error → error)", async () => {
    writeFileSync(modelPath, fixtureBytes("bad-version"));
    const state = await createWatcher(modelPath);
    expect(state.current.ok).toBe(false);

    writeFileSync(modelPath, altV1Bytes());
    bumpMtime(modelPath);

    const outcome = await maybeReload(state);
    expect(outcome.reloaded).toBe(true);
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("expected a version rejection");
    expect(outcome.result.error.kind).toBe("version");
    expect(outcome.transition?.kind).toBe("bundle_error");
  });
});
