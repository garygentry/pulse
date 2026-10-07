// src/client/views/alerts/routing-explain.ts — derive a read-only routing intent from the vendored
// taxonomy (04 §5.1, REQ-DETAIL-02/03, OQ-02 settled).
//
// Pure, no I/O: imports ONLY the vendored SEVERITY_TAXONOMY const, never the source JSON (CON-08).
// The taxonomy has no `receivers`/`urgency` field — the intent is the routing POLICY; Routing.tsx
// reconciles it against the alert's actual ActiveAlert.receivers.
import { SEVERITY_TAXONOMY } from "./taxonomy.js";
import type { SeverityRouting } from "./taxonomy.js";

/** The webhook-mirror policy value, keyed by the three taxonomy severities. */
export type WebhookMirrorPolicy = "always" | "if-selected" | "never";

/**
 * The severity's routing intent, derived from SEVERITY_TAXONOMY. `matched` is false when the alert's
 * (free-form) severity is not one of the taxonomy's severities — in which case every derived field is
 * null and the UI shows "no routing policy for this severity". No throws; total over any string.
 */
export interface RoutingIntent {
  /** The alert's raw severity string (echoed for display). */
  readonly severity: string;
  /** True iff `severity` matches a taxonomy `severities[].name`. */
  readonly matched: boolean;
  /** Human response guidance (SeverityEntry.response), or null when unmatched. */
  readonly response: string | null;
  /** The full routing policy (SeverityRouting), or null when unmatched. */
  readonly routing: SeverityRouting | null;
  /** Webhook-mirror policy for this severity, or null when unmatched. */
  readonly webhookMirror: WebhookMirrorPolicy | null;
  /** The taxonomy contract version the intent was derived from (for display/audit). */
  readonly contractVersion: number;
}

const MIRROR_KEYS = ["critical", "warning", "info"] as const;
type MirrorKey = (typeof MIRROR_KEYS)[number];
function isMirrorKey(s: string): s is MirrorKey {
  return (MIRROR_KEYS as readonly string[]).includes(s);
}

/**
 * Derive the routing intent for a (free-form) severity string. Unknown severities return a
 * fully-null, `matched: false` intent.
 */
export function explainRouting(severity: string): RoutingIntent {
  const entry = SEVERITY_TAXONOMY.severities.find((s) => s.name === severity) ?? null;
  const webhookMirror = isMirrorKey(severity) ? SEVERITY_TAXONOMY.webhookMirror[severity] : null;
  return {
    severity,
    matched: entry !== null,
    response: entry?.response ?? null,
    routing: entry?.routing ?? null,
    webhookMirror,
    contractVersion: SEVERITY_TAXONOMY.contractVersion,
  };
}
