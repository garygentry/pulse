/** format-v2-release-boundary.test.ts — the finite release-boundary regression guard
 *  (07 §2.1 compatibility-pin inventory + §2.4 releasability gate; 08 §10.1 format-pin
 *  meta-guard; item 013).
 *
 *  This single integration guard inventories the *finite* format-2 compatibility set and
 *  proves every valid producer/consumer/pin/generated artifact resolves to format 2 with
 *  coherent bundle IDs, while the one explicit unsupported-version fixture stays rejected.
 *  Its protection set is exactly the six items in 08 §10.1:
 *
 *    1. producer constant   — packages/renderer/src/manifest.ts → RENDER_FORMAT_VERSION
 *    2. web consumer list    — apps/web/src/server/estate/versions.ts → SUPPORTED_WEB_MODEL_VERSIONS
 *    3. stack pin            — stack/tests/harness.ts → EXPECTED_RENDER_FORMAT_VERSION
 *    4. every generated .rendered-manifest.json in the four §4.4 trees
 *    5. every web-{estate-model,coverage,findings}.json sibling in those trees
 *    6. the explicit bad-version web fixture → EstateBundleError kind "version"
 *
 *  Non-goals (08 §10.1): it does not rewrite arbitrary documentation numbers, inspect external
 *  consumer estates/images, forbid v1 in the *named* rejection fixture, prove deployment
 *  ordering, or search every numeric literal in the repository. It distinguishes the intentional
 *  unsupported-v1 fixture from stale valid data by asserting that the rejection fixture is still
 *  literally v1 (so it can never be blindly bumped to v2 unnoticed), and it validates each tree
 *  through the *real* v2 loader trust boundary rather than trusting a hand-parsed number.
 *
 *  This test spans packages, so it lives in the renderer test tree (not tsc-checked, so its
 *  cross-package relative imports carry no typecheck cost — the same convention item 012's
 *  benchmark uses). It reads only committed source/dev-build fixtures and performs no writes. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

// Producer constant — the single source of the format version.
import { RENDER_FORMAT_VERSION } from "../src/manifest.js";
// Web consumer compatibility list (derived from the renderer constant).
import { SUPPORTED_WEB_MODEL_VERSIONS } from "../../../apps/web/src/server/estate/versions.js";
// The v2 loader trust boundary + its structured error.
import { loadEstateBundle } from "../../../apps/web/src/server/estate/load.js";
import { EstateBundleError } from "../../../apps/web/src/shared/errors.js";
// Stack consumer pin (single non-test support module; imports no @pulse/* package).
import { EXPECTED_RENDER_FORMAT_VERSION } from "../../../stack/tests/harness.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Repository root: packages/renderer/tests → up three. */
const repoRoot = join(here, "..", "..", "..");

/** The four committed generated trees (07 §3.1 / 08 §4.4), by stable review id. */
const GENERATED_TREES = [
  { id: "renderer-multiclass", dir: join(repoRoot, "packages/renderer/tests/golden/multiclass.golden") },
  { id: "example-minimal", dir: join(repoRoot, "examples/minimal/rendered") },
  { id: "example-reference", dir: join(repoRoot, "examples/reference/rendered") },
  { id: "stack-fixture", dir: join(repoRoot, "stack/tests/fixtures/rendered") },
] as const;

const MANIFEST_NAME = ".rendered-manifest.json";
const WEB_ARTIFACTS = ["web-estate-model.json", "web-coverage.json", "web-findings.json"] as const;
const BUNDLE_ID_RE = /^sha256:[0-9a-f]{64}$/;

/** Read + JSON-parse a file from a generated tree. */
function readJson(dir: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
}

