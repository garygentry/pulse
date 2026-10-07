// apps/web/src/server/mutations/handlers/silences.ts — the silence.create / silence.expire mutations
// (REQ-SIL-01/02/04/05/06/07/09/10, REQ-SEC-03/07, REQ-AUD-01).
//
// The Alertmanager write client is injected (built only in the proxy-header bootstrap branch); this module
// imports TYPES only from @pulse/web-data/sources. Registration happens in definitions.ts.

import { z } from "zod";
import type { Identity } from "@pulse/web-data/identity";
import type { AlertmanagerWriteClient, CreateSilenceRequest, SourceError } from "@pulse/web-data/sources";
import type { CycleState } from "@pulse/web-data/cycle";
import {
  ALERTNAME_LABEL,
  RATIONALE_MAX_CHARS,
  RATIONALE_MIN_CHARS,
  SILENCE_COMMENT_MAX_BYTES,
  SILENCE_COMMENT_PREFIX,
  SILENCE_MATCHERS_MAX,
  SILENCE_MATCHERS_MIN,
  SILENCE_MAX_DURATION_MS,
  type CreateSilenceBody,
  type CreateSilenceResult,
  type ExpireSilenceBody,
  type ExpireSilenceResult,
} from "../../../shared/mutations.js";
import type { AuditDetails, MutationDefinition, MutationOutcome } from "../registry.js";
import { canonicalMatchers } from "../audit.js";
import { MUTATION_ID_MAX_BYTES } from "../constants.js";

// ── Dependencies ──────────────────────────────────────────────────────────────────────────────────

/** Dependencies closed over by both silence factories. They are never on `ServerContext`. */
export interface SilenceMutationDeps {
  /** The AM v2 write client built in the proxy-header branch only (REQ-SEAM-02). */
  readonly writeClient: AlertmanagerWriteClient;
  /** Injectable UTC clock, the same function the dispatcher uses. Used for `startsAt` and `durationSeconds`. */
  readonly now: () => Date;
}

// ── Shared validation primitives (mirrored by the client dialogs) ────────────────────────────────

const UTF8 = new TextEncoder();

/** UTF-8 byte length (the unit of every upstream and audit bound). */
export function utf8ByteLength(s: string): number {
  return UTF8.encode(s).length;
}

/** Code-point length: the unit of "characters" in REQ-SIL-05. */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/**
 * True when `s` contains a C0 control (U+0000–U+001F), DEL (U+007F) or a C1 control (U+0080–U+009F).
 * `\n` (U+000A) is exempt when `allowNewline`. `\r` and `\t` are NOT exempt (REQ-SEC-07: reject at input).
 */
export function hasForbiddenControl(s: string, allowNewline: boolean): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (allowNewline && cp === 0x0a) continue;
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return true;
  }
  return false;
}

/** Prometheus/Alertmanager label-name grammar. AM answers 400 for anything else, so refuse early. */
export const SILENCE_LABEL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Matcher name bound: the AM client's triage-key bound, a subset of the client's 512. */
export const SILENCE_MATCHER_NAME_MAX_BYTES = 128;
/** Matcher value bound: the AM client's triage-value bound, a subset of the client's 512. */
export const SILENCE_MATCHER_VALUE_MAX_BYTES = 256;
/** ISO-8601 UTC with an optional 1–3 digit fraction (the `Date#toISOString` shape the client sends). */
export const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Bound on `fingerprint` and `silenceId`: MUTATION_ID_MAX_BYTES (128). The audit writer caps `target` at
 * 256 bytes and the targets are `alert:<fp>` / `silence:<id>`, so 128 leaves margin. Non-empty, control-free.
 */
const boundedIdSchema = z
  .string()
  .min(1)
  .refine((s) => utf8ByteLength(s) <= MUTATION_ID_MAX_BYTES, { message: "too-long" })
  .refine((s) => !hasForbiddenControl(s, false), { message: "control-char" });

/** One exact-equality matcher input. Strict: `isRegex`/`isEqual` are REFUSED as unknown keys (REQ-SIL-02). */
const matcherInputSchema = z
  .object({
    name: z
      .string()
      .regex(SILENCE_LABEL_NAME_RE)
      .refine((s) => utf8ByteLength(s) <= SILENCE_MATCHER_NAME_MAX_BYTES, { message: "too-long" }),
    // Values come from upstream labels. Control characters are NOT refused here: the audit encoder
    // neutralizes them and AM stores the value verbatim. Empty is refused, because Prometheus never
    // emits empty labels and `name=""` would match "label absent".
    value: z
      .string()
      .min(1)
      .refine((s) => utf8ByteLength(s) <= SILENCE_MATCHER_VALUE_MAX_BYTES, { message: "too-long" }),
  })
  .strict();

