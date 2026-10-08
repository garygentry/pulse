// stack/alerting/src/transform/synthetic-rules.ts
// The synthetic-check (Gatus) rule family (issue #1). For each service whose ingress Gatus check
// carries an enabled `alerts:` binding, emit ONE critical `GatusCheckFailed` rule over Gatus's own
// `gatus_results_total` counter. This replaces the retired Gatus→Alertmanager push provider, which
// never set `endsAt` (so a resolve re-fired the alert) and sent TRIGGERED only once (so any outage
// longer than Alertmanager's `resolve_timeout` auto-resolved with a false "resolved"). vmalert
// re-sends a firing alert every evaluation and resolves it properly, so neither failure mode exists.
//
// Reads the estate model (not the rendered gatus/config.yaml): the selection mirrors the renderer's
// ingress-endpoint selection, and the endpoint name comes from the renderer's own
// `gatusEndpointName`, so a check and the rule that pages on it cannot drift apart.
import { gatusEndpointName } from "@pulse/renderer";
import { GATUS_CHECKS, METRICS, RUNBOOK_SLUGS, runbookUrl } from "../constants.js";
import type { EstateModel, Service } from "./estate.js";
import type { AlertingFinding } from "./findings.js";
import { serializeRuleGroups, type AlertRuleYaml } from "./rules-yaml.js";

const GROUP = "synthetic-checks";
const ALERT = "GatusCheckFailed"; // kept from the retired provider so routing/silences/UI carry over
/** Runbook link shared by every synthetic-check rule. */
const SYNTHETIC_RUNBOOK = runbookUrl(RUNBOOK_SLUGS.synthetic);

/** A service whose ingress check renders (has `ingressUrl`, not suppressed). */
type CheckedService = Service & { ingressUrl: string };

/** Quote `value` as a PromQL double-quoted string literal (backslash, quote and newline escaped). */
export function promqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/**
 * Make an estate-supplied value inert under vmalert's Go-template expansion of labels and
 * annotations: each `{{` / `}}` becomes a template action that prints it literally. A plain value
 * passes through unchanged.
 */
export function templateLiteral(value: string): string {
  return value.replace(/\{\{|\}\}/g, (delim) => `{{ "${delim}" }}`);
}

/** Whole seconds → a Prometheus duration (`180` → `"3m"`, `90` → `"90s"`). */
export function formatDuration(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}

/** The windows and thresholds one rule is rendered with (see `GATUS_CHECKS`). */
export interface SyntheticTiming {
  /** F — failed checks needed to fire. */
  failures: number;
  /** S — passing checks needed to resolve. */
  successes: number;
}

/**
 * The `GatusCheckFailed` expression for one Gatus endpoint (`name` + `group`), built from named
 * parts. For the defaults (F=3, S=2) it renders, with <id> = `name="<n>",group="<g>"`:
 *
 *   FIRE  = ALL_FAILED[210s] or on (name, group) ALL_FAILED[12m]
 *   ALL_FAILED[w] = (sum by (name, group) (increase(gatus_results_total{<id>,success="false"}[w])) >= 3)
 *         unless on (name, group) (sum by (name, group) (increase(gatus_results_total{<id>,success="true"}[w])) > 0)
 *   FIRING = max by (name, group) (time() - timestamp(ALERTS{alertname="GatusCheckFailed",alertstate="firing",<id>}) < 330)
 *   CLEAR = (sum by (name, group) (increase(gatus_results_total{<id>,success="true"}[4m])) >= 2)
 *         unless on (name, group) (sum by (name, group) (increase(gatus_results_total{<id>,success="false"}[4m])) > 0)
 *   expr  = (FIRE) or on (name, group) (FIRING unless on (name, group) (CLEAR))
 *
 * Semantics:
 *  - FIRE: within ONE window, ≥ F failed checks and no passing check. The nominal window
 *    (F·I + slack) fires at about the F-th consecutive failure; the slow window (4·F·I) still finds
 *    F failures when a broad outage slows Gatus, so slow checks fire later instead of never.
 *    Counting failures (`>= F`, not `> 0`) keeps the threshold after a Gatus restart: VictoriaMetrics'
 *    increase() counts a new series' first sample. Requiring zero passes in the same window means
 *    old failures separated from new ones by a pass never add up.
 *  - FIRING: the alert is already firing — read back from the ALERTS series vmalert remote-writes
 *    (a sample up to 330s old counts, so a few failed evaluations don't drop the hold).
 *  - CLEAR: within the clear window, ≥ S passing checks and no failed check. While FIRING it keeps
 *    firing until CLEAR; with no fresh results (Gatus down) nothing is clear, so it never
 *    false-resolves, and a pass between failures doesn't resolve it.
 *
 * Every part is aggregated `by (name, group)`, so the alert's label set is the same whichever part
 * holds it (a stable alert identity), and equal names in different groups stay independent.
 *
 * Residual: failures on both sides of a Gatus outage, with no pass recorded within the slow
 * window, can add up to F and fire.
 */
