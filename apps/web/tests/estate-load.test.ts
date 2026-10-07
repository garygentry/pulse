// apps/web/tests/estate-load.test.ts — migrated for rendered-model-v2 (items 008, 010).
//
// The v2 bundle loader (`loadEstateBundle`, 05-bundle-loader-and-validation.md) requires
// `formatVersion` 2. After the item-010 format cutover the valid `alt-estate`/`zero-hosts` fixtures
// are v2 (exercised through the still-authoritative v1 loader by `estate-agnostic.test.ts`), and the
// SOLE surviving v1 value is the dedicated `bad-version` fixture — explicit unsupported-version
// evidence. Under the v2 loader that v1 model is refused as `version`, and the truncated `malformed`
// file as `unparseable`. No stale v1 SUCCESS assertion survives here.
//
// The single-model v1 runtime (`loadEstateModel`/`parseEstateModel`) is unchanged and still
// authoritative until item 011 switches bundle authority; its happy path is exercised end-to-end by
// `estate-agnostic.test.ts`. Comprehensive v2 loader behavior lives in `estate-bundle-load.test.ts`.

import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { loadEstateBundle } from "../src/server/estate/load.js";
import { EstateBundleError } from "../src/shared/errors.js";

const FIXTURES = join(import.meta.dir, "fixtures");

/** Absolute path to a committed fixture's web-estate-model.json. */
function fixturePath(name: string): string {
  return join(FIXTURES, name, "web-estate-model.json");
}

describe("loadEstateBundle — the committed v1 fixture is an unsupported-version rejection", () => {
  test("the v1 bad-version model is refused with kind:\"version\" and foundVersion 1", async () => {
    const path = fixturePath("bad-version");
    const result = await loadEstateBundle(path);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    const { error } = result;
    expect(error).toBeInstanceOf(EstateBundleError);
    expect(error.kind).toBe("version");
    expect(error.artifact).toBe("model");
    expect(error.field).toBe("formatVersion");
    expect(error.foundVersion).toBe(1);
    expect(error.path).toBe(path);
    expect(error.message).toMatch(/formatVersion|re-render/i);
  });
});

describe("loadEstateBundle — malformed fixture is unparseable", () => {
  test("the truncated fixture yields kind:\"unparseable\" at '$'", async () => {
    const path = fixturePath("malformed");
    const result = await loadEstateBundle(path);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("unparseable");
    expect(result.error.artifact).toBe("model");
    expect(result.error.field).toBe("$");
    expect(result.error.path).toBe(path);
    expect(result.error.message).toMatch(/pulse render/i);
  });
});

describe("loadEstateBundle — missing model", () => {
  test("a nonexistent model path yields kind:\"missing\" naming the path", async () => {
    const path = join(FIXTURES, "does-not-exist", "web-estate-model.json");
    const result = await loadEstateBundle(path);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("missing");
    expect(result.error.artifact).toBe("model");
    expect(result.error.path).toBe(path);
    expect(result.error.message).toContain(path);
    expect(result.error.message).toMatch(/pulse render/i);
    expect(result.error.message).toMatch(/PULSE_WEB_ESTATE_MODEL/);
  });
});
