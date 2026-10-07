// stack/alerting/src/transform/deep-health-rules.ts
// The critical functional deep-health rule family (03 §4, REQ-AVAIL-02). For each service that
// declares a deep-health probe, emit ONE critical functional rule whose expression is the estate's
// declared `alertExpression`, bound to that service's scoped `pulse_deep_health` series. This owns
// the functional-VALUE rule; `02`'s static `DeepHealthProbeFailed` owns probe-reachability (§4.1).
// Reads NO secret field (`ProberEntry.credential` is ignored — REQ-SEC-01).
import { METRICS, RUNBOOK_SLUGS, runbookUrl } from "../constants.js";
import type { ProberConfigRendered, ProberEntry } from "./rendered.js";
import type { AlertingFinding } from "./findings.js";
import { serializeRuleGroups, type AlertRuleYaml } from "./rules-yaml.js";

const GROUP = "deep-health-functional";
const ALERT = "DeepHealthFailed"; // PascalCase, public convention (REQ-RULE-02)
/** Functional grace: fire only after the expression holds across ~1 scrape cycle. Module-local
 *  (00 §6 owns shared windows; this per-family window is local to the inventory-derived family). */
const FUNCTIONAL_FOR = "2m";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `svc:<host>/<service>` → `{host, service}`, or `null` if the name is not that form. */
export function parseDeepHealthName(name: string): { host: string; service: string } | null {
  const m = /^svc:([^/]+)\/(.+)$/.exec(name);
  return m ? { host: m[1]!, service: m[2]! } : null;
}

/**
 * Bind a declared deep-health expression to one service's `pulse_deep_health` series by replacing
 * each `responseMapping` metric name — the KEY, which is the `metric` label the prober emits — (as a
 * whole PromQL identifier) with the scoped selector `pulse_deep_health{service="<svc>",metric="<name>"}`.
 *
 * Metric names are replaced longest-first so a shorter name cannot corrupt a longer one; the
 * word-boundary guard `(?<![\w:])…(?![\w:])` prevents matching inside an already-substituted
 * selector (e.g. `count` will not match inside `metric="camera_count"`, since `_` is a word char).
 *
 * LIMITATION: this is a token replacement, not a PromQL parser. A metric name (a response_mapping
 * KEY) that collides with a PromQL keyword/function — `sum`, `rate`, `count`, `by`, `on`, … — would
 * be rewritten wherever it appears, including inside a function call, producing invalid PromQL. Keep
 * deep-health metric names to plain, non-reserved identifiers (the emitted `metric` label anyway).
 *
 * @param alertExpression - The declared expression, e.g. `camera_count < 6`.
 * @param responseMapping - metric-name → JSON-path map; its KEYS are the bindable identifiers, and
 *   they are the `metric` label the prober actually emits (`pulse_deep_health{…,metric="<key>"}` —
 *   agent/prober/src/probe.ts sets `samples[<key>]`). Binding on the VALUES (the JSON paths) would
 *   build a selector that never matches the emitted series (issue #10).
 * @param service - The service label value to scope by (unique per estate — REQ-SVC-01).
 * @returns The bound PromQL, e.g. `pulse_deep_health{service="cameras",metric="camera_count"} < 6`.
 */
export function bindDeepHealthExpression(
  alertExpression: string,
  responseMapping: Record<string, string>,
  service: string,
): string {
  const names = [...new Set(Object.keys(responseMapping))].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  let expr = alertExpression;
  for (const name of names) {
    const selector = `${METRICS.deepHealth}{service="${service}",metric="${name}"}`;
    expr = expr.replace(new RegExp(`(?<![\\w:])${escapeRegExp(name)}(?![\\w:])`, "g"), selector);
  }
  return expr;
}

/**
 * Build the deep-health functional rule family for one estate's rendered prober config.
 * Filters `kind: "deep-health"` entries, sorts by name (determinism — §3.1), and emits one
 * critical `DeepHealthFailed` rule per valid entry. Malformed entries push `INVALID_RULE`
 * findings (unparseable name, empty `alertExpression`, or an expression that binds nothing while
 * a `responseMapping` exists) and are skipped.
 */
export function buildDeepHealthRules(
  prober: ProberConfigRendered,
  findings: AlertingFinding[],
): string {
  const entries: ProberEntry[] = prober.probes
    .filter((p) => p.kind === "deep-health")
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // determinism (§3.1)

  const rules: AlertRuleYaml[] = [];
  for (const entry of entries) {
    const parsed = parseDeepHealthName(entry.name);
    if (!parsed) {
      findings.push({
        severity: "error",
        code: "INVALID_RULE",
        file: "rendered/prober/config.yaml",
        path: `probes[name=${entry.name}]`,
        message: `Deep-health probe entry name '${entry.name}' is not of the form svc:<host>/<service>.`,
        fix: "Re-render the prober config; do not hand-edit probe entry names.",
      });
      continue;
    }
    const expression = (entry.alertExpression ?? "").trim();
    if (expression === "") {
      findings.push({
        severity: "error",
        code: "INVALID_RULE",
        file: "rendered/prober/config.yaml",
        path: `probes[name=${entry.name}].alertExpression`,
        message: `Service '${parsed.service}' declares a deep-health probe with no alertExpression.`,
        fix: `Add an alertExpression to service '${parsed.service}' in the estate inventory, then re-render.`,
      });
      continue;
    }
    const mapping = entry.responseMapping ?? {};
    const expr = bindDeepHealthExpression(expression, mapping, parsed.service);
    if (expr === expression && Object.keys(mapping).length > 0) {
      findings.push({
        severity: "error",
        code: "INVALID_RULE",
        file: "rendered/prober/config.yaml",
        path: `probes[name=${entry.name}].alertExpression`,
        message: `Deep-health expression for '${parsed.service}' references no metric from its responseMapping (nothing bound).`,
        fix: `Ensure alertExpression uses a metric name declared in responseMapping for service '${parsed.service}'.`,
      });
      continue;
    }
    rules.push({
      alert: ALERT,
      expr,
      for: FUNCTIONAL_FOR,
      labels: { severity: "critical" }, // host/service/estate propagate from the series (§4.2, §6)
      annotations: {
        summary: "Deep-health functional check failed for {{ $labels.service }}",
        description:
          "Declared deep-health expression is failing for service {{ $labels.service }} on host " +
          "{{ $labels.host }} in estate {{ $labels.estate }}.",
        // Prometheus-style runbook link (issue #16), carried to Alertmanager + Grafana.
        runbook_url: runbookUrl(RUNBOOK_SLUGS.deepHealth),
      },
    });
  }
  return serializeRuleGroups([{ name: GROUP, rules }]);
}
