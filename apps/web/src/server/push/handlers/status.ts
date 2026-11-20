// GET /api/push/status body. The route table applies the browser read gate and the state behaviour; this
// module only shapes the body. It never sees a pairing token, its hash or its link: the caller passes the
// outstanding web token's expiry as an ISO instant.

import type { DeviceSummary, PushStatusPayload } from "@pulse/web-data/wire";

import { PUSH_CACHE_CONTROL } from "../constants.js";

/** Inputs of {@link buildPushStatus}. */
export interface PushStatusInput {
  /** Gateway state; the route does not exist when push is disabled. */
  readonly state: "configured" | "misconfigured";
  /** Device summaries in any order; ignored when misconfigured. */
  readonly devices: readonly DeviceSummary[];
  /** Expiry of the outstanding web-issued pairing token (ISO-8601 UTC), or null; ignored when misconfigured. */
  readonly outstandingExpiresAt: string | null;
  /** The configured device cap. */
  readonly maxDevices: number;
}

/**
 * Build the status body. Pure over its inputs.
 * - configured: the devices sorted by `pairedAt` ascending (stable for equal instants), `outstanding` as
 *   `{expiresAt}` or null, and `maxDevices`;
 * - misconfigured: `{state: "misconfigured", devices: [], outstanding: null, maxDevices}`.
 *
 * @param input - State, device summaries, outstanding expiry and device cap.
 * @returns The `PushStatusPayload`.
 */
export function buildPushStatus(input: PushStatusInput): PushStatusPayload {
  if (input.state === "misconfigured") {
    return { state: "misconfigured", devices: [], outstanding: null, maxDevices: input.maxDevices };
  }
  const devices = [...input.devices].sort((a, b) => Date.parse(a.pairedAt) - Date.parse(b.pairedAt));
  return {
    state: "configured",
    devices,
    outstanding: input.outstandingExpiresAt === null ? null : { expiresAt: input.outstandingExpiresAt },
    maxDevices: input.maxDevices,
  };
}

/**
 * Answer 200 with the status body: `content-type: application/json` and the push no-store cache policy.
 *
 * @param payload - The body from {@link buildPushStatus}.
 * @returns The response.
 */
export function pushStatusResponse(payload: PushStatusPayload): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": PUSH_CACHE_CONTROL },
  });
}
