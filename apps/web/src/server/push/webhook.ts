// Alertmanager webhook vocabulary: the validated v4 subset push reads, its parser, and a prototype-safe label
// accessor.

import { z } from "zod";

import { formatInvalidFields, zodIssuePaths } from "../mutations/guards.js";
import { AM_FINGERPRINT_PATTERN, PUSH_LIMITS } from "./constants.js";

/** One alert from an Alertmanager v4 webhook (validated subset). */
export interface AmAlert {
  /** The alert's own status. */
  readonly status: "firing" | "resolved";
  /** Alert labels; each value ≤ `PUSH_LIMITS.webhookMaxLabelValueBytes`. */
  readonly labels: Readonly<Record<string, string>>;
  /** Alert annotations (summary, description, …). Validated but never read into a payload. */
  readonly annotations: Readonly<Record<string, string>>;
  /** Alertmanager's RFC 3339 start time, carried as a string. */
  readonly startsAt: string;
  /** Matches `AM_FINGERPRINT_PATTERN`. */
  readonly fingerprint: string;
}

/** A validated Alertmanager v4 webhook notification. */
export interface AmNotification {
  /** Webhook payload version; only "4" is accepted. */
  readonly version: "4";
  /** Alertmanager group key; `groupCollapseId` hashes it into the `g-` collapse id. */
  readonly groupKey: string;
  /** Group status: firing while any alert in it fires. */
  readonly status: "firing" | "resolved";
  /** At most `PUSH_LIMITS.webhookMaxAlerts` alerts. */
  readonly alerts: readonly AmAlert[];
  /** Alertmanager's truncatedAlerts, default 0. Reported in logs only. */
  readonly truncatedAlerts: number;
}

/** Outcome of parsing a webhook body. */
export type WebhookParseResult =
  | {
      /** The body parsed and validated. */
      readonly ok: true;
      /** The validated notification. */
      readonly notification: AmNotification;
    }
  | {
      /** The body was refused. */
      readonly ok: false;
      /** The refusal kind. */
      readonly refusal: "invalid-body" | "unsupported-version" | "body-too-large";
      /** Offending field paths for invalid-body/unsupported-version; absent when none are known. */
      readonly fields?: string;
    };

/**
 * Read a label without consulting the prototype chain (a `__proto__` label key in JSON must never alias another
 * label). Used for every label read by the planner and the payload builder.
 *
 * @param labels - An `AmAlert.labels` map.
 * @param key - The label name.
 * @returns The value when the label is an own property, otherwise undefined.
 */
export function ownLabel(labels: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : undefined;
}

/** zod `params` marker on the label-value refinement, so the parser can tell a size issue from a shape issue. */
const LABEL_BYTES_MARKER = "push-label-bytes" as const;

const UTF8 = new TextEncoder();

/**
 * True when `value` encodes to at most `PUSH_LIMITS.webhookMaxLabelValueBytes` UTF-8 bytes. Avoids encoding in the
 * common case: one UTF-16 unit is at most 3 bytes, and at least 1.
 *
 * @param value - A label value.
 * @returns Whether the value is within the bound.
 */
export function withinLabelBytes(value: string): boolean {
  const max = PUSH_LIMITS.webhookMaxLabelValueBytes;
  if (value.length * 3 <= max) return true;
  if (value.length > max) return false;
  return UTF8.encode(value).length <= max;
}

/** One alert: required members validated, unknown members ignored. */
const amAlertSchema = z
  .object({
    status: z.enum(["firing", "resolved"]),
    labels: z.record(z.string().refine(withinLabelBytes, { params: { marker: LABEL_BYTES_MARKER } })),
    annotations: z.record(z.string()),
    startsAt: z.string(),
    fingerprint: z.string().regex(AM_FINGERPRINT_PATTERN),
  })
  .passthrough();

/** Version-4 notification: required members validated, unknown members ignored (Alertmanager adds fields). */
export const amNotificationSchema = z
  .object({
    version: z.literal("4"),
    groupKey: z.string(),
    status: z.enum(["firing", "resolved"]),
    alerts: z.array(amAlertSchema).max(PUSH_LIMITS.webhookMaxAlerts),
    truncatedAlerts: z.number().int().nonnegative().safe().optional(),
  })
  .passthrough();

type ParsedNotification = z.infer<typeof amNotificationSchema>;

function refuse(
  refusal: "invalid-body" | "unsupported-version" | "body-too-large",
  fields?: string,
): WebhookParseResult {
  return Object.freeze(fields === undefined ? { ok: false, refusal } : { ok: false, refusal, fields });
}

/** Copy a string map into a fresh frozen object holding own enumerable keys only. */
function copyStringMap(source: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(source)) {
    // defineProperty so a "__proto__" key stays an ordinary own property and never sets the prototype.
    Object.defineProperty(out, key, { value: source[key], enumerable: true, writable: false, configurable: false });
  }
  return Object.freeze(out);
}

function project(parsed: ParsedNotification): AmNotification {
  const alerts = parsed.alerts.map(
    (alert): AmAlert =>
      Object.freeze({
        status: alert.status,
        labels: copyStringMap(alert.labels),
        annotations: copyStringMap(alert.annotations),
        startsAt: alert.startsAt,
        fingerprint: alert.fingerprint,
      }),
  );
  return Object.freeze({
    version: parsed.version,
    groupKey: parsed.groupKey,
    status: parsed.status,
    alerts: Object.freeze(alerts),
    truncatedAlerts: parsed.truncatedAlerts ?? 0,
  });
}

/**
 * Parse and validate an Alertmanager webhook body. Never throws for a bad body.
 *
 * Stages, in order (each stops at the first failure):
 * 1. More than `PUSH_LIMITS.webhookMaxBytes` bytes → body-too-large.
 * 2. Strict UTF-8 decode and `JSON.parse` → invalid-body.
 * 3. Not a non-null, non-array object → invalid-body (fields `$`).
 * 4. Own member `version` present and not `"4"` → unsupported-version (a missing version fails at stage 6).
 * 5. More than `PUSH_LIMITS.webhookMaxAlerts` alerts → body-too-large, before the array is walked.
 * 6. Schema validation: a label value over the byte bound → body-too-large; anything else → invalid-body with the
 *    failing paths.
 * 7. Projection into a frozen `AmNotification` holding only the known members; truncatedAlerts defaults to 0.
 *
 * @param bytes - The exact request body bytes.
 * @returns The validated notification, or the refusal to answer with.
 */
export function parseAlertmanagerWebhook(bytes: Uint8Array): WebhookParseResult {
  if (bytes.length > PUSH_LIMITS.webhookMaxBytes) return refuse("body-too-large");

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return refuse("invalid-body");
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) return refuse("invalid-body", "$");
  const record = value as Record<string, unknown>;

  if (Object.prototype.hasOwnProperty.call(record, "version") && record["version"] !== "4") {
    return refuse("unsupported-version");
  }
  const alerts = Object.prototype.hasOwnProperty.call(record, "alerts") ? record["alerts"] : undefined;
  if (Array.isArray(alerts) && alerts.length > PUSH_LIMITS.webhookMaxAlerts) return refuse("body-too-large");

  const parsed = amNotificationSchema.safeParse(record);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const oversized = issues.some(
      (issue) =>
        issue.code === "custom" &&
        (issue.params as { marker?: unknown } | undefined)?.marker === LABEL_BYTES_MARKER,
    );
    if (oversized) return refuse("body-too-large");
    return refuse("invalid-body", formatInvalidFields(zodIssuePaths(issues)));
  }

  return Object.freeze({ ok: true, notification: project(parsed.data) });
}
