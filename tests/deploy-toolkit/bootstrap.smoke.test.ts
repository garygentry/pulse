/// <reference path="./bun-test.d.ts" />
/**
 * bootstrap.smoke.test.ts — REQ-VER-04 (OQ-02, D5).
 *
 * DOCKER TIER. Renders the reference estate via the SOURCE CLI (D9) into a temp output root,
 * brings the DEFAULT-profile stack up against stack/compose/docker-compose.yml (reusing
 * stack/tests/harness.ts), asserts health + functional probes, and tears down. Self-skips
 * when no Docker daemon is reachable so plain `bun test` stays green (00 §8, never false red).
 * Scope = default profile only; web/deep-health excluded (tech-spec §3.5).
 *
 * PATH-RESOLUTION (00 §3, config.ts:83-84): the estate INPUT is CWD-relative and estateDir is
 * NOT flag-overridable, so the render runs with cwd = the reference fixture dir and redirects
 * only OUTPUT via --output-root. Retires stack-core's V-006/V-007 stand-in fixture debt: the
 * real reference estate now drives the bring-up, not a hand-seeded tree.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  COMPOSE_FILE,
  composeNetworkName,
  createSmokeProjectName,
  DEFAULT_PROFILE_SERVICES,
  EXPECTED_RENDER_FORMAT_VERSION,
  // Lifted shared export (item 011 / 06 §5.1) — imported, never a third local copy.
  dockerDaemonReachable,
  run,
  smokeComposeArgs,
} from "../../stack/tests/harness.js";
import type { Ran, RenderedManifest, ServiceHealth } from "../../stack/tests/harness.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps", "cli", "src", "index.ts");
const REFERENCE_DIR = resolve(REPO_ROOT, "examples", "reference"); // CLI CWD for the render (00 §3)

const DOCKER_OK = dockerDaemonReachable();
/**
 * Run the Docker tier only under an explicit opt-in (`PULSE_SMOKE=1`, set by `bun run smoke`).
 * A plain `bun test` always skips it — even with a daemon present — so the tier runs exactly
 * once per gate (in `bun run smoke`) instead of twice, and an interrupted default `bun test`
 * never leaks `pulse-test-*` compose resources.
 */
const SMOKE_ENABLED = DOCKER_OK && process.env.PULSE_SMOKE === "1";
/** Skip the entire suite (bring-up + tests + hooks) unless the Docker tier is enabled (00 §8). */
const smokeDescribe = SMOKE_ENABLED ? describe : describe.skip;

/** Unique project identity keeps destructive teardown isolated from every real deployment. */
const TEST_PROJECT = createSmokeProjectName("deploy-toolkit");

/** One-shot pinned curl sidecar on the test project's network — reaches internal service:port DNS
 *  without publishing host ports or needing a shell in distroless targets (mirrors bringup). */
const CURL_IMAGE = "curlimages/curl:8.11.1";
const NETWORK = composeNetworkName(TEST_PROJECT);

function inStackGet(url: string): { ok: boolean; body: string } {
  const res = run(["docker", "run", "--rm", "--network", NETWORK, CURL_IMAGE, "-sS", "--max-time", "10", url]);
  return { ok: res.exitCode === 0, body: res.stdout };
}

/** Poll a synchronous predicate until it holds or `deadlineMs` elapses, blocking `stepMs`
 *  between tries via a spawnSync `sleep` (the docker tier is already serialized). Used for
 *  probes that settle a cadence after a service reports healthy (VM self-scrapes on a ~30s
 *  cadence, so the `up` series / gatus statuses can be briefly empty right after bring-up). */
function pollUntil(predicate: () => boolean, deadlineMs: number, stepMs: number): boolean {
  const started = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - started >= deadlineMs) return false;
    run(["sleep", String(stepMs / 1000)]);
  }
}

/** Bring-up env: rendered dir + the REQUIRED PULSE_ESTATE_NAME (no fallback, tech-spec §6.2). */
let renderedDir = "";
let upEnv: Record<string, string> = {};

const composeEnv = (env: Record<string, string>, ...args: string[]): Ran =>
  run(smokeComposeArgs(TEST_PROJECT, COMPOSE_FILE, ...args), env);

