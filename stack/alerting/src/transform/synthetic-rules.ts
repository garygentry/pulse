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

/**
 * The "every check in the window failed" expression for one Gatus endpoint: at least one failed
 * result in the last `window`, and no successful one. A healthy endpoint has no `success="false"`
 * increase, so the left side is empty; a single success in the window empties the result.
 */
export function syntheticExpr(endpoint: string, window: string): string {
  const name = promqlString(endpoint);
  const failed = `increase(${METRICS.gatusResults}{name=${name},success="false"}[${window}])`;
  const passed = `increase(${METRICS.gatusResults}{name=${name},success="true"}[${window}])`;
  return `(sum by (name, group) (${failed}) > 0) unless on (name) (sum by (name) (${passed}) > 0)`;
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
 * Timing: the look-back window is `failureThreshold × GATUS_CHECKS.checkIntervalSeconds`, and
 * `keep_firing_for` is `(successThreshold − 1) × checkIntervalSeconds` (omitted when 0).
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

    const interval = GATUS_CHECKS.checkIntervalSeconds;
    const failures = binding.failureThreshold ?? GATUS_CHECKS.defaultFailureThreshold;
    const successes = binding.successThreshold ?? GATUS_CHECKS.defaultSuccessThreshold;
    const keepFiringSeconds = (successes - 1) * interval;
    const name = templateLiteral(endpoint);

    rules.push({
      alert: ALERT,
      expr: syntheticExpr(endpoint, formatDuration(failures * interval)),
      ...(keepFiringSeconds > 0 ? { keep_firing_for: formatDuration(keepFiringSeconds) } : {}),
      // The exact label set the retired provider posted, so routing, inhibition, silences and the
      // web UI's endpoint matching are unchanged. `estate` is stamped by vmalert's external label.
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
  return serializeRuleGroups([{ name: GROUP, rules }]);
}
