/** Proposal types and zod schemas (browser-safe). Every schema is `.strict()`; the payload, file and
 *  result schemas contain no transforms, so a parse's output deep-equals its input — required because
 *  the signature is computed over the parsed value. */

import { z } from "zod";
import { suppressionMarkSchema } from "../schema/suppression.js"; // browser-safe: imports only zod
import { PROPOSABLE_FIELD_NAMES, fieldSpec } from "./fields.js";
import { PROPOSAL_ID_RE } from "./ids.js";
import { proposalValuesEqual } from "./canonical.js";
import {
  PROPOSAL_RATIONALE_MIN_CHARS, PROPOSAL_RATIONALE_MAX_CHARS, PROPOSAL_REJECT_REASON_MIN_CHARS,
  PROPOSAL_REJECT_REASON_MAX_CHARS, PROPOSAL_CHANGES_MAX, PROPOSAL_TARGET_ID_MAX_BYTES,
} from "./constants.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Allowlisted proposable fields (REQ-PROP-03). */
export type ProposableField = "expectedChurn" | "scrapeIntervalClass" | "cadvisor" | "heartbeat" | "suppressed";
/** Suppression mark value (core suppressionMarkSchema). */
export interface SuppressionMarkValue { readonly class: "excluded" | "expected-churn" | "known-expected"; readonly rationale: string; }
/** A proposed/seen value: boolean, non-empty string, null (clear), or a suppression mark. */
export type ProposalValue = boolean | string | null | SuppressionMarkValue;

/** One field change (REQ-PROP-02). */
export interface ProposalChange {
  /** Allowlisted field. */ readonly field: ProposableField;
  /** Value as seen by the proposer (staleness baseline, REQ-PROP-08b). */ readonly seen: ProposalValue;
  /** Proposed value, validated by the field's schema (REQ-PROP-04). */ readonly proposed: ProposalValue;
}
/** Signed payload. */
export interface ProposalPayload {
  /** p-YYYYMMDDTHHMMSSZ-<8hex>. */ readonly id: string;
  /** ISO-8601 UTC. */ readonly createdAt: string;
  /** Web request id (ties to the audit record). */ readonly requestId: string;
  /** Minimized proposer. */ readonly proposer: { readonly subject: string; readonly displayName: string };
  /** Target: web drilldown id plus the core identity (`name`) the CLI edits. */
  readonly target: { readonly kind: "host" | "service"; readonly id: string; readonly name: string };
  /** 1–5 changes with unique fields. */ readonly changes: readonly ProposalChange[];
  /** 10–500 chars after trim. */ readonly rationale: string;
}
/** On-disk proposal file (immutable) — <id>.proposal.json. */
export interface ProposalFileV1 {
  /** Format tag. */ readonly format: "pulse-proposal/v1";
  /** The signed payload. */ readonly payload: ProposalPayload;
  /** HMAC-SHA256 over canonicalProposalJson({format, payload}), base64url. */
  readonly signature: { readonly alg: "HMAC-SHA256"; readonly value: string };
}
/** CLI-written sidecar — <id>.result.json (unsigned; the directory is the trust boundary). */
export type ProposalResultV1 =
  /** Applied: `by` is the CLI operator, `commit` the resulting git commit SHA. */
  | { readonly format: "pulse-proposal-result/v1"; readonly id: string; readonly state: "applied"; readonly at: string; readonly by: string; readonly commit: string }
  /** Rejected: `by` is the CLI operator, `reason` the reject reason (PROPOSAL_REJECT_REASON_MIN/MAX_CHARS). */
  | { readonly format: "pulse-proposal-result/v1"; readonly id: string; readonly state: "rejected"; readonly at: string; readonly by: string; readonly reason: string };
/** Derived state (REQ-PROP-06). */
export type ProposalState = "pending" | "applied" | "rejected";

/** Allowlist row: applicability per entity kind and host collection_class. */
export interface ProposableFieldSpec {
  /** Allowlisted field name. */ readonly field: ProposableField;
  /** YAML key in the estate overlay. */ readonly yamlKey: "expected_churn" | "scrape_interval_class" | "cadvisor" | "heartbeat" | "suppressed";
  /** Entity kinds the field applies to. */ readonly kinds: readonly ("host" | "service")[];
  /** Host collection classes allowed (null = any). */ readonly hostClasses: readonly string[] | null;
  /** Whether `null` (clear the overlay key) is allowed, per kind. */ readonly nullable: Readonly<Record<"host" | "service", boolean>>;
  /** Value kind for schema selection and UI control. */ readonly valueKind: "boolean" | "string" | "suppression";
}

// ── Value schemas (REQ-PROP-04, REQ-SEC-07) ────────────────────────────────────

/** C0 (all), DEL, C1 — no control character at all. Used for identity-derived fields, which may legitimately carry LRM/RLM. */
export const ANY_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;
/**
 * Free text a person types (rationales, reject reasons): C0 except LF, DEL, C1, and the bidi/format
 * controls (LRM, RLM, U+202A–202E, U+2066–2069) that can reorder text a reviewer reads (REQ-SEC-07).
 * The CLI's `--reason` check refuses the same set, plus LF.
 */
