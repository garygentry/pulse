// Operator-facing projection of a device record.

import type { DeviceSummary } from "@pulse/web-data/wire";
import type { DeviceRecord } from "./schema.js";

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
