// stack/alerting/tests/rules.promtool.test.ts
// Tier B (Docker-gated, hermetic — 06 §3): drives `promtool test rules` over deterministic fixtures
// that inject synthetic series and assert each rule's firing state, severity/identity labels, and
// `for`/NoData timing. Covers all SIX static families (availability, capacity, engine,
// pipeline-health, churn, deadman — 06 §11.3) plus the rendered deep-health functional family.
//
// promtool is a TEST-ONLY tool (PROMTOOL_IMAGE, a pinned Prometheus image); it is NEVER wired into
// the VM/vmalert runtime compose tree (CON-04). vmalert rules are Prometheus rule-format, so
// `promtool test rules` validates and unit-tests them directly.
//
// The suite opens with `const d = DOCKER_OK ? describe : describe.skip;` so plain `bun test` in a
// daemon-less environment stays GREEN (the Tier-B tier self-skips). The backup-freshness block is
// additionally gated behind `backupMetricDelivered()` (06 §10) — a VISIBLE SKIP (PENDING) until
// host-agent delivers the required series, activatable with no test-body edits.
/// <reference path="./bun-test.d.ts" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAlertingConfig } from "../src/index.js";
import {
  AGENT_METRICS_JSON,
  DOCKER_OK,
  PROMTOOL_FIXTURE_DIR,
  PROMTOOL_IMAGE,
  STATIC_RULES_DIR,
  backupMetricDelivered,
  loadFixtureInput,
  run,
} from "./harness.js";

const d = DOCKER_OK ? describe : describe.skip;

/**
 * Assemble a temp workspace holding (a) the committed static rule families, (b) the deep-health.yml /
 * backup.yml rendered by `buildAlertingConfig` for the multi-service fixture estate, and (c) the
 * promtool `test rules` fixture YAMLs — all in one flat directory so each fixture's `rule_files:`
 * paths (relative to the test file) resolve. `promtool test rules` runs against `/w/<file>`.
 */
function assembleWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "pulse-promtool-"));
  cpSync(STATIC_RULES_DIR, workspace, { recursive: true }); // (a) static families
  const out = buildAlertingConfig(loadFixtureInput("multi-service")); // (b) rendered families
  writeFileSync(join(workspace, "deep-health.yml"), out.deepHealthRules);
  writeFileSync(join(workspace, "backup.yml"), out.backupRules);
  cpSync(PROMTOOL_FIXTURE_DIR, workspace, { recursive: true }); // (c) promtool test YAMLs
  // `mkdtempSync` yields a 0700 dir the pinned image's non-root user cannot traverse when mounted;
  // widen it so `promtool` (running as `nobody`) can read the mounted rule/test files.
  chmodSync(workspace, 0o755);
  return workspace;
}

/** Run `promtool test rules /w/<file>` in the pinned Prometheus image against a mounted workspace. */
function promtoolTest(workspace: string, file: string) {
  return run([
    "docker", "run", "--rm", "-v", `${workspace}:/w:ro`,
    "--entrypoint", "promtool", PROMTOOL_IMAGE,
    "test", "rules", `/w/${file}`,
  ]);
}

d("promtool rule unit tests (Tier B)", () => {
  let workspace: string;
  beforeAll(() => {
    workspace = assembleWorkspace();
  });
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  // All six static families (availability, capacity, engine, pipeline-health, churn, deadman) plus
  // the rendered deep-health functional family (06 §11.3).
  for (const file of [
    "hostdown.test.yaml",
    "capacity.test.yaml",
    "deep-health.test.yaml",
    "engine.test.yaml",
    "pipeline.test.yaml",
    "churn.test.yaml",
    "deadman.test.yaml",
    "canary.test.yaml",
  ]) {
    test(`promtool test rules ${file}`, () => {
      const res = promtoolTest(workspace, file);
      expect(res.exitCode, res.stdout + res.stderr).toBe(0);
    }, 120_000);
  }
});

// ── §10 backup-freshness block — capability-GATED on host-agent delivering the series ─────────────
//
// `backupMetricDelivered()` is now TRUE: the committed agent metric contract carries the `command`
// family with `pulse_backup_freshness_age_seconds` + `pulse_backup_freshness_up` (issue #3 — the
// per-host command-exporter delivers them). So this activates (subject to DOCKER_OK, since it drives
// promtool) with NO test-body edits — exactly the activation-on-delivery mechanism the gate was built
// for. It self-skips only when Docker is absent.
const backupDescribe = backupMetricDelivered() ? d : describe.skip;
backupDescribe("backup-freshness rules (GATED on host-agent, REQ-BACKUP-01..03)", () => {
  let workspace: string;
  beforeAll(() => {
    workspace = assembleWorkspace();
  });
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  test("BackupStale/BackupCritical fire past threshold; BackupNoData on missing signal", () => {
    const res = promtoolTest(workspace, "backup.test.yaml");
    expect(res.exitCode, res.stdout + res.stderr).toBe(0);
  }, 120_000);
});

// ── backup capability-gate unit test (Tier A — always runs, no Docker) ────────────────────────────
//
// Proves the gate reads `families[].series[].name` (NOT a flat top-level `series` array) and flips to
// true when a synthetic backup family is injected into a fixture metrics.json — the activation-on-
// delivery mechanism for the host-agent V-001 gap. This is pure TS; it must run in every `bun test`.
describe("backupMetricDelivered capability gate (§10)", () => {
  test("committed contract now delivers the backup family → gate is true (issue #3)", () => {
    expect(backupMetricDelivered()).toBe(true);
  });

  test("injecting a synthetic backup family into a fixture metrics.json flips the gate to true", () => {
    const dir = mkdtempSync(join(tmpdir(), "pulse-backup-gate-"));
    try {
      const contract = JSON.parse(readFileSync(AGENT_METRICS_JSON, "utf8")) as {
        families: { kind: string; prefix: string; series: { name: string }[] }[];
      };
      contract.families.push({
        kind: "backup-freshness",
        prefix: "pulse_",
        series: [
          { name: "pulse_backup_freshness_age_seconds" },
          { name: "pulse_backup_freshness_up" },
        ],
      });
      const path = join(dir, "metrics.json");
      writeFileSync(path, JSON.stringify(contract));
      expect(backupMetricDelivered(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a partial backup family (only one of the two series) keeps the gate false", () => {
    const dir = mkdtempSync(join(tmpdir(), "pulse-backup-gate-partial-"));
    try {
      const contract = {
        contractVersion: 1,
        families: [
          {
            kind: "backup-freshness",
            prefix: "pulse_",
            series: [{ name: "pulse_backup_freshness_age_seconds" }], // missing _up
          },
        ],
      };
      const path = join(dir, "metrics.json");
      writeFileSync(path, JSON.stringify(contract));
      expect(backupMetricDelivered(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
