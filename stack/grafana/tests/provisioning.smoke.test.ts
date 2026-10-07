/**
 * Tier B — provisioning smoke test (05-testing-strategy.md §3; REQ-VERIF-01 check 5, REQ-OBS-01).
 *
 * DOCKER TIER. Brings the stack-core engine UP against a dashboards-owned seeded fixture
 * (fixtures/estate/seed.prom, §4) via `docker compose up --wait`, then probes the running Grafana
 * for: the additive Alertmanager datasource is healthy, every board UID resolves, the four folders
 * exist, no provisioning error appears in the Grafana logs, and the host/hypervisor target
 * variables populate from the fixture labels (web01 / pve1).
 *
 * CRITICAL — self-skip when Docker is unavailable: plain `bun test` discovers this file too. If NO
 * Docker daemon is reachable, the ENTIRE suite registers under `describe.skip` so a Docker-less
 * `bun run smoke` (and thus `bun test`) stays green. Mirrors stack/tests/bringup.smoke.test.ts.
 *
 * NO cross-project import: BOARD_UIDS / FOLDERS / ALERTMANAGER_DS_UID come from this feature's own
 * ./guards.js. The compose path, env conventions, and the in-stack curl-sidecar probe vehicle are
 * REPLICATED locally from stack-core's harness/bringup patterns — the pattern, not a package
 * dependency (01-architecture-layout.md's "no cross-package runtime import" posture).
 */

/// <reference path="./bun-test.d.ts" />

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALERTMANAGER_DS_UID, BOARD_UIDS, FOLDER_DIRS, FOLDERS } from "./guards.js";

/* ===========================================================================================
 * Spawn helper (replicated from stack/tests/harness.ts `run`) — node:child_process, no dependency.
 * ========================================================================================= */

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run a command to completion, capturing streams. Never throws on non-zero exit. */
function run(argv: string[], env: Record<string, string> = {}): Ran {
  const [cmd, ...rest] = argv;
  const p = spawnSync(cmd ?? "", rest, {
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024, // `docker compose logs` can be large
  });
  return {
    status: p.status ?? 1,
    stdout: p.stdout ?? "",
    stderr: p.stderr ?? "",
  };
}

/* ===========================================================================================
 * Docker-daemon self-skip (mirrors bringup.smoke.test.ts): `docker version` contacts the daemon
 * and exits non-zero when it cannot connect; a missing CLI makes spawn's status null → 1. Either
 * way "no Docker" ⇒ the whole suite registers under describe.skip and plain `bun test` stays green.
 * ========================================================================================= */

function dockerDaemonReachable(): boolean {
  try {
    return run(["docker", "version"]).status === 0;
  } catch {
    return false; // CLI binary not found → not reachable
  }
}

const DOCKER_OK = dockerDaemonReachable();
/**
 * Run the Docker tier only under an explicit opt-in (`PULSE_SMOKE=1`, set by `bun run smoke`).
 * A plain `bun test` always skips it — even with a daemon present — so the tier runs exactly
 * once per gate (in `bun run smoke`) instead of twice, and an interrupted default `bun test`
 * never leaks `pulse-test-*` compose resources.
 */
const SMOKE_ENABLED = DOCKER_OK && process.env.PULSE_SMOKE === "1";
/** Skip the entire suite (bring-up + every probe + hooks) unless the Docker tier is enabled. */
const smokeDescribe = SMOKE_ENABLED ? describe : describe.skip;

/* ===========================================================================================
 * Compose + in-stack probe vehicles (replicated locally — 05 §3.2).
 * ========================================================================================= */

/** stack-core's committed engine tree (the compose file we bring up). */
const COMPOSE_FILE = resolve(import.meta.dir, "..", "..", "compose", "docker-compose.yml");
/** stack-core's seeded rendered tree — makes the seven default-profile services boot healthy. */
const FIXTURE_RENDERED_DIR = resolve(import.meta.dir, "..", "..", "tests", "fixtures", "rendered");
/** This feature's seeded estate metric series (§4) — pushed into VM after bring-up. */
const SEED_FILE = resolve(import.meta.dir, "fixtures", "estate", "seed.prom");