export const CONTROL_EXCEPT_LF_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const SCRAPE_CLASS_MAX = 128;

/**
 * A string of `min`–`max` Unicode code points. zod's `.min/.max` count UTF-16 units, which disagrees
 * with the documented "characters" (code points) that the client and CLI count for astral text.
 */
export function codePointBounded(min: number, max: number) {
  return z.string().refine((s) => {
    const n = [...s].length;
    return n >= min && n <= max;
  }, { message: `must be ${min}–${max} characters` });
}
const SUPPRESSION_RATIONALE_MAX = 500;

/** One of the proposable field names (enum). */
export const proposableFieldSchema = z.enum(PROPOSABLE_FIELD_NAMES);

/** Boolean fields: expectedChurn, cadvisor, heartbeat. */
export const booleanValueSchema = z.boolean();
/** scrapeIntervalClass: the core `z.string().min(1)`, tightened: ≤128 chars, no control chars, no edge whitespace. */
export const scrapeClassValueSchema = z.string().min(1).max(SCRAPE_CLASS_MAX)
  .refine((s) => !ANY_CONTROL_RE.test(s), { message: "control characters are not allowed" })
  .refine((s) => s.trim() === s, { message: "leading/trailing whitespace is not allowed" });
/**
 * Proposed suppression mark: core `suppressionMarkSchema` (strict `{class, rationale}`) plus the semantic
 * MISSING_RATIONALE rule applied here, so a proposal that would fail `pulse validate` is refused at
 * submission (PROP-04). Bounded and control-char-restricted (SEC-07).
 */
export const suppressionValueSchema = suppressionMarkSchema.superRefine((v, ctx) => {
  if (v.rationale.trim().length === 0) ctx.addIssue({ code: "custom", path: ["rationale"], message: "rationale required" });
  if (v.rationale.length > SUPPRESSION_RATIONALE_MAX) ctx.addIssue({ code: "custom", path: ["rationale"], message: "rationale too long" });
  if (CONTROL_EXCEPT_LF_RE.test(v.rationale)) ctx.addIssue({ code: "custom", path: ["rationale"], message: "control characters are not allowed" });
});

/** Any structurally valid value (the `seen`/`proposed` shape before per-field checks). */
export const proposalValueSchema = z.union([z.boolean(), z.string(), z.null(), suppressionMarkSchema]);

/**
 * The schema a `proposed` value must satisfy for `field` on `kind` (REQ-PROP-04). Includes `.nullable()`
 * iff `fieldSpec(field).nullable[kind]`.
 */
export function fieldValueSchema(field: ProposableField, kind: "host" | "service"): z.ZodType<ProposalValue> {
  const spec = fieldSpec(field);
  const base: z.ZodType<ProposalValue> =
    spec.valueKind === "boolean" ? booleanValueSchema : spec.valueKind === "string" ? scrapeClassValueSchema : suppressionValueSchema;
  return spec.nullable[kind] ? base.nullable() : base;
}

/**
 * The schema a `seen` value must satisfy: the field's **estate** shape (not the tightened proposal
 * bounds). It echoes the current declaration and is compared by deep equality. `null` is allowed
 * for string/suppression fields, because an absent key reads as `null`.
 */
export function fieldSeenSchema(field: ProposableField): z.ZodType<ProposalValue> {
  const spec = fieldSpec(field);
  return spec.valueKind === "boolean" ? z.boolean() : spec.valueKind === "string" ? z.string().min(1).nullable() : suppressionMarkSchema.nullable();
}

// ── Change, payload, file, result ──────────────────────────────────────────────

/** Rationale as stored: already trimmed (no transform), 10–500 chars, no control chars except LF. */
export const storedRationaleSchema = codePointBounded(PROPOSAL_RATIONALE_MIN_CHARS, PROPOSAL_RATIONALE_MAX_CHARS)
  .refine((s) => s.trim() === s, { message: "rationale must be trimmed" })
  .refine((s) => !CONTROL_EXCEPT_LF_RE.test(s), { message: "control characters are not allowed" });

/** One `{field, seen, proposed}` change, structural shape only (strict); per-field checks run in checkProposalChanges. */
export const proposalChangeSchema = z.object({
  field: proposableFieldSchema,
  seen: proposalValueSchema,
  proposed: proposalValueSchema,
}).strict();

/** One issue from the kind-dependent change checks (path relative to the `changes` array). */
export interface ChangeIssue { readonly path: readonly (string | number)[]; readonly message: string }

/**
 * Kind-dependent checks shared by the web body schema and `proposalPayloadSchema`:
 * unique fields; the field applies to `kind` (host-class applicability needs the estate and runs at
 * submission); `proposed` passes `fieldValueSchema(field, kind)`; `seen` passes `fieldSeenSchema(field)`;
 * `proposed` is not deep-equal to `seen`.
 */
