/**
 * stack-core Tier-2 smoke test suite (06-testing-strategy.md §5).
 *
 * DOCKER TIER. This suite brings the default-profile engine UP against the seeded fixture
 * (§3) via `docker compose up --wait`, asserts every default-profile service is healthy, and
 * runs four in-stack functional probes (§5.4). It realizes the REQ-PERF-01 green bar (§7) and
 * the behavioral REQ-FAIL-01 "never silent-green" proof (§5.6).
 *
 * CRITICAL — self-skip when Docker is unavailable (item 008): plain `bun test` discovers this
 * file too. If NO Docker daemon is reachable, the ENTIRE suite skips itself (guarded describe)
 * so the per-item loop gate in a Docker-less env PASSES rather than failing or hanging. When a
 * daemon IS reachable, the suite runs for real.
 *
 * Types/constants/helpers come from ./harness (the single non-test support module, 00 §9).
 */

/// <reference path="./bun-test.d.ts" />

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  COMPOSE_FILE,
  composeNetworkName,
  createSmokeProjectName,
  DEFAULT_PROFILE_SERVICES,
  EXPECTED_RENDER_FORMAT_VERSION,
  FIXTURE_ENV,
  FIXTURE_RENDERED_DIR,
  run,
  smokeComposeArgs,
} from "./harness.js";
import type { FunctionalProbe, Ran, RenderedManifest, ServiceHealth } from "./harness.js";

/* ===========================================================================================
 * Docker-daemon self-skip (item 008 / 06 §5)
 *
 * Detect at load time whether the Docker DAEMON is reachable (not merely the CLI). `docker
 * version` contacts the daemon for its Server block and exits non-zero when it cannot connect;
 * if the CLI binary is absent entirely, `run()`'s spawn throws — both cases mean "no Docker",
 * so the whole suite is registered under `describe.skip` and plain `bun test` stays green.
 * ========================================================================================= */

function dockerDaemonReachable(): boolean {
  try {
    return run(["docker", "version"]).exitCode === 0;
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
/** Skip the entire suite (bring-up + every test + hooks) unless the Docker tier is enabled. */
const stackDescribe = SMOKE_ENABLED ? describe : describe.skip;

/* ===========================================================================================
 * Compose + in-stack probe vehicles (06 §5)
 * ========================================================================================= */

/** One isolated Compose project per lifecycle: green and malformed may never cross-clean. */
const GREEN_PROJECT = createSmokeProjectName("stack");
const MALFORMED_PROJECT = createSmokeProjectName("stack-malformed");

/** Run a `docker compose` subcommand against one explicit, test-only project. */
const composeEnv = (
  project: typeof GREEN_PROJECT | typeof MALFORMED_PROJECT,
  env: Record<string, string>,
  ...args: string[]
): Ran => run(smokeComposeArgs(project, COMPOSE_FILE, ...args), env);

/** Default-fixture compose (green path). */
const compose = (...args: string[]): Ran => composeEnv(GREEN_PROJECT, FIXTURE_ENV, ...args);

/** In-stack probe vehicle: a one-shot pinned curl container on the lifecycle's isolated network.
 *  Reaches internal `service:port` DNS without publishing host ports or needing a shell in the
 *  target image (VM/AM are distroless). Pinned per REQ-COMPOSE-04. */
const CURL_IMAGE = "curlimages/curl:8.11.1";
const GREEN_NETWORK = composeNetworkName(GREEN_PROJECT);
const MALFORMED_NETWORK = composeNetworkName(MALFORMED_PROJECT);

function inStackGet(
  url: string,
  auth?: string,
  network: string = GREEN_NETWORK,
): { ok: boolean; body: string } {
  const res = run([
    "docker", "run", "--rm", "--network", network, CURL_IMAGE,
    "-sS", "--max-time", "10", ...(auth ? ["-u", auth] : []), url,
  ]);
  return { ok: res.exitCode === 0, body: res.stdout };
}

/** Grafana admin bootstrap creds — the compose defaults (`${GF_ADMIN_USER:-admin}` /
 *  `${GF_ADMIN_PASSWORD:-admin}`), which FIXTURE_ENV does not override. */
const GRAFANA_AUTH = "admin:admin";

/** Poll a synchronous predicate until it holds or `deadlineMs` elapses, blocking `stepMs` between
 *  tries via a spawnSync `sleep` (the smoke tier is already serialized around docker). Returns the
 *  last predicate result. Used for probes that settle a cadence after a service reports healthy
 *  (e.g. VM's first 30s self-scrape, Grafana datasource provisioning). */
function pollUntil(predicate: () => boolean, deadlineMs: number, stepMs: number): boolean {
  const started = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - started >= deadlineMs) return false;
    run(["sleep", String(stepMs / 1000)]);
  }
}