smokeDescribe("bootstrap smoke: reference estate → default-profile bring-up (REQ-VER-04)", () => {
  beforeAll(() => {
    // (1) Render the reference estate via the SOURCE CLI into a temp OUTPUT root (D9).
    //     cwd = REFERENCE_DIR so the estate INPUT resolves inside the fixture (00 §3, §1.2);
    //     --output-root redirects ONLY the output. Both CLI_ENTRY and renderedDir are absolute.
    renderedDir = mkdtempSync(join(tmpdir(), "pulse-bootstrap-rendered-"));
    const render = Bun.spawnSync(
      ["bun", "run", CLI_ENTRY, "render", "--output-root", renderedDir, "--json"],
      { cwd: REFERENCE_DIR, env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
    );
    if (render.exitCode !== 0) {
      throw new Error(
        `reference render failed (exit ${render.exitCode}):\n${new TextDecoder().decode(render.stderr)}`,
      );
    }

    // (2) Preflight: rendered formatVersion must match what stack-core builds against (00 §4.1).
    //     A drift fails loudly and cheaply here, not as an opaque unhealthy service later.
    const manifest = JSON.parse(
      readFileSync(resolve(renderedDir, ".rendered-manifest.json"), "utf8"),
    ) as RenderedManifest;
    if (manifest.formatVersion !== EXPECTED_RENDER_FORMAT_VERSION) {
      throw new Error(
        `rendered formatVersion ${manifest.formatVersion} != ${EXPECTED_RENDER_FORMAT_VERSION} — ` +
          "re-check mount wiring before bring-up.",
      );
    }

    upEnv = {
      PULSE_RENDERED_DIR: renderedDir,
      PULSE_ESTATE_NAME: "example-estate", // REQUIRED, fictional (no fallback; vmalert external label)
      PULSE_VM_RETENTION: "6",
    };

    // (3) Bring up the DEFAULT profile only. --wait blocks until healthy or the budget expires;
    //     a non-zero exit = "hung/broken" within a bounded budget (never hangs).
    const up = composeEnv(upEnv, "up", "--wait", "--wait-timeout", "180");
    if (up.exitCode !== 0) {
      const failing = unhealthy();
      throw new Error(
        `compose up --wait failed (exit ${up.exitCode}). ` +
          `Unhealthy: ${failing.map((s) => s.service).join(", ") || "(none reported)"}\n` +
          failing.map((s) => `── ${s.service} logs ──\n${s.logTail ?? ""}`).join("\n") +
          `\n── up stderr ──\n${up.stderr}`,
      );
    }
  }, 300_000); // image pulls + start_period budgets

  // (5) GUARANTEED checked teardown; always remove the host temp tree even on cleanup failure.
  afterAll(() => {
    let cleanupError = "";
    try {
      if (renderedDir) {
        const down = composeEnv(upEnv, "down", "-v", "--remove-orphans");
        if (down.exitCode !== 0) cleanupError = down.stderr;
      }
    } finally {
      if (renderedDir) rmSync(renderedDir, { recursive: true, force: true });
    }
    if (cleanupError) {
      throw new Error(`compose cleanup failed for ${TEST_PROJECT}: ${cleanupError}`);
    }
  }, 120_000);

  // (4a) Every default-profile service healthy — gatus EXEMPT (its pinned image is shell-less
  //      with no health subcommand, so its `ps` Health is always ""; it is HTTP-probed below).
  const HEALTHCHECK_EXEMPT = new Set<string>(["gatus"]);
  function unhealthy(): ServiceHealth[] {
    const raw = composeEnv(upEnv, "ps", "-a", "--format", "json").stdout.trim();
    const rows = (raw.startsWith("[")
      ? JSON.parse(raw)
      : raw
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))) as { Service: string; Health: string }[];
    return DEFAULT_PROFILE_SERVICES.filter((s) => !HEALTHCHECK_EXEMPT.has(s))
      .map((service): ServiceHealth => {
        const row = rows.find((r) => r.Service === service);
        const healthy = row?.Health === "healthy";
        return healthy
          ? { service, healthy }
          : { service, healthy, logTail: composeEnv(upEnv, "logs", "--tail", "40", service).stdout };
      })
      .filter((s) => !s.healthy);
  }

  test("every default-profile service is healthy (gatus HTTP-probed) (REQ-VER-04)", () => {
    const bad = unhealthy();
    expect(
      bad.map((s) => s.service),
      `unhealthy: ${bad.map((s) => `\n[${s.service}]\n${s.logTail}`).join("")}`,
    ).toEqual([]);
  });

  // (4b) Functional probes — the engine is queryable & self-observing. VM/gatus are polled
  //      (~45s deadline) because VM self-scrapes on a ~30s cadence, so the series/statuses can
  //      be briefly empty right after bring-up (mirrors bringup.smoke.test.ts pollUntil).
  test("gatus loaded its merged endpoint config (shell-less; HTTP probe)", () => {
    const ok = pollUntil(
      () => {
        const r = inStackGet("http://gatus:8080/api/v1/endpoints/statuses");
        if (!r.ok) return false;
        return (JSON.parse(r.body) as unknown[]).length > 0;
      },
      45_000,
      3_000,
    );
    expect(ok, "gatus statuses endpoint never reported endpoints").toBe(true);
  }, 60_000);

  test("VictoriaMetrics answers the `up` query (self-scrape ingested)", () => {
    const ok = pollUntil(
      () => {
        const r = inStackGet("http://victoriametrics:8428/api/v1/query?query=up");
        if (!r.ok) return false;
        const parsed = JSON.parse(r.body) as { status: string; data: { result: unknown[] } };
        return parsed.status === "success" && parsed.data.result.length > 0;
      },
      45_000,
      3_000,
    );
    expect(ok, "VM `up` query never returned a self-scrape series").toBe(true);
  }, 60_000);

  test("Alertmanager reports healthy", () => {
    expect(inStackGet("http://alertmanager:9093/-/healthy").ok, "AM /-/healthy failed").toBe(true);
  }, 60_000);
});
