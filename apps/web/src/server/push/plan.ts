// Delivery planning: turn one validated webhook call into immutable per-device notifications.

import { createHash } from "node:crypto";
import type {
  PushInterruptionLevel,
  PushPayload,
  PushPreferences,
  PushSeverity,
} from "@pulse/web-data/wire";
import { PUSH_LIMITS } from "./constants.js";
import type { MarkRef, NotifiedMemory } from "./memory.js";
import { buildPayload, type PayloadDraft } from "./payload.js";
import type { DeviceRecord } from "./registry/schema.js";
import { ownLabel, type AmAlert, type AmNotification } from "./webhook.js";

export type { MarkRef } from "./memory.js";

/** Metric and planning kind. `firing` is the audible first notification of an alert. */
export type NotificationKind = "firing" | "resolved" | "repeat" | "summary" | "test";

/** One planned APNs request for one device. Immutable once enqueued. */
export interface PlannedNotification {
  /** Target device id (`DEVICE_ID_PATTERN`). */
  readonly deviceId: string;
  /** Planning and metric kind. */
  readonly kind: NotificationKind;
  /** True when the notification plays a sound (`aps.sound` present). */
  readonly audible: boolean;
  /** `a-<fp>` or `g-<16 hex>`; null only for test. */
  readonly collapseId: string | null;
  /** The APNs JSON body to send. */
  readonly payload: PushPayload;
  /** Marks this item newly set. Empty for repeats, resolutions and quiet summaries. */
  readonly marks: readonly MarkRef[];
  /** APNs expiration (epoch seconds) computed at plan time. */
  readonly expiration: number;
}

/** Values captured once by the intake at plan time. */
export interface PlanContext {
  /** Firing-alert count for `aps.badge`; `null` omits the badge (read model unavailable). */
  readonly badge: number | null;
  /** Plan time, epoch milliseconds. */
  readonly nowMs: number;
}

/** Result of planning one webhook call. */
export interface PlanResult {
  /** Planned items keyed by device id, in send order; devices with nothing planned are absent. */
  readonly perDevice: ReadonlyMap<string, readonly PlannedNotification[]>;
  /** Alerts filtered by preference, per would-be kind (counted outcome="filtered"). */
  readonly filtered: ReadonlyMap<NotificationKind, number>;
}

/**
 * `labels.severity` → PushSeverity. Exact, case-sensitive match on the three known values; anything else, including
 * a missing label, is "unknown".
 *
 * @param alert - The alert.
 * @returns Its severity.
 */
export function severityOf(alert: AmAlert): PushSeverity {
  const raw = ownLabel(alert.labels, "severity");
  return raw === "critical" || raw === "warning" || raw === "info" ? raw : "unknown";
}

/**
 * The preference switch that governs a severity. "unknown" is filtered as "warning".
 *
 * @param severity - An alert severity.
 * @returns The `PushPreferences` key consulted for it.
 */
export function preferenceKey(severity: PushSeverity): keyof PushPreferences {
  return severity === "unknown" ? "warning" : severity;
}

/** Interruption level for an audible notification. Quiet notifications always use "passive". */
export const AUDIBLE_LEVEL: Readonly<Record<PushSeverity, PushInterruptionLevel>> = Object.freeze({
  critical: "time-sensitive",
  warning: "active",
  info: "passive",
  unknown: "active",
});

/** Ordering for "highest severity". unknown ranks between warning and info; ties keep the first seen. */
export const SEVERITY_RANK: Readonly<Record<PushSeverity, number>> = Object.freeze({
  critical: 4,
  warning: 3,
  unknown: 2,
  info: 1,
});

/**
 * Alert collapse id: "a-" + the 16-hex fingerprint (18 bytes, within Apple's 64-byte header limit).
 *
 * @param fingerprint - Alertmanager fingerprint.
 * @returns The collapse id.
 */
export function alertCollapseId(fingerprint: string): string {
  return `a-${fingerprint}`;
}

/**
 * Group collapse id: "g-" + the first 16 lowercase hex chars of sha256(UTF-8 groupKey) (18 bytes). The group key
 * itself never leaves the server.
 *
 * @param groupKey - Alertmanager group key.
 * @returns The collapse id.
 */
