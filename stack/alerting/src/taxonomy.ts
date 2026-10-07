// stack/alerting/src/taxonomy.ts
// The exposed `severity-taxonomy` type contract (00-core-definitions.md §3). This is the TypeScript
// source of truth, mirrored into contract/severity-taxonomy.{json,md} and conformance-tested.

/** The response-oriented severity levels. `deadman` is the internal DeadMansSwitch label (§6), NOT a
 *  routable human severity — it is excluded from this public union deliberately. */
export type Severity = "critical" | "warning" | "info";

/** Whether a severity mirrors to the automation webhook (REQ-HOOK-01). */
export type WebhookMirror = "always" | "if-selected" | "never";

/** One severity's routing semantics, keyed by required response (REQ-SEV-01). */
export interface SeverityDef {
  /** The level name. */
  readonly name: Severity;
  /** The required operator response, in prose (REQ-SEV-01). */
  readonly response: string;
  /** Human-readable channel target description (realized as AM receivers in 04). */
  readonly channels: string;
  /** Repeat cadence while firing & unsilenced, or `null` when not repeated (REQ-SEV-06). */
  readonly repeatInterval: string | null;
  /** Max grouping/batching window before delivery, or `null` (REQ-SEV-03). */
  readonly groupWindow: string | null;
  /** Whether this severity bypasses quiet hours (REQ-ROUTE-03). */
  readonly bypassesQuietHours: boolean;
  /** Whether a resolved notification is sent when the alert clears (REQ-SEV-05). */
  readonly sendsResolved: boolean;
  /** Webhook-mirror policy (REQ-HOOK-01). */
  readonly webhookMirror: WebhookMirror;
}

/** The exposed taxonomy. Order is significant (critical→warning→info) and stable. */
export const SEVERITY_TAXONOMY = [
  {
    name: "critical",
    response: "immediate human action",
    channels: "critical-human + webhook-mirror",
    repeatInterval: "30m",
    groupWindow: null,
    bypassesQuietHours: true,
    sendsResolved: true,
    webhookMirror: "always",
  },
  {
    name: "warning",
    response: "timely investigation",
    channels: "non-paging ops",
    repeatInterval: null,
    groupWindow: "15m",
    bypassesQuietHours: false,
    sendsResolved: true,
    webhookMirror: "if-selected",
  },
  {
    name: "info",
    response: "digest-only awareness",
    channels: "daily digest 09:00 estate-tz",
    repeatInterval: null,
    groupWindow: null,
    bypassesQuietHours: false,
    sendsResolved: false,
    webhookMirror: "never",
  },
] as const satisfies readonly SeverityDef[];

/** The exposed contract version; bumps on ANY taxonomy change (conformance-tested). */
export const SEVERITY_TAXONOMY_VERSION = 1 as const;
