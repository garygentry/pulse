// Alertmanager webhook vocabulary: the validated v4 subset push reads, and a prototype-safe label accessor.

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
