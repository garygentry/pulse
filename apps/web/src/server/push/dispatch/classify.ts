// APNs response classification: the single, pure decision point for retry, failure and device removal.

import type { ApnsClassification, ApnsResult } from "../apns/client.js";
import { APNS_REASON_PATTERN } from "../constants.js";

/**
 * Replace an APNs reason that does not match `APNS_REASON_PATTERN` (`^[A-Za-z]{1,64}$`) with "other".
 * A null reason becomes "other". The result is safe for logs, `lastDelivery.reason` and `PushTestResult.reason`.
 */
export function sanitizeApnsReason(raw: string | null): string {
  return raw !== null && APNS_REASON_PATTERN.test(raw) ? raw : "other";
}

/**
 * Classify one APNs result. A pure, total function with no side effects. It decides what the queue or test
 * send does next. Only `dead-token` (410 Unregistered, ExpiredToken or no reason) leads to a device removal.
 */
export function classifyApnsResponse(result: ApnsResult): ApnsClassification {
  if (result.kind === "error") return { kind: "transient", reason: result.error };
  const { status } = result;
  const reason = sanitizeApnsReason(result.reason);
  if (status === 200) return { kind: "delivered" };
  if (status === 410) {
    if (result.reason === null) return { kind: "dead-token", reason: "Unregistered" };
    if (reason === "Unregistered" || reason === "ExpiredToken") return { kind: "dead-token", reason };
    return { kind: "permanent", reason };
  }
  if (status === 403) {
    if (reason === "ExpiredProviderToken") return { kind: "auth-expired" };
    if (reason === "InvalidProviderToken" || reason === "MissingProviderToken") return { kind: "auth-failed", reason };
    return { kind: "permanent", reason };
  }
  if (status === 429 || (status >= 500 && status <= 599)) return { kind: "transient", reason };
  return { kind: "permanent", reason }; // 400, 413 and every other status
}