/** Parse `docker compose ps --format json` — NDJSON (one object per line) on compose v2, or a
 *  single JSON array on some builds. Handle both. */
function parsePs(stdout: string): { Service: string; Health: string }[] {
  const t = stdout.trim();
  if (!t) return [];
  if (t.startsWith("[")) return JSON.parse(t) as { Service: string; Health: string }[];
  return t.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { Service: string; Health: string });
}

/** Per-service health from `docker compose ps`; capture a logs tail for any unhealthy one. */
function serviceHealth(env: Record<string, string> = FIXTURE_ENV): ServiceHealth[] {
  const rows = parsePs(composeEnv(GREEN_PROJECT, env, "ps", "-a", "--format", "json").stdout);
  return DEFAULT_PROFILE_SERVICES.map((service): ServiceHealth => {
    const row = rows.find((r) => r.Service === service);
    const healthy = row?.Health === "healthy";
    // `exactOptionalPropertyTypes`: omit logTail entirely when healthy (never assign undefined).
    return healthy
      ? { service, healthy }
      : { service, healthy, logTail: composeEnv(GREEN_PROJECT, env, "logs", "--tail", "40", service).stdout };
  });
}
/** `gatus` has no container healthcheck (its pinned image is shell-less and has no health
 *  subcommand — see docker-compose.yml), so its `docker compose ps` Health is always "" rather
 *  than "healthy". Its readiness is asserted out-of-band by the `gatus-config-loaded` HTTP probe
 *  (§5.4). Exempt it from the container-Health assertion so §5.3 checks only self-healthchecking
 *  services. */
const HEALTHCHECK_EXEMPT = new Set<string>(["gatus"]);
const unhealthyServices = (env: Record<string, string> = FIXTURE_ENV) =>
  serviceHealth(env).filter((s) => !s.healthy && !HEALTHCHECK_EXEMPT.has(s.service));

/* ===========================================================================================
 * §5.1–§5.4 — Green path: default-profile bring-up, health, functional probes
 * ========================================================================================= */

