/**
 * host-agent Tier-2 bring-up smoke (06-testing-strategy.md §5).
 *
 * DOCKER TIER (best-effort). This suite dev-builds the heartbeat image locally, brings the
 * SEEDED bundle fixture UP via `docker compose up`, and asserts the always-on exporters answer
 * `/metrics` (node + heartbeat, with heartbeat reporting `pulse_agent_up 1`) plus the OPTIONAL
 * cAdvisor when the daemon permits its privileged introspection. It realizes the REQ-PERF-01
 * green bar; the golden + structural tiers remain the authoritative gate (06 §5).
 *
 * CRITICAL — self-skips ONLY when no Docker DAEMON is reachable (06 §2/§5): plain `bun test`
 * discovers this file too. If no daemon answers, the ENTIRE suite skips itself (guarded describe)
 * so a daemon-less env stays green. When a daemon IS reachable, the suite runs for real — a
 * missing CLI or a failed bring-up then surfaces as RED, never a false green.
 *
 * LOCAL images only (item 017 AC): the heartbeat image is built here into a unique ephemeral dev
 * tag, never pulled as a published/released tag. node_exporter and cAdvisor are the shared PINNED
 * patches. No published/released lifecycle state is fabricated.
 *
 * Types/constants/helpers come from ./harness (the single non-test support module, 06 §1).
 */

/// <reference path="./bun-test.d.ts" />

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { CADVISOR_PORT, HEARTBEAT_PORT, NODE_EXPORTER_PORT } from "../contract/constants.js";
import { PULSE_AGENT_UP } from "../contract/types.js";
import {
  AGENT_ROOT,
  CADVISOR_PROFILE,
  CURL_IMAGE,
  HEARTBEAT_DOCKERFILE,
  SMOKE_COMPOSE_FIXTURE,
  SMOKE_HEARTBEAT_IMAGE,
  SMOKE_HEARTBEAT_VERSION,
  SMOKE_NETWORK,
  SMOKE_PROJECT,
  run,
} from "./harness.js";
import type { Ran } from "./harness.js";

/* ===========================================================================================
 * Docker-daemon self-skip (06 §5) — the ONLY skip condition (item 017 AC).
 *
 * `docker version` contacts the daemon for its Server block and exits non-zero when it cannot
 * connect; if the CLI binary is absent, `run()`'s spawn throws. Both mean "no daemon" → the whole
 * suite registers under `describe.skip` and plain `bun test` stays green.
 * ========================================================================================= */

function dockerDaemonReachable(): boolean {
  try {
    return run(["docker", "version"]).exitCode === 0;
  } catch {
    return false; // CLI binary not found → not reachable
  }
}

const DOCKER_OK = dockerDaemonReachable();
const smokeDescribe = DOCKER_OK ? describe : describe.skip;

/* ===========================================================================================
 * Compose + in-stack probe vehicles (06 §5)
 * ========================================================================================= */

/** Base interpolation env for the fixture: only the local dev-build heartbeat image tag. */
const SMOKE_ENV: Record<string, string> = { PULSE_HEARTBEAT_IMAGE: SMOKE_HEARTBEAT_IMAGE };
/** Same, with cAdvisor's gating profile active (its optional body materialized). */
const CADVISOR_ENV: Record<string, string> = { ...SMOKE_ENV, COMPOSE_PROFILES: CADVISOR_PROFILE };

/** Run a `docker compose` subcommand against the seeded fixture with the given interpolation env. */
const compose = (env: Record<string, string>, ...args: string[]): Ran =>
  run(["docker", "compose", "-p", SMOKE_PROJECT, "-f", SMOKE_COMPOSE_FIXTURE, ...args], env);

/** In-stack probe vehicle: a one-shot pinned curl container on the fixture network. Reaches the
 *  internal `service:port` DNS without publishing any host port (REQ-SEC-02). */
function inStackGet(url: string): { ok: boolean; body: string } {
  const res = run([
    "docker", "run", "--rm", "--network", SMOKE_NETWORK, CURL_IMAGE,
    "-sS", "--max-time", "10", url,
  ]);
  return { ok: res.exitCode === 0, body: res.stdout };
}

/** Poll the in-stack endpoint until `match(body)` holds or `deadlineMs` elapses. Exporters answer
 *  a beat after the container reports running (first listen bind), so poll rather than sample once. */
function pollGet(
  url: string,
  match: (body: string) => boolean,
  deadlineMs = 45_000,
  stepMs = 3_000,
): { ok: boolean; body: string } {
  const started = Date.now();
  let last: { ok: boolean; body: string } = { ok: false, body: "" };
  for (;;) {
    last = inStackGet(url);
    if (last.ok && match(last.body)) return last;
    if (Date.now() - started >= deadlineMs) return last;
    run(["sleep", String(stepMs / 1000)]);
  }
}