export function groupCollapseId(groupKey: string): string {
  return `g-${createHash("sha256").update(groupKey, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * Plan one webhook call for every registered device. Pure apart from marking and unmarking `memory`.
 *
 * Only devices with a non-null apnsToken are planned (the environment is resolved at send time). Devices are visited
 * in `devices` order; alerts in `notification.alerts` order. Per device, alerts whose severity preference is off are
 * filtered (counted under their would-be kind; a filtered resolution still unmarks). Up to
 * `PUSH_LIMITS.summaryThreshold` kept alerts give one item each; more give exactly one summary.
 *
 * @param notification - The validated call.
 * @param devices - `store.list()` at plan time.
 * @param memory - The shared notified memory.
 * @param ctx - Badge and clock captured by the intake.
 * @returns Items per device (devices with no item are absent) and filtered counts per would-be kind.
 */
export function planDeliveries(
  notification: AmNotification,
  devices: readonly DeviceRecord[],
  memory: NotifiedMemory,
  ctx: PlanContext,
): PlanResult {
  const perDevice = new Map<string, readonly PlannedNotification[]>();
  const filtered = new Map<NotificationKind, number>();
  const expiration = Math.floor(ctx.nowMs / 1000) + PUSH_LIMITS.alertExpirationSeconds;
  const alerts = notification.alerts;
  const severities: PushSeverity[] = alerts.map(severityOf);
  // Per-alert payloads depend only on (alert, audible, badge), so they are shared across devices.
  const alertPayloads = new Map<string, PushPayload>();
  let group: string | null = null;

  for (const device of devices) {
    if (device.apnsToken === null) continue;
    const kept: number[] = [];
    for (let i = 0; i < alerts.length; i++) {
      const alert = alerts[i]!;
      if (device.preferences[preferenceKey(severities[i]!)]) {
        kept.push(i);
        continue;
      }
      const wouldBe: NotificationKind =
        alert.status === "resolved"
          ? "resolved"
          : memory.isMarked(device.id, alert.fingerprint)
            ? "repeat"
            : "firing";
      filtered.set(wouldBe, (filtered.get(wouldBe) ?? 0) + 1);
      if (alert.status === "resolved") memory.unmark(device.id, alert.fingerprint);
    }
    if (kept.length === 0) continue;

    if (kept.length <= PUSH_LIMITS.summaryThreshold) {
      const items: PlannedNotification[] = [];
      for (const i of kept) {
        const alert = alerts[i]!;
        let kind: NotificationKind;
        let marks: readonly MarkRef[] = [];
        if (alert.status === "resolved") {
          memory.unmark(device.id, alert.fingerprint);
          kind = "resolved";
        } else if (memory.isMarked(device.id, alert.fingerprint)) {
          kind = "repeat";
        } else {
          marks = [memory.mark(device.id, alert.fingerprint)];
          kind = "firing";
        }
        const audible = kind === "firing";
        const key = `${i}:${audible ? 1 : 0}`;
        let payload = alertPayloads.get(key);
        if (payload === undefined) {
          payload = buildPayload({ kind: "alert", alert, severity: severities[i]!, audible, badge: ctx.badge });
          alertPayloads.set(key, payload);
        }
        items.push(
          Object.freeze({
            deviceId: device.id,
            kind,
            audible,
            collapseId: alertCollapseId(alert.fingerprint),
            payload,
            marks: Object.freeze(marks),
            expiration,
          }),
        );
      }
      perDevice.set(device.id, Object.freeze(items));
      continue;
    }

    group ??= groupCollapseId(notification.groupKey);
    const marks: MarkRef[] = [];
    let firing = 0;
    let resolved = 0;
    let severity: PushSeverity | null = null;
    for (const i of kept) {
      const alert = alerts[i]!;
      if (alert.status === "resolved") {
        resolved++;
        memory.unmark(device.id, alert.fingerprint);
        continue;
      }
      firing++;
      if (memory.isMarked(device.id, alert.fingerprint)) continue;
      marks.push(memory.mark(device.id, alert.fingerprint));
      const s = severities[i]!;
      if (severity === null || SEVERITY_RANK[s] > SEVERITY_RANK[severity]) severity = s;
    }
    const draft: PayloadDraft = {
      kind: "summary",
      group,
      total: kept.length,
      firing,
      resolved,
      severity,
      firstAlertname: ownLabel(alerts[kept[0]!]!.labels, "alertname") ?? null,
      badge: ctx.badge,
    };
    perDevice.set(
      device.id,
      Object.freeze([
        Object.freeze({
          deviceId: device.id,
          kind: "summary" as const,
          audible: severity !== null,
          collapseId: group,
          payload: buildPayload(draft),
          marks: Object.freeze(marks),
          expiration,
        }),
      ]),
    );
  }
  return { perDevice, filtered };
}