export function syntheticExpr(endpoint: string, group: string, timing: SyntheticTiming): string {
  const C = GATUS_CHECKS;
  const I = C.checkIntervalSeconds;
  const { failures: F, successes: S } = timing;
  const nominalWindow = formatDuration(F * I + C.nominalWindowSlackSeconds);
  const slowWindow = formatDuration(C.slowWindowFactor * F * I);
  const clearWindow = formatDuration(Math.ceil(C.clearWindowFactor * S) * I + I);
  const ids = `name=${promqlString(endpoint)},group=${promqlString(group)}`;
  const count = (success: "true" | "false", window: string): string =>
    `sum by (name, group) (increase(${METRICS.gatusResults}{${ids},success="${success}"}[${window}]))`;
  const failed = (w: string): string => count("false", w);
  const passed = (w: string): string => count("true", w);

  const allFailed = (w: string): string =>
    `(${failed(w)} >= ${F}) unless on (name, group) (${passed(w)} > 0)`;
  const fire = `(${allFailed(nominalWindow)}) or on (name, group) (${allFailed(slowWindow)})`;
  const firing =
    `max by (name, group) (time() - timestamp(ALERTS{alertname="${ALERT}",alertstate="firing",${ids}})` +
    ` < ${C.firingStateMaxAgeSeconds})`;
  const clear = `(${passed(clearWindow)} >= ${S}) unless on (name, group) (${failed(clearWindow)} > 0)`;
  return `(${fire}) or on (name, group) (${firing} unless on (name, group) (${clear}))`;
}

/**
 * Build the synthetic-check rule family for one estate.
 *
 * Selection (one rule per service, sorted by endpoint name for determinism — §3.1): the service has
 * an `ingressUrl`, is not suppressed, and declares an `alerts:` binding with `enabled !== false`.
 * The first enabled binding supplies the thresholds and description; any further enabled binding
 * is ignored with an advisory finding. `type` selects nothing. A binding with
 * `sendOnResolved: false` draws an advisory finding — resolve notifications are governed by the
 * Alertmanager receiver (`send_resolved`), not the binding.
 *
 * Timing: see `syntheticExpr` and `GATUS_CHECKS` (F = `failureThreshold`, default 3;
 * S = `successThreshold`, default 2).
 *
 * @param estate   - The validated estate model.
 * @param findings - Accumulator for the advisory (`inconsistency`) findings; never an error.
 * @returns Byte-deterministic vmalert rule YAML (`groups: []` when nothing is selected).
 */
export function buildSyntheticRules(estate: EstateModel, findings: AlertingFinding[]): string {
  // Ignored-field advisories cover every binding, rendered or not: the field is inert either way.
  for (const service of estate.services) {
    (service.alerts ?? []).forEach((binding, i) => {
      if (binding.sendOnResolved !== false) return;
      findings.push({
        severity: "inconsistency",
        code: "IGNORED_ALERT_FIELD",
        file: service.provenance.file,
        path: `services[name=${service.name}].alerts[${i}].send_on_resolved`,
        message:
          `Service '${service.name}' sets send_on_resolved: false, which has no effect: Gatus checks ` +
          "page through a vmalert rule, and resolve notifications follow each Alertmanager " +
          "receiver's send_resolved setting.",
        fix:
          `Drop send_on_resolved from service '${service.name}'. To silence resolve notifications, ` +
          "configure send_resolved on the receiving channel.",
      });
    });
  }

  const selected = estate.services
    .filter(
      (s): s is CheckedService => s.ingressUrl !== undefined && s.suppressed === undefined,
    )
    .map((service) => ({ service, endpoint: gatusEndpointName(service) }))
    .sort((a, b) => (a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0)); // §3.1

  const rules: AlertRuleYaml[] = [];
  for (const { service, endpoint } of selected) {
    const enabled = (service.alerts ?? []).filter((b) => b.enabled !== false);
    const binding = enabled[0];
    if (binding === undefined) continue; // no binding, or every binding disabled → no paging
    if (enabled.length > 1) {
      findings.push({
        severity: "inconsistency",
        code: "IGNORED_ALERT_FIELD",
        file: service.provenance.file,
        path: `services[name=${service.name}].alerts`,
        message:
          `Service '${service.name}' declares ${enabled.length} enabled alerts: bindings; only the ` +
          "first is used (one GatusCheckFailed rule per check).",
        fix: `Keep a single enabled alerts: binding on service '${service.name}'.`,
      });
    }

    const failures = binding.failureThreshold ?? GATUS_CHECKS.defaultFailureThreshold;
    const successes = binding.successThreshold ?? GATUS_CHECKS.defaultSuccessThreshold;
    const name = templateLiteral(endpoint);

    rules.push({
      alert: ALERT,
      expr: syntheticExpr(endpoint, service.host, { failures, successes }),
      // The label set the retired provider posted, so routing, inhibition, silences and the web
      // UI's endpoint matching are unchanged. The expression adds `name` (= endpoint); vmalert adds
      // `alertgroup` and the `estate` external label.
      labels: {
        severity: "critical",
        source: "gatus",
        endpoint: name,
        group: templateLiteral(service.host),
      },
      annotations: {
        summary: `Gatus check ${name} is failing`,
        ...(binding.description !== undefined
          ? { description: templateLiteral(binding.description) }
          : {}),
        url: templateLiteral(service.ingressUrl),
        runbook_url: SYNTHETIC_RUNBOOK,
      },
    });
  }
  // Pin the evaluation interval: the HOLD term's freshness bound assumes one evaluation per minute.
  const interval = formatDuration(GATUS_CHECKS.evaluationIntervalSeconds);
  return serializeRuleGroups([{ name: GROUP, interval, rules }]);
}