/** Parse `docker compose ps --format json` — NDJSON on compose v2, or a single JSON array. */
function parsePs(stdout: string): { Service: string; State: string }[] {
  const t = stdout.trim();
  if (!t) return [];
  if (t.startsWith("[")) return JSON.parse(t) as { Service: string; State: string }[];
  return t.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { Service: string; State: string });
}

/** True when the named fixture service has a running container. */
function serviceRunning(service: string): boolean {
  const rows = parsePs(compose(CADVISOR_ENV, "ps", "--format", "json", service).stdout);
  return rows.some((r) => r.Service === service && r.State === "running");
}

/* ===========================================================================================
 * §5 — Green path: dev-build, bring up the seeded fixture, assert the exporters answer
 * ========================================================================================= */

smokeDescribe("Tier-2 smoke: seeded bundle bring-up (REQ-PERF-01)", () => {
  /** Whether cAdvisor's optional privileged body actually started on this daemon. */
  let cadvisorStarted = false;

  beforeAll(() => {
    // 1) LOCAL dev-build of the heartbeat image (build context = agent/, so contract/ + heartbeat/
    //    land under /app). AGENT_VERSION is the required build ARG — a dev, non-release string.
    const build = run([
      "docker", "build", AGENT_ROOT,
      "-f", HEARTBEAT_DOCKERFILE,
      "--build-arg", `AGENT_VERSION=${SMOKE_HEARTBEAT_VERSION}`,
      "-t", SMOKE_HEARTBEAT_IMAGE,
    ]);
    if (build.exitCode !== 0) {
      throw new Error(`heartbeat dev-build failed (exit ${build.exitCode}):\n${build.stderr}`);
    }

    // 2) Bring up the ALWAYS-ON exporters (node + heartbeat). `--wait` blocks until they are
    //    running; a non-zero exit means the required bundle members did not come up (RED).
    const up = compose(SMOKE_ENV, "up", "-d", "--wait", "--wait-timeout", "120");
    if (up.exitCode !== 0) {
      const logs = compose(SMOKE_ENV, "logs", "--tail", "40").stdout;
      throw new Error(`compose up --wait failed (exit ${up.exitCode}).\n${logs}\n── up stderr ──\n${up.stderr}`);
    }

    // 3) OPTIONAL cAdvisor — best-effort: a daemon that forbids privileged host introspection
    //    simply will not start it, and the cAdvisor assertion below is skipped. Never throw here.
    compose(CADVISOR_ENV, "up", "-d", "cadvisor");
    cadvisorStarted = serviceRunning("cadvisor");
  }, 420_000); // generous: image pulls + the local heartbeat build (00 §7)

  // GUARANTEED checked teardown even if a probe threw — no orphaned project or local image.
  afterAll(() => {
    const failures: string[] = [];
    const down = compose(CADVISOR_ENV, "down", "-v", "--remove-orphans");
    if (down.exitCode !== 0) failures.push(`compose down failed: ${down.stderr}`);
    const image = run(["docker", "image", "rm", SMOKE_HEARTBEAT_IMAGE]);
    if (image.exitCode !== 0) failures.push(`image cleanup failed: ${image.stderr}`);
    if (failures.length > 0) throw new Error(failures.join("\n"));
  }, 120_000);

  test("heartbeat reports pulse_agent_up 1 (REQ-HB-01/02)", () => {
    const res = pollGet(
      `http://heartbeat:${HEARTBEAT_PORT}/metrics`,
      (body) => body.includes(`${PULSE_AGENT_UP} 1`),
    );
    expect(res.ok, "heartbeat /metrics unreachable").toBe(true);
    expect(res.body).toContain(`${PULSE_AGENT_UP} 1`);
  }, 90_000);

  test("node_exporter answers /metrics with node_* series (REQ-NODE-01)", () => {
    const res = pollGet(
      `http://node-exporter:${NODE_EXPORTER_PORT}/metrics`,
      (body) => /^node_/m.test(body),
    );
    expect(res.ok, "node_exporter /metrics unreachable").toBe(true);
    expect(/^node_/m.test(res.body), "no node_* series in node_exporter exposition").toBe(true);
  }, 90_000);

  test("cAdvisor answers /metrics when its privileged body starts (optional exporter)", () => {
    if (!cadvisorStarted) {
      // Truly optional (item 017 AC / 06 §5): this daemon did not start cAdvisor's privileged
      // introspection. Not a false green — node + heartbeat above are the required green bar.
      console.log("[smoke] cAdvisor did not start (privileged host introspection unavailable) — optional, skipping assertion");
      return;
    }
    const res = pollGet(
      `http://cadvisor:${CADVISOR_PORT}/metrics`,
      (body) => /^container_/m.test(body) || body.includes("cadvisor_version_info"),
    );
    expect(res.ok, "cAdvisor started but /metrics is unreachable").toBe(true);
    expect(
      /^container_/m.test(res.body) || res.body.includes("cadvisor_version_info"),
      "no container_* / cadvisor_* series in cAdvisor exposition",
    ).toBe(true);
  }, 90_000);
});