/**
 * Rationale text, trimmed first (the parsed value is the trimmed string), then:
 * - `min` to RATIONALE_MAX_CHARS code points;
 * - no control characters except `\n`;
 * - `byteLength(SILENCE_COMMENT_PREFIX + text) ≤ SILENCE_COMMENT_MAX_BYTES`, i.e. ≤ 504 bytes.
 * Every failure reports the path `rationale`.
 */
function rationaleSchema(min: number) {
  return z
    .string()
    .trim()
    .refine(
      (s) => {
        const n = codePointLength(s);
        return n >= min && n <= RATIONALE_MAX_CHARS;
      },
      { message: "length" },
    )
    .refine((s) => !hasForbiddenControl(s, true), { message: "control-char" })
    .refine((s) => utf8ByteLength(SILENCE_COMMENT_PREFIX + s) <= SILENCE_COMMENT_MAX_BYTES, {
      message: "byte-ceiling",
    });
}

// ── Body schemas (REQ-SEC-03, REQ-SIL-02/04/05/07) ───────────────────────────────────────────────

/**
 * Strict body for POST /api/mutations/silences. The parsed value is a CreateSilenceBody with `rationale`
 * already trimmed. Static checks only; the clock-dependent endsAt window is `validate` (checkSilenceWindow).
 * `isRegex`, `isEqual`, `startsAt`, `createdBy` and `comment` are unknown keys: the server sets them.
 */
export const createSilenceBodySchema: z.ZodType<CreateSilenceBody, z.ZodTypeDef, unknown> = z
  .object({
    /** Source alert fingerprint. Audit target only; not re-resolved against the cycle. */
    fingerprint: boundedIdSchema,
    /** 1–24 exact-equality matchers. */
    matchers: z.array(matcherInputSchema).min(SILENCE_MATCHERS_MIN).max(SILENCE_MATCHERS_MAX),
    /** ISO-8601 UTC instant; parseable. */
    endsAt: z
      .string()
      .regex(ISO_UTC_RE)
      .refine((s) => Number.isFinite(Date.parse(s)), { message: "unparseable" }),
    /** Mandatory rationale; becomes the upstream comment after the Pulse marker. */
    rationale: rationaleSchema(RATIONALE_MIN_CHARS),
  })
  .strict()
  .superRefine((body, ctx) => {
    const names = new Set<string>();
    body.matchers.forEach((m, i) => {
      // Two exact matchers on one name are redundant or contradictory. Refuse them.
      if (names.has(m.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["matchers", i, "name"], message: "duplicate" });
      }
      names.add(m.name);
    });
    // REQ-SIL-02: the alert name matcher MUST always remain.
    if (!names.has(ALERTNAME_LABEL)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["matchers"], message: "alertname-required" });
    }
  });

/**
 * Strict body for POST /api/mutations/silences/expire. The optional rationale is 0–500 code points after
 * trim; it is audit-only (the AM DELETE carries no body) but keeps the same control rule and byte ceiling.
 * An empty or whitespace-only rationale is normalized to "absent".
 */
export const expireSilenceBodySchema: z.ZodType<ExpireSilenceBody, z.ZodTypeDef, unknown> = z
  .object({
    /** Any AM silence id visible in Pulse (REQ-SIL-07). No creator or ownership check. */
    silenceId: boundedIdSchema,
    rationale: rationaleSchema(0).optional(),
  })
  .strict()
  .transform(
    (b): ExpireSilenceBody =>
      b.rationale === undefined || b.rationale === ""
        ? { silenceId: b.silenceId }
        : { silenceId: b.silenceId, rationale: b.rationale },
  );

/**
 * REQ-SIL-04: now < endsAt ≤ now + SILENCE_MAX_DURATION_MS. Refuses a zero or negative duration, a past
 * end and anything beyond 7 d. The upper bound is inclusive.
 */
export function checkSilenceWindow(
  endsAt: string,
  now: Date,
): { readonly ok: true } | { readonly ok: false; readonly fields: readonly string[] } {
  const end = Date.parse(endsAt);
  const t = now.getTime();
  return end > t && end <= t + SILENCE_MAX_DURATION_MS ? { ok: true } : { ok: false, fields: ["endsAt"] };
}

// ── Create handler (REQ-SIL-01/05/06/09) ─────────────────────────────────────────────────────────

/** Build the closed AM request. Every field satisfies the write client's request schema by construction. */
export function toCreateSilenceRequest(body: CreateSilenceBody, actor: Identity, now: Date): CreateSilenceRequest {
  return {
    matchers: body.matchers.map((m) => ({ name: m.name, value: m.value, isRegex: false, isEqual: true })),
    startsAt: now.toISOString(),
    endsAt: new Date(Date.parse(body.endsAt)).toISOString(), // normalized ms-precision UTC
    createdBy: actor.displayName, // REQ-SIL-06; never a header or service name
    comment: SILENCE_COMMENT_PREFIX + body.rationale, // REQ-SIL-05 marker; ≤ 512 bytes by the schema
  };
}

