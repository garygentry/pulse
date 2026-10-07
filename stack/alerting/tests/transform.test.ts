// stack/alerting/tests/transform.test.ts
// The primary Tier-A suite (06 §5/§8/§11): proves `buildAlertingConfig` is a pure, deterministic
// transform whose output is byte-for-byte reproducible against committed goldens, and asserts the
// realized route/deadman/inhibit shapes, whole-or-nothing findings, secret-safety, and scale sanity.
// No Docker, no network — Tier A never self-skips (a tooling-absent env must fail RED).
//
// Golden regeneration: `UPDATE_GOLDEN=1 bun test stack/alerting/tests/transform.test.ts` rewrites the
// committed `fixtures/<name>/{alertmanager,deep-health,backup}.yml` from the current transform; the
// committed goldens are diff-reviewed like any source (§5.1).
/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { buildAlertingConfig } from "../src/index.js";
import { GOLDEN_DIR, generateScaleFixture, loadFixtureInput } from "./harness.js";

/** Every estate fixture the suite drives. `no-channel` is the whole-or-nothing (error) case. */
const FIXTURES = [
  "multi-service",
  "webhook-only",
  "no-channel",
  "single-service",
  "suppressions",
  "expected-churn",
  "deep-health-heavy",
  "telegram",
] as const;

/** The three golden output files committed per fixture (06 §11.2). */
const GOLDEN_FILES = [
  ["alertmanager.yml", "alertmanagerConfig"],
  ["deep-health.yml", "deepHealthRules"],
  ["backup.yml", "backupRules"],
] as const;

/** Env-gated golden regeneration convenience (§5.1). */
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === "1" || process.env.UPDATE_GOLDEN === "true";

/** True iff an AM route's `matchers` array contains the exact matcher string. */
function hasMatcher(route: { matchers?: unknown }, matcher: string): boolean {
  return Array.isArray(route.matchers) && route.matchers.includes(matcher);
}

// ── §5.1 Determinism ─────────────────────────────────────────────────────────────────────────────

describe("buildAlertingConfig determinism (§5.1)", () => {
  test("identical input → byte-identical output (all three families)", () => {
    const a = buildAlertingConfig(loadFixtureInput("multi-service"));
    const b = buildAlertingConfig(loadFixtureInput("multi-service"));
    expect(a.alertmanagerConfig).toBe(b.alertmanagerConfig);
    expect(a.deepHealthRules).toBe(b.deepHealthRules);
    expect(a.backupRules).toBe(b.backupRules);
  });
});

// ── §5.1 Byte-for-byte golden comparison ───────────────────────────────────────────────────────

describe("buildAlertingConfig golden output (§5.1)", () => {
  for (const name of FIXTURES) {
    test(`${name}: output matches committed golden byte-for-byte`, () => {
      const out = buildAlertingConfig(loadFixtureInput(name));
      for (const [file, key] of GOLDEN_FILES) {
        const goldenPath = join(GOLDEN_DIR, name, file);
        const actual = out[key];
        if (UPDATE_GOLDEN) {
          writeFileSync(goldenPath, actual, "utf8");
          continue;
        }
        expect(actual, `${name}/${file}`).toBe(readFileSync(goldenPath, "utf8"));
      }
    });
  }

  test("running the transform twice diffs to zero against the goldens", () => {
    for (const name of FIXTURES) {
      const first = buildAlertingConfig(loadFixtureInput(name));
      const second = buildAlertingConfig(loadFixtureInput(name));
      for (const [file, key] of GOLDEN_FILES) {
        if (UPDATE_GOLDEN) continue;
        const golden = readFileSync(join(GOLDEN_DIR, name, file), "utf8");
        expect(first[key]).toBe(golden);
        expect(second[key]).toBe(golden);
      }
    }
  });
});

// ── §5.4 Severity route realization ──────────────────────────────────────────────────────────────

