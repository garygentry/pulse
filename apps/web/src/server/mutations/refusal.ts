// apps/web/src/server/mutations/refusal.ts — the single mutation status/code policy.
//
// `refuse()` and the dispatcher's failed-outcome path both read these tables; nothing else chooses a
// mutation status. The policy tables come first; the response builders follow.

import type { ApiErrorCode } from "@pulse/web-data/wire";
import type { MutationReason, MutationRefusal, MutationSuccess, UpstreamReason } from "../../shared/mutations.js";
import { apiError } from "../routes/respond.js";
import { log } from "../log.js";
import { recordMutationRefusal } from "../routes/metrics.js";
import { IDEMPOTENCY_REPLAYED_HEADER, MUTATION_CACHE_CONTROL, REQUEST_ID_HEADER } from "./constants.js";
import type { AuditDetails, MutationAction } from "./registry.js";
import type { StoredOutcome } from "./idempotency.js";

/** Where in the pipeline a reason may arise. */
export type ReasonPhase = "refusal" | "failed";

/** Status/code/audit/storage policy for one reason in one phase. */
export interface ReasonPolicy {
  /** HTTP status. */ readonly status: 400 | 403 | 404 | 409 | 413 | 500 | 502 | 503 | 504;
  /** Existing envelope code. */ readonly code: ApiErrorCode;
  /** Whether an audit record is written (a `failed` finalize). Refusals: never (REQ-AUD-06). */
  readonly audited: boolean;
  /** Whether the outcome is stored for idempotent replay. Refusals: never. */
  readonly stored: boolean;
  /** Whether this reason marks a write-path store degraded. */
  readonly degrades: "audit" | "acks" | "proposals" | null;
}

/** Refusals — dispatcher steps 3–10 (before the handler runs). Counted in pulse_web_mutation_refusals_total. */
export const REFUSAL_POLICY: Readonly<Record<RefusalReason, ReasonPolicy>> = {
  "untrusted-identity":      { status: 403, code: "INVALID_REQUEST",    audited: false, stored: false, degrades: null },
  "cross-origin":            { status: 403, code: "INVALID_REQUEST",    audited: false, stored: false, degrades: null },
  "capability-false":        { status: 403, code: "INVALID_REQUEST",    audited: false, stored: false, degrades: null },
  "write-path-degraded":     { status: 503, code: "SOURCE_UNAVAILABLE", audited: false, stored: false, degrades: null },
  "invalid-body":            { status: 400, code: "INVALID_REQUEST",    audited: false, stored: false, degrades: null },
  "missing-idempotency-key": { status: 400, code: "INVALID_REQUEST",    audited: false, stored: false, degrades: null },
  "body-too-large":          { status: 413, code: "INVALID_REQUEST",    audited: false, stored: false, degrades: null },
  "idempotency-conflict":    { status: 409, code: "INVALID_REQUEST",    audited: false, stored: false, degrades: null },
  "audit-unavailable":       { status: 503, code: "SOURCE_UNAVAILABLE", audited: false, stored: false, degrades: "audit" },
  // Step-10 audit-details encoder defect — a refusal; does NOT degrade the write path.
  "internal":                { status: 500, code: "INTERNAL_ERROR",     audited: false, stored: false, degrades: null },
};
/** Every reason a mutation can be refused before its handler runs (the REFUSAL_POLICY keys). */
export type RefusalReason =
  | "untrusted-identity" | "cross-origin" | "capability-false" | "write-path-degraded" | "invalid-body"
  | "missing-idempotency-key" | "body-too-large" | "idempotency-conflict" | "audit-unavailable" | "internal";

/** Failed outcomes — dispatcher steps 11–12 (handler and audit finalize). Audited `failed`, stored for replay. */
export type FailedReason =
  | "alert-not-firing" | "silence-gone" | "entity-not-found" | "stale-proposal" | "write-failed" | "internal" | UpstreamReason;
/** Status/code policy for failed outcomes; upstream reasons collapse to the timeout (504) and other (502) rows. */
export const FAILED_POLICY: Readonly<Record<Exclude<FailedReason, UpstreamReason>, ReasonPolicy>> & {
  readonly upstreamTimeout: ReasonPolicy; readonly upstreamOther: ReasonPolicy;
} = {
  "alert-not-firing": { status: 404, code: "TARGET_NOT_FOUND",   audited: true, stored: true, degrades: null },
  "silence-gone":     { status: 404, code: "TARGET_NOT_FOUND",   audited: true, stored: true, degrades: null },
  "entity-not-found": { status: 404, code: "TARGET_NOT_FOUND",   audited: true, stored: true, degrades: null },
  "stale-proposal":   { status: 409, code: "INVALID_REQUEST",    audited: true, stored: true, degrades: null },
  "write-failed":     { status: 500, code: "INTERNAL_ERROR",     audited: true, stored: true, degrades: null }, // store self-degrades
  // Step-11 handler throw — audited `failed`, stored.
  "internal":         { status: 500, code: "INTERNAL_ERROR",     audited: true, stored: true, degrades: null },
  upstreamTimeout:    { status: 504, code: "SOURCE_TIMEOUT",     audited: true, stored: true, degrades: null },
  upstreamOther:      { status: 502, code: "SOURCE_UNAVAILABLE", audited: true, stored: true, degrades: null },
};

// ── Types and helpers ─────────────────────────────────────────────────────────────────────────────────

