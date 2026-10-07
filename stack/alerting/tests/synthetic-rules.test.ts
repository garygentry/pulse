// stack/alerting/tests/synthetic-rules.test.ts
// Tier-A unit tests for the synthetic-check (Gatus) rule builder (issue #1): selection (ingress,
// suppression, enabled), threshold defaults → look-back window / keep_firing_for, PromQL + template
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
        "  - name: synthetic-checks",
        "    rules:",
        "      - alert: GatusCheckFailed",
        "        annotations:",
        "          runbook_url: https://runbooks.pulse.local/synthetic",
        "          summary: Gatus check web-01/portal is failing",
        "          url: https://portal.example/",
        '        expr: (sum by (name, group) (increase(gatus_results_total{name="web-01/portal",success="false"}[3m])) > 0) unless on (name) (sum by (name) (increase(gatus_results_total{name="web-01/portal",success="true"}[3m])) > 0)',
        "        keep_firing_for: 1m",
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
    expect(rule!.expr).toContain(`name=${promqlString(name)}`);
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
    expect(rulesOf(yaml)[0]!.expr).toContain("[4m]");
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

  test("defaults: failure 3 → [3m] window; success 2 → keep_firing_for 1m", () => {
    const rule = withBinding({});
    expect(rule.expr.match(/\[(\w+)\]/g)).toEqual(["[3m]", "[3m]"]);
    expect(rule.keep_firing_for).toBe("1m");
    expect(rule.for).toBeUndefined();
  });

  test("failureThreshold N → an N-minute look-back window on both sides", () => {
    expect(withBinding({ failureThreshold: 5 }).expr.match(/\[(\w+)\]/g)).toEqual(["[5m]", "[5m]"]);
    expect(withBinding({ failureThreshold: 1 }).expr.match(/\[(\w+)\]/g)).toEqual(["[1m]", "[1m]"]);
  });

  test("successThreshold N → keep_firing_for (N−1) minutes; 1 → omitted", () => {
    expect(withBinding({ successThreshold: 4 }).keep_firing_for).toBe("3m");
    expect(withBinding({ successThreshold: 1 }).keep_firing_for).toBeUndefined();
  });
});

describe("buildSyntheticRules — escaping", () => {
  test("PromQL label values escape backslash, quote and newline", () => {
    expect(promqlString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
    expect(syntheticExpr('h/x"y', "3m")).toContain('name="h/x\\"y",success="false"');
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
    expect(rulesOf(yaml)[0]!.expr).toContain("[2m]");
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