describe("severity route realization (§5.4)", () => {
  test("multi-service route tree realizes severity semantics", () => {
    const out = buildAlertingConfig(loadFixtureInput("multi-service"));
    const cfg = parse(out.alertmanagerConfig) as {
      route: { group_by: string[]; routes: Array<Record<string, unknown>> };
    };

    // REQ-ROUTE-02: grouping identity.
    expect(cfg.route.group_by).toEqual(["estate", "host", "service", "alertname"]);

    const routes = cfg.route.routes;

    // Critical human route: continue:true (fans out to the mirror), fast + repeated, no mute.
    const crit = routes.find((r) => hasMatcher(r, 'severity="critical"') && r.continue === true);
    expect(crit, "critical human route").toBeDefined();
    expect(crit!.group_wait).toBe("10s"); // REQ-SEV-02
    expect(crit!.repeat_interval).toBe("30m"); // REQ-SEV-06
    expect(crit!.mute_time_intervals).toBeUndefined(); // quiet-hours bypass (REQ-ROUTE-03)
    expect(crit!.continue).toBe(true); // fan-out to mirror (REQ-HOOK-01)

    // Automation-webhook mirror: the second critical sibling, continue:false.
    const mirror = routes.find((r) => hasMatcher(r, 'severity="critical"') && r.continue === false);
    expect(mirror, "critical mirror route").toBeDefined();
    expect(mirror!.receiver).toBe("pulse-webhook-mirror");

    // Warning route: deferred during quiet hours, grouped ≤15m.
    const warn = routes.find((r) => hasMatcher(r, 'severity="warning"'));
    expect(warn, "warning route").toBeDefined();
    expect(warn!.mute_time_intervals).toContain("quiet-hours");
    expect(warn!.group_interval).toBe("15m"); // REQ-SEV-03

    // Info route: gated to the daily 09:00 active window.
    const info = routes.find((r) => hasMatcher(r, 'severity="info"'));
    expect(info, "info route").toBeDefined();
    expect(info!.active_time_intervals).toContain("daily-0900"); // REQ-SEV-04
  });

  test("an estate without quiet hours carries no warning mute", () => {
    const out = buildAlertingConfig(loadFixtureInput("single-service"));
    const cfg = parse(out.alertmanagerConfig) as { route: { routes: Array<Record<string, unknown>> } };
    const warn = cfg.route.routes.find((r) => hasMatcher(r, 'severity="warning"'));
    expect(warn!.mute_time_intervals).toBeUndefined();
  });
});

// ── §5.5 Whole-or-nothing & findings ─────────────────────────────────────────────────────────────

describe("whole-or-nothing & findings (§5.5)", () => {
  test("no-human-channel estate fails whole-or-nothing (NO_HUMAN_CHANNEL, empty config)", () => {
    const out = buildAlertingConfig(loadFixtureInput("no-channel"));
    const finding = out.findings.find((f) => f.code === "NO_HUMAN_CHANNEL");
    expect(finding, "NO_HUMAN_CHANNEL finding").toBeDefined();
    expect(finding!.severity).toBe("error");
    expect(finding!.fix.length).toBeGreaterThan(0); // actionable (REQ-CONFIG-02)
    expect(out.alertmanagerConfig).toBe("");
    expect(out.deepHealthRules).toBe("");
    expect(out.backupRules).toBe("");
  });

  test("webhook-only estate yields WEBHOOK_ONLY_CRITICAL (improvement) and a valid config", () => {
    const out = buildAlertingConfig(loadFixtureInput("webhook-only"));
    const finding = out.findings.find((f) => f.code === "WEBHOOK_ONLY_CRITICAL");
    expect(finding, "WEBHOOK_ONLY_CRITICAL finding").toBeDefined();
    expect(finding!.severity).toBe("improvement");
    expect(out.findings.some((f) => f.severity === "error")).toBe(false);
    expect(out.alertmanagerConfig.length).toBeGreaterThan(0); // config still produced
  });
});

// ── §5.6 DeadMansSwitch route ────────────────────────────────────────────────────────────────────

describe("DeadMansSwitch route (§5.6)", () => {
  test("multi-service deadman route is isolated, 5m cadence, ${VAR} webhook, no human receiver", () => {
    const out = buildAlertingConfig(loadFixtureInput("multi-service"));
    const cfg = parse(out.alertmanagerConfig) as {
      route: { routes: Array<Record<string, unknown>> };
      receivers: Array<{ name: string; webhook_configs?: Array<Record<string, unknown>> }>;
    };

    const dead = cfg.route.routes.find((r) => hasMatcher(r, 'alertname="DeadMansSwitch"'));
    expect(dead, "deadman route").toBeDefined();
    expect(dead!.receiver).toBe("pulse-deadman"); // REQ-DEAD-01 (isolated receiver)
    expect(dead!.repeat_interval).toBe("5m"); // REQ-DEAD-02
    expect(dead!.group_interval).toBe("1m");
    expect(dead!.continue).toBe(false); // never falls through to a human route (REQ-DEAD-03)

    const deadRcv = cfg.receivers.find((r) => r.name === "pulse-deadman");
    expect(deadRcv, "pulse-deadman receiver").toBeDefined();
    const wh = deadRcv!.webhook_configs?.[0];
    expect(wh!.url).toBe("${PULSE_DEADMANSSWITCH_URL}"); // a ${VAR} ref, never a literal (REQ-SEC-01)
    expect(wh!.send_resolved).toBe(false);

    // The deadman route is composed with NO human receiver: its only matcher is the alertname.
    expect(dead!.matchers).toEqual(['alertname="DeadMansSwitch"']);
    expect(dead!.routes).toBeUndefined();
  });
});

