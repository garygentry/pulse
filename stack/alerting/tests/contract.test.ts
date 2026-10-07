// stack/alerting/tests/contract.test.ts
// Tier-A pure-TS conformance + meta-guard suite (06 §7). No Docker, no network — Tier A never
// self-skips (a tooling-absent env must fail RED). Five concerns, each a guard that declares its
// ENUMERATED protection set and at least one EXPLICIT non-goal (the Meta-guard anti-churn norm,
// 06 §7): a guard judges only against its declared set and never claims an open-ended objective.
//
//   §7.4  Taxonomy tri-view      — severity-taxonomy.json ⇄ src/taxonomy.ts ⇄ severity-taxonomy.md
//   §7.1  Container-health guard — no deep-health service takes a container_* series as liveness
//   §7.2  DeadMansSwitch guard   — no generated inhibit matcher references DeadMansSwitch
//   §7.3  Expected-churn scope   — the churn inhibit rule admits ONLY the churn family
//   §7.4  Secret-literal scan    — only ${VAR}/op:// refs; no credential literal / live-provider host
/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { buildAlertingConfig, SEVERITY_TAXONOMY, SEVERITY_TAXONOMY_VERSION } from "../src/index.js";
import type { TransformInput } from "../src/index.js";
import { matcherReferencesDeadman, targetAdmitsAlertname } from "../src/transform/inhibit.js";
import {
  CONTRACT_DIR,
  FIXTURE_DIR,
  PKG_ROOT,
  STATIC_RULES_DIR,
  loadFixtureInput,
} from "./harness.js";

/** Every estate fixture that renders a non-empty config (excludes the whole-or-nothing `no-channel`). */
const CONFIG_FIXTURES = [
  "multi-service",
  "webhook-only",
  "single-service",
  "suppressions",
  "expected-churn",
  "deep-health-heavy",
] as const;

/** The six committed static vmalert rule families (item 009). */
const STATIC_RULE_FILES = [
  "availability.yml",
  "capacity.yml",
  "engine.yml",
  "pipeline-health.yml",
  "churn.yml",
  "deadman.yml",
] as const;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §7.4 — Taxonomy tri-view: json ⇄ taxonomy.ts ⇄ .md agree; versions in lockstep
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Protected set (enumerated): the three severities (critical→warning→info), their order, and every
//   routing field (channels, repeatInterval, groupWindow, bypassesQuietHours, sendsResolved,
//   webhookMirror), plus contractVersion === SEVERITY_TAXONOMY_VERSION === 1.
// Non-goal (explicit): it does NOT police prose outside the published severity table / version line
//   (purpose, non-goals sections may legitimately mention `deadman` by name); it conforms only the
//   three enumerated views' structured values.

interface JsonRouting {
  channels: string;
  repeatInterval: string | null;
  groupWindow: string | null;
  bypassesQuietHours: boolean;
  sendsResolved: boolean;
}
interface JsonSeverity {
  name: string;
  response: string;
  routing: JsonRouting;
}
interface JsonTaxonomy {
  contractVersion: number;
  severities: JsonSeverity[];
  webhookMirror: Record<string, string>;
}

/** One severity row parsed out of the `.md` companion's severity table (§3.2). */
interface MdSeverity {
  name: string;
  response: string;
  channels: string;
  repeatInterval: string | null;
  groupWindow: string | null;
  bypassesQuietHours: boolean;
  sendsResolved: boolean;
  webhookMirror: string;
}

const TAXONOMY_JSON = JSON.parse(
  readFileSync(join(CONTRACT_DIR, "severity-taxonomy.json"), "utf8"),
) as JsonTaxonomy;
const TAXONOMY_MD = readFileSync(join(CONTRACT_DIR, "severity-taxonomy.md"), "utf8");

/** Strip a Markdown cell to its bare value: trim, drop surrounding backticks. */
function cell(raw: string): string {
  return raw.trim().replace(/^`+|`+$/g, "").trim();
}
/** An em-dash (`—`) or empty cell denotes `null` (no repeat / no group window). */
function nullableCell(raw: string): string | null {
  const v = cell(raw);
  return v === "—" || v === "" ? null : v;
}
/** A `yes`/`no` cell → boolean. */
function boolCell(raw: string): boolean {
  return cell(raw).toLowerCase() === "yes";
}

