// stack/alerting/tests/backup-rules.test.ts
// Tier-A unit tests for the backup-freshness rule builder (03 §5): the parseDurationSeconds cases,
// the §5.4 golden byte-for-byte, and the INVALID_RULE findings (bad name / unparseable threshold).
/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import {
  buildBackupRules,
  parseBackupName,
  parseDurationSeconds,
} from "../src/transform/backup-rules.js";
import type { AlertingFinding } from "../src/transform/findings.js";
import type { ProberConfigRendered } from "../src/transform/rendered.js";

describe("parseDurationSeconds", () => {
  test("maps the acceptance cases", () => {
    expect(parseDurationSeconds("24h")).toBe(86400);
    expect(parseDurationSeconds("1d12h")).toBe(129600);
    expect(parseDurationSeconds("86400s")).toBe(86400);
    expect(parseDurationSeconds("soon")).toBeNull();
  });

  test("supports every unit and concatenated groups", () => {
    expect(parseDurationSeconds("90m")).toBe(5400);
    expect(parseDurationSeconds("1w")).toBe(604800);
    expect(parseDurationSeconds("1y")).toBe(31536000);
    expect(parseDurationSeconds("1h30m")).toBe(5400);
  });

  test("returns null for empty/undefined/partially-malformed input", () => {
    expect(parseDurationSeconds(undefined)).toBeNull();
    expect(parseDurationSeconds("")).toBeNull();
    expect(parseDurationSeconds("24")).toBeNull(); // no unit
    expect(parseDurationSeconds("24h ")).toBeNull(); // trailing garbage (consumed !== length)
    expect(parseDurationSeconds("24x")).toBeNull(); // unknown unit
  });
});

describe("parseBackupName", () => {
  test("parses svc:<host>/<service>#backup", () => {
    expect(parseBackupName("svc:db-01/postgres#backup")).toEqual({
      host: "db-01",
      service: "postgres",
    });
  });

  test("returns null when the #backup suffix is missing", () => {
    expect(parseBackupName("svc:db-01/postgres")).toBeNull();
  });
});

describe("buildBackupRules", () => {
  test("emits the §5.4 golden byte-for-byte", () => {
    const prober: ProberConfigRendered = {
      probes: [
        {
          name: "svc:db-01/postgres#backup",
          target: "http://db-01.local/backup",
          kind: "backup-freshness",
          threshold: "24h",
        },
      ],
    };
    const findings: AlertingFinding[] = [];
    const out = buildBackupRules(prober, findings);
    const expected =
      "groups:\n" +
      "  - name: backup-freshness\n" +
      "    rules:\n" +
      "      - alert: BackupStale\n" +
      "        annotations:\n" +
      "          description: Last successful backup for service {{ $labels.service }} on host {{ $labels.host }} is older than its declared threshold (24h).\n" +
      "          runbook_url: https://runbooks.pulse.local/backup-freshness\n" +
      "          summary: Backup for {{ $labels.service }} is stale\n" +
      '        expr: pulse_backup_freshness_age_seconds{service="postgres"} > 86400\n' +
      "        labels:\n" +
      "          severity: warning\n" +
      "      - alert: BackupCritical\n" +
      "        annotations:\n" +
      "          description: Last successful backup for service {{ $labels.service }} on host {{ $labels.host }} is older than twice its declared threshold (24h).\n" +
      "          runbook_url: https://runbooks.pulse.local/backup-freshness\n" +
      "          summary: Backup for {{ $labels.service }} is critically stale\n" +
      '        expr: pulse_backup_freshness_age_seconds{service="postgres"} > 172800\n' +
      "        labels:\n" +
      "          severity: critical\n" +
      "      - alert: BackupNoData\n" +
      "        annotations:\n" +
      "          description: No readable backup-freshness signal for service {{ $labels.service }} on host {{ $labels.host }}. Missing data is NOT treated as a healthy backup (REQ-BACKUP-03).\n" +
      "          runbook_url: https://runbooks.pulse.local/backup-freshness\n" +
      "          summary: Backup freshness signal missing for {{ $labels.service }}\n" +
      '        expr: pulse_backup_freshness_up{service="postgres"} == 0 or absent(pulse_backup_freshness_up{service="postgres"})\n' +
      "        for: 15m\n" +
      "        labels:\n" +
      "          severity: warning\n";
    expect(out).toBe(expected);
    expect(findings).toEqual([]);
  });

  test("filters non-backup kinds and sorts by name (determinism)", () => {
    const prober: ProberConfigRendered = {
      probes: [
        { name: "svc:db-02/redis#backup", target: "t", kind: "backup-freshness", threshold: "12h" },
        { name: "svc:edge-01/cameras", target: "t", kind: "deep-health", alertExpression: "x<1" },
        { name: "svc:db-01/postgres#backup", target: "t", kind: "backup-freshness", threshold: "24h" },
      ],
    };
    const findings: AlertingFinding[] = [];
    const out = buildBackupRules(prober, findings);
    expect(out.indexOf('service="postgres"')).toBeLessThan(out.indexOf('service="redis"'));
    expect(out).not.toContain("cameras");
    expect(findings).toEqual([]);
  });

  test("determinism: identical input → byte-identical output", () => {
    const mk = (): ProberConfigRendered => ({
      probes: [
        { name: "svc:db-01/postgres#backup", target: "t", kind: "backup-freshness", threshold: "24h" },
      ],
    });
    expect(buildBackupRules(mk(), [])).toBe(buildBackupRules(mk(), []));
  });

  test("INVALID_RULE for an unparseable entry name", () => {
    const findings: AlertingFinding[] = [];
    const out = buildBackupRules(
      { probes: [{ name: "svc:db-01/postgres", target: "t", kind: "backup-freshness", threshold: "24h" }] },
      findings,
    );
    expect(out).toBe("groups: []\n");
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("INVALID_RULE");
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.file).toBe("rendered/prober/config.yaml");
    expect(findings[0]!.path).toBe("probes[name=svc:db-01/postgres]");
    expect(findings[0]!.fix.length).toBeGreaterThan(0);
  });

  test("INVALID_RULE for an unparseable threshold", () => {
    const findings: AlertingFinding[] = [];
    buildBackupRules(
      { probes: [{ name: "svc:db-01/postgres#backup", target: "t", kind: "backup-freshness", threshold: "soon" }] },
      findings,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("INVALID_RULE");
    expect(findings[0]!.path).toBe("probes[name=svc:db-01/postgres#backup].threshold");
  });

  test("no finding message contains the ignored credential (secret safety)", () => {
    const findings: AlertingFinding[] = [];
    buildBackupRules(
      { probes: [{ name: "svc:db-01/postgres#backup", target: "t", kind: "backup-freshness", threshold: "soon", credential: "op://vault/secret" }] },
      findings,
    );
    for (const f of findings) {
      expect(f.message).not.toContain("op://vault/secret");
    }
  });
});
