// apps/web/src/server/mutations/audit.ts — audit event construction and writer-bounded detail
// encoding (REQ-SEAM-04, REQ-AUD-01/05).
//
// The writer (`@pulse/web-data/audit` writer.ts) keeps its bounds and validator module-private, so
// this module mirrors them (`AUDIT_*`, `isWriterValidEvent`); parity with the real writer is pinned
// by apps/web/tests/mutations-audit-details.test.ts. writer.ts is never edited.

import { createHash } from "node:crypto";
import type { AuditEvent } from "@pulse/web-data/audit";
import type { Identity } from "@pulse/web-data/identity";
import type { SilenceMatcherInput } from "../../shared/mutations.js";
import type { AuditDetails, CapabilityName, MutationAction } from "./registry.js";

/** writer.ts MAX_FIELD_BYTES. */ export const AUDIT_FIELD_MAX_BYTES = 256;
/** writer.ts MAX_DETAIL_ENTRIES. */ export const AUDIT_MAX_ENTRIES = 32;
/** writer.ts MAX_DETAIL_KEY_BYTES. */ export const AUDIT_KEY_MAX_BYTES = 128;
/** writer.ts MAX_DETAIL_VALUE_BYTES. */ export const AUDIT_VALUE_MAX_BYTES = 256;
/** writer.ts SENSITIVE_KEY_SUBSTRINGS (module-private there; mirrored and parity-tested). */
export const AUDIT_SENSITIVE_KEY_SUBSTRINGS: readonly string[] = [
  "authorization", "cookie", "password", "passwd", "secret", "token", "apikey", "api-key", "api_key",
  "credential", "bearer", "x-forwarded", "remote-user",
];
/**
 * Raw detail keys the encoder ALWAYS chunks into `<key>.1..k`, and the max chunk count for each.
 * `silenceId` is included because an Alertmanager id is an upstream-controlled string that
 * can exceed 256 bytes (up to 512 → 2 chunks). It is always chunked, even when short, so the key shape is
 * deterministic.
 */
export const CHUNKED_DETAIL_KEYS = { rationale: 8, note: 5, matchers: 12, silenceId: 2 } as const;
/** A chunked raw key. */
export type ChunkedDetailKey = keyof typeof CHUNKED_DETAIL_KEYS;

const utf8 = new TextEncoder();
const byteLength = (s: string): number => utf8.encode(s).length;

/**
 * Neutralize control characters so a value passes the writer's control check:
 * "\n" becomes U+2424 (␤); every other C0 (< 0x20), DEL (0x7f) or C1 (0x80–0x9f) becomes U+FFFD.
 * Iterates by code point; everything else is unchanged.
 */
export function neutralizeControl(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a) out += "␤";
    else if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) out += "�";
    else out += ch;
  }
  return out;
}

/**
 * Split `text` on code-point boundaries into chunks of ≤ maxBytes UTF-8 bytes each. The split is lossless:
 * joining the chunks gives `text`. Byte counts use TextEncoder (lone surrogates count as 3 bytes, as in the
 * writer). "" gives [].
 */
export function chunkUtf8(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of text) {
    const b = byteLength(ch);
    if (currentBytes + b > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += b;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

/**
 * Canonical matcher string for audit: sort by (name, value) in UTF-16 code-unit order,
 * render each as `name=value`, and join with ",". The silence handlers use this for `silence.create`
 * auditDetails().matchers.
 */
export function canonicalMatchers(matchers: readonly SilenceMatcherInput[]): string {
  return [...matchers]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .map((m) => `${m.name}=${m.value}`)
    .join(",");
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(utf8.encode(text)).digest("hex");
}

/** Why raw details could not be encoded; a definition defect (refused `internal` at step 10). */
export type AuditEncodingDefect = "chunked-not-string" | "chunk-cap-exceeded" | "reserved-key" | "non-finite-number";

/** Encoding result; never throws. */
export type AuditDetailsEncoding =
  | { /** Encoded. */ readonly ok: true; /** Writer-shaped details. */ readonly details: AuditDetails }
  | { /** Defect. */ readonly ok: false; /** Kind. */ readonly defect: AuditEncodingDefect; /** Offending raw key (a schema-defined name). */ readonly key: string };

const RESERVED_KEY_RE = /\.\d+$/;

/**
 * Encode raw details for the writer.
 * - `rationale` / `note` / `silenceId`: neutralize, chunk to ≤ 256 B → `<key>.1..k` (caps 8 / 5 / 2).
 *   More chunks than the cap is a defect. Body schemas make this impossible for rationale and note
 *   (500 code points → ≤ 2,000 B → ≤ 8 chunks; 280 → ≤ 1,120 B → ≤ 5). For silenceId, the write client's
 *   response schema bounds ids at 512 B → ≤ 2 chunks.
 * - `matchers`: `matchersSha256` = sha256Hex(raw, pre-neutralization) always; neutralize, chunk →
 *   `matchers.1..m` (m ≤ 12); `matchersTruncated` = whether chunks were dropped (never a defect).
 * - other strings: neutralized, otherwise passed through (an oversized value surfaces in
 *   isWriterValidEvent as a defect); numbers must be finite.
 */
export function encodeAuditDetails(raw: AuditDetails): AuditDetailsEncoding {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.hasOwn(CHUNKED_DETAIL_KEYS, key)) {
      if (typeof value !== "string") return { ok: false, defect: "chunked-not-string", key };
      const cap = CHUNKED_DETAIL_KEYS[key as ChunkedDetailKey];
      const chunks = chunkUtf8(neutralizeControl(value), AUDIT_VALUE_MAX_BYTES);
      if (key === "matchers") {
        out.matchersSha256 = sha256Hex(value);
        out.matchersTruncated = chunks.length > cap;
      } else if (chunks.length > cap) {
        return { ok: false, defect: "chunk-cap-exceeded", key };
      }
      chunks.slice(0, cap).forEach((chunk, i) => {
        out[`${key}.${i + 1}`] = chunk;
      });
      continue;
    }
    if (RESERVED_KEY_RE.test(key) || key === "matchersSha256" || key === "matchersTruncated") {
      return { ok: false, defect: "reserved-key", key };
    }
    if (typeof value === "number" && !Number.isFinite(value)) return { ok: false, defect: "non-finite-number", key };
    out[key] = typeof value === "string" ? neutralizeControl(value) : value;
  }
  return { ok: true, details: out };
}