stackDescribe("Tier-2 smoke: default-profile engine bring-up (REQ-PERF-01)", () => {
  // §5.1 Preflight drift guard BEFORE bring-up, then `up --wait` (default profile only —
  // nas/web/deep-health gated off). A rendered-format drift fails loudly and cheaply here,
  // not as an opaque unhealthy service later (CON-03, 00 §4.5).
  beforeAll(() => {
    const manifest = JSON.parse(
      readFileSync(resolve(FIXTURE_RENDERED_DIR, ".rendered-manifest.json"), "utf8"),
    ) as RenderedManifest;
    if (manifest.formatVersion !== EXPECTED_RENDER_FORMAT_VERSION) {
      throw new Error(
        `Rendered formatVersion ${manifest.formatVersion} != expected ` +
          `${EXPECTED_RENDER_FORMAT_VERSION} — upstream rendered-tree drift (CON-03). ` +
          "Re-check mount wiring before bring-up.",
      );
    }
    // --wait blocks until every default-profile service is healthy or its budget expires;
    // non-zero exit = "hung/broken" within a bounded budget (tech-spec §7, 00 §7).
    const up = compose("up", "--wait", "--wait-timeout", "180");
    if (up.exitCode !== 0) {
      const failing = unhealthyServices();
      throw new Error(
        `compose up --wait failed (exit ${up.exitCode}). ` +
          `Unhealthy: ${failing.map((s) => s.service).join(", ") || "(none reported)"}\n` +
          failing.map((s) => `── ${s.service} logs ──\n${s.logTail ?? ""}`).join("\n") +
          `\n── up stderr ──\n${up.stderr}`,
      );
    }
  }, 300_000); // generous bound: image pulls + start_period budgets (00 §7)

  // §5.2 GUARANTEED checked teardown — cleanup failures make the suite red, never leak silently.
  afterAll(() => {
    const down = compose("down", "-v", "--remove-orphans");
    if (down.exitCode !== 0) {
      throw new Error(`compose cleanup failed for ${GREEN_PROJECT}: ${down.stderr}`);
    }
  }, 120_000);

  // §5.3 Every default-profile service healthy (REQ-PERF-01, REQ-COMPOSE-03/FAIL-01).
  test("every default-profile service is healthy (REQ-PERF-01, REQ-COMPOSE-03)", () => {
    const unhealthy = unhealthyServices();
    expect(
      unhealthy.map((s) => s.service),
      `unhealthy services: ${unhealthy.map((s) => `\n[${s.service}]\n${s.logTail}`).join("")}`,
    ).toEqual([]);
  });

  // §5.4 Functional in-stack probes — the engine is actually queryable & self-observing. Only
  // the in-stack targets are probed; the fictional estate file_sd targets are expected-DOWN and
  // never touched (§5.5, §7). Gatus paging is NOT asserted here: it is a rendered vmalert rule
  // (synthetic.yml, issue #1) the base tree does not mount; its firing/resolve behaviour is tested
  // against a real VictoriaMetrics by stack/alerting/tests/synthetic.vm.test.ts.
  const PROBES: FunctionalProbe[] = [
    {
      // VM ingested its OWN self-scrape / cAdvisor series (REQ-SELF-01/02, 03 §2/§3). VM
      // self-scrapes on a 30s cadence (scrape.yml), so `up` is empty for up to one interval after
      // bring-up — poll until the series appears rather than sampling once.
      name: "vm-self-scrape",
      run() {
        return Promise.resolve(
          pollUntil(
            () => {
              const r = inStackGet("http://victoriametrics:8428/api/v1/query?query=up");
              if (!r.ok) return false;
              const parsed = JSON.parse(r.body) as { status: string; data: { result: unknown[] } };
              return parsed.status === "success" && parsed.data.result.length > 0;
            },
            45_000,
            3_000,
          ),
        );
      },
    },
    {
      // Grafana can reach the provisioned VictoriaMetrics datasource (REQ-GRAF-01, 04 §5). The
      // datasource-health endpoint is keyed by uid and requires admin auth, so resolve the
      // provisioned datasource's uid first, then query its health. Poll: provisioning + the VM
      // backend settle a beat after grafana reports healthy.
      name: "grafana-datasource",
      run() {
        return Promise.resolve(
          pollUntil(
            () => {
              const ds = inStackGet("http://grafana:3000/api/datasources/name/VictoriaMetrics", GRAFANA_AUTH);
              if (!ds.ok) return false;
              const uid = (JSON.parse(ds.body) as { uid?: string }).uid;
              if (!uid) return false;
              const health = inStackGet(`http://grafana:3000/api/datasources/uid/${uid}/health`, GRAFANA_AUTH);
              return health.ok && /"status"\s*:\s*"?(OK|success)/i.test(health.body);
            },
            30_000,
            2_000,
          ),
        );
      },
    },
    {
      // Gatus loaded its MERGED config dir (rendered endpoints + stack-core provider, 04 §4).
      name: "gatus-config-loaded",
      run() {
        const r = inStackGet("http://gatus:8080/api/v1/endpoints/statuses");
        if (!r.ok) return Promise.resolve(false);
        return Promise.resolve((JSON.parse(r.body) as unknown[]).length > 0);
      },
    },
    {
      // Alertmanager booted off its NATIVE bootstrap config (04 §2), not the abstract rendered
      // routing.yaml (which it cannot parse, 00 §4.3).
      name: "alertmanager-booted",
      run() {
        const healthy = inStackGet("http://alertmanager:9093/-/healthy").ok;
        const status = inStackGet("http://alertmanager:9093/api/v2/status");
        return Promise.resolve(healthy && status.ok);
      },
    },
  ];

  describe("functional probes: the engine is queryable & self-observing (REQ-PERF-01)", () => {
    for (const probe of PROBES) {
      test(
        probe.name,
        async () => {
          expect(await probe.run(), `${probe.name} probe failed`).toBe(true);
        },
        60_000,
      );
    }
  });
});

