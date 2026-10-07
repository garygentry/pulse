// apps/web/src/server/mutations/guards.ts — the pure request guards of the mutation pipeline
// (REQ-SEAM-03, REQ-SEC-02, REQ-SEC-03, REQ-IDEM-01).
//
// Guards take header or stream inputs and never throw. Each returns a GuardResult, which is declared here.
// The dispatcher runs them in its fixed pipeline step order.

import type { ZodIssue, ZodType, ZodTypeDef } from "zod";
import type { RefusalReason } from "./refusal.js";
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_KEY_RE, INVALID_FIELDS_MAX_BYTES } from "./constants.js";

/** Result of one guard: a value, or the refusal reason (plus optional invalid-field paths). */
export type GuardResult<T> =
  | {
      /** The guard passed. */ readonly ok: true;
      /** Guard output (null when the guard only checks). */ readonly value: T;
    }
  | {
      /** The guard refused. */ readonly ok: false;
      /** Refusal reason (always a key of REFUSAL_POLICY). */ readonly reason: RefusalReason;
      /** `details.fields` value from formatInvalidFields; set only for invalid-body with known paths. */
      readonly fields?: string | undefined;
    };

const PASS: GuardResult<null> = { ok: true, value: null };
const refusal = (reason: RefusalReason, fields?: string): GuardResult<never> =>
  fields === undefined ? { ok: false, reason } : { ok: false, reason, fields };

/**
 * Same-origin check. `Sec-Fetch-Site`, when present, is authoritative: it is a forbidden header that
 * browsers set, and only the exact value "same-origin" passes. Otherwise `Origin` must be a parseable
 * http(s) origin whose host (lowercased, default port elided) equals the `Host` header normalized under
 * the same scheme. Anything missing or malformed refuses (deny by default).
 *
 * @param headers - The request headers.
 * @returns PASS, or refusal "cross-origin".
 */
export function checkSameOrigin(headers: Headers): GuardResult<null> {
  const site = headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" ? PASS : refusal("cross-origin");

  const origin = headers.get("origin");
  if (origin === null || origin === "" || origin === "null") return refusal("cross-origin");
  const originUrl = parseBareOrigin(origin, null);
  if (originUrl === null) return refusal("cross-origin");

  const host = headers.get("host");
  if (host === null || host.trim() === "") return refusal("cross-origin");
  const hostUrl = parseBareOrigin(host.trim(), originUrl.protocol);
  if (hostUrl === null) return refusal("cross-origin");

  return originUrl.host === hostUrl.host ? PASS : refusal("cross-origin");
}

/**
 * Parse `value` as a bare origin, i.e. scheme + host[:port] with no userinfo, path, query or fragment.
 * With `scheme` set, `value` is a Host header and the scheme is prefixed. Returns null when invalid.
 */
