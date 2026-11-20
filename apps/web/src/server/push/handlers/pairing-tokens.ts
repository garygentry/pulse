// Pairing-token handlers: web issue and cancel (browser gate) and operator issue (operator secret). The 201 body is
// a secret; it is never logged and always carries no-store.

import type { IssueResult } from "../pairing.js";
import { pushErrorResponse } from "../refusal.js";
import { pushJson, pushNoContent, type PushHandlerDeps } from "./redeem.js";

function issueResponse(result: IssueResult): Response {
  if (result.ok) return pushJson(201, result.issued);
  return pushErrorResponse(result.refusal);
}

/**
 * POST /api/push/pairing-tokens. No request body is read. The fallback base is the request's Origin header,
 * verbatim, or null when absent.
 * 201 PairingTokenIssued | 409 INVALID_REQUEST {reason: "no-usable-address" | "address-too-long"}.
 */
export function handleIssueWebToken(deps: PushHandlerDeps, request: Request): Response {
  return issueResponse(deps.pairing.issue("web", request.headers.get("Origin")));
}

/** DELETE /api/push/pairing-tokens/current. Idempotent: always 204, whether or not a token was outstanding. */
export function handleCancelWebToken(deps: PushHandlerDeps): Response {
  deps.pairing.cancelWeb();
  return pushNoContent();
}

/**
 * POST /api/push/admin/pairing-tokens. The fallback base is `body.baseUrl ?? null`; an unusable base is a 409, not
 * a schema failure.
 * 201 PairingTokenIssued | 409 INVALID_REQUEST {reason}.
 */
export function handleIssueAdminToken(deps: PushHandlerDeps, body: { readonly baseUrl?: string }): Response {
  return issueResponse(deps.pairing.issue("cli", body.baseUrl ?? null));
}
