// packages/renderer/src/render/web-artifacts.ts
//
// The coordinated rendered-model-v2 web emitter (04-coordinated-render-and-coverage.md §§4–5).
// This module is the pure value-level transaction that turns one validated `EstateModel` and one
// immutable loader-finding list into the three coherent web payloads (model, coverage, findings)
// sharing one deterministic SHA-256 `bundleId`. Item 001 froze the compile-time types below; this
// item (005) adds the runtime: `computeBundleId`, `buildWebArtifactPayloads`, `emitWebArtifacts`,
// and the public compatibility `buildWebEstateModel`.
//
// It builds ONE `ArtifactIndex` and ONE `WebSafetyContext`, projects model and coverage from that
// single index (so every relationship agrees), merges all finding severities without deduplication,
// runs the final recursive safety assertion, computes the framed hash over the exact canonical
// UNSTAMPED payload bytes, then stamps the one lowercase `sha256:` id onto all three artifacts. A
// fatal projection/safety outcome exposes findings only and serializes no file. `node:crypto` is the
// sole nondeterminism-adjacent dependency and is used only for the deterministic digest.
//
// Integration deferred: this does not flip `RENDER_FORMAT_VERSION`, wire the render pipeline, or
// regenerate golden trees — item 010 owns that atomic cutover.
import { createHash } from "node:crypto";

import type { EstateModel, Finding } from "@pulse/core";

import type { RenderedFile } from "../tree.js";
import { buildArtifactIndex } from "./artifact-index.js";
import { computeCoverageFromIndex } from "../coverage.js";
import type { WebCoverageArtifact } from "../coverage.js";
import { buildWebEstateModelFromIndex } from "./web-model.js";
import type { WebEstateModelV2 } from "./web-model.js";
import {
  assertWebArtifactsSafe,
  createWebSafetyContext,
  finalizeCanaries,
} from "./web-safety.js";
import type { WebProjectionResult } from "./web-safety.js";
import { sortFindings } from "../findings.js";
import { toCanonicalJson } from "../format.js";
import { compareString } from "../order.js";

/**
 * Fixed web artifact names, sorted in raw code-point order when framed for hashing
 * (00-core-definitions.md §1.2). This is the sole authority for the three serialized paths.
 */
export const WEB_ARTIFACT_PATHS = [
  "web-coverage.json",
  "web-estate-model.json",
  "web-findings.json",
] as const;

/** One of the three fixed web artifact paths. */
export type WebArtifactPath = (typeof WEB_ARTIFACT_PATHS)[number];

/**
 * Lower-case SHA-256 with an explicit algorithm prefix (00-core-definitions.md §1.2). All
 * three web artifacts carry the same value. Runtime validators additionally enforce
 * `/^sha256:[0-9a-f]{64}$/`.
 */
export type BundleId = `sha256:${string}`;

/**
 * The rendered `web-findings.json` artifact (00-core-definitions.md §5): all loader,
 * validation, and projection findings in the canonical total order, sharing the bundle identity.
 */
export interface WebFindingsArtifact {
  /** Literal artifact format. */
  formatVersion: 2;
  /** Shared deterministic bundle identity. */
  bundleId: BundleId;
  /** All loader, validation, and projection findings in the canonical total order. */
  findings: Finding[];
}

/**
 * The three coordinated in-memory payloads before serialization (00-core-definitions.md §6.2).
 * A single relationship index and safety context produce all three so every entity agrees.
 */
export interface WebArtifactPayloads {
  /** Strict-superset model. */
  model: WebEstateModelV2;
  /** Coverage derived from the same relationship index. */
  coverage: WebCoverageArtifact;
  /** Sorted merged findings. */
  findings: WebFindingsArtifact;
}

/**
 * The three payloads before `bundleId` is attached (00-core-definitions.md §6.3). Hashing frames
 * each unstamped payload's canonical bytes, avoiding a hash cycle.
 */
export type UnstampedWebPayloads = {
  [K in WebArtifactPath]: Omit<
    K extends "web-estate-model.json"
      ? WebEstateModelV2
      : K extends "web-coverage.json"
        ? WebCoverageArtifact
        : WebFindingsArtifact,
    "bundleId"
  >;
};

// ---------------------------------------------------------------------------
// Bundle identity (04 §5.3, 00 §6.3)
// ---------------------------------------------------------------------------

/**
 * Compute the shared `BundleId` over the three UNSTAMPED payloads (04 §5.3). Each artifact is
 * framed in `WEB_ARTIFACT_PATHS` (raw code-point) order as the UTF-8 bytes of
 * `${path.length}:${path}:${bytes.byteLength}:` followed by that payload's exact canonical bytes
 * (including its trailing newline). The path names are ASCII, so `path.length` equals their UTF-8
 * byte length; the payload length is always the encoded `byteLength`, never the JS string length.
 * The decimal lengths and separators frame every path and payload unambiguously. The final stamped
 * payloads are NOT fed back into the hash, so there is no self-hash cycle. Deterministic and
 * synchronous; the only `node:crypto` use in the pure web modules.
 *
 * @param payloads - The three unstamped payloads keyed by their fixed paths.
 * @returns The lowercase `sha256:` + 64 hex digest shared by all three final artifacts.
 */
