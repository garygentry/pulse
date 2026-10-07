// src/server/routes/respond.ts — shared JSON error responses over the canonical error catalog.
//
// Every failure body is an `ErrorEnvelope` whose message is the EXACT default text from
// `@pulse/web-data/wire` `ERROR_MESSAGES` (§8 — handlers never author prose). Kept a leaf module
// (imports only the browser-safe wire catalog) so the router, registry, and placeholder routes can
// share it without an import cycle. `errorResponse` is the §7 shared helper; `apiError` builds the
// envelope; `notReadyResponse` is the pre-first-cycle 503 the current/history placeholders return.

import { ERROR_MESSAGES, type ApiErrorCode, type ErrorEnvelope } from "@pulse/web-data/wire";

import { errorResponse } from "../../shared/api/json.js";

// `errorResponse` is the §7 shared JSON error response; it lives with `cycleJsonResponse` in
// `shared/api/json.ts` and is re-exported here so the router/registry/placeholders share one helper.
export { errorResponse };

/** Build the canonical error envelope for `code` (exact catalog message; optional bounded details). */
export function apiError(
  code: ApiErrorCode,
  details?: Readonly<Record<string, string | number | boolean | null>>,
): ErrorEnvelope {
  return { code, message: ERROR_MESSAGES[code], ...(details !== undefined ? { details } : {}) };
}

/** Convenience: the JSON error response for `code` at `status` with the exact catalog message. */
export function errorFor(
  code: ApiErrorCode,
  status: number,
  details?: Readonly<Record<string, string | number | boolean | null>>,
): Response {
  return errorResponse(apiError(code, details), status);
}

/** The 503 `NOT_READY` returned by cycle/history routes before the first cycle is published (§7). */
export function notReadyResponse(): Response {
  return errorFor("NOT_READY", 503);
}
