// stack/alerting/tests/inhibit.test.ts
// Tier-A unit tests for the inhibit-rule fragment (04 §8): the narrow expected-churn scope
// (ONLY ContainerRestarting|ContainerChurn), the DeadMansSwitch un-suppressible guard (REQ-SUPP-04),
// the mandatory-rationale invariant (MISSING_RATIONALE), and malformed-suppression handling
// (INVALID_SUPPRESSION). Exercises the SECRET_LITERAL/INVALID_SUPPRESSION/MISSING_RATIONALE members
// of AlertingFindingCode owned by item 006 (06 §11.3).
/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import {
  buildInhibitRules,
  matcherReferencesDeadman,
  targetAdmitsAlertname,
} from "../src/transform/inhibit.js";
import type {
  EstateModel,
  Host,
  Service,
  Suppression,
} from "../src/transform/estate.js";
import type { AlertingFinding } from "../src/transform/findings.js";

const PROV = { file: "estate.yaml", path: "estate", line: 1, col: 1 } as const;

/** The eight protected families the expected-churn rule must NOT admit (04 §8.2, item 006 AC). */
const PROTECTED = [
  "HostDown",
  "HighCPU",
  "HighMemory",
  "LowDisk",
  "CriticalDisk",
  "BackupStale",
  "BackupCritical",
  "DeepHealthFailed",
] as const;

function managedHost(name: string, over: Partial<Host> = {}): Host {
  return {
    collectionClass: "managed-linux",
    name,
    addresses: [`${name}.local`],
    exporterPorts: [9100],
    commandSignals: [],
    cadvisor: true,
    heartbeat: true,
    deliveryForm: "compose",
    provenance: PROV,
    ...over,
  } as Host;
}

function makeModel(over: Partial<EstateModel> = {}): EstateModel {
  return {
    schemaMajor: 1,
    estate: {
      name: "acme-fictional",
      domains: ["acme.example"],
      timezone: "America/New_York",
      deadmanHook: "${PULSE_DEADMANSSWITCH_URL}",
      provenance: PROV,
    },
    hosts: [],
    services: [],
    channels: [],
    routingOverrides: [],
    suppressions: [],
    ...over,
  };
}

function knownExpected(target: string, rationale: string): Suppression {
  return { class: "known-expected", target, rationale, provenance: PROV };
}

describe("buildInhibitRules — expected-churn scope (REQ-SUPP-03)", () => {
  test("emits ONE host-scoped rule targeting only the churn family", () => {
    const findings: AlertingFinding[] = [];
    const model = makeModel({ hosts: [managedHost("node12", { expectedChurn: true })] });
    const { rules, comments } = buildInhibitRules(model, findings);

    expect(findings.length).toBe(0);
    expect(rules.length).toBe(1);
    const rule = rules[0]!;
    expect(rule.source_matchers).toEqual(['host="node12"']);
    expect(rule.target_matchers).toEqual([
      'host="node12"',
      'alertname=~"ContainerRestarting|ContainerChurn"',
    ]);
    expect(rule.equal).toEqual(["estate", "host"]);
    // The mandatory rationale is carried as a per-rule comment.
    expect(comments.get(rule)).toContain("node12");
  });

  test("the rule admits ONLY ContainerRestarting|ContainerChurn and none of the protected families", () => {
    const findings: AlertingFinding[] = [];
    const model = makeModel({ hosts: [managedHost("node12", { expectedChurn: true })] });
    const { rules } = buildInhibitRules(model, findings);
    const target = rules[0]!.target_matchers;

    expect(targetAdmitsAlertname(target, "ContainerRestarting")).toBe(true);
    expect(targetAdmitsAlertname(target, "ContainerChurn")).toBe(true);
    for (const name of PROTECTED) {
      expect(targetAdmitsAlertname(target, name)).toBe(false);
    }
    // Extra defense: the deep-health probe-availability family is also excluded.
    expect(targetAdmitsAlertname(target, "DeepHealthProbeFailed")).toBe(false);
  });
});

describe("buildInhibitRules — DeadMansSwitch is never a target (REQ-SUPP-04)", () => {
  test("no generated target_matchers entry references alertname=\"DeadMansSwitch\"", () => {
    const findings: AlertingFinding[] = [];
    const model = makeModel({
      hosts: [managedHost("node12", { expectedChurn: true })],
      suppressions: [knownExpected('host="node07",severity="warning"', "migration in progress")],
    });
    const { rules } = buildInhibitRules(model, findings);

    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      for (const m of [...rule.source_matchers, ...rule.target_matchers]) {
        expect(matcherReferencesDeadman(m)).toBe(false);
      }
    }
  });

  test("a known-expected suppression that targets DeadMansSwitch yields INVALID_SUPPRESSION", () => {
    const findings: AlertingFinding[] = [];
    const model = makeModel({
      suppressions: [knownExpected('alertname="DeadMansSwitch"', "should be rejected")],
    });
    const { rules } = buildInhibitRules(model, findings);

    expect(rules.length).toBe(0);
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("INVALID_SUPPRESSION");
    expect(findings[0]!.severity).toBe("error");
  });
});