// ── §5.7 Suppressions → inhibit rules ────────────────────────────────────────────────────────────

describe("suppressions → inhibit rules (§5.7)", () => {
  test("a known-expected suppression generates a scoped inhibit rule", () => {
    const out = buildAlertingConfig(loadFixtureInput("suppressions"));
    expect(out.findings.some((f) => f.severity === "error")).toBe(false);
    const cfg = parse(out.alertmanagerConfig) as {
      inhibit_rules?: Array<{ source_matchers?: string[]; target_matchers?: string[] }>;
    };
    const rules = cfg.inhibit_rules ?? [];
    expect(rules.length).toBeGreaterThan(0);
    // The known-expected `service="quiet-db"` suppression is realized as a target matcher.
    const scoped = rules.find((r) => (r.target_matchers ?? []).includes('service="quiet-db"'));
    expect(scoped, "scoped inhibit rule for quiet-db").toBeDefined();
  });

  test("a rationale-less known-expected suppression yields MISSING_RATIONALE (error)", () => {
    const base = loadFixtureInput("suppressions");
    const mutated = {
      ...base,
      estate: {
        ...base.estate,
        suppressions: base.estate.suppressions.map((s) => ({ ...s, rationale: "" })),
      },
    };
    const out = buildAlertingConfig(mutated);
    const finding = out.findings.find((f) => f.code === "MISSING_RATIONALE");
    expect(finding, "MISSING_RATIONALE finding").toBeDefined();
    expect(finding!.severity).toBe("error");
    expect(out.alertmanagerConfig).toBe(""); // whole-or-nothing
  });

  test("an expected-churn host generates a churn-only inhibit rule", () => {
    const out = buildAlertingConfig(loadFixtureInput("expected-churn"));
    expect(out.findings.some((f) => f.severity === "error")).toBe(false);
    const cfg = parse(out.alertmanagerConfig) as {
      inhibit_rules?: Array<{ target_matchers?: string[] }>;
    };
    const churn = (cfg.inhibit_rules ?? []).find((r) =>
      (r.target_matchers ?? []).some((m) => m.includes("ContainerRestarting")),
    );
    expect(churn, "expected-churn inhibit rule").toBeDefined();
    expect(churn!.target_matchers).toContain('host="churn-host"');
    expect(churn!.target_matchers).toContain('alertname=~"ContainerRestarting|ContainerChurn"');
  });
});

// ── §5.10 Secret-safety scan of generated YAML ───────────────────────────────────────────────────

