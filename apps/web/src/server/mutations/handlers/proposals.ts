// apps/web/src/server/mutations/handlers/proposals.ts — the proposal.create mutation
// (REQ-PROP-01..05, REQ-SEC-03/07, REQ-AUD-01).
//
// Writes a signed proposal file through the injected ProposalStore; it never touches the estate
// checkout or /rendered. Registration happens in definitions.ts.

import { z } from "zod";
import {
  proposalChangeSchema,
  checkProposalChanges,
  newProposalId,
  proposalValuesEqual,
  CONTROL_EXCEPT_LF_RE,
  codePointBounded,
  PROPOSAL_RATIONALE_MIN_CHARS,
  PROPOSAL_RATIONALE_MAX_CHARS,
  PROPOSAL_CHANGES_MAX,
  PROPOSAL_TARGET_ID_MAX_BYTES,
  type ProposalPayload,
} from "@pulse/core/proposals";
import type { CreateProposalBody, CreateProposalResult } from "../../../shared/mutations.js";
import type { MutationDefinition, MutationOutcome } from "../registry.js";
import type { ProposalStore } from "../stores/proposal-store.js";
import { resolveTarget, readProposableValue } from "../estate-values.js";

/**
 * POST /api/mutations/proposals body (strict, REQ-SEC-03). Rationale is trimmed then bounded (REQ-PROP-02).
 * `target.id` is byte-bounded so the audit target `"<kind>:<id>"` fits the writer's 256-byte cap.
 */
export const createProposalBodySchema = z
  .object({
    target: z
      .object({
        kind: z.enum(["host", "service"]),
        id: z
          .string()
          .min(1)
          .refine((s) => new TextEncoder().encode(s).byteLength <= PROPOSAL_TARGET_ID_MAX_BYTES, { message: "id too long" }),
      })
      .strict(),
    changes: z.array(proposalChangeSchema).min(1).max(PROPOSAL_CHANGES_MAX),
    rationale: z
      .string()
      .trim()
      .pipe(codePointBounded(PROPOSAL_RATIONALE_MIN_CHARS, PROPOSAL_RATIONALE_MAX_CHARS))
      .refine((s) => !CONTROL_EXCEPT_LF_RE.test(s), { message: "control characters are not allowed" }),
  })
  .strict()
  .superRefine((b, ctx) => {
    for (const i of checkProposalChanges(b.target.kind, b.changes)) {
      ctx.addIssue({ code: "custom", path: ["changes", ...i.path], message: i.message });
    }
  }) satisfies z.ZodType<CreateProposalBody, z.ZodTypeDef, unknown>;

/** Closure deps (bootstrap). */
export interface ProposalMutationDeps {
  /** The proposal store (constructed only in proxy-header mode). */ readonly store: ProposalStore;
  /** Random source for ids (tests). */ readonly randomBytes?: (n: number) => Uint8Array;
}

/** proposal.create (REQ-PROP-02..05). */
export function createProposalMutation(deps: ProposalMutationDeps): MutationDefinition<CreateProposalBody, CreateProposalResult> {
  return {
    method: "POST",
    path: "/api/mutations/proposals",
    capability: "proposeEstateEdit",
    action: "proposal.create",
    body: createProposalBodySchema,
    /** `<kind>:<drilldownId>`, e.g. "host:host:nas01", "service:svc:nas01/plex". */
    auditTarget: (b) => `${b.target.kind}:${b.target.id}`,
    /** Attempted details: field list (change order) + raw rationale (chunked into rationale.1..k by the audit encoder). */
    auditDetails: (b) => ({ fields: b.changes.map((c) => c.field).join(","), rationale: b.rationale }),

    /** Estate-dependent checks → invalid-body refusal (not audited, not stored). */
    validate(b, ctx) {
      const model = ctx.estate?.model;
      if (model === undefined) return { ok: true };
      const t = resolveTarget(model, b.target.kind, b.target.id);
      if (t === null) return { ok: true }; // handler → audited entity-not-found
      const fields = b.changes.flatMap((c, i) => (readProposableValue(model, t, c.field).applicable ? [] : [`changes.${i}.field`]));
      return fields.length === 0 ? { ok: true } : { ok: false, fields };
    },

    async handler(b, ctx, actor, meta): Promise<MutationOutcome<CreateProposalResult>> {
      const model = ctx.estate?.model;
      const t = model === undefined ? null : resolveTarget(model, b.target.kind, b.target.id);
      if (model === undefined || t === null) {
        return { outcome: "failed", status: 404, code: "TARGET_NOT_FOUND", reason: "entity-not-found" };
      }
      for (const c of b.changes) {
        const cur = readProposableValue(model, t, c.field);
        if (!cur.applicable || !proposalValuesEqual(c.seen, cur.value)) {
          return { outcome: "failed", status: 409, code: "INVALID_REQUEST", reason: "stale-proposal", details: { staleField: c.field } };
        }
      }
      const id = newProposalId(meta.now, deps.randomBytes);
      const payload: ProposalPayload = {
        id,
        createdAt: meta.now.toISOString(),
        requestId: meta.requestId,
        proposer: { subject: actor.subject, displayName: actor.displayName },
        target: { kind: t.kind, id: b.target.id, name: t.name },
        changes: b.changes.map((c) => ({ field: c.field, seen: c.seen, proposed: c.proposed })),
        rationale: b.rationale, // already trimmed by the body schema
      };
      const written = await deps.store.write(payload);
      if (!written.ok) {
        return { outcome: "failed", status: 500, code: "INTERNAL_ERROR", reason: "write-failed", details: { proposalId: id } };
      }
      return { outcome: "succeeded", status: 201, result: { proposalId: id }, details: { proposalId: id } };
    },
  };
}
