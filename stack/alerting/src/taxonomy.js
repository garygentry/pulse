// stack/alerting/src/taxonomy.ts
// The exposed `severity-taxonomy` type contract (00-core-definitions.md §3). This is the TypeScript
// source of truth, mirrored into contract/severity-taxonomy.{json,md} and conformance-tested.
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
];
/** The exposed contract version; bumps on ANY taxonomy change (conformance-tested). */
export const SEVERITY_TAXONOMY_VERSION = 1;
//# sourceMappingURL=taxonomy.js.map