function parseBareOrigin(value: string, scheme: string | null): URL | null {
  let url: URL;
  try {
    url = new URL(scheme === null ? value : `${scheme}//${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return url;
}

/**
 * Require `Content-Type: application/json` with an optional `charset=utf-8` parameter (any case,
 * optionally quoted). Any other media type or parameter refuses. Together with the same-origin check this
 * forces a CORS preflight that the server never approves, so a cross-origin page cannot send one.
 *
 * @returns PASS, or refusal "invalid-body".
 */
export function checkContentType(headers: Headers): GuardResult<null> {
  const raw = headers.get("content-type");
  if (raw === null) return refusal("invalid-body");
  const [essence = "", ...params] = raw.split(";");
  if (essence.trim().toLowerCase() !== "application/json") return refusal("invalid-body");
  for (const param of params) {
    if (param.trim() === "") continue; // tolerate a trailing ";"
    const eq = param.indexOf("=");
    const name = (eq < 0 ? param : param.slice(0, eq)).trim().toLowerCase();
    const value = (eq < 0 ? "" : param.slice(eq + 1)).trim().replace(/^"(.*)"$/, "$1").toLowerCase();
    if (name !== "charset" || value !== "utf-8") return refusal("invalid-body");
  }
  return PASS;
}

/**
 * Read the request body with a hard byte cap. A declared `Content-Length` is prechecked first (no read),
 * then the stream is counted chunk by chunk. On overflow the reader is cancelled, so Bun stops buffering
 * the rest of the upload, and the result is "body-too-large". A missing body, malformed Content-Length or
 * stream error gives "invalid-body". Never throws.
 *
 * Decoding and `JSON.parse` are deliberately deferred to parseStrictBody (step 8), so a missing key
 * (step 7) is reported before a malformed body.
 *
 * @param request - The incoming request (body not yet consumed).
 * @param maxBytes - MUTATION_BODY_MAX_BYTES (16 KiB).
 * @returns The exact body bytes (≤ maxBytes).
 */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<GuardResult<Uint8Array>> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const trimmed = declared.trim();
    if (!/^\d{1,15}$/.test(trimmed)) return refusal("invalid-body");
    if (Number(trimmed) > maxBytes) {
      await request.body?.cancel().catch(() => undefined);
      return refusal("body-too-large");
    }
  }
  const stream = request.body;
  if (stream === null) return refusal("invalid-body");

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    return refusal("invalid-body"); // body already locked or consumed
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined); // abort the upload; drop buffered chunks
        return refusal("body-too-large");
      }
      chunks.push(value);
    }
  } catch {
    return refusal("invalid-body"); // client aborted / transport error mid-body
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released by cancel */
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: bytes };
}

/**
 * Read `Idempotency-Key`; it must match IDEMPOTENCY_KEY_RE (`^[A-Za-z0-9_-]{8,128}$`), untrimmed. The
 * key is never logged, audited or echoed.
 *
 * @returns The key, or refusal "missing-idempotency-key" (absent OR malformed; one reason by design).
 */
export function parseIdempotencyKey(headers: Headers): GuardResult<string> {
  const key = headers.get(IDEMPOTENCY_KEY_HEADER);
  if (key === null || !IDEMPOTENCY_KEY_RE.test(key)) return refusal("missing-idempotency-key");
  return { ok: true, value: key };
}

/** A path segment that is safe to echo: schema-defined names and array indices only. */
const FIELD_SEGMENT_RE = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Convert zod issues to dot-joined paths. An `unrecognized_keys` issue reports its parent path (for the
 * root, "$"), never the unknown key names, which are client-controlled text.
 */
export function zodIssuePaths(issues: readonly ZodIssue[]): string[] {
  return issues.map((issue) => pathToString(issue.path));
}

function pathToString(path: readonly (string | number)[]): string {
  if (path.length === 0) return "$";
  return path.map((seg) => (typeof seg === "number" ? String(seg) : FIELD_SEGMENT_RE.test(seg) ? seg : "?")).join(".");
}

/**
 * Build `details.fields`: sanitized paths (every segment matches FIELD_SEGMENT_RE, else "?"; "$" = root),
 * deduplicated in first-seen order, comma-joined, and truncated at a whole-path boundary to
 * ≤ INVALID_FIELDS_MAX_BYTES (512). No value is ever included.
 *
 * @param paths - Dot-joined paths from zodIssuePaths or MutationDefinition.validate().fields.
 * @returns The joined string, or undefined when there are no paths (the key is then omitted).
 */
export function formatInvalidFields(paths: readonly string[]): string | undefined {
  const seen = new Set<string>();
  let out = "";
  for (const raw of paths) {
    const clean = raw === "$" ? "$" : raw.split(".").map((s) => (FIELD_SEGMENT_RE.test(s) ? s : "?")).join(".");
    if (seen.has(clean)) continue;
    seen.add(clean);
    const next = out === "" ? clean : `${out},${clean}`;
    if (next.length > INVALID_FIELDS_MAX_BYTES) break; // all-ASCII, so length === UTF-8 bytes
    out = next;
  }
  return out === "" ? undefined : out;
}

/**
 * Step 8a: strict UTF-8 decode, JSON.parse, then `schema.safeParse`. Every body schema is `.strict()`
 * and typed `ZodType<B, ZodTypeDef, unknown>` (so it works under exactOptionalPropertyTypes). Never throws.
 *
 * @returns The validated body, or refusal "invalid-body" (with `fields` when zod reported paths).
 */
export function parseStrictBody<B>(schema: ZodType<B, ZodTypeDef, unknown>, bytes: Uint8Array): GuardResult<B> {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); // BOM stripped; bad UTF-8 throws
  } catch {
    return refusal("invalid-body");
  }
  const result = schema.safeParse(json);
  if (!result.success) return refusal("invalid-body", formatInvalidFields(zodIssuePaths(result.error.issues)));
  return { ok: true, value: result.data };
}
