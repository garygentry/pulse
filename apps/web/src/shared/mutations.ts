// apps/web/src/shared/mutations.ts — shared mutation wire types and constants.
//
// Imported directly by server AND client, so it is deliberately not in `@pulse/web-data/wire` (the
// undeclared `/wire` barrel is not edited). Bundled into the browser: no `node:*`
// imports and no import from `server/`. Package imports are type-only: a value import of
// `@pulse/core/proposals` would bundle its zod schemas into the browser (build-budget.test.ts), so the
// rationale bounds are literals typed as the core constants' literal types (drift fails typecheck) and
// pinned at runtime by mutations-shared.test.ts.

import type { ApiErrorCode } from "@pulse/web-data/wire";
import type { SourceErrorKind } from "@pulse/web-data/sources";
import type {
  PROPOSAL_RATIONALE_MAX_CHARS,
  PROPOSAL_RATIONALE_MIN_CHARS,
  ProposableField,
  ProposalChange,
  ProposalState,
  ProposalValue,
} from "@pulse/core/proposals";

// ── MutationReason (closed, bounded — REQ-SEAM-03, REQ-OBS-01) ─────────────────────────────────────

/** Upstream failure reasons, one per `SourceErrorKind` (REQ-SIL-09). */
export type UpstreamReason = `upstream-${SourceErrorKind}`;

/** Closed set of mutation refusal/failure reasons. Every value is safe to put in a metric label. */
export type MutationReason =
  | "untrusted-identity"      // step 3: no trusted identity (REQ-SEC-01)
  | "cross-origin"            // step 4: same-origin check failed (REQ-SEC-02)
  | "capability-false"        // step 5: capability false for a non-health reason
  | "write-path-degraded"     // step 5: capability false because its store is unhealthy
  | "invalid-body"            // step 6/8: content-type, JSON parse, zod strict, domain bounds
  | "body-too-large"          // step 6: > MUTATION_BODY_MAX_BYTES
  | "missing-idempotency-key" // step 7: absent or malformed Idempotency-Key
  | "idempotency-conflict"    // step 9: same key, different body hash (REQ-IDEM-04)
  | "audit-unavailable"       // step 10: attempted-record I/O failure (REQ-AUD-02)
  | "alert-not-firing"        // handler: ack target not in latest cycle
  | "silence-gone"            // handler: expire of a missing/already-expired silence (REQ-SIL-10)
  | "entity-not-found"        // handler: proposal target not in the estate
  | "stale-proposal"          // handler: `seen` differs from the current declared value
  | "write-failed"            // handler: ack/proposal store persist failed
  | "internal"                // step 10 encoder defect (refusal) OR step 11 handler throw (failed) — see REFUSAL_POLICY
  | UpstreamReason;

/** Every MutationReason, for exhaustive tables and tests. */
export const MUTATION_REASONS: readonly MutationReason[] = [
  "untrusted-identity", "cross-origin", "capability-false", "write-path-degraded", "invalid-body",
  "body-too-large", "missing-idempotency-key", "idempotency-conflict", "audit-unavailable",
  "alert-not-firing", "silence-gone", "entity-not-found", "stale-proposal", "write-failed", "internal",
  "upstream-timeout", "upstream-transport", "upstream-upstream-status", "upstream-malformed-json",
  "upstream-invalid-shape", "upstream-incompatible", "upstream-overflow", "upstream-disabled",
] as const;

// ── MutationSuccess (REQ-SEAM-06, REQ-UX-01) ──────────────────────────────────────────────────────

/** Successful (or replayed) mutation response body. Status 200 or 201. */
export interface MutationSuccess<R> {
  /** Always "succeeded" on 2xx. */
  readonly outcome: "succeeded";
  /** Server request id; also sent as the X-Request-Id header. */
  readonly requestId: string;
  /** Mutation-specific result (see the per-endpoint result types below). */
  readonly result: R;
}

// ── MutationRefusal (REQ-SEAM-03/06, REQ-UX-02) ───────────────────────────────────────────────────

/**
 * Refusal/failure body: exactly the existing `ErrorEnvelope` built by `errorFor(code, status, details)`.
 * Mutation data rides in the scalar `details` map; the API convention is unchanged.
 */
export interface MutationRefusal {
  /** An existing ApiErrorCode: INVALID_REQUEST | TARGET_NOT_FOUND | SOURCE_UNAVAILABLE | SOURCE_TIMEOUT | INTERNAL_ERROR. */
  readonly code: ApiErrorCode;
  /** Fixed ERROR_MESSAGES text for `code`; clients ignore it for mutations and render `details.reason`. */
  readonly message: string;
  /** Scalar details. */
  readonly details: {
    /** Bounded machine reason. */
    readonly reason: MutationReason;
    /** Request id when one was assigned (always, after step 2). */
    readonly requestId?: string;
    /** Invalid body paths (zod paths, dot-joined; no values), comma-joined, ≤ 512 bytes. */
    readonly fields?: string;
  };
}

// ── Per-endpoint body and result types ─────────────────────────────────────────────────────────────

/** One exact-equality matcher; the server sets isRegex:false, isEqual:true (REQ-SIL-02). */
export interface SilenceMatcherInput {
  /** Label name. */ readonly name: string;
  /** Exact label value to match. */ readonly value: string;
}