/* ===========================================================================================
 * §5.6 — Fail-loud negative proof (REQ-FAIL-01, P0)
 *
 * Point PULSE_RENDERED_DIR at a deliberately-malformed rendered subtree (a truncated
 * gatus/config.yaml) and assert the affected service does NOT reach healthy within its budget —
 * i.e. `up --wait` returns non-zero and that service's Health !== "healthy". Never silent-green.
 * Teardown still runs. Gated behind the SAME Docker self-skip as the green path.
 * ========================================================================================= */

stackDescribe("Tier-2 smoke: fail-loud on a malformed rendered subtree (REQ-FAIL-01)", () => {
  let malformedDir = "";
  let malformedEnv: Record<string, string> = {};
  let up: Ran = { exitCode: 0, stdout: "", stderr: "" };

  beforeAll(() => {
    // Copy the good fixture, then corrupt ONLY gatus/config.yaml so gatus is the affected
    // service and the rest are unaffected — a targeted "bad-rendered-config" class
    // (05-mounts-contracts-failure.md §4). Runtime-built (not committed) so no broken artifact
    // ships and the hermetic secret/fixture scans never see it.
    malformedDir = mkdtempSync(join(tmpdir(), "pulse-malformed-rendered-"));
    cpSync(FIXTURE_RENDERED_DIR, malformedDir, { recursive: true });
    // Deliberately invalid YAML (a tab in indentation + an unterminated flow sequence): Gatus
    // fails to parse its merged config dir and exits.
    writeFileSync(join(malformedDir, "gatus", "config.yaml"), "endpoints:\n\t- name: [broken\n");
    malformedEnv = { ...FIXTURE_ENV, PULSE_RENDERED_DIR: malformedDir };

    // Bounded: `up --wait` returns non-zero within the budget rather than hanging forever. Do
    // NOT throw here — a non-zero exit is the EXPECTED outcome, asserted in the test below.
    up = composeEnv(MALFORMED_PROJECT, malformedEnv, "up", "--wait", "--wait-timeout", "120");
  }, 300_000);

  afterAll(() => {
    // GUARANTEED checked teardown; always remove the host temp subtree even if Compose cleanup fails.
    let cleanupError = "";
    try {
      if (malformedDir) {
        const down = composeEnv(
          MALFORMED_PROJECT,
          malformedEnv,
          "down",
          "-v",
          "--remove-orphans",
        );
        if (down.exitCode !== 0) cleanupError = down.stderr;
      }
    } finally {
      if (malformedDir) rmSync(malformedDir, { recursive: true, force: true });
    }
    if (cleanupError) {
      throw new Error(`compose cleanup failed for ${MALFORMED_PROJECT}: ${cleanupError}`);
    }
  }, 120_000);

  test("malformed rendered subtree takes gatus down (never silent-green)", () => {
    // REQ-FAIL-01: a bad mount must surface as RED, never silent-green. gatus has no container
    // healthcheck (option D — see docker-compose.yml), so a bad gatus mount is NOT caught by
    // `up --wait` (a healthcheck-less container satisfies --wait once "started", and gatus's fatal
    // config-parse exit happens just after that) — `up.exitCode` is therefore informational here,
    // not the assertion. The fail-loud proof is the same in-stack HTTP probe the green path asserts
    // SUCCEEDS on the unmodified fixture (§5.4 gatus-config-loaded, the green baseline): with only
    // gatus/config.yaml corrupted, gatus never binds its port, so that probe must fail — the
    // corruption, not any pre-existing redness, is what takes gatus down (V-009 causation).
    const serving = inStackGet(
      "http://gatus:8080/api/v1/endpoints/statuses",
      undefined,
      MALFORMED_NETWORK,
    ).ok;
    expect(
      serving,
      `gatus should NOT be serving on a malformed rendered config (up --wait exit ${up.exitCode})`,
    ).toBe(false);
  }, 60_000); // the in-stack curl sidecar (docker run) overruns the default 5s test budget
});