describe("buildInhibitRules — known-expected findings (REQ-SUPP-02, REQ-CONFIG-02)", () => {
  test("a valid known-expected suppression emits a rule carrying its rationale comment", () => {
    const findings: AlertingFinding[] = [];
    const model = makeModel({
      suppressions: [
        knownExpected('host="node07",severity="warning"', "disk alerts acknowledged (OPS-1421)"),
      ],
    });
    const { rules, comments } = buildInhibitRules(model, findings);

    expect(findings.length).toBe(0);
    expect(rules.length).toBe(1);
    const rule = rules[0]!;
    expect(rule.target_matchers).toEqual(['host="node07"', 'severity="warning"']);
    // Source is scoped to the entity identity; `equal` shares the identity label.
    expect(rule.source_matchers).toEqual(['host="node07"']);
    expect(rule.equal).toEqual(["host"]);
    expect(comments.get(rule)).toBe("rationale: disk alerts acknowledged (OPS-1421)");
  });

  test("a rationale-less known-expected suppression yields MISSING_RATIONALE (error) and no rule", () => {
    const findings: AlertingFinding[] = [];
    const model = makeModel({
      suppressions: [knownExpected('host="node07"', "   ")],
    });
    const { rules } = buildInhibitRules(model, findings);

    expect(rules.length).toBe(0);
    expect(findings.length).toBe(1);
    const f = findings[0]!;
    expect(f.code).toBe("MISSING_RATIONALE");
    expect(f.severity).toBe("error");
    expect(f.path).toContain("node07");
    expect(f.fix.length).toBeGreaterThan(0);
  });

  test("a malformed suppression matcher/target yields INVALID_SUPPRESSION naming file/path/fix", () => {
    const findings: AlertingFinding[] = [];
    const model = makeModel({
      // `host=="oops"` is not a valid AM matcher (double `=`), and it is not a bare identity.
      suppressions: [knownExpected('host=="oops"', "typo in the matcher")],
    });
    const { rules } = buildInhibitRules(model, findings);

    expect(rules.length).toBe(0);
    expect(findings.length).toBe(1);
    const f = findings[0]!;
    expect(f.code).toBe("INVALID_SUPPRESSION");
    expect(f.severity).toBe("error");
    expect(f.file.length).toBeGreaterThan(0);
    expect(f.path.length).toBeGreaterThan(0);
    expect(f.fix.length).toBeGreaterThan(0);
  });

  test("excluded suppressions produce no inhibit rule", () => {
    const findings: AlertingFinding[] = [];
    // The `excluded` host variant carries a suppression mark of class "excluded".
    const excluded = {
      collectionClass: "excluded",
      name: "node99",
      addresses: ["node99.local"],
      suppressed: { class: "excluded", rationale: "decommissioned" },
      provenance: PROV,
    } as unknown as Host;
    const model = makeModel({ hosts: [excluded] });
    const { rules } = buildInhibitRules(model, findings);

    expect(rules.length).toBe(0);
    expect(findings.length).toBe(0);
  });
});

describe("buildInhibitRules — in-place marks & determinism", () => {
  test("an in-place known-expected service mark emits a service-scoped rule", () => {
    const findings: AlertingFinding[] = [];
    const svc: Service = {
      name: "cameras",
      host: "node07",
      kind: "app",
      managed: true,
      suppressed: { class: "known-expected", rationale: "camera flapping tracked in OPS-99" },
      provenance: PROV,
    };
    const model = makeModel({ hosts: [managedHost("node07")], services: [svc] });
    const { rules, comments } = buildInhibitRules(model, findings);

    expect(findings.length).toBe(0);
    expect(rules.length).toBe(1);
    expect(rules[0]!.target_matchers).toEqual(['service="cameras"']);
    expect(comments.get(rules[0]!)).toContain("OPS-99");
  });

  test("rules are emitted in a stable (deterministic) order across runs", () => {
    const model = makeModel({
      hosts: [
        managedHost("nodeB", { expectedChurn: true }),
        managedHost("nodeA", { expectedChurn: true }),
      ],
      suppressions: [knownExpected('host="zzz"', "z rationale")],
    });
    const a = buildInhibitRules(model, []).rules.map((r) => r.target_matchers.join(","));
    const b = buildInhibitRules(model, []).rules.map((r) => r.target_matchers.join(","));
    expect(a).toEqual(b);
  });
});
