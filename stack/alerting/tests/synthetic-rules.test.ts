// stack/alerting/tests/synthetic-rules.test.ts
// Tier-A unit tests for the synthetic-check (Gatus) rule builder (issue #1): selection (ingress,
// suppression, enabled), thresholds → fire/clear windows and counts, the HOLD term, PromQL + template
// escaping, determinism, the endpoint-name single source of truth shared with the renderer, and the
// advisory IGNORED_ALERT_FIELD findings.
/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { gatusEndpointName } from "@pulse/renderer";
import {
  buildSyntheticRules,
  formatDuration,
  promqlString,
  syntheticExpr,
  templateLiteral,
} from "../src/transform/synthetic-rules.js";
import type { AlertingFinding } from "../src/transform/findings.js";
import type { EstateModel, Service } from "../src/transform/estate.js";

const PROV = { file: "estate.yaml", path: "services", line: 1, col: 1 } as const;

function svc(over: Partial<Service> & Pick<Service, "name" | "host">): Service {
  return { kind: "http", managed: true, provenance: PROV, ...over };
}

function estate(services: Service[]): EstateModel {
  return {
    schemaMajor: 1,
    estate: {
      name: "synthetic-fixture",
      domains: ["example.com"],
      timezone: "UTC",
      deadmanHook: "${PULSE_DEADMANSSWITCH_URL}",
      provenance: PROV,
    },
    hosts: [],
    services,
    channels: [],
    routingOverrides: [],
    suppressions: [],
  };
}

