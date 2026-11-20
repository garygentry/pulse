// APNs payload construction: notification text, sanitising, size capping and the fixed-order payload object.

import type {
  PushCategory,
  PushInterruptionLevel,
  PushPayload,
  PushSeverity,
  PushTarget,
} from "@pulse/web-data/wire";
import { CONTRACT_LIMITS, truncateUtf8 } from "@pulse/web-data/contract";
import type { ApnsRequest } from "./apns/client.js";
import { PUSH_LIMITS } from "./constants.js";
import { AUDIBLE_LEVEL, alertCollapseId, type PlannedNotification } from "./plan.js";
import { PushInvariantError } from "./refusal.js";
import { ownLabel, type AmAlert } from "./webhook.js";

/** Input to the alert/summary payload builder. Test payloads have their own builder. */
export type PayloadDraft =
  | {
      /** A per-alert notification. */
      readonly kind: "alert";
      /** The alert; only status, fingerprint and the alertname/target/instance/host labels are read. */
      readonly alert: AmAlert;
      /** severityOf(alert); carried unchanged into pulse.alert.severity. */
      readonly severity: PushSeverity;
      /** First firing notification (true) or repeat/resolution (false). A resolved alert is never audible. */
      readonly audible: boolean;
      /** Current badge, or null to omit aps.badge. */
      readonly badge: number | null;
    }
  | {
      /** One roll-up notification for a large call. */
      readonly kind: "summary";
      /** groupCollapseId(groupKey). */
      readonly group: string;
      /** Kept alerts covered (the "<n> alerts changed" count). */
      readonly total: number;
      /** Kept firing alerts. */
      readonly firing: number;
      /** Kept resolved alerts. */
      readonly resolved: number;
      /** Highest severity among newly firing alerts; null means quiet. */
      readonly severity: PushSeverity | null;
      /** alertname of the first kept alert, for the optional body suffix. */
      readonly firstAlertname: string | null;
      /** Current badge, or null to omit aps.badge. */
      readonly badge: number | null;
    };

const UTF8 = new TextEncoder();
const ELLIPSIS = "…"; // U+2026, 3 UTF-8 bytes
const ELLIPSIS_BYTES = 3;
const UNNAMED_ALERT = "Unnamed alert";
const TARGET_LABELS = ["target", "instance", "host"] as const;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

function utf8Length(value: string): number {
  return UTF8.encode(value).length;
}

/**
 * Make label-derived text safe to measure and send: each lone UTF-16 surrogate becomes U+FFFD and each C0 control or
 * DEL becomes a space, so the output is valid UTF-8 and JSON escaping cannot inflate it.
 *
 * @param value - Raw text.
 * @returns The sanitised text.
 */
export function sanitizeText(value: string): string {
  return value.replace(LONE_SURROGATE, "�").replace(CONTROL_CHARS, " ");
}

/**
 * Cap a string at `maxBytes` UTF-8 bytes, appending "…" within the cap when it is cut.
 *
 * @param value - The text to cap.
 * @param maxBytes - Byte budget (non-negative integer).
 * @returns `value` when it fits; otherwise its longest code-point prefix within `maxBytes - 3` plus "…"; "" when
 *   `maxBytes < 3`.
 */
export function fitText(value: string, maxBytes: number): string {
  if (value.length * 3 <= maxBytes || utf8Length(value) <= maxBytes) return value;
  if (maxBytes < ELLIPSIS_BYTES) return "";
  return truncateUtf8(value, maxBytes - ELLIPSIS_BYTES) + ELLIPSIS;
}