/** Inputs to one audit event. */
export interface AuditEventInput {
  /** Event time (the dispatcher's injected clock). */ readonly at: Date;
  /** Acting identity; only subject/displayName/source are copied (REQ-AUD-05). */ readonly actor: Identity;
  /** Closed action name. */ readonly action: MutationAction;
  /** Governing capability (the definition's capability). */ readonly capability: CapabilityName;
  /** Audit target from def.auditTarget(body); ≤ 256 B because every body schema bounds its target id (silence/ack ≤ MUTATION_ID_MAX_BYTES; proposal ≤ PROPOSAL_TARGET_ID_MAX_BYTES). */ readonly target: string;
  /** Phase. */ readonly outcome: AuditEvent["outcome"];
  /** Shared request id (attempted and finalize). */ readonly requestId: string;
  /** ENCODED details (encodeAuditDetails output). */ readonly details: AuditDetails;
}

/**
 * Build an AuditEvent (REQ-AUD-01). The actor is a fresh 3-key object (the writer rejects any other key
 * count), `correlationId` is always null (mutations have no correlation id), and the target is
 * neutralized. Pure; throws only a RangeError when `at` is an invalid Date (a clock defect, caught by the
 * dispatcher as `internal`).
 */
export function buildAuditEvent(input: AuditEventInput): AuditEvent {
  return {
    at: input.at.toISOString(),
    actor: { subject: input.actor.subject, displayName: input.actor.displayName, source: "proxy-header" },
    action: input.action,
    capability: input.capability,
    target: neutralizeControl(input.target),
    outcome: input.outcome,
    requestId: input.requestId,
    correlationId: null,
    details: input.details,
  };
}

/**
 * Mirror of writer.ts `eventIsValid` (writer.ts:139-151; module-private there, so mirrored here). True iff
 * the writer would accept the event. Used as the step-10 pre-append assertion and on finalize.
 * Parity with the real writer is enforced by a shared corpus test (mutations-audit-details).
 * Like the writer, the event, actor and details must be plain objects; never throws (a hostile getter or
 * a non-object anywhere yields false).
 */
export function isWriterValidEvent(event: AuditEvent): boolean {
  try {
    return eventIsValid(event);
  } catch {
    return false;
  }
}

function eventIsValid(event: AuditEvent): boolean {
  const bounded = (v: unknown, max: number): boolean =>
    typeof v === "string" && v.length > 0 && !hasControlUnit(v) && byteLength(v) <= max;
  if (!isPlainObject(event)) return false;
  if (!bounded(event.at, AUDIT_FIELD_MAX_BYTES) || !Number.isFinite(Date.parse(event.at))) return false;
  const a = event.actor as unknown;
  if (!isPlainObject(a)) return false;
  if (Object.keys(a).length !== 3 || !bounded(a.subject, AUDIT_FIELD_MAX_BYTES) ||
      !bounded(a.displayName, AUDIT_FIELD_MAX_BYTES) || a.source !== "proxy-header") return false;
  if (!bounded(event.action, AUDIT_FIELD_MAX_BYTES) || !bounded(event.target, AUDIT_FIELD_MAX_BYTES)) return false;
  if (event.outcome !== "attempted" && event.outcome !== "succeeded" && event.outcome !== "failed") return false;
  if (!bounded(event.requestId, AUDIT_FIELD_MAX_BYTES)) return false;
  if (event.correlationId !== null && !bounded(event.correlationId, AUDIT_FIELD_MAX_BYTES)) return false;
  const details = event.details as unknown;
  if (!isPlainObject(details)) return false;
  const keys = Object.keys(details);
  if (keys.length > AUDIT_MAX_ENTRIES) return false;
  for (const key of keys) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") return false;
    if (key.length === 0 || hasControlUnit(key) || byteLength(key) > AUDIT_KEY_MAX_BYTES) return false;
    const lower = key.toLowerCase();
    if (AUDIT_SENSITIVE_KEY_SUBSTRINGS.some((s) => lower.includes(s))) return false;
    const v = details[key];
    if (v === null || typeof v === "boolean") continue;
    if (typeof v === "number") { if (!Number.isFinite(v)) return false; continue; }
    if (typeof v === "string") { if (hasControlUnit(v) || byteLength(v) > AUDIT_VALUE_MAX_BYTES) return false; continue; }
    return false;
  }
  return true;
}

/** writer.ts isPlainObject: a non-array object whose prototype is Object.prototype or null. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === null || proto === Object.prototype;
}

/** writer.ts hasControlChar: per UTF-16 unit, C0 / DEL / C1. */
function hasControlUnit(v: string): boolean {
  for (let i = 0; i < v.length; i += 1) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return true;
  }
  return false;
}