/** Map an upstream SourceError to the audited failed outcome (REQ-SIL-09; FAILED_POLICY upstreamTimeout/upstreamOther). */
export function upstreamFailure(error: SourceError): MutationOutcome<never> {
  return error.kind === "timeout"
    ? { outcome: "failed", status: 504, code: "SOURCE_TIMEOUT", reason: "upstream-timeout" }
    : { outcome: "failed", status: 502, code: "SOURCE_UNAVAILABLE", reason: `upstream-${error.kind}` };
}

// ── Audit details (REQ-AUD-01) ───────────────────────────────────────────────────────────────────

/** Raw attempted-record details for silence.create. `now` is deps.now(), the same clock as validate. */
export function createAuditDetails(body: CreateSilenceBody, now: Date): AuditDetails {
  const endsAt = new Date(Date.parse(body.endsAt)).toISOString();
  return {
    endsAt,
    durationSeconds: Math.round((Date.parse(endsAt) - now.getTime()) / 1000),
    matcherCount: body.matchers.length,
    matchers: canonicalMatchers(body.matchers),
    rationale: body.rationale,
  };
}

/** POST /api/mutations/silences — capability "silence", action "silence.create". */
export function createSilenceMutation(
  deps: SilenceMutationDeps,
): MutationDefinition<CreateSilenceBody, CreateSilenceResult> {
  return {
    method: "POST",
    path: "/api/mutations/silences",
    capability: "silence",
    action: "silence.create",
    body: createSilenceBodySchema,
    validate: (body, _ctx, now) => checkSilenceWindow(body.endsAt, now),
    auditTarget: (body) => `alert:${body.fingerprint}`,
    auditDetails: (body) => createAuditDetails(body, deps.now()),
    async handler(body, _ctx, actor) {
      const request = toCreateSilenceRequest(body, actor, deps.now());
      const res = await deps.writeClient.createSilence(request); // single attempt; never retried
      if (!res.ok) return upstreamFailure(res.error);
      return {
        outcome: "succeeded",
        status: 201,
        result: { silenceId: res.data.id, endsAt: request.endsAt },
        details: { silenceId: res.data.id },
      };
    },
  };
}

// ── Expire handler (REQ-SIL-07/09/10) ────────────────────────────────────────────────────────────

/**
 * True when an expire failure means the silence no longer exists or is already expired (REQ-SIL-10).
 * (a) AM answered 404: an unknown id.
 * (b) AM answered another non-2xx, and the latest cycle has usable Alertmanager evidence ("current" or
 *     "stale") that does not list the id as active/pending. AM answers 500 for an already-expired silence.
 * Without usable evidence (no cycle, "unavailable", "not-configured") a real AM fault is never reported
 * as "already gone". Other SourceErrorKinds (timeout, transport, …) are never silence-gone.
 */
export function isSilenceGone(error: SourceError, silenceId: string, cycle: CycleState | null): boolean {
  if (error.kind !== "upstream-status") return false;
  if (error.status === 404) return true;
  if (cycle === null) return false;
  const payload = cycle.alerts.value;
  if (payload.alertmanager.state !== "current" && payload.alertmanager.state !== "stale") return false;
  return !payload.silences.some((s) => s.id === silenceId && (s.state === "active" || s.state === "pending"));
}

/**
 * POST /api/mutations/silences/expire — capability "silence", action "silence.expire". No `validate`: the
 * target's existence is an audited handler outcome (silence-gone). No creator check (REQ-SIL-07): any
 * silence id is accepted; the capability gate is the only authorization. The rationale is audit-only.
 */
export function expireSilenceMutation(
  deps: SilenceMutationDeps,
): MutationDefinition<ExpireSilenceBody, ExpireSilenceResult> {
  return {
    method: "POST",
    path: "/api/mutations/silences/expire",
    capability: "silence",
    action: "silence.expire",
    body: expireSilenceBodySchema,
    auditTarget: (body) => `silence:${body.silenceId}`,
    auditDetails: (body): AuditDetails => (body.rationale !== undefined ? { rationale: body.rationale } : {}),
    async handler(body, ctx) {
      const res = await deps.writeClient.expireSilence(body.silenceId); // single attempt
      if (res.ok) return { outcome: "succeeded", status: 200, result: { silenceId: body.silenceId } };
      if (isSilenceGone(res.error, body.silenceId, ctx.cycle)) {
        return { outcome: "failed", status: 404, code: "TARGET_NOT_FOUND", reason: "silence-gone" };
      }
      return upstreamFailure(res.error);
    },
  };
}
