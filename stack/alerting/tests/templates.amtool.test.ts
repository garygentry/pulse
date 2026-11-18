// stack/alerting/tests/templates.amtool.test.ts
// Tier B (Docker-gated): renders the shipped notification templates
// (stack/compose/config/alertmanager/templates/pulse.tmpl) with the real `amtool template render`
// from the pinned Alertmanager image, against a group holding one firing and one resolved alert.
//
// Issue #87: receivers send resolved notices, and the Telegram body used to omit the alert's status,
// so a resolve read as a second, new page. Each alert now leads with its own FIRING/RESOLVED status.
//
// The suite opens with `const d = DOCKER_OK ? describe : describe.skip;` so plain `bun test` in a
// daemon-less environment stays GREEN.
/// <reference path="./bun-test.d.ts" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AMTOOL_IMAGE, DOCKER_OK, run } from "./harness.js";
import { REPO_ROOT } from "./paths.js";

const d = DOCKER_OK ? describe : describe.skip;

const TEMPLATES_DIR = resolve(REPO_ROOT, "stack", "compose", "config", "alertmanager", "templates");

const alert = (status: "firing" | "resolved", alertname: string, runbook?: string) => ({
  status,
  labels: { alertname, severity: "critical" },
  annotations: {
    summary: `${alertname} summary`,
    description: `${alertname} description`,
    ...(runbook ? { runbook_url: runbook } : {}),
  },
  startsAt: "2026-11-17T10:00:00Z",
  endsAt: status === "resolved" ? "2026-11-17T10:01:00Z" : "0001-01-01T00:00:00Z",
  generatorURL: "",
  fingerprint: alertname,
});

/** A mixed group: the group status is firing, but one member alert has resolved. */
const DATA = {
  receiver: "pulse-critical",
  status: "firing",
  alerts: [
    alert("firing", "UPSOnBattery", "https://runbooks.pulse.local/availability"),
    alert("resolved", "HostDown"),
  ],
  groupLabels: {},
  commonLabels: { severity: "critical" },
  commonAnnotations: {},
  externalURL: "http://alertmanager.invalid",
};

d("notification templates — amtool template render (Tier B)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pulse-amtpl-"));
    writeFileSync(join(dir, "data.json"), JSON.stringify(DATA));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const render = (name: string, type: "text" | "html") => {
    const res = run([
      "docker", "run", "--rm",
      "-v", `${TEMPLATES_DIR}:/tpl:ro`,
      "-v", `${join(dir, "data.json")}:/data/data.json:ro`,
      "--entrypoint", "amtool", AMTOOL_IMAGE,
      "template", "render",
      "--template.glob=/tpl/*.tmpl",
      `--template.text={{ template "${name}" . }}`,
      `--template.type=${type}`,
      "--template.data=/data/data.json",
    ]);
    expect(res.exitCode, res.stdout + res.stderr).toBe(0);
    return res.stdout;
  };

  test("telegram body leads each alert with its own status (issue #87)", () => {
    const out = render("pulse.telegram.message", "text");
    expect(out).toContain("🔥 FIRING — UPSOnBattery: UPSOnBattery summary\nUPSOnBattery description\nRunbook: https://runbooks.pulse.local/availability");
    expect(out).toContain("✅ RESOLVED — HostDown: HostDown summary\nHostDown description");
    expect(out).not.toContain("HostDown description\nRunbook:"); // no runbook_url → no runbook line
  }, 120_000);

  test("email body heads each alert with its own status", () => {
    const out = render("pulse.email.html", "html");
    expect(out).toContain("🔥 FIRING — UPSOnBattery — UPSOnBattery summary</h3>");
    expect(out).toContain("✅ RESOLVED — HostDown — HostDown summary</h3>");
    expect(out).toContain('<a href="https://runbooks.pulse.local/availability">Open runbook</a>');
  }, 120_000);
});
