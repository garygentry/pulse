// Operator-facing projection of a device record.

import type { DeviceSummary } from "@pulse/web-data/wire";
import type { DeviceRecord, DeviceRemovalReason } from "./schema.js";
import type { RegistryStore } from "./store.js";

/**
 * Project a record to the operator view. Pure. Drops credentialHash and the full apnsToken.
 * tokenSuffix is the last 6 characters of the lowercase hex token, or null before the first registration.
 */
export function toDeviceSummary(record: DeviceRecord): DeviceSummary {
  return {
    id: record.id,
    displayName: record.displayName,
    pairedAt: record.pairedAt,
    seenAt: record.seenAt,
    environment: record.environment,
    preferences: record.preferences,
    tokenSuffix: record.apnsToken === null ? null : record.apnsToken.slice(-6),
    lastDelivery: record.lastDelivery,
  };
}

/** Outcome of {@link removeDevice}. */
export type RemoveDeviceResult = "removed" | "not-found" | "write-failed";

/**
 * Remove one device through the store's chain. The step re-reads the current array, so a device already removed by
 * a concurrent change yields "not-found" and nothing is written. With `expectedApnsToken`, the device is removed
 * only while its current token still equals it (a dead-token report for a replaced token removes nothing).
 *
 * @param store - the concrete store (the reason drives logs, counters and onRemoved listeners)
 * @param id - device id
 * @param reason - why the device is removed
 * @param opts - optional token guard checked inside the step
 */
export async function removeDevice(
  store: RegistryStore,
  id: string,
  reason: DeviceRemovalReason,
  opts?: { readonly expectedApnsToken?: string },
): Promise<RemoveDeviceResult> {
  const expected = opts?.expectedApnsToken;
  const r = await store.mutate<RemoveDeviceResult>((devices) => {
    const current = devices.find((d) => d.id === id);
    if (current === undefined || (expected !== undefined && current.apnsToken !== expected)) {
      return { kind: "abort", result: "not-found" };
    }
    return { kind: "commit", devices: devices.filter((d) => d.id !== id), result: "removed" };
  }, reason);
  return r.ok ? r.result : "write-failed";
}
