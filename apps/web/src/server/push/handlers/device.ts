// Device self-service handlers: register/refresh and self-removal. The device id comes from the credential
// authoriser; the body passed the registration schema.

import { APNS_TOKEN_PATTERN } from "@pulse/web-data/contract";
import type { DeviceRegistrationRequest, DeviceRegistrationResponse } from "@pulse/web-data/wire";

import type { DeviceRecord } from "../registry/schema.js";
import { removeDevice } from "../registry/summary.js";
import { pushErrorResponse } from "../refusal.js";
import { pushJson, pushNoContent, type PushHandlerDeps } from "./redeem.js";

/**
 * PUT /api/push/device. Replaces the token, environment and preferences and stamps `seenAt`; every other device
 * holding the same token is removed in the same write (reason `superseded`).
 * 200 DeviceRegistrationResponse | 400 INVALID_REQUEST {fields: "apnsToken"} | 401 UNAUTHORIZED | 503 PUSH_UNAVAILABLE.
 */
export async function handleRegisterDevice(
  deps: PushHandlerDeps,
  deviceId: string,
  body: DeviceRegistrationRequest,
): Promise<Response> {
  const apnsToken = body.apnsToken.toLowerCase();
  if (!APNS_TOKEN_PATTERN.test(apnsToken)) return pushErrorResponse("invalid-body", { fields: "apnsToken" });
  const seenAt = new Date(deps.clock.nowMs()).toISOString();

  const r = await deps.store.mutate<DeviceRecord | null>((devices) => {
    const self = devices.find((d) => d.id === deviceId);
    // Revoked or removed between authorisation and this step: never resurrect it.
    if (self === undefined) return { kind: "abort", result: null };
    let updated: DeviceRecord = self;
    const next: DeviceRecord[] = [];
    for (const d of devices) {
      if (d.id === deviceId) {
        updated = {
          ...d,
          apnsToken,
          environment: body.environment,
          preferences: { ...body.preferences },
          seenAt,
        };
        next.push(updated);
      } else if (d.apnsToken !== apnsToken) {
        next.push(d);
      }
    }
    return { kind: "commit", devices: next, result: updated };
  }, "superseded");

  if (!r.ok) return pushErrorResponse("unavailable");
  if (r.result === null) return pushErrorResponse("unauthorized");
  const d = r.result;
  const response: DeviceRegistrationResponse = {
    deviceId: d.id,
    environment: body.environment,
    preferences: d.preferences,
    seenAt: d.seenAt,
  };
  return pushJson(200, response);
}

/** DELETE /api/push/device. 204 (also when the device is already gone) | 503 PUSH_UNAVAILABLE. */
export async function handleRemoveSelf(deps: PushHandlerDeps, deviceId: string): Promise<Response> {
  const result = await removeDevice(deps.store, deviceId, "self");
  return result === "write-failed" ? pushErrorResponse("unavailable") : pushNoContent();
}
