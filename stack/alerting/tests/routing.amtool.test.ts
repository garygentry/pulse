// stack/alerting/tests/routing.amtool.test.ts
// Tier B (Docker-gated, hermetic — 06 §4): validates the transform's native Alertmanager config with
// the real `amtool` (bundled in the pinned Alertmanager image) and asserts route-tree receiver
// selection. The config under test is produced by `buildAlertingConfig` for fixture estates and
// written to a temp file the container mounts read-only.
//
// Config prep (hermetic scaffolding — mirrors what compose/deploy supply at runtime): the transform
// intentionally emits `${VAR}` credential references (REQ-SEC-01) and no global SMTP settings, so
// before handing the config to amtool we (a) expand every `${VAR}` to a dummy loopback URL and
// (b) supply dummy global smtp_smarthost/smtp_from so an email receiver validates. Neither touches a
// real provider (REQ-TEST-01); both are the deploy-time values amtool needs to parse the structure.
//
// The suite opens with `const d = DOCKER_OK ? describe : describe.skip;` so plain `bun test` in a
// daemon-less environment stays GREEN.
/// <reference path="./bun-test.d.ts" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { buildAlertingConfig } from "../src/index.js";
import { RECEIVERS } from "../src/constants.js";
import { AMTOOL_IMAGE, DOCKER_OK, loadFixtureInput, run } from "./harness.js";

const d = DOCKER_OK ? describe : describe.skip;

/** Run one `amtool` subcommand against a mounted config. */
function amtool(cfgPath: string, ...args: string[]) {
  return run([
    "docker", "run", "--rm", "-v", `${cfgPath}:/cfg/alertmanager.yml:ro`,
    "--entrypoint", "amtool", AMTOOL_IMAGE, ...args,
  ]);
}

/**
 * Render a fixture's Alertmanager config, apply the hermetic deploy-time scaffolding (expand `${VAR}`
 * refs, supply dummy global SMTP), and write it to `dir/<fixture>.yml`. Returns the written path.
 */
function writeConfigFor(fixture: string, dir: string): string {
  const out = buildAlertingConfig(loadFixtureInput(fixture));
  const expanded = out.alertmanagerConfig.replace(/\$\{[A-Z0-9_]+\}/g, "https://example.invalid/hook");
  const cfg = parse(expanded) as { global?: Record<string, unknown>; [k: string]: unknown };
  cfg.global = {
    ...(cfg.global ?? {}),
    smtp_smarthost: "smtp.example.invalid:587",
    smtp_from: "alerts@example.invalid",
  };
  const path = join(dir, `${fixture}.yml`);
  writeFileSync(path, stringify(cfg));
  return path;
}

d("amtool routing (Tier B)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pulse-amtool-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  describe("config validity — amtool check-config", () => {
    for (const fixture of ["multi-service", "webhook-only", "single-service", "telegram"]) {
      test(`check-config accepts ${fixture}`, () => {
        const cfg = writeConfigFor(fixture, dir);
        const res = amtool(cfg, "check-config", "/cfg/alertmanager.yml");
        expect(res.exitCode, res.stdout + res.stderr).toBe(0);
      }, 120_000);
    }
  });

  describe("route selection — amtool config routes test", () => {
    /** Terminal receiver(s) amtool selects for a label set (comma-joined for a continue:true fan-out). */
    const routes = (cfg: string, ...labels: string[]) =>
      amtool(cfg, "config", "routes", "test", "--config.file=/cfg/alertmanager.yml", ...labels)
        .stdout.trim();

    test("critical → human receiver AND continues to the webhook mirror (REQ-SEV-02, REQ-HOOK-01)", () => {
      const cfg = writeConfigFor("multi-service", dir);
      const out = routes(cfg, "severity=critical", "alertname=HostDown", "estate=fixture-estate");
      expect(out, out).toContain("pulse-critical"); // rendered critical human receiver
      expect(out, out).toContain(RECEIVERS.webhookMirror); // continue:true fan-out to the mirror
    }, 120_000);

    test("warning → non-paging ops receiver (REQ-SEV-03)", () => {
      const cfg = writeConfigFor("multi-service", dir);
      expect(routes(cfg, "severity=warning", "alertname=HighCPU")).toContain("pulse-ops");
    }, 120_000);

    test("info → digest receiver (REQ-SEV-04)", () => {
      const cfg = writeConfigFor("multi-service", dir);
      expect(routes(cfg, "severity=info", "alertname=SomeInfo")).toContain(RECEIVERS.digest);
    }, 120_000);

    test("unmatched labels → default-ops fallback (REQ-ROUTE-04)", () => {
      const cfg = writeConfigFor("multi-service", dir);
      expect(routes(cfg, "alertname=Whatever")).toBe(RECEIVERS.defaultOps);
    }, 120_000);

    test("alertname=DeadMansSwitch → deadman receiver ONLY, no human path (REQ-DEAD-01/03)", () => {
      const cfg = writeConfigFor("multi-service", dir);
      const out = routes(cfg, "alertname=DeadMansSwitch");
      expect(out).toBe(RECEIVERS.deadman);
      expect(out).not.toContain("pulse-critical");
      expect(out).not.toContain(RECEIVERS.webhookMirror);
    }, 120_000);
  });
});
