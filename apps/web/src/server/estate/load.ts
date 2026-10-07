// src/server/estate/load.ts — read → parse → version-assert → structural check of the rendered
// web-estate-model.json. The ONLY code path that reads a file for estate
// structure (REQ-MODEL-01). Pure of timing/scheduling concern; never throws — every failure mode is
// captured into a discriminated `LoadResult` (REQ-MODEL-03) so the caller enters error-page mode
// rather than crashing.

import type {
  WebCoverageArtifact,
  WebEstateModel,
  WebEstateModelV2,
  WebFindingsArtifact,
} from "@pulse/renderer";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { SUPPORTED_WEB_MODEL_VERSIONS } from "./versions.js";
import { EstateBundleError, EstateModelError } from "../../shared/errors.js";
import type { EstateBundleArtifact } from "../../shared/errors.js";
import { parseEstateBundle } from "./validate.js";

// ── Estate bundle contracts (rendered-model-v2) ─────────────────────────────────────────────────
// Shared v2 bundle types are homed here (00-core-definitions.md §7); items 008-009 implement
// `deriveEstateBundlePaths`, `loadEstateBundle`, and `parseEstateBundle` against them. `validate.ts`
// imports these type-only, so the runtime edge (load → parseEstateBundle) stays acyclic. Declared
// once here and nowhere else. The current single-model `loadEstateModel`/`parseEstateModel` runtime
// below is unchanged and remains authoritative until item 011.

/** Derived sibling paths for one configured model path. */
export interface EstateBundlePaths {
  /** Configured mandatory model path. */
  model: string;
  /** `web-coverage.json` in the same directory. */
  coverage: string;
  /** `web-findings.json` in the same directory. */
  findings: string;
}

/** Raw file bytes; optional siblings are null only when ENOENT. */
export interface BundleFileBytes {
  model: string;
  coverage: string | null;
  findings: string | null;
}

/** Validated server authority, not a rendered artifact. */
export interface EstateBundle {
  /** Mandatory v2 model. */
  model: WebEstateModelV2;
  /** Validated coverage, or null only when absent. */
  coverage: WebCoverageArtifact | null;
  /** Validated findings, or null only when absent. */
  findings: WebFindingsArtifact | null;
  /** UTC ISO timestamp set when these bytes became authoritative. */
  loadedAt: string;
}

/** Result-as-data outcome of loading or validating one estate bundle; never thrown. */
export type EstateBundleLoadResult =
  | { ok: true; bundle: EstateBundle }
  | { ok: false; error: EstateBundleError };

// ── v2 bundle loader (05-bundle-loader-and-validation.md §§3, 4, 8) ──────────────────────────────

/**
 * Derive the complete three-member bundle paths from the configured model path (05 §3). The model
 * path is used verbatim; `web-coverage.json` and `web-findings.json` are fixed siblings in the same
 * directory. No coverage/findings configuration option is introduced. Accepts relative or absolute
 * paths — deployment owns the mount path; only JSON-contained provenance is constrained to relative.
 */
export function deriveEstateBundlePaths(modelPath: string): EstateBundlePaths {
  const directory = dirname(modelPath);
  return {
    model: modelPath,
    coverage: join(directory, "web-coverage.json"),
    findings: join(directory, "web-findings.json"),
  };
}

/**
 * Read, parse, and validate one rendered estate bundle without throwing (05 §4). Reads sequentially
 * in model → coverage → findings order so simultaneous failures give a deterministic first error.
 * Only an optional sibling whose read fails with `code === "ENOENT"` maps to `null` absence; the
 * mandatory model's ENOENT is a `missing` error and every other read rejection is `unreadable`. The
 * `loadedAt` timestamp is generated only after all reads succeed, then all bytes flow to
 * `parseEstateBundle` exactly once. OS error text is never copied into the public message (05 §4.1).
 *
 * @param modelPath - Configured model path, or `null` when the env var is unset/empty.
 * @param now       - Injectable clock; defaults to `() => new Date()`.
 */