function targetOf(alert: AmAlert): string | null {
  for (const key of TARGET_LABELS) {
    const value = ownLabel(alert.labels, key);
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

/**
 * Title and body of an alert or summary notification before size capping.
 *
 * Only `alertname` and the first non-empty of `target`/`instance`/`host` are read. A summary body carries the
 * ` in <firstAlertname>…` suffix only when the whole sanitised body stays within the body byte cap.
 *
 * @param draft - The payload draft.
 * @returns The raw (unsanitised, uncapped) title and body.
 */
export function notificationText(draft: PayloadDraft): { readonly title: string; readonly body: string } {
  if (draft.kind === "alert") {
    const name = ownLabel(draft.alert.labels, "alertname");
    const title = name === undefined || name === "" ? UNNAMED_ALERT : name;
    const verb = draft.alert.status === "resolved" ? "Resolved" : "Firing";
    const target = targetOf(draft.alert);
    return { title, body: target === null ? verb : `${verb} on ${target}` };
  }
  const title = `${draft.total} alerts changed`;
  const base = `${draft.firing} firing, ${draft.resolved} resolved`;
  const first = draft.firstAlertname;
  if (first !== null && first !== "") {
    const withSuffix = `${base} in ${first}${ELLIPSIS}`;
    if (utf8Length(sanitizeText(withSuffix)) <= CONTRACT_LIMITS.push.bodyBytes) return { title, body: withSuffix };
  }
  return { title, body: base };
}

/**
 * UTF-8 JSON bytes of a payload. Key order is the object's insertion order, fixed by the builders.
 *
 * @param payload - The payload.
 * @returns The serialised bytes, no whitespace.
 */
export function serializePayload(payload: PushPayload): Uint8Array {
  return UTF8.encode(JSON.stringify(payload));
}

/**
 * Size-cap a payload: start from the body capped at the body limit and halve the body budget until the serialised
 * payload is within `maxBytes`. The title is never shortened here. Exported for tests with a lowered `maxBytes`.
 *
 * @param assemble - Builds the payload around a given (already sanitised and capped) body.
 * @param rawBody - The sanitised, uncapped body.
 * @param maxBytes - Serialised payload budget.
 * @returns The first payload that fits.
 * @throws {PushInvariantError} when the payload does not fit even with an empty body.
 */
export function fitPayload(
  assemble: (body: string) => PushPayload,
  rawBody: string,
  maxBytes: number,
): PushPayload {
  let body = fitText(rawBody, CONTRACT_LIMITS.push.bodyBytes);
  let payload = assemble(body);
  while (serializePayload(payload).length > maxBytes) {
    if (body === "") throw new PushInvariantError("push payload cannot fit");
    body = fitText(rawBody, Math.floor(utf8Length(body) / 2));
    payload = assemble(body);
  }
  return payload;
}

interface Presentation {
  readonly category: PushCategory;
  readonly level: PushInterruptionLevel;
  readonly audible: boolean;
  readonly badge: number | null;
  readonly pulse: PushPayload["pulse"];
}

function assemblePayload(title: string, body: string, p: Presentation): PushPayload {
  const aps: {
    alert: { readonly title: string; readonly body: string };
    category: PushCategory;
    "interruption-level": PushInterruptionLevel;
    sound?: "default";
    badge?: number;
  } = {
    alert: Object.freeze({ title, body }),
    category: p.category,
    "interruption-level": p.level,
  };
  if (p.audible) aps.sound = "default";
  if (p.badge !== null) aps.badge = p.badge;
  return Object.freeze({ aps: Object.freeze(aps), pulse: p.pulse });
}

function pulseFor(draft: PayloadDraft): PushPayload["pulse"] {
  if (draft.kind === "alert") {
    const fingerprint = draft.alert.fingerprint;
    const target: PushTarget = Object.freeze({ screen: "alert", fingerprint });
    return Object.freeze({
      v: 1,
      kind: "alert",
      collapseId: alertCollapseId(fingerprint),
      target,
      alert: Object.freeze({ fingerprint, status: draft.alert.status, severity: draft.severity }),
    });
  }
  const target: PushTarget = Object.freeze({ screen: "alerts" });
  return Object.freeze({
    v: 1,
    kind: "summary",
    collapseId: draft.group,
    target,
    summary: Object.freeze({
      group: draft.group,
      firing: draft.firing,
      resolved: draft.resolved,
      severity: draft.severity,
    }),
  });
}

function presentationOf(draft: PayloadDraft): Presentation {
  const pulse = pulseFor(draft);
  if (draft.kind === "alert") {
    const audible = draft.audible && draft.alert.status === "firing";
    return {
      category: draft.alert.status === "resolved" ? "PULSE_ALERT_RESOLVED" : "PULSE_ALERT_FIRING",
      level: audible ? AUDIBLE_LEVEL[draft.severity] : "passive",
      audible,
      badge: draft.badge,
      pulse,
    };
  }
  const severity = draft.severity;
  return {
    category: "PULSE_ALERT_SUMMARY",
    level: severity === null ? "passive" : AUDIBLE_LEVEL[severity],
    audible: severity !== null,
    badge: draft.badge,
    pulse,
  };
}

/**
 * Build the size-capped, deeply frozen payload for an alert or summary.
 *
 * Member order is fixed: `aps {alert {title, body}, category, interruption-level, sound?, badge?}` then
 * `pulse {v, kind, collapseId, target, alert? | summary?}`. `sound` is present only when audible and `badge` only
 * when the draft's badge is non-null.
 *
 * @param draft - The alert or summary draft.
 * @returns The payload, within `CONTRACT_LIMITS.push.payloadBytes`.
 * @throws {PushInvariantError} only if the payload cannot fit even with an empty body (unreachable in practice).
 */
export function buildPayload(draft: PayloadDraft): PushPayload {
  const text = notificationText(draft);
  const title = fitText(sanitizeText(text.title), CONTRACT_LIMITS.push.titleBytes);
  const presentation = presentationOf(draft);
  return fitPayload(
    (body) => assemblePayload(title, body, presentation),
    sanitizeText(text.body),
    CONTRACT_LIMITS.push.payloadBytes,
  );
}

/** A payload and the APNs request that carries it. */
export interface BuiltPush {
  /** The deeply frozen body object. */
  readonly payload: PushPayload;
  /** Headers + the serialised body (≤ CONTRACT_LIMITS.push.payloadBytes). */
  readonly request: ApnsRequest;
}

/** Fields of a draft that only the request needs. */
export interface RequestFields {
  /** APNs expiration, epoch seconds. */
  readonly expiration: number;
  /** The configured APNs topic (bundle id). */
  readonly topic: string;
}

const TEST_TITLE = "Pulse test notification";
const TEST_BODY = "Push delivery to this device works.";

function requestFor(
  payload: PushPayload,
  audible: boolean,
  collapseId: string | null,
  expiration: number,
  topic: string,
): ApnsRequest {
  const headers: {
    "apns-push-type": "alert";
    "apns-topic": string;
    "apns-priority": "10" | "5";
    "apns-expiration": string;
    "apns-collapse-id"?: string;
  } = {
    "apns-push-type": "alert",
    "apns-topic": topic,
    "apns-priority": audible ? "10" : "5",
    "apns-expiration": String(expiration),
  };
  if (collapseId !== null) headers["apns-collapse-id"] = collapseId;
  return Object.freeze({ headers: Object.freeze(headers), body: serializePayload(payload) });
}

/**
 * Build payload + request in one step (contract fixtures, tests). Deterministic: no clock is read.
 * `request.headers["apns-collapse-id"]` equals `payload.pulse.collapseId`.
 *
 * @param draft - The alert or summary draft.
 * @param fields - Expiration and topic for the request headers.
 * @returns The payload and its request.
 */
export function buildPushPayload(draft: PayloadDraft, fields: RequestFields): BuiltPush {
  const payload = buildPayload(draft);
  const audible = payload.aps.sound !== undefined;
  const request = requestFor(payload, audible, payload.pulse.collapseId, fields.expiration, fields.topic);
  return Object.freeze({ payload, request });
}

/**
 * Build the APNs request for an already planned item at send time. Re-serialises `planned.payload` (deterministic,
 * byte-identical to the size-checked serialisation) and derives the headers from `planned.audible`,
 * `planned.collapseId` and `planned.expiration`.
 *
 * @param planned - The planned notification.
 * @param topic - The configured APNs topic.
 * @returns The request to send.
 */
export function toApnsRequest(planned: PlannedNotification, topic: string): ApnsRequest {
  return requestFor(planned.payload, planned.audible, planned.collapseId, planned.expiration, topic);
}

/**
 * Build a test notification: audible, `active`, priority 10, no collapse id, category PULSE_TEST, target home, the
 * badge when available, and expiration `floor(nowMs / 1000) + PUSH_LIMITS.testExpirationSeconds`. Deterministic: the
 * time is an input.
 *
 * @param badge - Current badge, or null to omit `aps.badge`.
 * @param nowMs - Build time, epoch milliseconds.
 * @param topic - The configured APNs topic.
 * @returns The payload and its request (without an `apns-collapse-id` header).
 */
export function buildTestPayload(badge: number | null, nowMs: number, topic: string): BuiltPush {
  const pulse: PushPayload["pulse"] = Object.freeze({
    v: 1,
    kind: "test",
    collapseId: null,
    target: Object.freeze({ screen: "home" }),
  });
  const payload = assemblePayload(TEST_TITLE, TEST_BODY, {
    category: "PULSE_TEST",
    level: "active",
    audible: true,
    badge,
    pulse,
  });
  const expiration = Math.floor(nowMs / 1000) + PUSH_LIMITS.testExpirationSeconds;
  return Object.freeze({ payload, request: requestFor(payload, true, null, expiration, topic) });
}
