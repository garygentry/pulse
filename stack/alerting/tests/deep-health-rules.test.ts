// stack/alerting/tests/deep-health-rules.test.ts
// Tier-A unit tests for the functional deep-health rule builder (03 §4): the bind example, the
// §4.4 golden byte-for-byte, and the INVALID_RULE findings (bad name / empty expr / unbound expr).
/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import {
  bindDeepHealthExpression,
  buildDeepHealthRules,
  parseDeepHealthName,
} from "../src/transform/deep-health-rules.js";
import type { AlertingFinding } from "../src/transform/findings.js";
import type { ProberConfigRendered } from "../src/transform/rendered.js";

describe("bindDeepHealthExpression", () => {
  test("binds a single metric to the scoped selector (acceptance example)", () => {
    expect(
      bindDeepHealthExpression("camera_count < 6", { camera_count: "$.x" }, "cameras"),
    ).toBe('pulse_deep_health{service="cameras",metric="camera_count"} < 6');
  });

  test("longest-first replacement prevents a short name corrupting a longer one", () => {
    // `count` must NOT match inside the substituted `metric="camera_count"` selector.
    const out = bindDeepHealthExpression(
      "camera_count < 6 and count > 0",
      { camera_count: "$.a", count: "$.b" },
      "cameras",
    );
    expect(out).toBe(
      'pulse_deep_health{service="cameras",metric="camera_count"} < 6 and pulse_deep_health{service="cameras",metric="count"} > 0',
    );
  });

  test("an expression referencing no mapped metric is returned unchanged", () => {
    expect(bindDeepHealthExpression("vector(0) > 1", { camera_count: "$.x" }, "cameras")).toBe(
      "vector(0) > 1",
    );
  });
});

describe("parseDeepHealthName", () => {
  test("parses svc:<host>/<service>", () => {
    expect(parseDeepHealthName("svc:edge-01/cameras")).toEqual({
      host: "edge-01",
      service: "cameras",
    });
  });

  test("returns null for a malformed name", () => {
    expect(parseDeepHealthName("cameras")).toBeNull();
  });
});

describe("buildDeepHealthRules", () => {
  test("emits the §4.4 golden byte-for-byte", () => {
    const prober: ProberConfigRendered = {
      probes: [
        {
          name: "svc:edge-01/cameras",
          target: "http://edge-01.local/health",
          kind: "deep-health",
          responseMapping: { "camera_count": "$.cameras.online" },
          alertExpression: "camera_count < 6",
        },
      ],
    };
    const findings: AlertingFinding[] = [];
    const out = buildDeepHealthRules(prober, findings);
    const expected =
      "groups:\n" +
      "  - name: deep-health-functional\n" +
      "    rules:\n" +
      "      - alert: DeepHealthFailed\n" +
      "        annotations:\n" +
      "          description: Declared deep-health expression is failing for service {{ $labels.service }} on host {{ $labels.host }} in estate {{ $labels.estate }}.\n" +
      "          runbook_url: https://runbooks.pulse.local/deep-health\n" +
      "          summary: Deep-health functional check failed for {{ $labels.service }}\n" +
      '        expr: pulse_deep_health{service="cameras",metric="camera_count"} < 6\n' +
      "        for: 2m\n" +
      "        labels:\n" +
      "          severity: critical\n";
    expect(out).toBe(expected);
    expect(findings).toEqual([]);
  });

  test("filters non-deep-health kinds and sorts by name (determinism)", () => {
    const prober: ProberConfigRendered = {
      probes: [
        {
          name: "svc:edge-02/sensors",
          target: "t",
          kind: "deep-health",
          responseMapping: { "sensor_count": "$.n" },
          alertExpression: "sensor_count < 3",
        },
        { name: "svc:db-01/postgres#backup", target: "t", kind: "backup-freshness", threshold: "24h" },
        {
          name: "svc:edge-01/cameras",
          target: "t",
          kind: "deep-health",
          responseMapping: { "camera_count": "$.c" },
          alertExpression: "camera_count < 6",
        },
      ],
    };
    const findings: AlertingFinding[] = [];
    const out = buildDeepHealthRules(prober, findings);
    // edge-01/cameras sorts before edge-02/sensors; backup entry is excluded.
    expect(out.indexOf('metric="camera_count"')).toBeLessThan(out.indexOf('metric="sensor_count"'));
    expect(out).not.toContain("backup");
    expect(findings).toEqual([]);
  });

  test("determinism: identical input → byte-identical output", () => {
    const mk = (): ProberConfigRendered => ({
      probes: [
        {
          name: "svc:edge-01/cameras",
          target: "t",
          kind: "deep-health",
          responseMapping: { "camera_count": "$.c" },
          alertExpression: "camera_count < 6",
        },
      ],
    });
    expect(buildDeepHealthRules(mk(), [])).toBe(buildDeepHealthRules(mk(), []));
  });

  test("INVALID_RULE for an unparseable entry name", () => {
    const findings: AlertingFinding[] = [];
    const out = buildDeepHealthRules(
      { probes: [{ name: "bogus", target: "t", kind: "deep-health", alertExpression: "x < 1" }] },
      findings,
    );
    expect(out).toBe("groups: []\n");
    expect(findings).toHaveProperty("length");
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("INVALID_RULE");
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.file).toBe("rendered/prober/config.yaml");
    expect(findings[0]!.path).toBe("probes[name=bogus]");
    expect(findings[0]!.fix.length).toBeGreaterThan(0);
  });

  test("INVALID_RULE for an empty alertExpression", () => {
    const findings: AlertingFinding[] = [];
    buildDeepHealthRules(
      {
        probes: [
          { name: "svc:edge-01/cameras", target: "t", kind: "deep-health", alertExpression: "  " },
        ],
      },
      findings,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("INVALID_RULE");
    expect(findings[0]!.path).toBe("probes[name=svc:edge-01/cameras].alertExpression");
  });

  test("INVALID_RULE for an expression that binds nothing while a responseMapping exists", () => {
    const findings: AlertingFinding[] = [];
    buildDeepHealthRules(
      {
        probes: [
          {
            name: "svc:edge-01/cameras",
            target: "t",
            kind: "deep-health",
            responseMapping: { "camera_count": "$.c" },
            alertExpression: "vector(0) > 1",
          },
        ],
      },
      findings,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("INVALID_RULE");
    expect(findings[0]!.path).toBe("probes[name=svc:edge-01/cameras].alertExpression");
  });

  test("no finding message contains the ignored credential (secret safety)", () => {
    const findings: AlertingFinding[] = [];
    buildDeepHealthRules(
      { probes: [{ name: "bogus", target: "t", kind: "deep-health", credential: "op://vault/secret", alertExpression: "x<1" }] },
      findings,
    );
    for (const f of findings) {
      expect(f.message).not.toContain("op://vault/secret");
    }
  });
});