/** Placeholder interpolation env (never real secrets) — mirrors harness.ts FIXTURE_ENV. */
const FIXTURE_ENV: Record<string, string> = {
  PULSE_RENDERED_DIR: FIXTURE_RENDERED_DIR,
  PVE_TOKEN: "placeholder-not-a-secret",
  PULSE_VM_RETENTION: "6",
};

/**
 * Unique test-only project identity. Keep this local: the dashboard verification package mirrors
 * stack-core's test pattern without importing another project's harness.
 */
const TEST_PROJECT = `pulse-test-dashboards-${process.pid}-${randomUUID()}`;

/** Run a `docker compose` subcommand against the isolated test project. */
const composeEnv = (env: Record<string, string>, ...args: string[]): Ran =>
  run(["docker", "compose", "-p", TEST_PROJECT, "-f", COMPOSE_FILE, ...args], env);
/** Default-fixture compose (green path). */
const compose = (...args: string[]): Ran => composeEnv(FIXTURE_ENV, ...args);

/** In-stack probe vehicle: a one-shot pinned curl container on the isolated project's network.
 * Reaches internal `service:port` DNS without publishing host ports. `-g` disables curl URL
 * globbing so `match[]=` query params pass through. */
const CURL_IMAGE = "curlimages/curl:8.11.1";
const NETWORK = `${TEST_PROJECT}_pulse`;

function inStackGet(url: string, auth?: string): { ok: boolean; body: string } {
  const res = run([
    "docker", "run", "--rm", "--network", NETWORK, CURL_IMAGE,
    "-sS", "-g", "--max-time", "10", ...(auth ? ["-u", auth] : []), url,
  ]);
  return { ok: res.status === 0, body: res.stdout };
}

/** HTTP status code of an in-stack GET (curl does not fail on 4xx/5xx without -f, so read the code). */
function inStackStatus(url: string, auth?: string): number {
  const res = run([
    "docker", "run", "--rm", "--network", NETWORK, CURL_IMAGE,
    "-sS", "-g", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10",
    ...(auth ? ["-u", auth] : []), url,
  ]);
  return Number.parseInt(res.stdout.trim(), 10) || 0;
}

/** Push a Prometheus text-exposition body into VictoriaMetrics' import endpoint via the sidecar. */
function seedVictoriaMetrics(body: string): { ok: boolean; body: string } {
  const res = run([
    "docker", "run", "--rm", "--network", NETWORK, CURL_IMAGE,
    "-sS", "-g", "--max-time", "20", "--data-binary", body,
    "http://victoriametrics:8428/api/v1/import/prometheus",
  ]);
  return { ok: res.status === 0, body: res.stdout + res.stderr };
}

/** Grafana admin bootstrap creds — the compose defaults (`${GF_ADMIN_PASSWORD:-admin}`). */
const GRAFANA_AUTH = "admin:admin";

/** Poll a synchronous predicate until it holds or the deadline elapses (blocking `sleep` between
 *  tries — the smoke tier is serialized around docker). Mirrors harness.ts pollUntil, but wall-clock
 *  is measured by counting attempts * stepMs (Date.now() is unavailable in some sandboxes; a fixed
 *  attempt budget is deterministic and dependency-free). */
function pollUntil(predicate: () => boolean, attempts: number, stepMs: number): boolean {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return true;
    run(["sleep", String(stepMs / 1000)]);
  }
  return predicate();
}

