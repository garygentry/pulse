// Device management handlers shared by the web UI (browser gate) and the operator surface (operator secret).

import { DEVICE_ID_PATTERN } from "@pulse/web-data/contract";
import type { PushDevicesPayload } from "@pulse/web-data/wire";

import { removeDevice, toDeviceSummary } from "../registry/summary.js";
import { pushErrorResponse } from "../refusal.js";
import { pushJson, pushNoContent, type PushHandlerDeps } from "./redeem.js";

/**
 * DELETE /api/push/devices/:id and DELETE /api/push/admin/devices/:id. An id failing the device-id pattern is
 * treated as unknown, with no lookup.
 * 204 | 404 API_NOT_FOUND | 503 PUSH_UNAVAILABLE.
 */
export async function handleRevokeDevice(deps: PushHandlerDeps, id: string): Promise<Response> {
  if (!DEVICE_ID_PATTERN.test(id)) return pushErrorResponse("not-found");
  const result = await removeDevice(deps.store, id, "revoked");
  if (result === "removed") return pushNoContent();
  if (result === "not-found") return pushErrorResponse("not-found");
  return pushErrorResponse("unavailable");
}

/** GET /api/push/admin/devices. 200 PushDevicesPayload in registry (pairing) order. Never fails. */
export function handleListAdminDevices(deps: PushHandlerDeps): Response {
  const body: PushDevicesPayload = { devices: deps.store.list().map(toDeviceSummary) };
  return pushJson(200, body);
}
