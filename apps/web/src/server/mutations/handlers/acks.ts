// apps/web/src/server/mutations/handlers/acks.ts — the ack.set / ack.remove mutations
// (REQ-ACK-01/02/05/08, REQ-SEC-03/06/07, REQ-PERF-03).
//
// Pulse-local state only: no Alertmanager write client is ever injected, so neither mutation makes
// an upstream call (REQ-ACK-08). Registration happens in definitions.ts.

import { z, type ZodType, type ZodTypeDef } from "zod";
import type { Identity } from "@pulse/web-data/identity";
import type { ServerContext } from "../../../shared/registry.js";
import {
  ACK_NOTE_MAX_CHARS,
  type SetAckBody,
  type SetAckResult,
  type RemoveAckBody,
  type RemoveAckResult,
} from "../../../shared/mutations.js";
import type { MutationDefinition, MutationOutcome, AuditDetails } from "../registry.js";
import type { AckRecord, AckStore } from "../stores/ack-store.js";
import { fingerprintSchema } from "../stores/ack-store.js"; // ≤ MUTATION_ID_MAX_BYTES (128), no control chars

// ── Body schemas ──────────────────────────────────────────────────────────────────────────────────

/** C0 (except \n), DEL, C1 control characters — rejected in free text (SEC-07). */
const CONTROL_EXCEPT_NL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u;

/** Request note: after trim, ≤ ACK_NOTE_MAX_CHARS code points; no control chars except \n. May be "" or whitespace (→ no note). */
const noteInputSchema = z
  .string()
  .refine((s) => [...s.trim()].length <= ACK_NOTE_MAX_CHARS, "note-too-long")
  .refine((s) => !CONTROL_EXCEPT_NL.test(s), "note-control-char");

/** POST /api/mutations/acks body — strict (unknown keys → invalid-body). */
export const setAckBodySchema: ZodType<SetAckBody, ZodTypeDef, unknown> = z
  .object({ fingerprint: fingerprintSchema, note: noteInputSchema.optional() })
  .strict()
  .transform(
    (b): SetAckBody => (b.note === undefined ? { fingerprint: b.fingerprint } : { fingerprint: b.fingerprint, note: b.note }),
  );

/** POST /api/mutations/acks/remove body — strict. */
export const removeAckBodySchema: ZodType<RemoveAckBody, ZodTypeDef, unknown> = z
  .object({ fingerprint: fingerprintSchema })
  .strict();

/** Normalize a validated note: trimmed; empty → null (stored/wire `note: null`). */
export function normalizeNote(note?: string): string | null {
  if (note === undefined) return null;
  const trimmed = note.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ── Dependencies ──────────────────────────────────────────────────────────────────────────────────

/** Closure dependencies; constructed in buildWriteRuntime. */
export interface AckMutationDeps {
  /** The process ack store (proxy-header mode only). */
  readonly ackStore: AckStore;
  /** Wall clock for `at`; defaults to () => new Date(). */
  readonly now?: () => Date;
}

// ── Definitions and handlers ──────────────────────────────────────────────────────────────────────

/** POST /api/mutations/acks — capability "ack", action "ack.set". No `validate` hook: the body schema is the whole check. */
export function setAckMutation(deps: AckMutationDeps): MutationDefinition<SetAckBody, SetAckResult> {
  const now = deps.now ?? (() => new Date());
  return {
    method: "POST",
    path: "/api/mutations/acks",
    capability: "ack",
    action: "ack.set",
    body: setAckBodySchema,
    auditTarget: (b) => `alert:${b.fingerprint}`,
    auditDetails: (b): AuditDetails => {
      const note = normalizeNote(b.note);
      return note === null ? { hasNote: false } : { hasNote: true, note };
    },
    /**
     * ack.set (REQ-ACK-01/02/05). Requires the fingerprint in the latest published cycle's
     * alerts payload in ANY state (firing | silenced | inhibited); otherwise failed/alert-not-firing.
     * No upstream call of any kind (REQ-ACK-08).
     */
    async handler(body: SetAckBody, ctx: ServerContext, actor: Identity): Promise<MutationOutcome<SetAckResult>> {
      if (!isInLatestCycle(ctx, body.fingerprint)) {
        return { outcome: "failed", status: 404, code: "TARGET_NOT_FOUND", reason: "alert-not-firing" };
      }
      const record: AckRecord = {
        actor: { subject: actor.subject, displayName: actor.displayName }, // minimized (SEC-06): no `source`, no header
        at: now().toISOString(),
        note: normalizeNote(body.note),
      };
      const stored = await deps.ackStore.set(body.fingerprint, record);
      if (!stored.ok) {
        // Store already kept its prior state and called writePath.markFailed("acks","write-failed").
        return { outcome: "failed", status: 500, code: "INTERNAL_ERROR", reason: "write-failed" };
      }
      return { outcome: "succeeded", status: 200, result: { fingerprint: body.fingerprint, at: stored.value.at } };
    },
  };
}

/** POST /api/mutations/acks/remove — capability "ack", action "ack.remove". No `validate` hook. */
export function removeAckMutation(deps: AckMutationDeps): MutationDefinition<RemoveAckBody, RemoveAckResult> {
  return {
    method: "POST",
    path: "/api/mutations/acks/remove",
    capability: "ack",
    action: "ack.remove",
    body: removeAckBodySchema,
    auditTarget: (b) => `alert:${b.fingerprint}`,
    auditDetails: () => ({}),
    /**
     * ack.remove (REQ-ACK-01/05): idempotent; any capable operator may remove anyone's ack. No
     * firing check — a stale ack for a resolved alert may be removed before reconcile clears it.
     */
    async handler(body: RemoveAckBody): Promise<MutationOutcome<RemoveAckResult>> {
      const removed = await deps.ackStore.remove(body.fingerprint);
      if (!removed.ok) {
        return { outcome: "failed", status: 500, code: "INTERNAL_ERROR", reason: "write-failed" };
      }
      return {
        outcome: "succeeded",
        status: 200,
        result: { fingerprint: body.fingerprint, removed: removed.value },
        details: { removed: removed.value },
      };
    },
  };
}

/**
 * Whether `fingerprint` is present in the captured cycle's alerts payload. `ServerContext.cycle`
 * is `CycleState | null`; its `alerts` is `MaterializedPayload<AlertsPayload>`, so the list is
 * `ctx.cycle.alerts.value.alerts`. No cycle yet → false.
 */
function isInLatestCycle(ctx: ServerContext, fingerprint: string): boolean {
  const alerts = ctx.cycle?.alerts.value.alerts ?? [];
  return alerts.some((alert) => alert.fingerprint === fingerprint);
}