/** Resolve the provisioned VictoriaMetrics datasource uid (stack-core provisions it by name). */
function grafanaVmUid(): string {
  const res = inStackGet("http://grafana:3000/api/datasources/name/VictoriaMetrics", GRAFANA_AUTH);
  if (!res.ok) return "";
  try {
    return (JSON.parse(res.body) as { uid?: string }).uid ?? "";
  } catch {
    return "";
  }
}

/** label_values(<metric>, <label>) as Grafana resolves it — through the provisioned VM datasource
 *  proxy — proving the board's target variable would populate from the seeded fixture labels. */
function labelValuesViaGrafana(vmUid: string, metric: string, label: string): string[] {
  const url =
    `http://grafana:3000/api/datasources/proxy/uid/${vmUid}` +
    `/api/v1/label/${label}/values?match[]=${metric}`;
  const res = inStackGet(url, GRAFANA_AUTH);
  if (!res.ok) return [];
  try {
    return (JSON.parse(res.body) as { data?: string[] }).data ?? [];
  } catch {
    return [];
  }
}

/* ===========================================================================================
 * Bring-up + probes (05 §3.2 / §3.3)
 * ========================================================================================= */

smokeDescribe("Tier B — provisioning smoke (REQ-VERIF-01 #5, REQ-OBS-01)", () => {
  // Bring the default-profile engine up against the seeded fixture, then push the estate series
  // into VictoriaMetrics so the host/hypervisor variables can populate from real labels (§4).
  beforeAll(() => {
    // Bring the stack up DETACHED, then gate on Grafana readiness with our own budget instead of
    // `up --wait`. `up --wait` honors the container's healthcheck budget (start_period + retries);
    // on a slow-disk host Grafana's initial SQLite migration runs long enough to exhaust that budget
    // and abort bring-up before a slow-but-healthy Grafana finishes booting. Polling `/api/health`
    // for 200 lets the transient unhealthy→healthy flip resolve within the tolerance we intend here.
    const up = compose("up", "-d");
    if (up.status !== 0) {
      throw new Error(
        `compose up -d failed (exit ${up.status}).\n` +
          `── ps ──\n${compose("ps", "-a").stdout}\n── up stderr ──\n${up.stderr}`,
      );
    }
    const ready = pollUntil(
      () => inStackStatus("http://grafana:3000/api/health", GRAFANA_AUTH) === 200,
      30,
      5_000,
    );
    if (!ready) {
      throw new Error(
        `Grafana did not become ready (GET /api/health 200) within the readiness budget.\n` +
          `── ps ──\n${compose("ps", "-a").stdout}\n── grafana logs ──\n${compose("logs", "grafana").stdout}`,
      );
    }
    const seeded = seedVictoriaMetrics(readFileSync(SEED_FILE, "utf8"));
    if (!seeded.ok) {
      throw new Error(`failed to seed VictoriaMetrics from ${SEED_FILE}: ${seeded.body}`);
    }
  }, 300_000); // generous bound: image pulls + start_period budgets

  // GUARANTEED checked teardown — cleanup failures make the suite red, never leak silently.
  afterAll(() => {
    const down = compose("down", "-v", "--remove-orphans");
    if (down.status !== 0) {
      throw new Error(`compose cleanup failed for ${TEST_PROJECT}: ${down.stderr}`);
    }
  }, 120_000);

  test("Alertmanager datasource is provisioned & reachable (REQ-ALERT-02, SUCCESS-04)", () => {
    // The alertmanager datasource type has no backend CheckHealth in Grafana 11.4 — its `/health`
    // endpoint returns `plugin.unavailable` (500). So prove REQ-ALERT-02 the way that actually
    // holds for this DS type: the DS resolves by its stable uid (provisioned), and Grafana reaches
    // the live Alertmanager through the provisioned DS proxy (`/api/v2/status` → 200).
    const provisioned = pollUntil(
      () => inStackStatus(`http://grafana:3000/api/datasources/uid/${ALERTMANAGER_DS_UID}`, GRAFANA_AUTH) === 200,
      15,
      2_000,
    );
    expect(provisioned, `Alertmanager datasource ${ALERTMANAGER_DS_UID} was not provisioned`).toBe(true);
    const reachable = pollUntil(
      () =>
        inStackStatus(
          `http://grafana:3000/api/datasources/proxy/uid/${ALERTMANAGER_DS_UID}/api/v2/status`,
          GRAFANA_AUTH,
        ) === 200,
      15,
      2_000,
    );
    expect(reachable, "Grafana could not reach Alertmanager through the provisioned datasource").toBe(true);
  }, 60_000);

  test("every board UID resolves via GET /api/dashboards/uid/<uid> (SUCCESS-01, SUCCESS-03)", () => {
    for (const uid of BOARD_UIDS) {
      const ok = pollUntil(
        () => {
          const res = inStackGet(`http://grafana:3000/api/dashboards/uid/${uid}`, GRAFANA_AUTH);
          if (!res.ok) return false;
          try {
            return (JSON.parse(res.body) as { dashboard?: { uid?: string } }).dashboard?.uid === uid;
          } catch {
            return false;
          }
        },
        15,
        2_000,
      );
      expect(ok, `board ${uid} did not resolve — provisioning likely failed`).toBe(true);
    }
  }, 120_000);

  test("the four folders exist (REQ-FOLDER-01, SUCCESS-01)", () => {
    // With `foldersFromFilesStructure: true`, Grafana names each folder after its on-disk directory
    // (FOLDER_DIRS values: hosts/deep-health/infrastructure/engine) verbatim — NOT the title-case
    // FOLDERS display names. Assert the four dir-derived titles, one per FOLDERS entry.
    const expectedFolders = FOLDERS.map((f) => FOLDER_DIRS[f]);
    let titles = new Set<string>();
    const ok = pollUntil(
      () => {
        const res = inStackGet("http://grafana:3000/api/search?type=dash-folder", GRAFANA_AUTH);
        if (!res.ok) return false;
        try {
          titles = new Set((JSON.parse(res.body) as { title: string }[]).map((f) => f.title));
        } catch {
          return false;
        }
        return expectedFolders.every((f) => titles.has(f));
      },
      15,
      2_000,
    );
    expect(ok, `missing folder(s); expected ${expectedFolders.join(", ")}; found: ${[...titles].join(", ")}`).toBe(true);
  }, 60_000);

  test("no provisioning error in the Grafana logs (REQ-OBS-01)", () => {
    const logs = compose("logs", "grafana").stdout;
    // REQ-OBS-01: a malformed board/datasource must surface as a `level=error` line from the
    // provisioner that reads it — `logger=provisioning.dashboard` / `provisioning.datasources`.
    // Scope to those two provisioners: Grafana ALWAYS logs `level=error` for the absent optional
    // `provisioning/plugins` and `provisioning/alerting` directories (stack-core's mount ships
    // neither), and those benign, environmental lines are not this feature's concern.
    const offending = logs
      .split("\n")
      .filter((l) => /logger=provisioning\.(dashboard|datasource)/i.test(l) && /level=error/i.test(l));
    expect(offending, `provisioning error line(s):\n${offending.join("\n")}`).toEqual([]);
  }, 60_000);

  test("host & hypervisor instance variables populate from fixture labels (web01/pve1) — SUCCESS-02", () => {
    const ok = pollUntil(
      () => {
        const uid = grafanaVmUid();
        if (!uid) return false;
        const hostInstances = labelValuesViaGrafana(uid, "node_uname_info", "instance");
        const hvInstances = labelValuesViaGrafana(uid, "pve_up", "instance");
        return hostInstances.includes("web01") && hvInstances.includes("pve1");
      },
      20,
      3_000,
    );
    expect(
      ok,
      "expected pulse-host `instance` to include web01 and pulse-hypervisor `instance` to include pve1",
    ).toBe(true);
  }, 90_000);
});