describe("format-v2 release boundary — source-backed compatibility pins (08 §10.1 items 1–3)", () => {
  test("the renderer producer constant is exactly 2", () => {
    expect(RENDER_FORMAT_VERSION).toBe(2);
  });

  test("the web consumer list is the derived [RENDER_FORMAT_VERSION] and evaluates to [2]", () => {
    // Derived, not a hard-coded second value (07 §2.2): the list must track the producer constant.
    expect([...SUPPORTED_WEB_MODEL_VERSIONS]).toEqual([RENDER_FORMAT_VERSION]);
    expect([...SUPPORTED_WEB_MODEL_VERSIONS]).toEqual([2]);
  });

  test("the stack consumer pin is exactly 2", () => {
    expect(EXPECTED_RENDER_FORMAT_VERSION).toBe(2);
  });

  test("all three pins agree on one release version", () => {
    expect(new Set([RENDER_FORMAT_VERSION, SUPPORTED_WEB_MODEL_VERSIONS[0], EXPECTED_RENDER_FORMAT_VERSION]).size).toBe(1);
  });
});

describe("format-v2 release boundary — every generated tree is format 2 with coherent bundle IDs (08 §10.1 items 4–5)", () => {
  for (const { id, dir } of GENERATED_TREES) {
    describe(id, () => {
      const manifest = readJson(dir, MANIFEST_NAME) as { formatVersion: number; files: string[] };

      test("the manifest carries formatVersion 2, lists the three web siblings, and excludes itself", () => {
        expect(manifest.formatVersion).toBe(2);
        for (const artifact of WEB_ARTIFACTS) expect(manifest.files).toContain(artifact);
        expect(manifest.files).not.toContain(MANIFEST_NAME);
      });

      test("all three web artifacts are format 2 and share one valid bundle ID (raw bytes)", () => {
        const parsed = WEB_ARTIFACTS.map((a) => readJson(dir, a) as { formatVersion: number; bundleId: string });
        for (const p of parsed) expect(p.formatVersion).toBe(2);
        const ids = parsed.map((p) => p.bundleId);
        expect(BUNDLE_ID_RE.test(ids[0]!)).toBe(true);
        expect(new Set(ids).size).toBe(1);
      });

      test("the real v2 loader validates the tree as a coherent bundle (trust-boundary proof)", async () => {
        // Loading through loadEstateBundle enforces version, cross-artifact bundleId coherence, and
        // exhaustive validation — the strongest proof the three siblings agree, not a parsed guess.
        const result = await loadEstateBundle(join(dir, "web-estate-model.json"));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const { model, coverage, findings } = result.bundle;
        expect(coverage).not.toBeNull();
        expect(findings).not.toBeNull();
        expect(model.formatVersion).toBe(2);
        expect(coverage!.formatVersion).toBe(2);
        expect(findings!.formatVersion).toBe(2);
        expect(BUNDLE_ID_RE.test(model.bundleId)).toBe(true);
        expect(new Set([model.bundleId, coverage!.bundleId, findings!.bundleId]).size).toBe(1);
      });
    });
  }
});

describe("format-v2 release boundary — the explicit v1 fixture stays rejected (08 §10.1 item 6)", () => {
  const fixtureModel = join(repoRoot, "apps/web/tests/fixtures/bad-version/web-estate-model.json");

  test("the rejection fixture is still literally formatVersion 1 (intentional, not stale valid data)", () => {
    // This distinguishes the *named* unsupported-version evidence from a tree that drifted: if a
    // blind bump ever flips it to 2, this line fails loudly rather than silently losing the case.
    const raw = JSON.parse(readFileSync(fixtureModel, "utf8")) as { formatVersion: number };
    expect(raw.formatVersion).toBe(1);
  });

  test("loadEstateBundle refuses it with EstateBundleError kind 'version', foundVersion 1, and re-render guidance", async () => {
    const result = await loadEstateBundle(fixtureModel);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const { error } = result;
    expect(error).toBeInstanceOf(EstateBundleError);
    expect(error.kind).toBe("version");
    expect(error.artifact).toBe("model");
    expect(error.field).toBe("formatVersion");
    expect(error.foundVersion).toBe(1);
    expect(error.message).toMatch(/re-render/i);
    // The structured error never falls back to v1 parsing (07 §2.2).
    expect(SUPPORTED_WEB_MODEL_VERSIONS).not.toContain(1);
  });
});