/** POST /api/mutations/silences body (REQ-SIL-01..05). */
export interface CreateSilenceBody {
  /** Fingerprint of the source alert (audit target; matched-count recompute). */
  readonly fingerprint: string;
  /** 1–24 matchers; `alertname` MUST be present. */
  readonly matchers: readonly SilenceMatcherInput[];
  /** ISO-8601 UTC; now < endsAt ≤ now + SILENCE_MAX_DURATION_MS. */
  readonly endsAt: string;
  /** 10–500 chars after trim; `"[pulse] " + rationale` ≤ 512 UTF-8 bytes; no control chars except \n. */
  readonly rationale: string;
}
/** 201 result. */
export interface CreateSilenceResult {
  /** Alertmanager silence id. */ readonly silenceId: string;
  /** Effective end time, ISO-8601 UTC. */ readonly endsAt: string;
}

/** POST /api/mutations/silences/expire body (REQ-SIL-07). */
export interface ExpireSilenceBody {
  /** Silence to expire (≤ MUTATION_ID_MAX_BYTES). */ readonly silenceId: string;
  /** Optional rationale (audited only). */ readonly rationale?: string;
}
/** 200 result. */
export interface ExpireSilenceResult {
  /** The expired silence id. */ readonly silenceId: string;
}

/** POST /api/mutations/acks body (REQ-ACK-01). */
export interface SetAckBody {
  /** Fingerprint of the firing alert to acknowledge. */ readonly fingerprint: string;
  /** Optional note (≤ ACK_NOTE_MAX_CHARS). */ readonly note?: string;
}
/** 200 result; `at` is the stored ack time (the client pending predicate compares it). */
export interface SetAckResult {
  /** Acknowledged alert fingerprint. */ readonly fingerprint: string;
  /** Stored ack time, ISO-8601 UTC. */ readonly at: string;
}

/** POST /api/mutations/acks/remove body. */
export interface RemoveAckBody {
  /** Fingerprint whose ack is removed. */ readonly fingerprint: string;
}
/** 200 result; `removed:false` when no ack existed (idempotent). */
export interface RemoveAckResult {
  /** Fingerprint the remove applied to. */ readonly fingerprint: string;
  /** Whether an ack existed and was removed. */ readonly removed: boolean;
}

/** POST /api/mutations/proposals body (REQ-PROP-02). `seen`/`proposed` validated per field by the core proposal schema. */
export interface CreateProposalBody {
  /** Target entity: kind plus web drilldown id (≤ PROPOSAL_TARGET_ID_MAX_BYTES). */
  readonly target: { readonly kind: "host" | "service"; readonly id: string };
  /** 1–PROPOSAL_CHANGES_MAX changes with unique fields. */
  readonly changes: readonly { readonly field: ProposableField; readonly seen: ProposalValue; readonly proposed: ProposalValue }[];
  /** 10–500 chars after trim. */
  readonly rationale: string;
}
/** 201 result. */
export interface CreateProposalResult {
  /** Id of the written proposal (p-YYYYMMDDTHHMMSSZ-<8hex>). */ readonly proposalId: string;
}

// ── GET /api/proposals wire types (client-importable; ProposalStore stays server-side) ────

/** Proposal list item served by GET /api/proposals (inert text only). */
export interface ProposalView {
  /** Proposal id. */ readonly id: string;
  /** ISO-8601 UTC. */ readonly createdAt: string;
  /** Proposer displayName only. */ readonly proposer: string;
  /** The proposed field changes. */ readonly changes: readonly ProposalChange[];
  /** Proposer rationale (inert text). */ readonly rationale: string;
  /** Derived state from the result sidecar. */ readonly state: ProposalState;
  /** Reject reason when state === "rejected". */ readonly reason: string | null;
  /** Commit SHA when state === "applied". */ readonly commit: string | null;
}
/** GET /api/proposals?kind=&id= body. */
export interface ProposalListBody {
  /** Whether the proposal store is configured and readable. */ readonly enabled: boolean;
  /** Newest first, ≤ PROPOSAL_LIST_MAX. */ readonly proposals: readonly ProposalView[];
  /** Files failing parse/verify for any target. */ readonly invalidCount: number;
}

// ── Shared constants ────────────────────────────────────────────────────────────────────────

/** Default silence duration: 2 h (REQ-SIL-04). */
export const SILENCE_DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;
/** Silence duration cap: 7 d (REQ-SIL-04). */
export const SILENCE_MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
/** Silence duration presets: 1 h, 2 h, 4 h, 24 h, 7 d. */
export const SILENCE_PRESETS_MS = [1, 2, 4, 24, 168].map((h) => h * 3_600_000) as readonly number[];
/** Minimum matchers per silence. */
export const SILENCE_MATCHERS_MIN = 1;
/** Maximum matchers per silence. */
export const SILENCE_MATCHERS_MAX = 24;
/** Marker prefixed to every Pulse-created silence comment (REQ-SIL-05). */
export const SILENCE_COMMENT_PREFIX = "[pulse] " as const;
/** Silence comment cap in UTF-8 bytes (= SOURCE_MAX_NAME_BYTES). */
export const SILENCE_COMMENT_MAX_BYTES = 512;
/** Minimum rationale length in code points after trim (REQ-SIL-05, REQ-PROP-02); typed as the core value. */
export const RATIONALE_MIN_CHARS: typeof PROPOSAL_RATIONALE_MIN_CHARS = 10;
/** Maximum rationale length in code points after trim (REQ-SIL-05, REQ-PROP-02); typed as the core value. */
export const RATIONALE_MAX_CHARS: typeof PROPOSAL_RATIONALE_MAX_CHARS = 500;
/** Ack note cap in code points (REQ-ACK-01). */
export const ACK_NOTE_MAX_CHARS = 280;
/** A pending action not reflected after 3 core cycles is shown as "not yet reflected". */
export const PENDING_STALE_MS = 30_000;
/** The label every silence must match on. */
export const ALERTNAME_LABEL = "alertname" as const;
