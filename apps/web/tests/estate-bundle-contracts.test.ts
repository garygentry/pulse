// apps/web/tests/estate-bundle-contracts.test.ts — compile-time + runtime evidence that item 006
// froze the v2 bundle boundary contracts (00-core-definitions.md §§7-9). This is a contracts-only
// item: the loader/validator/watcher/runtime behavior is items 007-011. Here we prove the shared
// types exist in their specified web source homes, can be imported type-only, and that
// `EstateBundleError` exposes the exact stable fields agents and health output depend on.

import { describe, expect, test } from "bun:test";

// Type-only imports prove later modules can consume the contracts without a runtime edge. The
// bundle types are homed in load.ts/watch.ts/config.ts; the error class is homed in shared/errors.ts.
import type {
  BundleFileBytes,
  EstateBundle,
  EstateBundleLoadResult,
  EstateBundlePaths,
} from "../src/server/estate/load.js";
import type {
  BundleMemberSignature,
  BundleTransition,
  BundleTransitionKind,
} from "../src/server/estate/watch.js";
import type { EstateTimezoneDecision } from "../src/server/config.js";
import type {
  EstateBundleArtifact,
  EstateBundleErrorKind,
} from "../src/shared/errors.js";
import type {
  BundleId,
  WebCoverageArtifact,
  WebEstateModelV2,
  WebFindingsArtifact,
} from "@pulse/renderer";

import { EstateBundleError, WebAppError } from "../src/shared/errors.js";

const SAMPLE_ID = `sha256:${"a".repeat(64)}` as BundleId;

describe("EstateBundleError — stable result-as-data fields (§8)", () => {
  test("exposes code, kind, artifact, path, field, and foundVersion", () => {
    const err = new EstateBundleError(
      "version",
      "model",
      "/rendered/web-estate-model.json",
      "Estate bundle model at /rendered/web-estate-model.json has an unsupported formatVersion.",
      { field: "formatVersion", foundVersion: 1 },
    );
    expect(err).toBeInstanceOf(WebAppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("EstateBundleError");
    expect(err.code).toBe("ESTATE_BUNDLE_VERSION");
    expect(err.kind).toBe("version");
    expect(err.artifact).toBe("model");
    expect(err.path).toBe("/rendered/web-estate-model.json");
    expect(err.field).toBe("formatVersion");
    expect(err.foundVersion).toBe(1);
  });

  test("optional field/foundVersion default to null (I/O and root failures)", () => {
    const err = new EstateBundleError(
      "missing",
      "model",
      "/rendered/web-estate-model.json",
      "Required estate model is missing.",
    );
    expect(err.code).toBe("ESTATE_BUNDLE_MISSING");
    expect(err.field).toBeNull();
    expect(err.foundVersion).toBeNull();
  });

  test("code is derived from every error kind", () => {
    const kinds: EstateBundleErrorKind[] = [
      "missing",
      "unreadable",
      "unparseable",
      "version",
      "structure",
      "incoherent",
    ];
    for (const kind of kinds) {
      const err = new EstateBundleError(kind, "coverage", "/p", "m");
      expect(err.code).toBe(`ESTATE_BUNDLE_${kind.toUpperCase()}`);
    }
  });

  test("no message reproduces an unsafe value: caller-supplied message is verbatim", () => {
    // The class does not synthesize messages; the loader/validator (items 007-009) own the safe
    // templates. This only proves the class carries whatever safe message it is given.
    const err = new EstateBundleError("structure", "findings", "/p", "safe message");
    expect(err.message).toBe("safe message");
  });
});

describe("bundle contracts are declared once and match §§7-9", () => {
  test("EstateBundlePaths / BundleFileBytes have the three fixed members", () => {
    const paths: EstateBundlePaths = {
      model: "/rendered/web-estate-model.json",
      coverage: "/rendered/web-coverage.json",
      findings: "/rendered/web-findings.json",
    };
    const bytes: BundleFileBytes = { model: "{}", coverage: null, findings: null };
    expect(Object.keys(paths).sort()).toEqual(["coverage", "findings", "model"]);
    expect(bytes.coverage).toBeNull();
  });

  test("EstateBundle carries v2 renderer members plus loadedAt", () => {
    // Type-level assignment only; no runtime shape is fabricated. A structurally-typed factory would
    // belong to item 007; here we assert the field surface compiles against the renderer v2 types.
    type ModelField = EstateBundle["model"];
    type CoverageField = EstateBundle["coverage"];
    type FindingsField = EstateBundle["findings"];
    const _model: ModelField extends WebEstateModelV2 ? true : false = true;
    const _coverage: CoverageField extends WebCoverageArtifact | null ? true : false = true;
    const _findings: FindingsField extends WebFindingsArtifact | null ? true : false = true;
    const loadedAt: EstateBundle["loadedAt"] = "2026-09-10T00:00:00.000Z";
    expect(_model && _coverage && _findings).toBe(true);
    expect(loadedAt.endsWith("Z")).toBe(true);
  });

  test("EstateBundleLoadResult is an ok/error discriminated union", () => {
    const ok: EstateBundleLoadResult = {
      ok: true,
      bundle: {
        model: {} as WebEstateModelV2,
        coverage: null,
        findings: null,
        loadedAt: "2026-09-10T00:00:00.000Z",
      },
    };
    const err: EstateBundleLoadResult = {
      ok: false,
      error: new EstateBundleError("missing", "model", "/p", "m"),
    };
    expect(ok.ok).toBe(true);
    expect(err.ok).toBe(false);
  });

  test("BundleMemberSignature captures presence + byte identity (§7)", () => {
    const present: BundleMemberSignature = {
      present: true,
      mtimeMs: 1,
      size: 2,
      hash: "abc",
    };
    const absent: BundleMemberSignature = {
      present: false,
      mtimeMs: null,
      size: null,
      hash: null,
    };
    expect(present.present).toBe(true);
    expect(absent.hash).toBeNull();
  });

  test("BundleTransition enumerates the four kinds and nullable success/error fields (§8)", () => {
    const kinds: BundleTransitionKind[] = [
      "bundle_loaded",
      "bundle_reloaded",
      "bundle_error",
      "bundle_recovered",
    ];
    const loaded: BundleTransition = {
      kind: "bundle_loaded",
      artifact: null,
      errorKind: null,
      bundleId: SAMPLE_ID,
    };
    const errored: BundleTransition = {
      kind: "bundle_error",
      artifact: "coverage" satisfies EstateBundleArtifact,
      errorKind: "incoherent" satisfies EstateBundleErrorKind,
      bundleId: null,
    };
    expect(kinds).toHaveLength(4);
    expect(loaded.bundleId).toBe(SAMPLE_ID);
    expect(errored.artifact).toBe("coverage");
  });

  test("EstateTimezoneDecision carries timezone, fallback, and structured warning (§9)", () => {
    const modelDefault: EstateTimezoneDecision = {
      timezone: "America/New_York",
      fallback: false,
      warning: null,
    };
    const overrideMismatch: EstateTimezoneDecision = {
      timezone: "Europe/Berlin",
      fallback: false,
      warning: { configured: "Europe/Berlin", rendered: "America/New_York" },
    };
    const errorMode: EstateTimezoneDecision = {
      timezone: "UTC",
      fallback: true,
      warning: null,
    };
    expect(modelDefault.warning).toBeNull();
    expect(overrideMismatch.warning?.configured).toBe("Europe/Berlin");
    expect(errorMode.fallback).toBe(true);
  });
});
