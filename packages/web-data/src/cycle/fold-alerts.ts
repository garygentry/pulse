// packages/web-data/src/cycle/fold-alerts.ts — the pure alerts fold
// (04-cycle-and-current-view-folds.md §8). Projects the captured Alertmanager and vmalert
// records into `AlertsPayload`: every AM alert in firing/silenced/inhibited state, every
// vmalert rule (including inactive and deadman/canary rules), and active silences. AM and
// vmalert carry independent availability; a failed source retains its stale last-good set
// (never an empty current set) and its governing availability records `stale`/`unavailable`
// so nothing silently reads as healthy. The fold is pure: it reads only its inputs, makes
// no source or history call, and applies deterministic contract ordering.

import type {
  ActiveAlert,
  ActiveSilence,
  AlertsPayload,
  HistoryRef,
  RuleState,
} from "../wire/alerts.js";
import type { DataAvailability } from "../wire/common.js";
import type {
  AlertmanagerAlert,
  AlertmanagerSilence,
} from "../sources/alertmanager.js";
import type { VmalertRuleGroup } from "../sources/vmalert.js";
import type { FoldInputs } from "./records.js";
import { effectiveData, sourceAvailability } from "./records.js";
import { candidateFromAlertLabels, resolveCandidate, toTargetIdentity } from "./target-match.js";

/** Deterministic code-point string comparison used by every stable order below. */
function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort rank for Alertmanager delivery state (firing before silenced before inhibited). */
function stateRank(state: AlertmanagerAlert["state"]): number {
  return state === "firing" ? 0 : state === "silenced" ? 1 : 2;
}

/** Sort rank for severity (critical before warning before info before any other value). */
function severityRank(severity: string): number {
  return severity === "critical" ? 0 : severity === "warning" ? 1 : severity === "info" ? 2 : 3;
}

/** Parse an ISO instant to epoch millis, or `+Infinity` when unparseable (sorts last). */
function startMillis(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Combine two governing availabilities into the worse of the two so a single source's
 * degradation surfaces in the shared section availability. Ranks `current` best and
 * `unavailable` worst; ties keep the first (primary) availability.
 */
function worseAvailability(a: DataAvailability, b: DataAvailability): DataAvailability {
  const rank = (s: DataAvailability["state"]): number =>
    s === "current" ? 0 : s === "stale" ? 1 : s === "not-configured" ? 2 : 3;
  return rank(b.state) > rank(a.state) ? b : a;
}

/** Map one Alertmanager alert to its wire {@link ActiveAlert} with attribution and history ref. */
function toActiveAlert(alert: AlertmanagerAlert, inputs: FoldInputs): ActiveAlert {
  const target = toTargetIdentity(
    resolveCandidate(inputs.model, candidateFromAlertLabels(alert.labels)),
  );
  const historyRef: HistoryRef = { queryId: "alerts.firing", target };
  const ack = inputs.acks?.get(alert.fingerprint);
  return {
    fingerprint: alert.fingerprint,
    state: alert.state,
    severity: alert.severity,
    name: alert.name,
    target,
    startsAt: alert.startsAt,
    labels: alert.labels,
    annotations: alert.annotations,
    receivers: alert.receivers,
    silencedBy: alert.silencedBy,
    inhibitedBy: alert.inhibitedBy,
    group: alert.group,
    historyRef,
    // REQ-ACK-02/07: joined only when a record exists — never `ack: null`/`undefined` (additive).
    // Fresh object: the wire value never aliases store state; `by` is displayName only (SEC-06).
    ...(ack !== undefined ? { ack: { by: ack.by, at: ack.at, note: ack.note } } : {}),
  };
}

/** Flatten vmalert groups into wire {@link RuleState}s, preserving group/family attribution. */
function toRuleStates(groups: readonly VmalertRuleGroup[]): RuleState[] {
  const out: RuleState[] = [];
  for (const group of groups) {
    for (const rule of group.rules) {
      out.push({
        group: group.group,
        family: group.family,
        name: rule.name,
        state: rule.state,
        health: rule.health,
        lastEvaluationAt: rule.lastEvaluationAt,
        lastError: rule.lastError,
        deadman: rule.deadman,
      });
    }
  }
  return out;
}

/** Map one Alertmanager silence to its wire {@link ActiveSilence}. */
function toActiveSilence(silence: AlertmanagerSilence): ActiveSilence {
  return {
    id: silence.id,
    matchers: silence.matchers,
    createdBy: silence.createdBy,
    comment: silence.comment,
    startsAt: silence.startsAt,
    endsAt: silence.endsAt,
    state: silence.state,
  };
}

/**
 * Fold the captured records into the alerts view payload (§8). Returns every AM alert,
 * every vmalert rule, and active silences (state `active` or `pending`, never expired) with
 * exact model attribution, history references, independent availability, and deterministic
 * ordering. Pure and total over valid inputs; performs no source or history call.
 *
 * @param inputs - The captured model/artifacts, source records, and stamping metadata.
 * @returns The materialized {@link AlertsPayload}.
 */
export function foldAlerts(inputs: FoldInputs): AlertsPayload {
  const { records } = inputs;

  const alertsAvail = sourceAvailability(records["alertmanager-alerts"], "alertmanager-alerts");
  const silencesAvail = sourceAvailability(
    records["alertmanager-silences"],
    "alertmanager-silences",
  );
  const vmalertAvail = sourceAvailability(records["vmalert-rules"], "vmalert-rules");

  const effectiveAlerts = effectiveData(records["alertmanager-alerts"]);
  const effectiveSilences = effectiveData(records["alertmanager-silences"]);
  const effectiveRules = effectiveData(records["vmalert-rules"]);

  const alerts = (effectiveAlerts?.data ?? [])
    .map((alert) => toActiveAlert(alert, inputs))
    .sort(
      (a, b) =>
        stateRank(a.state) - stateRank(b.state) ||
        severityRank(a.severity) - severityRank(b.severity) ||
        startMillis(a.startsAt) - startMillis(b.startsAt) ||
        compareString(a.fingerprint, b.fingerprint),
    );

  const rules = toRuleStates(effectiveRules?.data ?? []).sort(
    (a, b) =>
      compareString(a.group, b.group) ||
      compareString(a.family, b.family) ||
      compareString(a.name, b.name),
  );

  const silences = (effectiveSilences?.data ?? [])
    .filter((silence) => silence.state !== "expired")
    .map(toActiveSilence)
    .sort(
      (a, b) => startMillis(a.startsAt) - startMillis(b.startsAt) || compareString(a.id, b.id),
    );

  return {
    generatedAt: inputs.observedAt,
    alertmanager: worseAvailability(alertsAvail, silencesAvail),
    vmalert: vmalertAvail,
    alerts,
    rules,
    silences,
  };
}
