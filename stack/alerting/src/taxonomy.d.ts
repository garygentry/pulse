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
export declare const SEVERITY_TAXONOMY: readonly [{
    readonly name: "critical";
    readonly response: "immediate human action";
    readonly channels: "critical-human + webhook-mirror";
    readonly repeatInterval: "30m";
    readonly groupWindow: null;
    readonly bypassesQuietHours: true;
    readonly sendsResolved: true;
    readonly webhookMirror: "always";
}, {
    readonly name: "warning";
    readonly response: "timely investigation";
    readonly channels: "non-paging ops";
    readonly repeatInterval: null;
    readonly groupWindow: "15m";
    readonly bypassesQuietHours: false;
    readonly sendsResolved: true;
    readonly webhookMirror: "if-selected";
}, {
    readonly name: "info";
    readonly response: "digest-only awareness";
    readonly channels: "daily digest 09:00 estate-tz";
    readonly repeatInterval: null;
    readonly groupWindow: null;
    readonly bypassesQuietHours: false;
    readonly sendsResolved: false;
    readonly webhookMirror: "never";
}];
/** The exposed contract version; bumps on ANY taxonomy change (conformance-tested). */
export declare const SEVERITY_TAXONOMY_VERSION: 1;
//# sourceMappingURL=taxonomy.d.ts.map