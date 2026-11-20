// stack/alerting/tests/push-receiver.amtool.test.ts
// Tier B (Docker-gated, the DOCKER_OK pattern): proves examples/alertmanager/push-receiver.yml is a
// valid Alertmanager fragment by merging it into a minimal config and running `amtool check-config`,
// then proves the push route fans out WITHOUT displacing the existing receiver.
/// <reference path="./bun-test.d.ts" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { AMTOOL_IMAGE, DOCKER_OK, run } from "./harness.js";
import { REPO_ROOT } from "./paths.js";

const d = DOCKER_OK ? describe : describe.skip;

const EXAMPLE = resolve(REPO_ROOT, "examples", "alertmanager", "push-receiver.yml");
/** The path the example names. A placeholder file is mounted there so the reference resolves. */
const CREDENTIALS_PATH = "/etc/alertmanager/secrets/pulse-push-webhook";

interface Fragment {
  route: { routes: Array<Record<string, unknown>> };
  receivers: Array<{ name: string } & Record<string, unknown>>;
}

/**
 * Merge the example into a minimal config: root receiver `default-sink` (a null receiver), the example's
 * routes first, then one existing-style child route for `severity="critical"` → `ops-sink`, then the
 * catch-all `default-sink` child route the example tells operators to add last (once the push route
 * has matched, Alertmanager no longer falls back to the root receiver).
 * @returns The merged config object.
 */
export function mergeExample(fragment: Fragment): Record<string, unknown> {
  return {
    route: {
      receiver: "default-sink",
      group_by: ["alertname"],
      routes: [
        ...fragment.route.routes,
        { receiver: "ops-sink", matchers: ['severity="critical"'] },
        { receiver: "default-sink" },
      ],
    },
    receivers: [{ name: "default-sink" }, { name: "ops-sink" }, ...fragment.receivers],
  };
}

d("example push receiver — amtool (Tier B)", () => {
  let dir: string;
  let cfg: string;
  let cred: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pulse-push-amtool-"));
    cfg = join(dir, "alertmanager.yml");
    cred = join(dir, "pulse-push-webhook");
    writeFileSync(cfg, stringify(mergeExample(parse(readFileSync(EXAMPLE, "utf8")) as Fragment)));
    writeFileSync(cred, "test-placeholder-not-a-secret");
    chmodSync(dir, 0o755); // the image's non-root user must traverse the mount
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const amtool = (...args: string[]) =>
    run([
      "docker", "run", "--rm",
      "-v", `${cfg}:/cfg/alertmanager.yml:ro`,
      "-v", `${cred}:${CREDENTIALS_PATH}:ro`,
      "--entrypoint", "amtool", AMTOOL_IMAGE, ...args,
    ]);

  test("check-config accepts the merged example", () => {
    const res = amtool("check-config", "/cfg/alertmanager.yml");
    expect(res.exitCode, res.stdout + res.stderr).toBe(0);
  }, 120_000);

  test("push is offered first and the existing route still matches (continue: true)", () => {
    const out = amtool("config", "routes", "test", "--config.file=/cfg/alertmanager.yml",
      "severity=critical", "alertname=HostDown").stdout.trim();
    expect(out).toContain("pulse-push");
    expect(out).toContain("ops-sink");
  }, 120_000);

  test("an unmatched alert reaches both push and the root receiver", () => {
    const out = amtool("config", "routes", "test", "--config.file=/cfg/alertmanager.yml",
      "alertname=Whatever").stdout.trim();
    expect(out).toContain("pulse-push");
    expect(out).toContain("default-sink");
  }, 120_000);
});

/** Tier A (always runs): the example's shape, without Docker. */
describe("example push receiver — static shape", () => {
  const frag = parse(readFileSync(EXAMPLE, "utf8")) as Fragment;
  test("first child route is pulse-push with continue and no matchers", () => {
    expect(frag.route.routes[0]).toEqual({ receiver: "pulse-push", continue: true });
  });
  test("receiver fields are exact", () => {
    const r = frag.receivers.find((x) => x.name === "pulse-push") as Record<string, unknown>;
    expect(r).toEqual({
      name: "pulse-push",
      webhook_configs: [{
        url: "http://web:8080/api/push/alertmanager",
        send_resolved: true,
        max_alerts: 500,
        http_config: { authorization: { type: "Bearer", credentials_file: CREDENTIALS_PATH } },
      }],
    });
  });
});