interface Rule {
  alert: string;
  expr: string;
  keep_firing_for?: string;
  for?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

function rulesOf(yaml: string): Rule[] {
  const doc = parse(yaml) as { groups: Array<{ name: string; rules: Rule[] }> };
  return doc.groups.flatMap((g) => g.rules);
}

function build(services: Service[]): { yaml: string; findings: AlertingFinding[] } {
  const findings: AlertingFinding[] = [];
  return { yaml: buildSyntheticRules(estate(services), findings), findings };
}

/** The rendered expression for web-01/portal with default thresholds (F=3, S=2). */
const DEFAULT_EXPR =
  '((sum by (name, group) (increase(gatus_results_total{name="web-01/portal",group="web-01",success="false"}[12m])) >= 3) unless on (name, group) (sum by (name, group) (increase(gatus_results_total{name="web-01/portal",group="web-01",success="true"}[3m])) > 0)) or on (name, group) (max by (name, group) (time() - timestamp(ALERTS{alertname="GatusCheckFailed",alertstate="firing",name="web-01/portal",group="web-01"}) < 90) unless on (name, group) ((sum by (name, group) (increase(gatus_results_total{name="web-01/portal",group="web-01",success="true"}[3m])) >= 2) unless on (name, group) (sum by (name, group) (increase(gatus_results_total{name="web-01/portal",group="web-01",success="false"}[3m])) > 0)))';

const PORTAL = svc({
  name: "portal",
  host: "web-01",
  ingressUrl: "https://portal.example/",
  alerts: [{ type: "custom" }],
});

describe("buildSyntheticRules — the rendered rule", () => {
  test("emits the canonical rule byte-for-byte for a default binding", () => {
    const { yaml, findings } = build([PORTAL]);
    expect(findings).toEqual([]);
    expect(yaml).toBe(
      [
        "groups:",
        "  - interval: 1m",
        "    name: synthetic-checks",
        "    rules:",
        "      - alert: GatusCheckFailed",
        "        annotations:",
        "          runbook_url: https://runbooks.pulse.local/synthetic",
        "          summary: Gatus check web-01/portal is failing",
        "          url: https://portal.example/",
        "        expr: " + DEFAULT_EXPR,
        "        labels:",
        "          endpoint: web-01/portal",
        "          group: web-01",
        "          severity: critical",
        "          source: gatus",
        "",
      ].join("\n"),
    );
  });

  test("carries the binding's description as an annotation", () => {
    const { yaml } = build([
      svc({ ...PORTAL, alerts: [{ type: "custom", description: "Portal is down" }] }),
    ]);
    expect(rulesOf(yaml)[0]!.annotations.description).toBe("Portal is down");
  });

  test("the endpoint label/selector use the renderer's gatusEndpointName (one source of truth)", () => {
    const [rule] = rulesOf(build([PORTAL]).yaml);
    const name = gatusEndpointName(PORTAL);
    expect(rule!.labels.endpoint).toBe(name);
    expect(rule!.expr).toContain(`name=${promqlString(name)},group=${promqlString(PORTAL.host)}`);
  });
});

describe("buildSyntheticRules — selection", () => {
  test("no ingressUrl, suppressed, no binding, or all bindings disabled → no rule", () => {
    const { yaml } = build([
      svc({ name: "no-ingress", host: "h", alerts: [{ type: "custom" }] }),
      svc({
        name: "suppressed",
        host: "h",
        ingressUrl: "https://s.example/",
        alerts: [{ type: "custom" }],
        suppressed: { class: "known-expected", rationale: "decommissioning" },
      }),
      svc({ name: "unbound", host: "h", ingressUrl: "https://u.example/" }),
      svc({
        name: "disabled",
        host: "h",
        ingressUrl: "https://d.example/",
        alerts: [{ type: "custom", enabled: false }],
      }),
    ]);
    expect(yaml).toBe("groups: []\n");
  });

  test("type selects nothing: any type, and enabled: true, both render", () => {
    const { yaml } = build([
      svc({ name: "a", host: "h", ingressUrl: "https://a.example/", alerts: [{ type: "gatus" }] }),
      svc({
        name: "b",
        host: "h",
        ingressUrl: "https://b.example/",
        alerts: [{ type: "custom", enabled: true }],
      }),
    ]);
    expect(rulesOf(yaml).map((r) => r.labels.endpoint)).toEqual(["h/a", "h/b"]);
  });

  test("a disabled first binding falls through to the first enabled one", () => {
    const { yaml } = build([
      svc({
        ...PORTAL,
        alerts: [
          { type: "custom", enabled: false, failureThreshold: 9 },
          { type: "custom", failureThreshold: 4 },
        ],
      }),
    ]);
    expect(rulesOf(yaml)[0]!.expr).toContain("[16m])) >= 4)");
  });

  test("rules are sorted by endpoint name regardless of estate order (determinism)", () => {
    const services = [
      svc({ name: "zeta", host: "b-host", ingressUrl: "https://z.example/", alerts: [{ type: "x" }] }),
      svc({ name: "alpha", host: "b-host", ingressUrl: "https://a.example/", alerts: [{ type: "x" }] }),
      svc({ name: "mid", host: "a-host", ingressUrl: "https://m.example/", alerts: [{ type: "x" }] }),
    ];
    const forward = build(services).yaml;
    const reversed = build([...services].reverse()).yaml;
    expect(forward).toBe(reversed);
    expect(rulesOf(forward).map((r) => r.labels.endpoint)).toEqual([
      "a-host/mid",
      "b-host/alpha",
      "b-host/zeta",
    ]);
  });
});

describe("buildSyntheticRules — thresholds", () => {
  const withBinding = (b: Partial<NonNullable<Service["alerts"]>[number]>): Rule =>
    rulesOf(build([svc({ ...PORTAL, alerts: [{ type: "custom", ...b }] })]).yaml)[0]!;
  /** Every `[window]` in the expression, in order: fail-count, no-pass, clear-pass, clear-fail. */
  const windows = (r: Rule): string[] => r.expr.match(/\[(\w+)\]/g) ?? [];

  test("defaults F=3/S=2: ≥3 failures in 12m, no pass in 3m; clear = ≥2 passes, no failure in 3m", () => {
    const rule = withBinding({});
    expect(windows(rule)).toEqual(["[12m]", "[3m]", "[3m]", "[3m]"]);
    expect(rule.expr).toContain(")) >= 3)");
    expect(rule.expr).toContain(")) >= 2)");
    expect(rule.keep_firing_for).toBeUndefined();
    expect(rule.for).toBeUndefined();
  });

  test("failureThreshold F → ≥F failures in a 4·F-minute window, no pass in F minutes", () => {
    const rule = withBinding({ failureThreshold: 5 });
    expect(windows(rule).slice(0, 2)).toEqual(["[20m]", "[5m]"]);
    expect(rule.expr).toContain(")) >= 5)");
    expect(windows(withBinding({ failureThreshold: 1 })).slice(0, 2)).toEqual(["[4m]", "[1m]"]);
  });

  test("successThreshold S → ≥S passes and no failure in (S+1) minutes", () => {
    const rule = withBinding({ successThreshold: 4 });
    expect(windows(rule).slice(2)).toEqual(["[5m]", "[5m]"]);
    expect(rule.expr).toContain(")) >= 4)");
    expect(windows(withBinding({ successThreshold: 1 })).slice(2)).toEqual(["[2m]", "[2m]"]);
  });

  test("the HOLD term reads only fresh firing state of this exact alert", () => {
    expect(withBinding({}).expr).toContain(
      'time() - timestamp(ALERTS{alertname="GatusCheckFailed",alertstate="firing",name="web-01/portal",group="web-01"}) < 90',
    );
  });
});

describe("buildSyntheticRules — escaping", () => {
  test("PromQL label values escape backslash, quote and newline", () => {
    expect(promqlString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
    expect(syntheticExpr('h/x"y', "g\\1", { failures: 3, successes: 2 })).toContain(
      'name="h/x\\"y",group="g\\\\1",success="false"',
    );
  });

  test("template delimiters in estate-supplied text are neutralized", () => {
    expect(templateLiteral("plain")).toBe("plain");
    expect(templateLiteral("a {{ $value }} b")).toBe('a {{ "{{" }} $value {{ "}}" }} b');
    const [rule] = rulesOf(
      build([svc({ ...PORTAL, alerts: [{ type: "custom", description: "see {{x}}" }] })]).yaml,
    );
    expect(rule!.annotations.description).toBe('see {{ "{{" }}x{{ "}}" }}');
  });

  test("formatDuration renders whole minutes as m, otherwise s", () => {
    expect(formatDuration(180)).toBe("3m");
    expect(formatDuration(90)).toBe("90s");
  });
});

describe("buildSyntheticRules — advisory findings", () => {
  test("sendOnResolved: false → one IGNORED_ALERT_FIELD inconsistency; the rule still renders", () => {
    const { yaml, findings } = build([
      svc({ ...PORTAL, alerts: [{ type: "custom", sendOnResolved: false }] }),
    ]);
    expect(findings.length).toBe(1);
    expect(findings[0]!.severity).toBe("inconsistency");
    expect(findings[0]!.code).toBe("IGNORED_ALERT_FIELD");
    expect(findings[0]!.path).toBe("services[name=portal].alerts[0].send_on_resolved");
    expect(findings[0]!.fix).toContain("send_resolved");
    expect(rulesOf(yaml).length).toBe(1);
  });

  test("sendOnResolved: true or omitted → no finding", () => {
    expect(build([svc({ ...PORTAL, alerts: [{ type: "c", sendOnResolved: true }] })]).findings).toEqual([]);
    expect(build([PORTAL]).findings).toEqual([]);
  });

  test("several enabled bindings → the first wins, with an advisory finding", () => {
    const { yaml, findings } = build([
      svc({
        ...PORTAL,
        alerts: [
          { type: "custom", failureThreshold: 2 },
          { type: "custom", failureThreshold: 6 },
        ],
      }),
    ]);
    expect(rulesOf(yaml)[0]!.expr).toContain("[8m])) >= 2)");
    expect(findings.map((f) => [f.code, f.severity, f.path])).toEqual([
      ["IGNORED_ALERT_FIELD", "inconsistency", "services[name=portal].alerts"],
    ]);
  });

  test("never emits an error-severity finding (cannot trip whole-or-nothing)", () => {
    const { findings } = build([
      svc({
        ...PORTAL,
        alerts: [
          { type: "custom", sendOnResolved: false },
          { type: "custom", sendOnResolved: false },
        ],
      }),
    ]);
    expect(findings.length).toBe(3);
    expect(findings.some((f) => f.severity === "error")).toBe(false);
  });
});
