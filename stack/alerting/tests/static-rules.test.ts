// stack/alerting/tests/static-rules.test.ts
// Tier-A structural guard for the six committed static vmalert rule families
// (stack/compose/config/vmalert/rules/*.yml, authored per 02-static-rule-library.md). Reads every
// file and asserts: (1) every `alert:` is PascalCase ^[A-Z][A-Za-z0-9]+$ (REQ-RULE-02); (2) every
// rule carries a `severity` label from {critical,warning,info,deadman} (REQ-RULE-04); (3) `deadman`
// appears only on DeadMansSwitch (REQ-DEAD-03); (4) no credential-literal shape appears (REQ-SEC-01/02).
// Full promtool firing coverage lives in item 014; this is the lightweight static guard.
/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const RULES_DIR = join(import.meta.dir, "..", "..", "compose", "config", "vmalert", "rules");
const FILES = [
  "availability.yml",
  "capacity.yml",
  "engine.yml",
  "pipeline-health.yml",
  "churn.yml",
  "deadman.yml",
] as const;

const PASCAL_CASE = /^[A-Z][A-Za-z0-9]+$/;
const ALLOWED_SEVERITIES = new Set(["critical", "warning", "info", "deadman"]);
const DEADMAN_ALERT = "DeadMansSwitch";

interface RuleFileEntry {
  file: string;
  raw: string;
  alert: string;
  severity: unknown;
}

interface ParsedRule {
  alert?: unknown;
  labels?: Record<string, unknown>;
}
interface ParsedGroup {
  name?: unknown;
  rules?: ParsedRule[];
}
interface ParsedRuleFile {
  groups?: ParsedGroup[];
}

/** Read + parse every static rule file, flattening to one entry per rule. */
function loadRules(): RuleFileEntry[] {
  const entries: RuleFileEntry[] = [];
  for (const file of FILES) {
    const raw = readFileSync(join(RULES_DIR, file), "utf8");
    const doc = parse(raw) as ParsedRuleFile;
    expect(Array.isArray(doc.groups), `${file}: groups must be an array`).toBe(true);
    for (const group of doc.groups ?? []) {
      for (const rule of group.rules ?? []) {
        entries.push({
          file,
          raw,
          alert: String(rule.alert),
          severity: rule.labels?.severity,
        });
      }
    }
  }
  return entries;
}

const RULES = loadRules();

describe("static vmalert rule library — structural guard", () => {
  test("all six rule files are present and non-empty", () => {
    // Every family contributes at least one rule (16 static alerts across six files).
    expect(RULES.length).toBeGreaterThanOrEqual(16);
    const seen = new Set(RULES.map((r) => r.file));
    for (const file of FILES) expect(seen.has(file)).toBe(true);
  });

  test("every alert name is PascalCase ^[A-Z][A-Za-z0-9]+$ (REQ-RULE-02)", () => {
    for (const r of RULES) {
      expect(PASCAL_CASE.test(r.alert), `${r.file}: alert "${r.alert}" is not PascalCase`).toBe(
        true,
      );
    }
  });

  test("every rule has a severity label in {critical,warning,info,deadman} (REQ-RULE-04)", () => {
    for (const r of RULES) {
      expect(
        typeof r.severity === "string" && ALLOWED_SEVERITIES.has(r.severity),
        `${r.file}: alert "${r.alert}" has invalid severity ${JSON.stringify(r.severity)}`,
      ).toBe(true);
    }
  });

  test("`deadman` severity appears only on DeadMansSwitch (REQ-DEAD-03)", () => {
    for (const r of RULES) {
      if (r.severity === "deadman") {
        expect(r.alert, `${r.file}: non-deadman alert "${r.alert}" carries severity deadman`).toBe(
          DEADMAN_ALERT,
        );
      }
      if (r.alert === DEADMAN_ALERT) {
        expect(r.severity, `${DEADMAN_ALERT} must carry severity deadman`).toBe("deadman");
      }
    }
    // DeadMansSwitch exists exactly once, in deadman.yml.
    const deadmen = RULES.filter((r) => r.alert === DEADMAN_ALERT);
    expect(deadmen.length).toBe(1);
    expect(deadmen[0]!.file).toBe("deadman.yml");
  });

  test("no credential-literal or secret-reference shape appears (REQ-SEC-01/02)", () => {
    // Deny-list of secret shapes: URLs with embedded credentials, secret-manager refs, bearer
    // tokens, and password/token/secret/apikey assignments. These static files are pure product
    // policy — they carry NO credential of any form. NB: a bare ${VAR} reference is NOT a
    // credential literal (these files legitimately mention the non-secret ${PULSE_ESTATE_NAME}
    // external-label placeholder in a header comment), so ${ENV} interpolation is not denied here.
    const DENY: { name: string; re: RegExp }[] = [
      { name: "url-embedded-credentials", re: /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i },
      { name: "op-secret-ref", re: /\bop:\/\//i },
      { name: "bearer-token", re: /\bbearer\s+[A-Za-z0-9._-]{8,}/i },
      { name: "secret-assignment", re: /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S/i },
    ];
    for (const r of RULES) {
      for (const { name, re } of DENY) {
        expect(re.test(r.raw), `${r.file}: matched credential-literal shape "${name}"`).toBe(false);
      }
    }
  });
});