/** Per-request rendering context, fixed at step 2. */
export interface ResponseContext {
  /** Matched definition's action (metric and log label). */ readonly action: MutationAction;
  /** Server request id (header, body, log, audit). */ readonly requestId: string;
}

/** A handler outcome after the dispatcher has applied FAILED_POLICY (step 11). */
export type NormalizedOutcome =
  | {
      /** Success. */ readonly outcome: "succeeded";
      /** 200 or 201 from the handler. */ readonly status: 200 | 201;
      /** Result echoed in MutationSuccess.result. */ readonly result: unknown;
      /** Raw finalize details (encoded by encodeAuditDetails). */ readonly details: AuditDetails;
    }
  | {
      /** Failure after the attempted record. */ readonly outcome: "failed";
      /** Reason (a FailedReason; undeclared handler reasons collapse to "internal"). */ readonly reason: FailedReason;
      /** Resolved policy row (status, code). */ readonly policy: ReasonPolicy;
      /** Raw finalize details (handler's, e.g. staleField; the dispatcher adds `reason` at step 12). */ readonly details: AuditDetails;
    };

/** Headers on EVERY mutation response after step 2 (REQ-SEAM-06). Never an identity header or peer. */
export function mutationHeaders(requestId: string, replayed: boolean): Record<string, string> {
  return {
    "cache-control": MUTATION_CACHE_CONTROL,
    [REQUEST_ID_HEADER]: requestId,
    ...(replayed ? { [IDEMPOTENCY_REPLAYED_HEADER]: "true" } : {}),
  };
}

/**
 * The refusal/failure body: exactly `apiError(code, details)` (respond.ts), i.e. the unchanged
 * ErrorEnvelope with the catalog message. `details` holds only the closed reason, the server request id
 * and sanitized paths.
 */
export function refusalBody(code: ApiErrorCode, reason: MutationReason, requestId: string, fields?: string): MutationRefusal {
  const details = fields === undefined ? { reason, requestId } : { reason, requestId, fields };
  return apiError(code, details) as MutationRefusal; // apiError always sets details when given
}

// ── Builders ──────────────────────────────────────────────────────────────────────────────────────────
// `errorFor` cannot attach headers, so the builders use `apiError` + `Response.json`; the body bytes equal
// the `errorFor(code, status, details)` body (pinned by mutations-envelope.test.ts).

/** Pure: the refusal Response for `reason` (no metric, no log). Used for waiter templates (step 10). */
export function refusalResponse(reason: RefusalReason, rc: ResponseContext, fields?: string): Response {
  const policy = REFUSAL_POLICY[reason];
  return Response.json(refusalBody(policy.code, reason, rc.requestId, fields), {
    status: policy.status,
    headers: mutationHeaders(rc.requestId, false),
  });
}

/** Emit the refusal metric + `mutation_refused` log for one refused HTTP response. */
export function emitRefusal(reason: RefusalReason, rc: ResponseContext): void {
  recordMutationRefusal(rc.action, reason);
  log({ event: "mutation_refused", ok: false, requestId: rc.requestId, action: rc.action, reason });
}

/**
 * Refuse: emit, then build. A refusal never reaches upstream, writes no audit record
 * (REQ-AUD-06), and is never stored for idempotency.
 */
export function refuse(reason: RefusalReason, rc: ResponseContext, fields?: string): Response {
  emitRefusal(reason, rc);
  return refusalResponse(reason, rc, fields);
}

const FAILED_KEYS: ReadonlySet<string> = new Set([
  "alert-not-firing", "silence-gone", "entity-not-found", "stale-proposal", "write-failed", "internal",
]);

/**
 * Resolve the FAILED_POLICY row for a handler-reported reason. `upstream-timeout` maps to 504 and other
 * `upstream-*` values map to 502. A reason outside FailedReason (for example a handler returning a
 * refusal-only reason such as "invalid-body", which belongs in `validate`) is a handler contract violation
 * and collapses to "internal".
 */
export function resolveFailedPolicy(reason: MutationReason): { readonly reason: FailedReason; readonly policy: ReasonPolicy } {
  if (reason.startsWith("upstream-")) {
    const upstream = reason as UpstreamReason;
    return { reason: upstream, policy: upstream === "upstream-timeout" ? FAILED_POLICY.upstreamTimeout : FAILED_POLICY.upstreamOther };
  }
  if (FAILED_KEYS.has(reason)) {
    const key = reason as Exclude<FailedReason, UpstreamReason>;
    return { reason: key, policy: FAILED_POLICY[key] };
  }
  return { reason: "internal", policy: FAILED_POLICY.internal };
}

/** Convert a normalized outcome into the replayable StoredOutcome (step 13). */
export function outcomeToStored(outcome: NormalizedOutcome, requestId: string): StoredOutcome {
  if (outcome.outcome === "succeeded") {
    const body: MutationSuccess<unknown> = { outcome: "succeeded", requestId, result: outcome.result };
    return { status: outcome.status, body, requestId };
  }
  return { status: outcome.policy.status, body: refusalBody(outcome.policy.code, outcome.reason, requestId), requestId };
}

/** Pure: a Response for a stored outcome. `replayed` adds `Idempotency-Replayed: true`. */
export function storedResponse(stored: StoredOutcome, replayed: boolean): Response {
  return Response.json(stored.body, { status: stored.status, headers: mutationHeaders(stored.requestId, replayed) });
}