export async function loadEstateBundle(
  modelPath: string | null,
  now: () => Date = () => new Date(),
): Promise<EstateBundleLoadResult> {
  // 1. Null configuration — do not call `now` or read any file.
  if (modelPath === null) {
    return { ok: false, error: nullConfigError() };
  }

  // 2. Derive all paths once.
  const paths = deriveEstateBundlePaths(modelPath);

  // 3. Model is mandatory: ENOENT → missing, every other rejection → unreadable.
  let modelBytes: string;
  try {
    modelBytes = await readFile(paths.model, "utf8");
  } catch (cause) {
    return {
      ok: false,
      error: isEnoent(cause)
        ? modelMissingError(paths.model)
        : unreadableError("model", paths.model),
    };
  }

  // 4. Coverage is optional: ENOENT → null absence, every other rejection → unreadable.
  let coverageBytes: string | null;
  try {
    coverageBytes = await readFile(paths.coverage, "utf8");
  } catch (cause) {
    if (!isEnoent(cause)) {
      return { ok: false, error: unreadableError("coverage", paths.coverage) };
    }
    coverageBytes = null;
  }

  // 5. Findings is optional, read identically.
  let findingsBytes: string | null;
  try {
    findingsBytes = await readFile(paths.findings, "utf8");
  } catch (cause) {
    if (!isEnoent(cause)) {
      return { ok: false, error: unreadableError("findings", paths.findings) };
    }
    findingsBytes = null;
  }

  // 6. Record load time only after every read succeeded. A thrown/invalid clock is an internal
  //    operation failure; never manufacture a timestamp.
  let loadedAt: string;
  try {
    loadedAt = now().toISOString();
    if (typeof loadedAt !== "string" || loadedAt.length === 0) {
      return { ok: false, error: clockError(paths.model) };
    }
  } catch {
    return { ok: false, error: clockError(paths.model) };
  }

  // 7. Validate all bytes together, exactly once.
  return parseEstateBundle(
    { model: modelBytes, coverage: coverageBytes, findings: findingsBytes },
    paths,
    loadedAt,
  );
}

/** Code-based ENOENT detection — never string-match OS wording (05 §4.1; item 008 notes). */
function isEnoent(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT"
  );
}

/** Null-configuration error: artifact `model`, path `""`, field null (05 §8). */
function nullConfigError(): EstateBundleError {
  return new EstateBundleError(
    "missing",
    "model",
    "",
    "Estate model path is not configured. Set PULSE_WEB_ESTATE_MODEL to the read-only mount of " +
      "web-estate-model.json.",
  );
}

/** Mandatory model ENOENT error: artifact `model`, model path, field null (05 §8). */
function modelMissingError(path: string): EstateBundleError {
  return new EstateBundleError(
    "missing",
    "model",
    path,
    `Required estate model is missing at ${path}. Run 'pulse render' and verify the ` +
      `PULSE_WEB_ESTATE_MODEL mount.`,
  );
}

/** Non-ENOENT read failure for any member: field null, no OS error text (05 §§4.1, 8). */
function unreadableError(artifact: EstateBundleArtifact, path: string): EstateBundleError {
  return new EstateBundleError(
    "unreadable",
    artifact,
    path,
    `Estate bundle ${artifact} is unreadable at ${path}. Verify the read-only rendered-tree mount ` +
      `and file permissions, then run 'pulse render' if needed.`,
  );
}

/** Invalid/thrown clock: artifact `model`, model path, field `loadedAt` (05 §8). */
function clockError(path: string): EstateBundleError {
  return new EstateBundleError(
    "unreadable",
    "model",
    path,
    `Estate bundle load time could not be recorded for ${path}. Verify the server clock and retry ` +
      `the load.`,
    { field: "loadedAt" },
  );
}

/**
 * The outcome of loading + validating the rendered estate model.
 * - `ok: true`  → a structurally-valid, version-compatible `WebEstateModel`.
 * - `ok: false` → an `EstateModelError` carrying kind + path + agent-actionable message;
 *   the server enters error-page mode (§4, REQ-MODEL-03).
 */
export type LoadResult =
  | { ok: true; model: WebEstateModel }
  | { ok: false; error: EstateModelError };

/**
 * Read, parse, and validate the rendered estate model at `path`. Never throws: every failure mode
 * is captured into a `LoadResult` with `ok: false` (REQ-MODEL-03) so the caller can enter error-page
 * mode rather than crash. The `path` is the in-container mount path from `PULSE_WEB_ESTATE_MODEL`
 * (e.g. `/rendered/web-estate-model.json`, REQ-PKG-04).
 *
 * @param path - Absolute in-container path to `web-estate-model.json` (config.estateModelPath), or
 *   `null` when the env var is unset/empty — both yield a `missing` error (servable error-page mode).
 * @returns A `LoadResult`; `ok: false` for missing / unparseable / version / structure failures.
 */
export async function loadEstateModel(path: string | null): Promise<LoadResult> {
  if (path === null) {
    return {
      ok: false,
      error: new EstateModelError(
        "missing",
        "",
        `Estate model path is not configured (PULSE_WEB_ESTATE_MODEL is unset or empty). ` +
          `Set it to the read-only mount of the rendered web-estate-model.json.`,
      ),
    };
  }
  let bytes: string;
  try {
    bytes = await readFile(path, "utf8");
  } catch (cause) {
    return {
      ok: false,
      error: new EstateModelError(
        "missing",
        path,
        `Estate model not found or unreadable at ${path} (${describe(cause)}). ` +
          `Render it with 'pulse render' and confirm the read-only mount ` +
          `(PULSE_WEB_ESTATE_MODEL → the rendered web-estate-model.json).`,
      ),
    };
  }
  return parseEstateModel(bytes, path);
}

/**
 * Parse + validate already-read model bytes. Pure (no I/O), so it is reused by `maybeReload` after a
 * content change and is table-tested directly. Order matters: JSON well-formedness → root shape →
 * version compatibility (REQ-MODEL-02) → structural fields (REQ-MODEL-03).
 *
 * @param bytes - The raw file contents (UTF-8).
 * @param path  - The source path, echoed into every error message for agent-actionability.
 * @returns A `LoadResult`.
 */