describe("secret-safety scan of generated YAML (§5.10)", () => {
  /** Credential-literal deny-list (a resolved secret / real-provider shape must NEVER appear). */
  const DENY: Array<[string, RegExp]> = [
    ["slack bot/user token", /xox[baprs]-[A-Za-z0-9-]+/],
    ["slack webhook literal", /hooks\.slack\.com/],
    ["opsgenie/pagerduty host", /(api\.opsgenie\.com|events\.pagerduty\.com)/],
    ["url-embedded userinfo credential", /:\/\/[^/@\s"']+:[^/@\s"']+@/],
    ["bearer token literal", /Bearer\s+[A-Za-z0-9._-]{8,}/],
    ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["resolved op secret value", /op:\/\/[^\s"']*\s*=\s*\S/],
  ];

  test("no generated YAML embeds a credential literal or real-provider host", () => {
    for (const name of FIXTURES) {
      const out = buildAlertingConfig(loadFixtureInput(name));
      const blob = [out.alertmanagerConfig, out.deepHealthRules, out.backupRules].join("\n");
      for (const [label, pattern] of DENY) {
        expect(pattern.test(blob), `${name}: generated YAML must not contain a ${label}`).toBe(false);
      }
    }
  });

  test("every secret-bearing value in the multi-service config is a ${VAR}/op:// reference", () => {
    const out = buildAlertingConfig(loadFixtureInput("multi-service"));
    // The only secret-shaped tokens the config carries are ${VAR} env references.
    const refs = out.alertmanagerConfig.match(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    // Confirm the two product-static ${VAR} references are present and unresolved.
    expect(out.alertmanagerConfig).toContain("${PULSE_DEADMANSSWITCH_URL}");
    expect(out.alertmanagerConfig).toContain("${PULSE_WEBHOOK_MIRROR_URL}");
  });
});

// ── runbook_url annotations + notification templates (issue #16) ───────────────────────────────────

describe("runbook links (issue #16)", () => {
  test("dynamic rule families carry a runbook_url annotation", () => {
    const out = buildAlertingConfig(loadFixtureInput("multi-service"));
    expect(out.deepHealthRules).toContain("runbook_url: https://runbooks.pulse.local/deep-health");
    expect(out.backupRules).toContain("runbook_url: https://runbooks.pulse.local/backup-freshness");
  });

  test("the AM config registers the notification templates glob", () => {
    const out = buildAlertingConfig(loadFixtureInput("multi-service"));
    const cfg = parse(out.alertmanagerConfig) as { templates?: string[] };
    expect(cfg.templates).toEqual(["/etc/alertmanager/templates/*.tmpl"]);
  });

  test("email receiver body references the runbook template; the credential ref is preserved", () => {
    const out = buildAlertingConfig(loadFixtureInput("multi-service"));
    const cfg = parse(out.alertmanagerConfig) as {
      receivers: Array<{ name: string; email_configs?: Array<Record<string, unknown>> }>;
    };
    const email = cfg.receivers.find((r) => r.email_configs)?.email_configs?.[0];
    expect(email?.html).toBe('{{ template "pulse.email.html" . }}');
    expect(email?.auth_password).toBe("${SMTP_PASSWORD}"); // secret ref untouched (REQ-SEC-01)
  });

  test("telegram receiver body references the runbook template; the bot_token ref is preserved", () => {
    const out = buildAlertingConfig(loadFixtureInput("telegram"));
    const cfg = parse(out.alertmanagerConfig) as {
      receivers: Array<{ name: string; telegram_configs?: Array<Record<string, unknown>> }>;
    };
    const tg = cfg.receivers.find((r) => r.telegram_configs)?.telegram_configs?.[0];
    expect(tg?.message).toBe('{{ template "pulse.telegram.message" . }}');
    expect(tg?.parse_mode).toBe(""); // plain text — unescaped annotation text can't break delivery
    expect(tg?.bot_token).toBe("${TELEGRAM_BOT_TOKEN}"); // secret ref untouched (REQ-SEC-01)
  });
});

// ── alert-path delivery canary (issue #17) ─────────────────────────────────────────────────────────

describe("delivery canary route (issue #17)", () => {
  test("routes PulseAlertPathCanary to the live human receiver (not the deadman webhook)", () => {
    const out = buildAlertingConfig(loadFixtureInput("multi-service"));
    const cfg = parse(out.alertmanagerConfig) as {
      route: { routes: Array<Record<string, unknown>> };
      receivers: Array<{ name: string; email_configs?: unknown; telegram_configs?: unknown; slack_configs?: unknown }>;
    };
    const canary = cfg.route.routes.find((r) => hasMatcher(r, 'alertname="PulseAlertPathCanary"'));
    expect(canary, "canary route present").toBeDefined();
    expect(canary!.continue).toBe(false);
    expect(canary!.repeat_interval).toBe("6h");
    // Its target is a human receiver (has an email/telegram/slack slot), not the deadman webhook.
    const target = cfg.receivers.find((rc) => rc.name === canary!.receiver);
    expect(target, "canary target receiver resolves").toBeDefined();
    expect(
      Boolean(target!.email_configs || target!.telegram_configs || target!.slack_configs),
      "canary routes to a human channel, proving live delivery",
    ).toBe(true);
    expect(canary!.receiver).not.toBe("pulse-deadman");
  });
});

// ── §8 Scale sanity ──────────────────────────────────────────────────────────────────────────────

describe("scale sanity (§8)", () => {
  test("200 hosts / 2000 active alerts: grouping holds, critical path intact", () => {
    const out = buildAlertingConfig(generateScaleFixture({ hosts: 200, activeAlerts: 2000 }));
    expect(out.findings.every((f) => f.severity !== "error")).toBe(true);

    const cfg = parse(out.alertmanagerConfig) as {
      route: { group_by: string[]; routes: Array<Record<string, unknown>> };
    };
    // Grouping collapses the alert volume into grouped notifications (REQ-REL-01).
    expect(cfg.route.group_by).toEqual(["estate", "host", "service", "alertname"]);

    const crit = cfg.route.routes.find(
      (r) => hasMatcher(r, 'severity="critical"') && r.continue === true,
    );
    expect(crit, "critical route unaffected by estate size").toBeDefined();
    expect(crit!.group_wait).toBe("10s");
    expect(crit!.continue).toBe(true);

    // Both rendered rule families are produced for the large estate (no lifecycle class dropped).
    expect(out.deepHealthRules).toContain("DeepHealthFailed");
    expect(out.backupRules).toContain("BackupStale");
  });
});
