// packages/web-data/src/wire/alerts.ts — authoritative browser-safe alerts wire
// contracts (01-core-definitions.md §9). Retains explicit Alertmanager delivery state,
// renderer attribution, vmalert rule provenance, and silence lifecycle without any
// unknown, arbitrary-upstream, or secret-bearing field. `generatedAt` is body
// materialization time. All type imports are erased, so `/wire` stays runtime-free.

import type { DataAvailability, HashId } from "./common.js";
import type { TargetIdentity } from "./history.js";

/** Safe history deep link into a target's firing-alert history. */
export interface HistoryRef {
  /** Fixed alert-history query. */ readonly queryId: "alerts.firing";
  /** Exact attributed target, or null for estate-wide/unmatched history. */ readonly target: TargetIdentity | null;
}

/** One validated Alertmanager silence matcher. */
export interface SilenceMatcher {
  /** Bounded label name. */ readonly name: string;
  /** Bounded matcher value. */ readonly value: string;
  /** Whether value is interpreted as a regular expression by Alertmanager. */ readonly isRegex: boolean;
  /** Whether matching is equality (true) or negated (false). */ readonly isEqual: boolean;
}

/** Pulse-local acknowledgement of one alert; carries the actor display name only. */
export interface AlertAck {
  /** Acknowledging actor's display name (never the subject). */ readonly by: string;
  /** Acknowledgement time in UTC. */ readonly at: string;
  /** Trimmed operator note, or null when none was given. */ readonly note: string | null;
}

/** One current Alertmanager alert with delivery state, attribution, and suppression relations. */
export interface ActiveAlert {
  /** Stable Alertmanager fingerprint. */ readonly fingerprint: string;
  /** Current Alertmanager delivery state. */ readonly state: "firing" | "silenced" | "inhibited";
  /** Bounded source severity; unknown values remain explicit strings. */ readonly severity: string;
  /** Bounded alert name. */ readonly name: string;
  /** Renderer attribution, or null when unmatched. */ readonly target: TargetIdentity | null;
  /** Alert start in UTC. */ readonly startsAt: string;
  /** Allowlisted bounded source labels. */ readonly labels: Readonly<Record<string, string>>;
  /** Allowlisted bounded annotations. */ readonly annotations: Readonly<Record<string, string>>;
  /** Matched receiver names in stable order. */ readonly receivers: readonly string[];
  /** Matching silence ids in stable order. */ readonly silencedBy: readonly string[];
  /** Inhibiting alert ids in stable order. */ readonly inhibitedBy: readonly string[];
  /** Normalized group identity, or null when absent. */ readonly group: string | null;
  /** Safe history deep link, or null when attribution/history is unavailable. */ readonly historyRef: HistoryRef | null;
  /** Pulse-local acknowledgement; present only when acknowledged, ABSENT (never null) otherwise (REQ-ACK-02/07). */
  readonly ack?: AlertAck;
}

/** One vmalert rule projection including inactive and deadman/canary rules. */
export interface RuleState {
  /** vmalert group identity. */ readonly group: string;
  /** Rule family/source identity. */ readonly family: string;
  /** Rule name. */ readonly name: string;
  /** Bounded upstream rule state. */ readonly state: string;
  /** Normalized evaluation health. */ readonly health: "healthy" | "unhealthy" | "unknown";
  /** Latest evaluation time in UTC, or null. */ readonly lastEvaluationAt: string | null;
  /** Bounded safe evaluation error, or null. */ readonly lastError: string | null;
  /** Whether this is a configured deadman/canary rule, derived from identity not firing state. */ readonly deadman: boolean;
}

/** One Alertmanager silence with its lifecycle state and validated matchers. */
export interface ActiveSilence {
  /** Alertmanager silence id. */ readonly id: string;
  /** Complete validated matcher set. */ readonly matchers: readonly SilenceMatcher[];
  /** Bounded creator display value. */ readonly createdBy: string;
  /** Bounded operator comment. */ readonly comment: string;
  /** Silence start in UTC. */ readonly startsAt: string;
  /** Silence expiry in UTC. */ readonly endsAt: string;
  /** Current silence lifecycle state. */ readonly state: "active" | "pending" | "expired";
}

/** The alerts view payload: current alerts, rules, and silences with governing evidence. */
export interface AlertsPayload {
  /** Content materialization time in UTC. */ readonly generatedAt: string;
  /** Alertmanager evidence for alerts/silences. */ readonly alertmanager: DataAvailability;
  /** vmalert evidence for rules. */ readonly vmalert: DataAvailability;
  /** Complete current alerts in deterministic order. */ readonly alerts: readonly ActiveAlert[];
  /** Complete current rules in deterministic order. */ readonly rules: readonly RuleState[];
  /** Complete silence records in deterministic order. */ readonly silences: readonly ActiveSilence[];
}