export function parseEstateModel(bytes: string, path: string): LoadResult {
  let root: unknown;
  try {
    root = JSON.parse(bytes);
  } catch (cause) {
    return {
      ok: false,
      error: new EstateModelError(
        "unparseable",
        path,
        `Estate model at ${path} is not valid JSON (${describe(cause)}). ` +
          `Re-run 'pulse render'; a truncated file usually means the mount was read mid-copy.`,
      ),
    };
  }

  const versionError = checkVersion(root, path);
  if (versionError !== null) return { ok: false, error: versionError };

  const structureError = checkStructure(root, path);
  if (structureError !== null) return { ok: false, error: structureError };

  // Validated: root is a version-compatible, structurally-sound WebEstateModel. The cast is safe
  // because checkVersion + checkStructure have asserted every field the app reads; deeper field
  // validation is intentionally omitted (the producer is the in-repo renderer — §1).
  return { ok: true, model: root as WebEstateModel };
}

/** Render an unknown thrown value as a short message fragment for an error string. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Assert the artifact is a JSON object carrying a supported `formatVersion` (REQ-MODEL-02). A
 * non-object root, or a `formatVersion` that is missing / non-numeric / unsupported, yields a
 * `version` error. `foundVersion` is the offending numeric version, or `null` when absent/non-numeric.
 *
 * @returns An `EstateModelError` (kind `version`) on mismatch, or `null` when compatible.
 */
function checkVersion(root: unknown, path: string): EstateModelError | null {
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    return new EstateModelError(
      "version",
      path,
      `Estate model at ${path} is not a JSON object (found ${kindOf(root)}). ` +
        `Re-render with 'pulse render'; do not hand-edit web-estate-model.json.`,
    );
  }
  const found = (root as Record<string, unknown>)["formatVersion"];
  if (typeof found !== "number") {
    return new EstateModelError(
      "version",
      path,
      `Estate model at ${path} has no numeric 'formatVersion'. ` +
        `Re-render with a current 'pulse' version.`,
    );
  }
  if (!SUPPORTED_WEB_MODEL_VERSIONS.includes(found)) {
    return new EstateModelError(
      "version",
      path,
      `Estate model at ${path} has formatVersion ${found}, but this build supports ` +
        `[${SUPPORTED_WEB_MODEL_VERSIONS.join(", ")}]. Re-render with a matching 'pulse' version, ` +
        `or upgrade the web app image.`,
      found,
    );
  }
  return null;
}

/**
 * Shallow structural validation of an already-version-checked root (REQ-MODEL-03). Confirms the
 * arrays the app iterates are present and their identity fields are strings. Returns the FIRST
 * violation as a `structure` error naming the offending field, or `null` when sound.
 *
 * @returns An `EstateModelError` (kind `structure`) on the first problem, or `null`.
 */
function checkStructure(root: unknown, path: string): EstateModelError | null {
  const obj = root as Record<string, unknown>;

  const estate = obj["estate"];
  if (typeof estate !== "object" || estate === null) {
    return structErr(path, "estate", "expected an object with { name, domains }");
  }
  const estateObj = estate as Record<string, unknown>;
  if (typeof estateObj["name"] !== "string") {
    return structErr(path, "estate.name", "expected a string");
  }
  if (!Array.isArray(estateObj["domains"])) {
    return structErr(path, "estate.domains", "expected an array");
  }

  const hosts = obj["hosts"];
  if (!Array.isArray(hosts)) {
    return structErr(path, "hosts", "expected an array (an empty array is valid — REQ-GRID-04)");
  }
  for (let i = 0; i < hosts.length; i++) {
    const h = hosts[i] as Record<string, unknown> | null;
    if (typeof h !== "object" || h === null || typeof h["name"] !== "string") {
      return structErr(path, `hosts[${i}].name`, "expected a string");
    }
  }

  const services = obj["services"];
  if (!Array.isArray(services)) {
    return structErr(path, "services", "expected an array");
  }
  for (let i = 0; i < services.length; i++) {
    const s = services[i] as Record<string, unknown> | null;
    if (typeof s !== "object" || s === null || typeof s["name"] !== "string") {
      return structErr(path, `services[${i}].name`, "expected a string");
    }
    if (typeof s["host"] !== "string") {
      return structErr(path, `services[${i}].host`, "expected a string");
    }
  }

  return null;
}

/** Build a `structure` EstateModelError naming the offending field + fix path. */
function structErr(path: string, field: string, detail: string): EstateModelError {
  return new EstateModelError(
    "structure",
    path,
    `Estate model at ${path} has a malformed field '${field}' (${detail}). ` +
      `Re-run 'pulse render'; do not hand-edit web-estate-model.json.`,
  );
}

/** Human-readable JSON kind of an unknown value, for error messages. */
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
