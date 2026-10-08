// stack/alerting/src/transform/findings.ts
// The alerting-local finding taxonomy (00 §5). Structurally mirrors @pulse/core's `Finding`
// (severity/code/file/path/message/fix — note the field is `path`, NOT `field`) with an
// alerting-local, closed code union, so agent tooling that reads core findings reads these too.

/** Finding severity. Mirrors @pulse/core's tri-state, plus alerting's `inconsistency`/`improvement`
 *  advisory levels used by the verifier severity floor. `error` is the only level that aborts the
 *  whole transform (REQ-CONFIG-01). */
export type AlertingFindingSeverity = "error" | "inconsistency" | "improvement";

/** Closed, alerting-local finding codes (REQ-AGENT-01). */
export type AlertingFindingCode =
  | "SECRET_LITERAL" // a literal where a SecretRef belongs (REQ-SEC-01); distinct local member
  | "ROUTING_GAP" // an alert matches no specific route (REQ-ROUTE-04)
  | "NO_HUMAN_CHANNEL" // estate declares no human channel and no webhook-only policy (REQ-ROUTE-05)
  | "WEBHOOK_ONLY_CRITICAL" // informational: critical path is human-less by declared policy (tech-spec §3.2)
  | "INVALID_RULE" // a generated/consumed rule is malformed (REQ-CONFIG-02)
  | "INVALID_ROUTE" // a route/receiver is malformed (REQ-CONFIG-02)
  | "INVALID_SUPPRESSION" // a suppression is malformed (REQ-CONFIG-02)
  | "MISSING_RATIONALE" // a known-expected suppression lacks a rationale (REQ-SUPP-02, invariant 6)
  | "IGNORED_ALERT_FIELD"; // a declared alert-binding field has no effect (advisory, issue #1)

/** A machine-actionable, secret-safe finding (REQ-CONFIG-02, REQ-SEC-02). Structurally mirrors
 *  `@pulse/core` `Finding` (severity/code/file/path/message/fix) with the local code union above. */
export interface AlertingFinding {
  /** Only `error` aborts the transform; `inconsistency`/`improvement` are advisory. */
  severity: AlertingFindingSeverity;
  /** The alerting-local code. */
  code: AlertingFindingCode;
  /** Source location (rule file / routing / suppression) — never a credential (REQ-SEC-02). */
  file: string;
  /** Field path within the source (mirrors `@pulse/core` `Finding.path`, NOT `field`). */
  path: string;
  /** Human-readable message; carries estate/entity names but never secrets or probe bodies (REQ-SEC-02). */
  message: string;
  /** Agent-actionable fix path (REQ-AGENT-01). */
  fix: string;
}
