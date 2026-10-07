// src/shared/errors.ts — the WebAppError hierarchy.
//
// A single base class with a stable `code` (TypeScript stack convention), one subclass per failure
// domain. Engine-source failures are NOT thrown across the refresh loop — they are captured into
// `SourceHealth`; the throwing errors below are the startup/model/route faults.

/** Base for every web-app error; carries a stable machine `code` (agent-actionable). */
export class WebAppError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A required engine/model env var is missing or empty at startup. Hard startup failure — the slot always injects these, so absence means a mis-deployed
 *  container; crash-fast + red healthcheck is correct. `code: "CONFIG_MISSING_ENV"`. */
export class ConfigError extends WebAppError {
  /** The offending environment variable name (from `ENV`, §1). */
  readonly envVar: string;
  constructor(envVar: string, message: string) {
    super("CONFIG_MISSING_ENV", message);
    this.envVar = envVar;
  }
}

/** Which estate-model failure mode occurred (drives the error-page and `/healthz` detail). */
export type EstateModelErrorKind = "missing" | "unparseable" | "version" | "structure";

/** The estate model could not be loaded/validated (REQ-MODEL-03). Puts the server in error-page
 *  mode; recovery is automatic on the next cycle that reads a valid file. Every
 *  message names the file path, the problem, and the fix path (`pulse render`, mount check) —
 *  agent-actionable, never an empty or partial grid. */
export class EstateModelError extends WebAppError {
  /** Which failure mode (drives the error-page and `/healthz` detail). */
  readonly kind: EstateModelErrorKind;
  /** The absolute in-container model path (from `PULSE_WEB_ESTATE_MODEL`) — named in the page. */
  readonly path: string;
  /** For `kind:"version"`, the offending `formatVersion`; else `null`. */
  readonly foundVersion: number | null;
  constructor(kind: EstateModelErrorKind, path: string, message: string, foundVersion?: number) {
    super(`ESTATE_MODEL_${kind.toUpperCase()}`, message);
    this.kind = kind;
    this.path = path;
    this.foundVersion = foundVersion ?? null;
  }
}

// ── Estate bundle errors (rendered-model-v2) ────────────────────────────────────────────────────
// The v2 bundle boundary reads three coherent rendered members (model + optional coverage/findings
// siblings). `EstateBundleError` is the result-as-data failure the bundle loader/validator return
// for one bad member OR a cross-member invariant. It supersedes `EstateModelError` once item 011
// switches runtime authority; both coexist until then so the current single-model loader keeps
// working. Contract is authoritative in 00-core-definitions.md §8.

/** Which bundle failure mode occurred; drives health output and agent recovery guidance. */
export type EstateBundleErrorKind =
  | "missing"
  | "unreadable"
  | "unparseable"
  | "version"
  | "structure"
  | "incoherent";

/** Which bundle member the failure is attributed to. */
export type EstateBundleArtifact = "model" | "coverage" | "findings";

/** Stable result-as-data failure for one bundle member or a cross-member invariant. Never thrown
 *  across the loader/validator — returned in the failure branch of `EstateBundleLoadResult`. No
 *  message reproduces an unsafe field value (REQ-BUNDLE-07, REQ-OBS-03). `code: "ESTATE_BUNDLE_<KIND>"`. */
export class EstateBundleError extends WebAppError {
  /** Stable category used by agents and health output. */
  readonly kind: EstateBundleErrorKind;
  /** Member that failed; `model` for a cross-bundle identity/coverage failure rooted there. */
  readonly artifact: EstateBundleArtifact;
  /** Configured/derived filesystem path. */
  readonly path: string;
  /** Exact JSON field path, or `null` for I/O/root failures. */
  readonly field: string | null;
  /** Unsupported numeric format, or `null`. */
  readonly foundVersion: number | null;

  constructor(
    kind: EstateBundleErrorKind,
    artifact: EstateBundleArtifact,
    path: string,
    message: string,
    options: { field?: string; foundVersion?: number } = {},
  ) {
    super(`ESTATE_BUNDLE_${kind.toUpperCase()}`, message);
    this.kind = kind;
    this.artifact = artifact;
    this.path = path;
    this.field = options.field ?? null;
    this.foundVersion = options.foundVersion ?? null;
  }
}