export function checkProposalChanges(kind: "host" | "service", changes: readonly ProposalChange[]): ChangeIssue[] {
  const issues: ChangeIssue[] = [];
  const seenFields = new Set<ProposableField>();
  changes.forEach((c, i) => {
    if (seenFields.has(c.field)) issues.push({ path: [i, "field"], message: "duplicate field" });
    seenFields.add(c.field);
    if (!fieldSpec(c.field).kinds.includes(kind)) { issues.push({ path: [i, "field"], message: "field not proposable for this kind" }); return; }
    if (!fieldValueSchema(c.field, kind).safeParse(c.proposed).success) issues.push({ path: [i, "proposed"], message: "invalid value" });
    if (!fieldSeenSchema(c.field).safeParse(c.seen).success) issues.push({ path: [i, "seen"], message: "invalid value" });
    if (proposalValuesEqual(c.seen, c.proposed)) issues.push({ path: [i, "proposed"], message: "unchanged" });
  });
  return issues;
}

const ISO_UTC = z.string().datetime({ offset: false }); // "…Z" only
const shortText = z.string().min(1).max(256).refine((s) => !ANY_CONTROL_RE.test(s), { message: "control characters are not allowed" });

/** The proposal target `{kind, id, name}` (strict); the drilldown id must agree with kind and name. */
export const proposalTargetSchema = z.object({
  kind: z.enum(["host", "service"]),
  id: z.string().min(1)
    .refine((s) => new TextEncoder().encode(s).byteLength <= PROPOSAL_TARGET_ID_MAX_BYTES, { message: "id too long" })
    .refine((s) => !ANY_CONTROL_RE.test(s)),
  name: shortText,
}).strict().superRefine((t, ctx) => {
  // The drilldown id and the core identity must agree (`host:<name>` / `svc:<host>/<name>`).
  const ok = t.kind === "host"
    ? t.id === `host:${t.name}`
    : t.id.startsWith("svc:") && t.id.endsWith(`/${t.name}`) && t.id.length > `svc:/${t.name}`.length;
  if (!ok) ctx.addIssue({ code: "custom", path: ["id"], message: "id does not match kind/name" });
});

/** The signed proposal payload (strict), including the kind-dependent change checks. */
export const proposalPayloadSchema = z.object({
  id: z.string().regex(PROPOSAL_ID_RE),
  createdAt: ISO_UTC,
  requestId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
  proposer: z.object({ subject: shortText, displayName: shortText }).strict(),
  target: proposalTargetSchema,
  changes: z.array(proposalChangeSchema).min(1).max(PROPOSAL_CHANGES_MAX),
  rationale: storedRationaleSchema,
}).strict().superRefine((p, ctx) => {
  for (const issue of checkProposalChanges(p.target.kind, p.changes)) {
    ctx.addIssue({ code: "custom", path: ["changes", ...issue.path], message: issue.message });
  }
});

/** base64url of a 32-byte HMAC-SHA256 digest, unpadded = exactly 43 chars. */
export const SIGNATURE_VALUE_RE = /^[A-Za-z0-9_-]{43}$/;

/** A whole `pulse-proposal/v1` file: format, payload and HMAC-SHA256 signature (strict at every level). */
export const proposalFileSchema = z.object({
  format: z.literal("pulse-proposal/v1"),
  payload: proposalPayloadSchema,
  signature: z.object({ alg: z.literal("HMAC-SHA256"), value: z.string().regex(SIGNATURE_VALUE_RE) }).strict(),
}).strict();

const resultBase = { format: z.literal("pulse-proposal-result/v1"), id: z.string().regex(PROPOSAL_ID_RE), at: ISO_UTC, by: shortText };
/** A `pulse-proposal-result/v1` sidecar, discriminated by `state` (applied with a commit sha, or rejected with a reason); each arm strict. */
export const proposalResultSchema = z.discriminatedUnion("state", [
  z.object({ ...resultBase, state: z.literal("applied"), commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/) }).strict(),
  z.object({ ...resultBase, state: z.literal("rejected"),
    reason: codePointBounded(PROPOSAL_REJECT_REASON_MIN_CHARS, PROPOSAL_REJECT_REASON_MAX_CHARS)
      .refine((s) => !CONTROL_EXCEPT_LF_RE.test(s)) }).strict(),
]);

// Type-level agreement with the declared types (compile-time only; mutable outputs are assignable to readonly types).
const _payloadCheck: z.ZodType<ProposalPayload, z.ZodTypeDef, unknown> = proposalPayloadSchema;
const _fileCheck: z.ZodType<ProposalFileV1, z.ZodTypeDef, unknown> = proposalFileSchema;
const _resultCheck: z.ZodType<ProposalResultV1, z.ZodTypeDef, unknown> = proposalResultSchema;
void _payloadCheck; void _fileCheck; void _resultCheck;