export function computeBundleId(payloads: UnstampedWebPayloads): BundleId {
  const hash = createHash("sha256");
  for (const path of WEB_ARTIFACT_PATHS) {
    const bytes = Buffer.from(toCanonicalJson(payloads[path]), "utf8");
    hash.update(`${path.length}:${path}:${bytes.byteLength}:`, "utf8");
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Coordinated payload transaction (04 §4)
// ---------------------------------------------------------------------------

/**
 * Build, safety-check, identify, and stamp the coherent three-payload set (04 §4.2), or return a
 * fatal result carrying findings only (04 §4.3). One `ArtifactIndex` and one `WebSafetyContext`
 * drive both model and coverage projection, so every entity relationship agrees exactly. The
 * findings payload is the canonically sorted union of `inputFindings` and every renderer-produced
 * warning — no severity is dropped and no duplicate is collapsed. After the recursive
 * `assertWebArtifactsSafe` guard passes, one framed `BundleId` is stamped onto all three payloads.
 * A fatal model projection, provenance failure, or leak assertion serializes nothing and returns
 * `{ ok: false, findings }` with the sorted union of input and projection findings.
 *
 * Pure: no filesystem, environment, clock, random, locale, or network access; the caller's model
 * and finding arrays are never mutated.
 *
 * @param model - A validated `EstateModel`.
 * @param inputFindings - Immutable loader/validation findings; defaults to none.
 * @returns The stamped `WebArtifactPayloads`, or a fatal findings-only result.
 */
export function buildWebArtifactPayloads(
  model: EstateModel,
  inputFindings: readonly Finding[] = [],
): WebProjectionResult<WebArtifactPayloads> {
  // (1) One safety context and one relationship index shared by model + coverage projection.
  const safety = createWebSafetyContext();
  const index = buildArtifactIndex(model);

  // (2) Project the unstamped model from that index. A fatal projection ends the transaction (§4.3).
  const projected = buildWebEstateModelFromIndex(model, index, safety);
  if (!projected.ok) {
    return { ok: false, findings: sortFindings([...inputFindings, ...projected.findings]) };
  }
  const unstampedModel = projected.value;

  // (3) Coverage from the SAME index; wrap it in the versioned unstamped coverage payload.
  const coverage = computeCoverageFromIndex(model, index);
  const unstampedCoverage: Omit<WebCoverageArtifact, "bundleId"> = {
    formatVersion: 2,
    covered: coverage.covered,
    gaps: coverage.gaps,
    suppressed: coverage.suppressed,
  };

  // (4) One findings union in the canonical total order; no severity filter, no dedupe (§3.3).
  const mergedFindings = sortFindings([...inputFindings, ...safety.findings]);
  const unstampedFindings: Omit<WebFindingsArtifact, "bundleId"> = {
    formatVersion: 2,
    findings: mergedFindings,
  };

  // (5) Final recursive safety assertion over all three unstamped payloads + accumulated canaries.
  const unstamped: UnstampedWebPayloads = {
    "web-coverage.json": unstampedCoverage,
    "web-estate-model.json": unstampedModel,
    "web-findings.json": unstampedFindings,
  };
  const safe = assertWebArtifactsSafe(unstamped, finalizeCanaries(safety));
  if (!safe.ok) {
    return {
      ok: false,
      findings: sortFindings([...inputFindings, ...safety.findings, ...safe.findings]),
    };
  }

  // (6) One framed id stamped onto all three; the stamped payloads are never rehashed (no cycle).
  const bundleId = computeBundleId(unstamped);
  const payloads: WebArtifactPayloads = {
    model: { ...unstampedModel, bundleId },
    coverage: { ...unstampedCoverage, bundleId },
    findings: { ...unstampedFindings, bundleId },
  };
  return { ok: true, value: payloads, findings: mergedFindings };
}

/**
 * Emit the complete coherent web generation as exactly three `RenderedFile` values, or no files
 * (04 §4.2 step 7 / §4.3). Delegates the whole value-level transaction to
 * `buildWebArtifactPayloads`, then canonically serializes each stamped payload to its fixed path
 * and returns the three files sorted by path (raw code-point). A fatal result returns
 * `{ ok: false, findings }` and serializes nothing.
 *
 * @param model - A validated `EstateModel`.
 * @param inputFindings - Immutable loader/validation findings; defaults to none.
 * @returns The three path-sorted rendered files, or a fatal findings-only result.
 */
export function emitWebArtifacts(
  model: EstateModel,
  inputFindings: readonly Finding[] = [],
): WebProjectionResult<RenderedFile[]> {
  const result = buildWebArtifactPayloads(model, inputFindings);
  if (!result.ok) return { ok: false, findings: result.findings };
  const { model: modelArtifact, coverage, findings } = result.value;
  const files: RenderedFile[] = [
    { path: "web-coverage.json", contents: toCanonicalJson(coverage) },
    { path: "web-estate-model.json", contents: toCanonicalJson(modelArtifact) },
    { path: "web-findings.json", contents: toCanonicalJson(findings) },
  ].sort((a, b) => compareString(a.path, b.path));
  return { ok: true, value: files, findings: result.findings };
}

/**
 * Public compatibility entry point (00-core-definitions.md §6.1): project a validated estate into
 * the stamped strict-superset `WebEstateModelV2`. Delegates to `buildWebArtifactPayloads(model, [])`
 * and returns its fully stamped `model`. This intentionally computes coverage and an empty-input
 * findings payload in memory purely to derive the SAME coherent `bundleId` a normal web emission
 * produces, so `WebEstateModelV2.bundleId` always identifies a complete coherent generation. It
 * performs no serialization or I/O.
 *
 * @param model - A validated `EstateModel`.
 * @returns The stamped v2 model on success, or a fatal findings-only result.
 */
export function buildWebEstateModel(model: EstateModel): WebProjectionResult<WebEstateModelV2> {
  const result = buildWebArtifactPayloads(model, []);
  if (!result.ok) return { ok: false, findings: result.findings };
  return { ok: true, value: result.value.model, findings: result.findings };
}
