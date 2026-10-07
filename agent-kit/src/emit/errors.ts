// agent-kit/src/emit/errors.ts
// The agent-kit build/generation error hierarchy.
//
// Generation and emit follow the repo's stated-throws pattern: a malformed unit, an unknown
// ecosystem target, a slot mismatch, or a secret literal in emitted content THROWS, failing
// `bun run generate` / `tsc -b` / the tests loudly. No silent fallback — a broken source must
// fail the build, not emit degraded content. Every error carries a stable `code` and
// domain-specific context fields.

/** Base error for all agent-kit build/generation failures. Carries a stable `code`. */
export class AgentKitError extends Error {
  /** Stable machine-readable code, e.g. "CONTENT_INVALID". */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * A `ContentUnit` is malformed: bad id casing, a `requirements` entry failing `REQ_ID_RE`,
 * an empty `targets`, or a `render()` returning no sections. Fails `generate`.
 */
export class ContentValidationError extends AgentKitError {
  /** The offending unit id (or "<unknown>" if unreadable). */
  readonly unitId: string;

  constructor(unitId: string, message: string) {
    super("CONTENT_INVALID", `content unit '${unitId}': ${message}`);
    this.unitId = unitId;
  }
}

/** A manifest/unit targets an ecosystem with no registered `Emitter`. */
export class UnknownEcosystemError extends AgentKitError {
  /** The unrecognized ecosystem string. */
  readonly ecosystem: string;

  constructor(ecosystem: string) {
    super("UNKNOWN_ECOSYSTEM", `no emitter registered for ecosystem '${ecosystem}'`);
    this.ecosystem = ecosystem;
  }
}

/** A `render()` referenced a slot the `Slots` bundle did not supply, or of the wrong shape. */
export class SlotMismatchError extends AgentKitError {
  /** The slot name that mismatched, e.g. "cliContract". */
  readonly slot: string;

  constructor(slot: string, message: string) {
    super("SLOT_MISMATCH", `slot '${slot}': ${message}`);
    this.slot = slot;
  }
}

/**
 * An emitted file contains a secret literal (REQ-SEC-01) — only `${ENV}` / `op://` reference
 * grammar is permitted. Thrown by the generation-time secret-safety lint.
 */
export class SecretLiteralError extends AgentKitError {
  /** The emitted file path the literal was found in. */
  readonly path: string;

  constructor(path: string, message: string) {
    super("SECRET_LITERAL", `emitted file '${path}' contains a secret literal: ${message}`);
    this.path = path;
  }
}
