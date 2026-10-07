// src/client/views/alerts/taxonomy.ts — vendored severity taxonomy + default history range.
//
// SEVERITY_TAXONOMY is a typed FULL MIRROR of stack/alerting/contract/severity-taxonomy.json
// (contractVersion 1). That file lives outside the bun workspace, so it is NEVER imported or read at
// runtime — tests/alerts-taxonomy-drift.test.ts reads it by relative path and asserts exact equality
// (CON-08). The source has no `receivers` and no `urgency` field; routing explanations reconcile the
// intended policy against the alert's actual ActiveAlert.receivers (04 §Routing).
//
// Severity/state → status maps live in client/status/target-status.ts.

import type { RangeId } from "@pulse/web-data/wire";

/** Full mirror of stack/alerting/contract/severity-taxonomy.json (contractVersion 1). */
export interface SeverityRouting {
  readonly channels: string;
  readonly repeatInterval: string | null;
  readonly groupWindow: string | null;
  readonly bypassesQuietHours: boolean;
  readonly sendsResolved: boolean;
}
/** One severity's operator response and routing policy. */
export interface SeverityEntry {
  readonly name: string;
  readonly response: string;
  readonly routing: SeverityRouting;
}
/** Complete typed severity-taxonomy contract mirrored by this module. */
export interface SeverityTaxonomy {
  readonly contractVersion: number;
  readonly severities: readonly SeverityEntry[];
  readonly webhookMirror: Readonly<Record<"critical" | "warning" | "info", string>>;
}

/** Typed full mirror of the severity contract JSON, pinned by alerts-taxonomy-drift.test.ts. */
export const SEVERITY_TAXONOMY = {
  contractVersion: 1,
  severities: [
    { name: "critical", response: "immediate human action",
      routing: { channels: "critical-human + webhook-mirror", repeatInterval: "30m",
                 groupWindow: null, bypassesQuietHours: true, sendsResolved: true } },
    { name: "warning", response: "timely investigation",
      routing: { channels: "non-paging ops", repeatInterval: null,
                 groupWindow: "15m", bypassesQuietHours: false, sendsResolved: true } },
    { name: "info", response: "digest-only awareness",
      routing: { channels: "daily digest 09:00 estate-tz", repeatInterval: null,
                 groupWindow: null, bypassesQuietHours: false, sendsResolved: false } },
  ],
  webhookMirror: { critical: "always", warning: "if-selected", info: "never" },
} as const satisfies SeverityTaxonomy;

/** Default history-strip range (settles OQ-T3 — the alerts.firing catalog default). */
export const DEFAULT_HISTORY_RANGE: RangeId = "24h";