/** Parse the three severity rows out of the `.md` companion's severity table, in document order. */
function parseMdSeverities(md: string): MdSeverity[] {
  const rows: MdSeverity[] = [];
  for (const line of md.split("\n")) {
    if (!/^\|\s*`(critical|warning|info)`/.test(line)) continue;
    // Split the pipe-delimited row, dropping the leading/trailing empties from the outer pipes.
    const cols = line.split("|").slice(1, -1);
    if (cols.length < 8) continue;
    rows.push({
      name: cell(cols[0]!),
      response: cell(cols[1]!),
      channels: cell(cols[2]!),
      repeatInterval: nullableCell(cols[3]!),
      groupWindow: nullableCell(cols[4]!),
      bypassesQuietHours: boolCell(cols[5]!),
      sendsResolved: boolCell(cols[6]!),
      webhookMirror: cell(cols[7]!),
    });
  }
  return rows;
}

describe("§7.4 taxonomy tri-view (json ⇄ taxonomy.ts ⇄ .md)", () => {
  test("contractVersion === SEVERITY_TAXONOMY_VERSION === 1", () => {
    expect(SEVERITY_TAXONOMY_VERSION).toBe(1);
    expect(TAXONOMY_JSON.contractVersion).toBe(SEVERITY_TAXONOMY_VERSION);
    // The .md version line agrees (## Contract version: 1).
    const m = /Contract version:\s*(\d+)/.exec(TAXONOMY_MD);
    expect(m, "`.md` must declare a Contract version").toBeDefined();
    expect(Number(m![1])).toBe(SEVERITY_TAXONOMY_VERSION);
  });

  test("all three views agree on the three severities and their order", () => {
    const tsNames = SEVERITY_TAXONOMY.map((s) => s.name);
    expect(tsNames).toEqual(["critical", "warning", "info"]);
    expect(TAXONOMY_JSON.severities.map((s) => s.name)).toEqual(tsNames);
    expect(parseMdSeverities(TAXONOMY_MD).map((s) => s.name)).toEqual(tsNames);
  });

  test("json routing fields mirror SEVERITY_TAXONOMY for every severity", () => {
    for (const def of SEVERITY_TAXONOMY) {
      const j = TAXONOMY_JSON.severities.find((s) => s.name === def.name);
      expect(j, `json missing severity ${def.name}`).toBeDefined();
      expect(j!.response).toBe(def.response);
      expect(j!.routing.channels).toBe(def.channels);
      expect(j!.routing.repeatInterval).toBe(def.repeatInterval);
      expect(j!.routing.groupWindow).toBe(def.groupWindow);
      expect(j!.routing.bypassesQuietHours).toBe(def.bypassesQuietHours);
      expect(j!.routing.sendsResolved).toBe(def.sendsResolved);
      // webhookMirror is a top-level map keyed by severity name (json shape differs from the flat TS).
      expect(TAXONOMY_JSON.webhookMirror[def.name]).toBe(def.webhookMirror);
    }
  });

  test(".md severity table mirrors SEVERITY_TAXONOMY for every severity", () => {
    const mdByName = new Map(parseMdSeverities(TAXONOMY_MD).map((s) => [s.name, s]));
    for (const def of SEVERITY_TAXONOMY) {
      const md = mdByName.get(def.name);
      expect(md, `.md missing severity ${def.name}`).toBeDefined();
      expect(md!.response).toBe(def.response);
      expect(md!.channels).toBe(def.channels);
      expect(md!.repeatInterval).toBe(def.repeatInterval);
      expect(md!.groupWindow).toBe(def.groupWindow);
      expect(md!.bypassesQuietHours).toBe(def.bypassesQuietHours);
      expect(md!.sendsResolved).toBe(def.sendsResolved);
      expect(md!.webhookMirror).toBe(def.webhookMirror);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §7.1 — Container-health guard: container_* is never a deep-health service's liveness signal
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Protected set (enumerated): every service that DECLARES a deep-health probe (`Service.deepHealth`)
//   in the `multi-service` and `deep-health-heavy` fixtures. For each, no static or rendered rule
//   scoped to that service derives its liveness-of-function from a `container_*` series.
// Non-goals (explicit):
//   - It does NOT police container_*-based churn/capacity alerts (ContainerRestarting/ContainerChurn)
//     — those are legitimate workload telemetry (tech-spec §3.3/§3.8), scoped by `name`, not service.
//   - It does NOT police services WITHOUT a declared probe (container health may be legitimate there).
//   - It does NOT enumerate every conceivable future container-liveness shape; its contract is the
//     enumerated deep-health-declaring services and the `container_*`-scoped-to-service shape.

/** One rule flattened out of a static or rendered rule-group document. */
interface RuleExpr {
  file: string;
  alert: string;
  expr: string;
}

interface ParsedRule {
  alert?: unknown;
  expr?: unknown;
}
interface ParsedGroup {
  rules?: ParsedRule[];
}
interface ParsedRuleFile {
  groups?: ParsedGroup[];
}

/** Flatten a rule-group YAML string into `{file, alert, expr}` entries. */
function flattenRules(file: string, yaml: string): RuleExpr[] {
  if (yaml.trim().length === 0) return [];
  const doc = parse(yaml) as ParsedRuleFile;
  const out: RuleExpr[] = [];
  for (const group of doc.groups ?? []) {
    for (const rule of group.rules ?? []) {
      out.push({ file, alert: String(rule.alert), expr: String(rule.expr ?? "") });
    }
  }
  return out;
}

/** Every static-library rule expression (all six committed families). */
function staticRules(): RuleExpr[] {
  return STATIC_RULE_FILES.flatMap((f) =>
    flattenRules(f, readFileSync(join(STATIC_RULES_DIR, f), "utf8")),
  );
}

/** Static + per-estate rendered (deep-health + backup) rule expressions for a fixture. */
function allRules(input: TransformInput): RuleExpr[] {
  const out = buildAlertingConfig(input);
  return [
    ...staticRules(),
    ...flattenRules("deep-health.yml", out.deepHealthRules),
    ...flattenRules("backup.yml", out.backupRules),
  ];
}

/** Deep-health-declaring services of an estate — the enumerated protection set. */
function deepHealthServiceNames(input: TransformInput): string[] {
  return input.estate.services.filter((s) => s.deepHealth !== undefined).map((s) => s.name);
}

describe("§7.1 container-health guard (REQ-AVAIL-04)", () => {
  for (const fixture of ["multi-service", "deep-health-heavy"] as const) {
    test(`no container_* liveness rule for a deep-health service in ${fixture}`, () => {
      const input = loadFixtureInput(fixture);
      const services = deepHealthServiceNames(input);
      expect(services.length, `${fixture} must declare at least one deep-health service`).toBeGreaterThan(0);

      const rules = allRules(input);
      for (const svc of services) {
        // A rule "scopes" this service when its expression selects `service="<svc>"`.
        const scoped = rules.filter((r) => r.expr.includes(`service="${svc}"`));
        const containerLiveness = scoped.filter((r) => /\bcontainer_[a-z_]+/i.test(r.expr));
        expect(
          containerLiveness.map((r) => `${r.file}:${r.alert}`),
          `deep-health service ${svc} must have no container_*-derived liveness rule`,
        ).toEqual([]);
      }

      // Sanity: the churn family DOES use container_* — but never scoped to a deep-health service
      // (documented non-goal). Its expressions carry no `service="…"` selector.
      const churn = rules.filter((r) => /\bcontainer_/.test(r.expr));
      expect(churn.length, "churn family present in the scanned set").toBeGreaterThan(0);
      for (const r of churn) {
        for (const svc of services) {
          expect(r.expr.includes(`service="${svc}"`), `${r.alert} must not scope ${svc}`).toBe(false);
        }
      }
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §7.2 — DeadMansSwitch-not-suppressible guard
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Protected set (enumerated): the single alertname `DeadMansSwitch`. No transform-generated
//   inhibit_rule (neither its source_matchers nor target_matchers) may reference it.
// Non-goals (explicit):
//   - It does NOT police an operator's MANUAL runtime AM silence (a human MAY silence anything at
//     runtime; AM cannot structurally forbid it — tech-spec §3.4). The guard's remit is only the
//     policy `alerting` GENERATES.
//   - It does NOT police receiver-side muting configured outside the transform.

interface ParsedInhibit {
  source_matchers?: string[];
  target_matchers?: string[];
}
interface ParsedConfig {
  inhibit_rules?: ParsedInhibit[];
}

/** Every source+target matcher across every generated inhibit rule of a fixture's config. */
function inhibitMatchers(input: TransformInput): string[] {
  const cfgText = buildAlertingConfig(input).alertmanagerConfig;
  if (cfgText.length === 0) return [];
  const cfg = parse(cfgText) as ParsedConfig;
  return (cfg.inhibit_rules ?? []).flatMap((r) => [
    ...(r.source_matchers ?? []),
    ...(r.target_matchers ?? []),
  ]);
}

describe("§7.2 DeadMansSwitch-not-suppressible guard (REQ-SUPP-04)", () => {
  test("no generated inhibit matcher references alertname DeadMansSwitch", () => {
    for (const fixture of CONFIG_FIXTURES) {
      const matchers = inhibitMatchers(loadFixtureInput(fixture));
      for (const m of matchers) {
        // Two independent checks: the positive-reference helper (=/=~ that admits it) AND a raw
        // substring scan (no matcher may even name the alertname).
        expect(matcherReferencesDeadman(m), `${fixture}: matcher positively targets DeadMansSwitch: ${m}`).toBe(
          false,
        );
        expect(m.includes("DeadMansSwitch"), `${fixture}: matcher mentions DeadMansSwitch: ${m}`).toBe(false);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §7.3 — Expected-churn scope guard: the churn inhibit rule admits ONLY the churn family
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Protected set (enumerated): the exact PROTECTED_FAMILIES array below — the alertname families an
//   `expected-churn` inhibit rule MUST NOT touch. The guard asserts the generated expected-churn
//   inhibit rule's target matcher admits ONLY ContainerRestarting|ContainerChurn and NONE of them.
// Non-goals (explicit):
//   - It does NOT police operator-created MANUAL AM silences (a human MAY silence anything at runtime).
//   - It does NOT police the `known-expected` (config-as-code) class, which MAY legitimately target
//     other families WITH a rationale (REQ-SUPP-02, its own review discipline §5.7). This guard
//     governs only the `expected-churn` classification's generated rule.

const PROTECTED_FAMILIES = [
  "HostDown",
  "HighCPU",
  "HighMemory",
  "LowDisk",
  "CriticalDisk",
  "BackupStale",
  "BackupCritical",
  "DeepHealthFailed",
  "DeepHealthProbeFailed",
  "DeepHealthProbeStale",
  "AlertPathDown",
  "AncillaryDown",
  // pipeline-health family — exact alertnames from 02-static-rule-library.md §7
  "AlertRuleEvalErrors",
  "AlertNotificationsFailing",
  "AlertNotificationLatencyHigh",
  "AlertRemoteWriteBacklog",
] as const;

/** The churn family the expected-churn rule is allowed to target. */
const CHURN_FAMILY = ["ContainerRestarting", "ContainerChurn"] as const;

describe("§7.3 expected-churn scope guard (REQ-SUPP-03)", () => {
  test("the expected-churn inhibit rule admits ONLY the churn family, none of PROTECTED_FAMILIES", () => {
    const cfgText = buildAlertingConfig(loadFixtureInput("expected-churn")).alertmanagerConfig;
    expect(cfgText.length, "expected-churn fixture must render a config").toBeGreaterThan(0);
    const cfg = parse(cfgText) as {
      inhibit_rules?: Array<{ target_matchers?: string[] }>;
    };
    // The expected-churn rule is the one whose target matches the churn alternation.
    const churnRule = (cfg.inhibit_rules ?? []).find((r) =>
      (r.target_matchers ?? []).some((m) => m.includes("ContainerRestarting")),
    );
    expect(churnRule, "expected-churn inhibit rule").toBeDefined();
    const target = churnRule!.target_matchers ?? [];

    // …admits the churn family…
    for (const name of CHURN_FAMILY) {
      expect(targetAdmitsAlertname(target, name), `must admit ${name}`).toBe(true);
    }
    // …and NONE of the enumerated protected families.
    for (const name of PROTECTED_FAMILIES) {
      expect(targetAdmitsAlertname(target, name), `must NOT admit ${name}`).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §7.4 — Secret-literal & no-real-target scan
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Protected set (enumerated): every DATA/CONFIG file under stack/alerting/ (fixtures, committed
//   goldens, contract artifacts, src, package/tsconfig) + the static rule files under
//   stack/compose/config/vmalert/rules/ + every generated artifact. The scan matches a fixed
//   deny-list of credential-literal shapes and live-provider hostnames and asserts ZERO hits — the
//   only secret-shaped tokens that may appear are ${VAR}/op:// references.
// Non-goals (explicit):
//   - It does NOT attempt to prove a string is not secret by entropy heuristics; it matches the
//     enumerated literal/hostname shapes only.
//   - It explicitly excludes the TEST SOURCES themselves (`*.test.ts`, `bun-test.d.ts`), which carry
//     deliberate secret-shaped doubles and deny-list patterns to exercise the redaction/finding paths
//     (e.g. routing.test.ts injects a fake `xoxb-…` token and asserts the SECRET_LITERAL finding
//     never echoes it). Those are asserted in place by their owning suites.

/** Enumerated deny-list: credential literals + live-provider hostnames. Every pattern is written
 *  with escaped dots so the deny-list's own source text does not self-match when this file is (not)
 *  scanned. A ${VAR}/op:// reference matches NONE of these — it is the allowed shape. */
const DENY: Array<[string, RegExp]> = [
  ["slack bot/user token literal", /\bxox[baprs]-[0-9A-Za-z-]{8,}/],
  ["slack incoming-webhook literal", /hooks\.slack\.com\/services\//],
  ["opsgenie host", /\bapi\.opsgenie\.com\b/],
  ["pagerduty host", /\b(?:events|api)\.pagerduty\.com\b/],
  ["telegram bot host", /\bapi\.telegram\.org\b/],
  ["pushover host", /\bapi\.pushover\.net\b/],
  ["url-embedded userinfo credential", /:\/\/[^/@\s"']+:[^/@\s"']+@[A-Za-z0-9]/],
  ["bearer token literal", /\bBearer\s+[A-Za-z0-9._-]{16,}\b/],
  ["jwt literal", /\bey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
  ["aws access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["PEM private key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
];

/** File extensions worth scanning as text (data/config/source/docs). */
const SCAN_EXTS = new Set([".ts", ".json", ".yaml", ".yml", ".md"]);
/** Directory names never descended into. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

/** Recursively collect scannable file paths under `root`, applying the protected-set exclusions. */
function collectScanFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      // Exclude test sources (deliberate secret-shaped doubles + deny-list patterns — documented
      // non-goal) and files without a scannable text extension.
      if (entry.name.endsWith(".test.ts") || entry.name === "bun-test.d.ts") continue;
      const dot = entry.name.lastIndexOf(".");
      const ext = dot === -1 ? "" : entry.name.slice(dot);
      if (!SCAN_EXTS.has(ext)) continue;
      files.push(full);
    }
  };
  walk(root);
  return files;
}

describe("§7.4 secret-literal & no-real-target scan (REQ-SEC-01/02, REQ-TEST-01)", () => {
  test("no credential literal / live-provider host under stack/alerting/ + static rules", () => {
    const targets = [...collectScanFiles(PKG_ROOT), ...collectScanFiles(STATIC_RULES_DIR)];
    // Sanity: the walk actually found the fixtures + goldens + contract + static rules it protects.
    expect(targets.length, "scan must cover a non-trivial file set").toBeGreaterThan(20);

    for (const path of targets) {
      const text = readFileSync(path, "utf8");
      const rel = path.startsWith(PKG_ROOT) ? path.slice(PKG_ROOT.length + 1) : path;
      for (const [label, pattern] of DENY) {
        expect(pattern.test(text), `${rel}: matched deny-list shape "${label}"`).toBe(false);
      }
    }
  });

  test("no generated artifact embeds a credential literal (all fixtures, all three families)", () => {
    for (const fixture of CONFIG_FIXTURES) {
      const out = buildAlertingConfig(loadFixtureInput(fixture));
      const blob = [out.alertmanagerConfig, out.deepHealthRules, out.backupRules].join("\n");
      for (const [label, pattern] of DENY) {
        expect(pattern.test(blob), `${fixture} generated artifact: matched "${label}"`).toBe(false);
      }
      // Positive: the only secret-shaped tokens present are ${VAR} references (op:// legal too,
      // though these fixtures use none). Confirm at least the product-static refs survive unresolved.
      expect(out.alertmanagerConfig).toContain("${PULSE_DEADMANSSWITCH_URL}");
    }
  });

  test("every op:// occurrence in the scanned tree is a reference, never a resolved value", () => {
    // op:// is an ALLOWED reference shape; a "resolved" op value (a ref followed by `= <value>`) is
    // not. Scan the protected set and require each op:// token to be a bare reference.
    const targets = [...collectScanFiles(PKG_ROOT), ...collectScanFiles(STATIC_RULES_DIR)];
    const resolvedOp = /op:\/\/[^\s"']*\s*=\s*\S/;
    for (const path of targets) {
      const text = readFileSync(path, "utf8");
      expect(resolvedOp.test(text), `${path}: op:// must appear only as a reference`).toBe(false);
    }
  });
});
