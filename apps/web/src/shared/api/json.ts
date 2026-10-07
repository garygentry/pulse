// src/shared/api/json.ts — the current-state representation helper (05 §7).
//
// `cycleJsonResponse` serves ONE captured current-view materialized payload from ONE cycle
// reference: it negotiates plain/gzip against the request, serves the retained exact bytes/ETag
// WITHOUT reserializing or recompressing, compares `If-None-Match` with strong-tag list semantics,
// and returns a bodyless 304 on a match. Both the 200 and the 304 carry the exact strong `ETag`,
// `Cache-Control: private, no-cache`, `Vary: Accept-Encoding`, the bounded base64url
// `X-Pulse-Observation`, and the semantic `X-Pulse-Payload-Id`; the plain and gzip validators are
// distinct (different bytes → different SHA-256), so a plain ETag can never validate gzip or vice
// versa. Observation/payload-id headers are outside representation identity and advance even when the
// retained bytes are reused. `errorResponse` is the shared JSON error helper (05 §7); the leaf error
// builders in `../../server/routes/respond.ts` re-export it.

import type { CycleState, MaterializedPayload } from "@pulse/web-data/cycle";
import { ERROR_MESSAGES, type ErrorEnvelope } from "@pulse/web-data/wire";

import { acceptsGzip, encodeObservationHeader, ifNoneMatchMatches } from "./observation.js";

/** The inputs to `cycleJsonResponse`: the request, the captured cycle, and the one materialized
 *  payload to serve — all read from the SAME `ServerContext` so observation and bytes are coherent. */
export interface CycleJsonOptions<T> {
  /** The incoming request (read for `Accept-Encoding` and `If-None-Match` only — never its body). */
  readonly request: Request;
  /** The captured immutable current cycle; its `observation` stamps both 200 and 304. */
  readonly cycle: CycleState;
  /** The current view's retained materialized representation (plain/gzip bytes + strong ETags). */
  readonly payload: MaterializedPayload<T>;
}

/** The §7 shared JSON error response: an `ErrorEnvelope` body at `status`, with optional headers. */
export function errorResponse(
  error: ErrorEnvelope,
  status: number,
  headers?: Readonly<Record<string, string>>,
): Response {
  return Response.json(error, { status, ...(headers !== undefined ? { headers } : {}) });
}

/**
 * Serve a current-view representation from one captured cycle reference (05 §7).
 *
 * Selects gzip only when the parsed `Accept-Encoding` admits it, serves the retained exact
 * bytes/ETag with no per-request reserialization/recompression, and returns a bodyless 304 when a
 * strong `If-None-Match` validator matches the SELECTED encoding's ETag. Both outcomes carry the
 * strong `ETag`, `Cache-Control: private, no-cache`, `Vary: Accept-Encoding`, the bounded base64url
 * observation, and the semantic payload id; a failure to construct a valid observation header fails
 * safely with `INTERNAL_ERROR` (never a malformed/oversized header).
 */
export function cycleJsonResponse<T>(options: CycleJsonOptions<T>): Response {
  const { request, cycle, payload } = options;

  // (2) Negotiate encoding and (3) select the retained representation + its strong ETag. Never
  //     reserialize/recompress — the bytes and ETag were materialized once when the cycle was built.
  const gzip = acceptsGzip(request.headers.get("accept-encoding"));
  const representation = gzip ? payload.gzip : payload.plain;
  const etag = representation.etag;

  // (4) Encode the captured observation; oversized/uncanonicalizable → fail safely (never emit a bad
  //     header). Observation/payload-id are NOT part of the ETag (header metadata excluded).
  const observationHeader = encodeObservationHeader(cycle.observation);
  if (observationHeader === null) {
    return errorResponse({ code: "INTERNAL_ERROR", message: ERROR_MESSAGES.INTERNAL_ERROR }, 500);
  }

  // Headers present on BOTH 200 and 304 (05 §7). The ETag is quoted; the observation advances even
  // when the retained bytes are reused, so a 304 still carries the latest observation/payload id.
  const shared: Record<string, string> = {
    "cache-control": "private, no-cache",
    vary: "Accept-Encoding",
    etag: `"${etag}"`,
    "x-pulse-observation": observationHeader,
    "x-pulse-payload-id": payload.identity,
  };

  // (5) A matching strong validator → bodyless 304. Weak/mismatched validators fall through to 200.
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: shared });
  }

  // (6) Otherwise the selected exact bytes with the JSON content type and optional gzip encoding.
  //     The retained bytes are ArrayBuffer-backed (canonical JSON / deterministic gzip output); the
  //     cast narrows `Uint8Array<ArrayBufferLike>` to the `BodyInit`-accepted `Uint8Array<ArrayBuffer>`
  //     without copying, so the exact retained bytes are streamed as-is (no reserialization; §7).
  return new Response(representation.bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      ...shared,
      "content-type": "application/json; charset=utf-8",
      ...(gzip ? { "content-encoding": "gzip" } : {}),
    },
  });
}
