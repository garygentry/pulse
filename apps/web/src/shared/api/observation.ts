// src/shared/api/observation.ts — content-negotiation and observation-header helpers for the
// current-state representation protocol (05 §7). These are the pure pieces `json.ts` composes:
//
//  • `acceptsGzip`  — parse `Accept-Encoding` correctly, honouring q-values (a `gzip;q=0` REJECTS
//    gzip; we never substring-match the token). The retained gzip bytes are served only when the
//    request genuinely admits gzip.
//  • `ifNoneMatchMatches` — strong `If-None-Match` list semantics. A weak (`W/"…"`) validator never
//    matches; `*` matches any current representation; a strong tag matches only its exact retained
//    ETag (so a plain ETag can never validate the gzip representation, or vice versa — the caller
//    passes the ETag of the *selected* encoding).
//  • `encodeObservationHeader` — the captured `CycleObservation` as canonical UTF-8 JSON then
//    base64url for `X-Pulse-Observation`, bounded to `OBSERVATION_HEADER_MAX_BYTES` (invalid/oversized
//    construction returns `null` so the caller can fail safely rather than emit a malformed header).
//
// All three are used only from server route handling; none reads a request body.

import { canonicalJson } from "@pulse/web-data/cycle";
import { OBSERVATION_HEADER_MAX_BYTES, type CycleObservation } from "@pulse/web-data/wire";

/** Parse one `q=` weight from an `Accept-Encoding` element's parameters (default 1; malformed → 1). */
function weightOf(params: readonly string[]): number {
  for (const param of params) {
    const p = param.trim().toLowerCase();
    if (p.startsWith("q=")) {
      const q = Number.parseFloat(p.slice(2));
      return Number.isFinite(q) ? q : 1;
    }
  }
  return 1;
}

/**
 * Whether a parsed `Accept-Encoding` header genuinely admits gzip (05 §7 step 2).
 *
 * An explicit `gzip` element wins and is admitted only when its q-value is > 0 (so `gzip;q=0`
 * REJECTS it). Absent an explicit `gzip`, a `*` wildcard with q > 0 admits it. A missing header, or
 * a header that lists neither, does not admit gzip (we serve the plain retained bytes). The header
 * is parsed — never substring-matched — so `gzip;q=0` is not mistaken for acceptance.
 */
export function acceptsGzip(header: string | null): boolean {
  if (header === null || header.trim() === "") return false;
  let gzipQ: number | null = null;
  let starQ: number | null = null;
  for (const element of header.split(",")) {
    const trimmed = element.trim();
    if (trimmed === "") continue;
    const [codingRaw, ...params] = trimmed.split(";");
    const coding = (codingRaw ?? "").trim().toLowerCase();
    if (coding === "gzip") gzipQ = weightOf(params);
    else if (coding === "*") starQ = weightOf(params);
  }
  if (gzipQ !== null) return gzipQ > 0;
  if (starQ !== null) return starQ > 0;
  return false;
}

/** Strip one layer of surrounding double quotes from an entity-tag token, if present. */
function unquote(tag: string): string {
  return tag.length >= 2 && tag.startsWith('"') && tag.endsWith('"') ? tag.slice(1, -1) : tag;
}

/**
 * Whether an `If-None-Match` header matches the selected representation's strong `etag` (05 §7 step
 * 3). Strong-comparison list semantics: a `*` matches any current representation; each listed strong
 * tag matches only when its unquoted value equals `etag`; a weak validator (`W/"…"`) never matches.
 * The caller passes the ETag of the *selected* encoding, so a cached plain validator cannot satisfy a
 * gzip request (their ETags differ).
 *
 * @param header - The raw `If-None-Match` request header value, or `null` when absent.
 * @param etag - The unquoted strong validator of the selected representation (e.g. `sha256:…`).
 */
export function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const trimmed = header.trim();
  if (trimmed === "") return false;
  if (trimmed === "*") return true;
  for (const raw of trimmed.split(",")) {
    const tag = raw.trim();
    if (tag === "" || tag.startsWith("W/")) continue; // weak validators never match (strong compare)
    if (unquote(tag) === etag) return true;
  }
  return false;
}

/**
 * Encode a captured `CycleObservation` for the `X-Pulse-Observation` header (05 §7 step 4): canonical
 * UTF-8 JSON, then base64url. Returns `null` when the encoded value would exceed
 * `OBSERVATION_HEADER_MAX_BYTES` (8 KiB) or the observation cannot be canonicalized, so the caller
 * fails safely instead of emitting a malformed/oversized header. base64url is ASCII, so its length is
 * its byte length.
 */
export function encodeObservationHeader(observation: CycleObservation): string | null {
  let encoded: string;
  try {
    encoded = Buffer.from(canonicalJson(observation)).toString("base64url");
  } catch {
    return null; // uncanonicalizable observation → fail safely
  }
  return encoded.length > OBSERVATION_HEADER_MAX_BYTES ? null : encoded;
}
