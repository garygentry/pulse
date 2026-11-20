// Redeem handler and the shared handler dependencies and success-response helpers. Handlers run after the route
// table has authorised the request and parsed its body; they only map service results to responses.

import type { PairingRedeemRequest } from "@pulse/web-data/wire";

import { PUSH_CACHE_CONTROL } from "../constants.js";
import type { Clock } from "../ids.js";
import type { PairingService } from "../pairing.js";
import type { RegistryStore } from "../registry/store.js";
import { pushErrorResponse } from "../refusal.js";

/** Dependencies every pairing and device handler needs. Built once by bootstrap. */
export interface PushHandlerDeps {
  /** The pairing service (issue, cancel, redeem). */
  readonly pairing: PairingService;
  /** The concrete device registry. */
  readonly store: RegistryStore;
  /** Time source for instants the handlers stamp. */
  readonly clock: Clock;
}

/**
 * A push success response with a JSON body: `Content-Type: application/json; charset=utf-8`,
 * `Cache-Control: private, no-store`, body `JSON.stringify(body)`.
 */
export function pushJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": PUSH_CACHE_CONTROL,
    },
  });
}

/** A push 204: no body, only `Cache-Control: private, no-store`. */
export function pushNoContent(): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": PUSH_CACHE_CONTROL } });
}

/**
 * POST /api/push/pairings/redeem. The body passed the redeem schema; a malformed token still reaches the service
 * and is refused uniformly.
 * 201 PairingRedeemResponse | 403 PAIRING_REFUSED | 409 DEVICE_CAP_REACHED | 429 RATE_LIMITED (+ Retry-After)
 * | 503 PUSH_UNAVAILABLE.
 */
export async function handleRedeem(deps: PushHandlerDeps, body: PairingRedeemRequest): Promise<Response> {
  const result = await deps.pairing.redeem(body);
  if (result.ok) return pushJson(201, result.response);
  switch (result.refusal) {
    case "rate-limited":
      return pushErrorResponse("rate-limited", { retryAfterSeconds: result.retryAfterSeconds ?? 1 });
    case "pairing-refused":
      return pushErrorResponse("pairing-refused");
    case "device-cap-reached":
      return pushErrorResponse("device-cap-reached");
    case "unavailable":
      return pushErrorResponse("unavailable");
  }
}
