// packages/web-data/src/wire/validate.ts — strict browser-safe runtime validation for
// the wire shapes the spec validates at the client/stream boundary
// (01-core-definitions.md §§1, 5, 11). Runtime validation starts from `unknown`; a
// TypeScript assertion alone is not validation. Every helper is a pure function that
// returns a freshly-constructed typed value or `null`, never throws for expected
// malformed input, and never echoes a raw input value into an error — so it is safe to
// use on untrusted response/header/tick data. The only value import is the relative
// `OBSERVATION_HEADER_MAX_BYTES` constant from `./common.js` (within `wire/`), so `/wire`
// stays free of any bare runtime dependency.

import { OBSERVATION_HEADER_MAX_BYTES } from "./common.js";
import type { AvailabilityState, CycleObservation, HashId, SourceId, SourceObservation, ViewId } from "./common.js";
import type { LiveTick } from "./live.js";

// ---------------------------------------------------------------------------
// Closed-key runtime tables (exhaustiveness enforced against the type unions)
// ---------------------------------------------------------------------------

// The `satisfies Record<…, true>` annotations force every union member to be present and
// forbid extras at compile time, so these runtime key lists cannot drift from the types.
const SOURCE_ID_KEYS = {
  "victoriametrics-signals": true,
  "victoriametrics-targets": true,
  "victoriametrics-buildinfo": true,
  "alertmanager-alerts": true,
  "alertmanager-silences": true,
  "alertmanager-status": true,
  "alertmanager-receivers": true,
  "vmalert-rules": true,
  "gatus-statuses": true,
  "grafana-health": true,
} as const satisfies Record<SourceId, true>;
const SOURCE_IDS = Object.keys(SOURCE_ID_KEYS) as readonly SourceId[];

const VIEW_ID_KEYS = {
  overview: true,
  alerts: true,
  estate: true,
  engine: true,
  timeline: true,
} as const satisfies Record<ViewId, true>;
const VIEW_IDS = Object.keys(VIEW_ID_KEYS) as readonly ViewId[];

// ---------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------

/** A non-null, non-array plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string (used for identifiers that must be present). */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A positive safe integer (used for the monotonic sequence). */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A nullable UTC timestamp string. */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Whether `value` is exactly the closed `AvailabilityState` set. */
function isAvailabilityState(value: unknown): value is AvailabilityState {
  return value === "current" || value === "stale" || value === "unavailable" || value === "not-configured";
}

/** True only when `obj` has exactly `keys` — no missing and no extra members. */
function hasExactKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  if (Object.keys(obj).length !== keys.length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

/** UTF-8 byte length of a string, used for the observation size bound. */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

// ---------------------------------------------------------------------------
// Public validators
// ---------------------------------------------------------------------------

/**
 * Validate a strong content identity. Accepts only `sha256:` followed by exactly 64
 * lowercase hex characters; returns the branded `HashId` or null. Used for both payload
 * identities and representation ETags.
 */
export function validateHashId(input: unknown): HashId | null {
  if (typeof input !== "string") return null;
  return /^sha256:[0-9a-f]{64}$/.test(input) ? (input as HashId) : null;
}

/**
 * Validate one `SourceObservation`. Requires exactly the three fields (no extras), a
 * closed availability state, and nullable timestamp strings; returns a fresh value or
 * null. Never echoes the raw input.
 */
export function validateSourceObservation(input: unknown): SourceObservation | null {
  if (!isRecord(input)) return null;
  if (!hasExactKeys(input, ["state", "lastAttemptAt", "lastSuccess"])) return null;
  if (!isAvailabilityState(input.state)) return null;
  if (!isNullableString(input.lastAttemptAt)) return null;
  if (!isNullableString(input.lastSuccess)) return null;
  return { state: input.state, lastAttemptAt: input.lastAttemptAt, lastSuccess: input.lastSuccess };
}

/**
 * Strictly validate a `CycleObservation` decoded from an untrusted source (the
 * `X-Pulse-Observation` header or an SSE tick). Rejects incomplete metadata (missing
 * fields or missing source entries), extra fields at any level, malformed types, and
 * oversized metadata whose JSON serialization exceeds `OBSERVATION_HEADER_MAX_BYTES`.
 * Returns a freshly-constructed value or null; a rejection never throws and never exposes
 * a raw input value.
 */
export function validateCycleObservation(input: unknown): CycleObservation | null {
  // Reject oversized or non-serializable metadata first, before any deep inspection.
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return null; // cyclic or otherwise non-serializable (e.g. BigInt)
  }
  if (serialized === undefined || utf8ByteLength(serialized) > OBSERVATION_HEADER_MAX_BYTES) return null;

  if (!isRecord(input)) return null;
  if (!hasExactKeys(input, ["generation", "seq", "observedAt", "appVersion", "sources"])) return null;
  if (!isNonEmptyString(input.generation)) return null;
  if (!isPositiveSafeInteger(input.seq)) return null;
  if (typeof input.observedAt !== "string") return null;
  if (typeof input.appVersion !== "string") return null;
  if (!isRecord(input.sources)) return null;
  if (!hasExactKeys(input.sources, SOURCE_IDS)) return null;

  const sources = {} as Record<SourceId, SourceObservation>;
  for (const id of SOURCE_IDS) {
    const observation = validateSourceObservation(input.sources[id]);
    if (observation === null) return null;
    sources[id] = observation;
  }
  return {
    generation: input.generation,
    seq: input.seq,
    observedAt: input.observedAt,
    appVersion: input.appVersion,
    sources,
  };
}

/**
 * Strictly validate a `LiveTick`. Requires exactly the observation plus an identities map
 * with exactly the five `ViewId` keys, each a valid `HashId`; returns a fresh value or
 * null. A rejection never throws and never exposes a raw input value.
 */
export function validateLiveTick(input: unknown): LiveTick | null {
  if (!isRecord(input)) return null;
  if (!hasExactKeys(input, ["observation", "identities"])) return null;
  const observation = validateCycleObservation(input.observation);
  if (observation === null) return null;
  if (!isRecord(input.identities)) return null;
  if (!hasExactKeys(input.identities, VIEW_IDS)) return null;

  const identities = {} as Record<ViewId, HashId>;
  for (const view of VIEW_IDS) {
    const identity = validateHashId(input.identities[view]);
    if (identity === null) return null;
    identities[view] = identity;
  }
  return { observation, identities };
}
