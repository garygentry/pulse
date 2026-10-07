/**
 * @pulse/web `--profile web` smoke test (08-testing-strategy.md §11; SC-1 bring-up half, SC-6).
 *
 * DOCKER TIER. This is the ONE web-app test that boots the REAL app container. It brings the
 * profile-gated `web` slot UP against stack-core's seeded rendered fixture tree
 * (`stack/tests/fixtures/rendered/`, CON-07) via `docker compose --profile web up --build --wait`,
 * then asserts the reconciled slot (07-slot-reconciliation.md) actually serves:
 *
 *   §11.2  the `/healthz` body is green (`status: "ok"`) with per-source reachability accurate
 *          against the running engine (REQ-OBS-01, SC-6);
 *   §11.3  `/api/overview` lists EVERY fixture host + service — presence derives from the declared
 *          estate, not from which targets have data (SC-1 bring-up half, REQ-GRID-01);
 *   §11.4  the read-only rendered-model mount is readable — and NOT writable — in-container at
 *          `/rendered/web-estate-model.json`. This is the assertion site that discharges the
 *          deliberate exclusion of the `web` mount from stack-core's `RENDERED_MOUNTS` guard
 *          (07 §3.7 / stack/tests/harness.ts): the mount is proven HERE, not in config.test.ts.
 *
 * CRITICAL — self-skip when Docker is unavailable: plain `bun test` discovers this file too. If NO
 * Docker daemon is reachable, the ENTIRE suite skips itself (guarded describe) so a Docker-less
 * loop gate PASSES rather than failing or hanging — the exact pattern used by
 * stack/tests/bringup.smoke.test.ts. When a daemon IS reachable, the suite runs for real.
 *
 * Reuses stack/tests/harness.ts (the single non-test support module) by relative import for the
 * compose file path, the fixture interpolation env, and the never-throwing `run()` spawn wrapper.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  COMPOSE_FILE,
  composeNetworkName,
  createSmokeProjectName,
  FIXTURE_ENV,
  run,
  smokeComposeArgs,
} from "../../../stack/tests/harness.js";
import type { HealthBody, OverviewSnapshot } from "../src/shared/snapshot.js";
import { loadProposalSecret, loadServerConfig } from "../src/server/config.js";
import { buildWriteRuntime, type WriteRuntime } from "../src/server/mutations/bootstrap.js";
import { createServerRuntime, type ServerRuntime } from "../src/server/refresh.js";
import { dispatch } from "../src/server/router.js";
import type { StaticAssets } from "../src/server/assets.js";
import { makeEstateBundleFixture } from "./factories/estate-bundle.js";

/* ===========================================================================================
 * Docker-daemon self-skip (08 §11; mirrors bringup.smoke.test.ts)
 *
 * `docker version` contacts the daemon for its Server block and exits non-zero when it cannot
 * connect; if the CLI binary is absent entirely, `run()`'s spawn throws — both cases mean
 * "no Docker", so the whole suite registers under `describe.skip` and plain `bun test` stays green.
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
const webDescribe = SMOKE_ENABLED ? describe : describe.skip;

/* ===========================================================================================
 * Compose + in-stack probe vehicles (reuses harness FIXTURE_ENV/COMPOSE_FILE)
 * ========================================================================================= */

/** Unique project identity keeps `down -v` away from deployments and concurrent smoke runs. */
const TEST_PROJECT = createSmokeProjectName("web");

/** Run a `docker compose --profile web` subcommand against the isolated test project. */
const compose = (...args: string[]) =>
  run(smokeComposeArgs(TEST_PROJECT, COMPOSE_FILE, "--profile", "web", ...args), FIXTURE_ENV);

/** In-stack HTTP vehicle: a one-shot pinned curl container on the test project's network, reaching
 *  internal `web:8080` DNS without publishing a host port (the slot declares NO `ports:`). Pinned
 *  image, mirroring bringup.smoke.test.ts's probe sidecar. */
const CURL_IMAGE = "curlimages/curl:8.11.1";
const NETWORK = composeNetworkName(TEST_PROJECT);

function inStackGet(url: string): { ok: boolean; body: string } {
  const res = run([
    "docker", "run", "--rm", "--network", NETWORK, CURL_IMAGE,
    "-sS", "--max-time", "10", url,
  ]);
  return { ok: res.exitCode === 0, body: res.stdout };
}

/** Poll a predicate until it holds or `deadlineMs` elapses, sleeping `stepMs` between tries via a
 *  spawnSync `sleep` (the smoke tier is serialized around docker). Used because the container
 *  healthcheck only asserts HTTP-200 liveness — the first refresh cycle that turns every source
 *  green (and `/healthz` → "ok") settles a beat after `--wait` reports the service healthy. */
function pollUntil(predicate: () => boolean, deadlineMs: number, stepMs: number): boolean {
  const started = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - started >= deadlineMs) return false;
    run(["sleep", String(stepMs / 1000)]);
  }
}

/* ===========================================================================================
 * §11 — profile-web bring-up against the seeded fixture tree
 * ========================================================================================= */

/** Fixture estate shape read by the mounted model (stack/tests/fixtures/rendered/web-estate-model.json). */
const FIXTURE_ESTATE_NAME = "home-estate";
const FIXTURE_HOSTS = ["edge01", "nas1", "old01", "pve1", "web01"] as const;
const FIXTURE_SERVICES = ["web01/frigate", "web01/grafana", "web01/staging"] as const;

webDescribe("smoke:web — profile-web bring-up (SC-1, SC-6)", () => {
  // `up --build` makes the boot hermetic (the repo-root build context builds @pulse/web from
  // source) — no host pre-build step. The `--profile web` gate is activated ONLY here.
  beforeAll(() => {
    const up = compose("up", "--build", "--wait", "--wait-timeout", "240");
    if (up.exitCode !== 0) {
      const logs = compose("logs", "--tail", "60", "web").stdout;
      throw new Error(
        `compose --profile web up failed (exit ${up.exitCode})\n` +
          `── web logs ──\n${logs}\n── up stderr ──\n${up.stderr}`,
      );
    }
  }, 600_000); // image build (bun install + build.ts) + engine start budgets

  // GUARANTEED checked teardown — cleanup failures make the suite red, never leak silently.
  afterAll(() => {
    const down = compose("down", "-v", "--remove-orphans");
    if (down.exitCode !== 0) {
      throw new Error(`compose cleanup failed for ${TEST_PROJECT}: ${down.stderr}`);
    }
  }, 180_000);

  // §11.2 — /healthz green + per-source reachability accurate (SC-6, REQ-OBS-01).
  test("/healthz reports green with accurate per-source reachability (SC-6, REQ-OBS-01)", () => {
    // The container healthcheck only asserts HTTP-200 liveness; the first refresh cycle that turns
    // every source green settles just after `--wait`. Poll /healthz until `status: "ok"`.
    let last: HealthBody | null = null;
    const green = pollUntil(
      () => {
        const r = inStackGet("http://web:8080/healthz");
        if (!r.ok) return false;
        try {
          last = JSON.parse(r.body) as HealthBody;
        } catch {
          return false;
        }
        return last.status === "ok";
      },
      60_000,
      3_000,
    );
    expect(green, `/healthz never reached status:"ok"; last body: ${JSON.stringify(last)}`).toBe(true);
    const body = last as HealthBody | null;
    expect(body).not.toBeNull();
    // The model mount loaded, and per-source reachability is reported accurately (all three green
    // against the running engine the slot depends_on).
    expect(body!.estateModel.loaded).toBe(true);
    expect(body!.sources.metrics.ok, JSON.stringify(body!.sources.metrics)).toBe(true);
    expect(body!.sources.alerts.ok, JSON.stringify(body!.sources.alerts)).toBe(true);
    expect(body!.sources.checks.ok, JSON.stringify(body!.sources.checks)).toBe(true);
  }, 90_000);

  // §11.3 — /api/overview lists every fixture host + service (SC-1 bring-up half, REQ-GRID-01).
  test("/api/overview lists every fixture host and service (SC-1, REQ-GRID-01)", () => {
    const r = inStackGet("http://web:8080/api/overview");
    expect(r.ok, `GET /api/overview failed: ${r.body}`).toBe(true);
    const snap = JSON.parse(r.body) as OverviewSnapshot;
    expect(snap.estate.name).toBe(FIXTURE_ESTATE_NAME);

    // Presence derives from the DECLARED estate, not from which targets have data (REQ-GRID-01).
    const hostNames = snap.hosts.map((h) => h.name).sort();
    expect(hostNames).toEqual([...FIXTURE_HOSTS].sort());

    // Every declared service appears nested under its owning host, keyed `<host>/<name>`.
    const serviceKeys = snap.hosts
      .flatMap((h) => h.services.map((s) => `${s.host}/${s.name}`))
      .sort();
    expect(serviceKeys).toEqual([...FIXTURE_SERVICES].sort());
  }, 60_000);

  // §11.4 — the :ro rendered-model mount is readable (and NOT writable) in-container. This is the
  // assertion that discharges the 07 §3.7 RENDERED_MOUNTS exclusion. Use `bun -e` (Bun is the
  // guaranteed in-container binary — the CMD is `bun`; slim-base coreutils are not guaranteed).
  test("the :ro model mount is readable-not-writable in-container (07 §3.7)", () => {
    // (a) Readable: the mounted model parses and carries the fixture estate name.
    const read = compose(
      "exec", "-T", "web", "bun", "-e",
      'const m = await Bun.file("/rendered/web-estate-model.json").json();' +
        'if (m.estate.name !== "home-estate") { console.error("unexpected estate", m.estate.name); process.exit(3); }',
    );
    expect(read.exitCode, `in-container model read failed: ${read.stderr}`).toBe(0);

    // (b) Read-only: a write attempt against the `:ro` bind FAILS (REQ-PKG-04). Exit 0 == the write
    // was correctly rejected; exit 1 == the mount was unexpectedly writable.
    const write = compose(
      "exec", "-T", "web", "bun", "-e",
      'try { require("node:fs").appendFileSync("/rendered/web-estate-model.json", "x");' +
        ' console.error("write unexpectedly succeeded"); process.exit(1); }' +
        ' catch { process.exit(0); }',
    );
    expect(write.exitCode, `expected write to /rendered to be rejected (:ro): ${write.stderr}`).toBe(0);
  }, 60_000);
});

/* ===========================================================================================
 * NORMAL-COMPOSITION SMOKE (10 §8 — "Smoke test boots through normal composition … and checks
 * every route in not-ready/ready/error mode. Docker smoke self-skip cannot be sole route evidence.")
 *
 * This suite is the ALWAYS-RUN counterpart to the Docker tier above: it composes the REAL server
 * runtime the exact way `server/index.ts` does — `createServerRuntime(loadServerConfig(env), deps)`
 * — against sanitized in-process mock sources (an injected routing `fetchImpl`, never the network)
 * and a temporary on-disk rendered bundle, then dispatches every M1 route directly through the real
 * `dispatch` (no port bind). It exercises each route in NOT_READY (before the first cycle), ready
 * (after a published cycle), a representative degraded mode (one source deliberately unreachable but
 * the cycle still publishes), and bundle-error mode. It needs NO Docker daemon, so a plain `bun test`
 * carries this evidence and the Docker self-skip is never the sole proof.
 * ========================================================================================= */

/** The five cycle-backed current-view routes (05 §7). */
const CYCLE_ROUTES = ["/api/overview", "/api/alerts", "/api/estate", "/api/timeline", "/api/engine"] as const;

/** A minimal `StaticAssets` stub — the normal-composition smoke exercises API routes, not the SPA
 *  bundle, so no built `dist/client` is required. */
const STUB_ASSETS: StaticAssets = {
  get: () => undefined,
  shell: () => '<!doctype html><html lang="en"><body><div id="app"></div></body></html>',
  buildId: () => null,
};

/** The four required engine origins plus the model mount, mirroring the compose slot env. */
function inProcessEnv(model: string): Record<string, string | undefined> {
  return {
    PULSE_VM_URL: "http://victoriametrics:8428",
    PULSE_ALERTMANAGER_URL: "http://alertmanager:9093",
    PULSE_GATUS_URL: "http://gatus:8080",
    PULSE_VMALERT_URL: "http://vmalert:8880",
    PULSE_WEB_ESTATE_MODEL: model,
  };
}

/** Classify one upstream request into a stable source category (mirrors the disambiguation the
 *  refresh scheduler uses: data vs legacy clients share some paths, split by query string). */
function classify(u: URL): string {
  const p = u.pathname;
  const s = u.search;
  if (p === "/api/v1/query") return s.includes("label_replace") ? "data:signals" : "legacy:vm";
  if (p === "/api/v1/query_range") return "data:query_range";
  if (p === "/api/v1/targets") return "data:targets";
  if (p === "/api/v1/status/buildinfo") return "data:buildinfo";
  if (p === "/api/v1/rules") return "data:rules";
  if (p === "/api/v2/alerts") return s.includes("silenced=true") ? "data:alerts" : "legacy:am";
  if (p === "/api/v2/silences") return "data:silences";
  if (p === "/api/v2/status") return "data:amstatus";
  if (p === "/api/v2/receivers") return "data:receivers";
  if (p === "/api/v1/endpoints/statuses") return s.includes("pageSize") ? "data:gatus" : "legacy:gatus";
  if (p === "/api/health") return "data:grafana";
  return "unknown";
}

/** A minimal sanitized body each category's parser accepts as a success (no real estate values). */
function bodyFor(cat: string): unknown {
  switch (cat) {
    case "data:signals":
    case "legacy:vm":
      return { status: "success", data: { resultType: "vector", result: [] } };
    case "data:query_range":
      return { status: "success", data: { resultType: "matrix", result: [] } };
    case "data:targets":
      return { status: "success", data: { activeTargets: [] } };
    case "data:buildinfo":
      return { status: "success", data: { version: "1.102.1" } };
    case "data:rules":
      return { status: "success", data: { groups: [] } };
    case "data:amstatus":
      return { versionInfo: { version: "0.27.0" }, cluster: { status: "ready" } };
    case "data:grafana":
      return { database: "ok", version: "11.4.0" };
    default:
      return []; // alerts, silences, receivers, gatus (both)
  }
}

/** Build a routing `fetchImpl` that returns sanitized success bodies, except for the categories the
 *  live `failing` set names — those return a non-2xx so the source degrades (never-silent-green). */
function makeRouter(failing: () => ReadonlySet<string>): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const u = new URL(input.toString());
    const cat = classify(u);
    if (failing().has(cat)) return new Response("upstream unreachable", { status: 502 });
    return new Response(JSON.stringify(bodyFor(cat)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return impl as unknown as typeof fetch;
}

describe("smoke:web (in-process) — normal composition, every M1 route (10 §8)", () => {
  let dir: string;
  let modelPath: string;
  let mtimeSeq: number;
  let runtime: ServerRuntime | null;
  const failing = new Set<string>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pulse-web-smoke-"));
    modelPath = join(dir, "web-estate-model.json");
    mtimeSeq = 1_000_000;
    failing.clear();
    runtime = null;
  });

  afterEach(() => {
    runtime?.close(); // clears timers / streams / history — no leak across tests
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write the three bundle members with strictly increasing mtimes so the watcher always fires. */
  function writeGeneration(members: { model: string; coverage: string; findings: string }): void {
    const t = new Date(mtimeSeq++);
    writeFileSync(modelPath, members.model);
    writeFileSync(join(dir, "web-coverage.json"), members.coverage);
    writeFileSync(join(dir, "web-findings.json"), members.findings);
    for (const name of ["web-estate-model.json", "web-coverage.json", "web-findings.json"]) {
      utimesSync(join(dir, name), t, t);
    }
  }

  /** Write a complete valid rendered bundle from the sanitized fixture. */
  function writeValidBundle(): void {
    const f = makeEstateBundleFixture();
    writeGeneration({ model: f.files.model, coverage: f.files.coverage ?? "", findings: f.files.findings ?? "" });
  }

  /** Compose the runtime exactly as `server/index.ts` does, with the injected mock sources. */
  function boot(): ServerRuntime {
    const rt = createServerRuntime(loadServerConfig(inProcessEnv(modelPath)), {
      fetchImpl: makeRouter(() => failing),
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });
    runtime = rt;
    return rt;
  }

  /** Dispatch a GET through the real router (no port bind). */
  function get(rt: ServerRuntime, path: string, headers?: Record<string, string>): Promise<Response> {
    const req = new Request(`http://web:8080${path}`, headers ? { headers } : undefined);
    return dispatch(req, new URL(req.url).pathname, rt, STUB_ASSETS);
  }

  test("NOT_READY: cycle routes 503 NOT_READY before the first cycle; operational/session/events stay live", async () => {
    writeValidBundle();
    const rt = boot(); // composed, but no cycle published yet

    for (const p of CYCLE_ROUTES) {
      const res = await get(rt, p);
      expect(res.status, p).toBe(503);
      expect((await res.json()).code, p).toBe("NOT_READY");
    }

    // Operational + session + events are always available.
    expect((await get(rt, "/healthz")).status).toBe(200);
    expect((await get(rt, "/metrics")).status).toBe(200);

    const sess = await get(rt, "/api/session");
    expect(sess.status).toBe(200);
    expect(sess.headers.get("cache-control")).toBe("private, no-store");
    const sbody = (await sess.json()) as { identity: unknown; capabilities: Record<string, boolean> };
    expect(sbody.identity).toBeNull();
    expect(sbody.capabilities).toEqual({ silence: false, ack: false, proposeEstateEdit: false });

    const ev = await get(rt, "/api/events");
    expect(ev.status).toBe(200);
    expect(ev.headers.get("content-type")).toContain("text/event-stream");
    expect(ev.headers.get("x-accel-buffering")).toBe("no");
    await ev.body?.cancel();

    // Non-GET → JSON 405 (no body read); unknown /api/* → JSON 404.
    const post = await dispatch(
      new Request("http://web:8080/api/overview", { method: "POST" }),
      "/api/overview",
      rt,
      STUB_ASSETS,
    );
    expect(post.status).toBe(405);
    expect((await get(rt, "/api/does-not-exist")).status).toBe(404);

    // History routes are NOT cycle representations, so they have no NOT_READY code: before any
    // cycle/model they resolve to a bounded, safe error (series unavailable) rather than a crash
    // or a stale body. This proves the on-demand history seam is exercised in the pre-ready phase.
    const histNotReady = await get(rt, "/api/history/alerts");
    expect(histNotReady.status).toBe(502);
    expect((await histNotReady.json()).code).toBe("SOURCE_UNAVAILABLE");
  });

  test("ready: cycle routes serve 200 with ETag/observation + bodyless 304; history serves a bounded 200", async () => {
    writeValidBundle();
    const rt = boot();
    await rt.runOnce(); // publish the first coherent cycle
    expect(rt.getContext(null).cycle).not.toBeNull();

    for (const p of CYCLE_ROUTES) {
      const res = await get(rt, p);
      expect(res.status, p).toBe(200);
      const etag = res.headers.get("etag");
      expect(etag, p).toBeTruthy();
      expect(res.headers.get("x-pulse-observation"), p).toBeTruthy();
      expect(res.headers.get("x-pulse-payload-id"), p).toBeTruthy();
      expect(res.headers.get("cache-control"), p).toBe("private, no-cache");
      expect(res.headers.get("vary"), p).toBe("Accept-Encoding");

      // A matching strong If-None-Match → bodyless 304 carrying the same validator + observation.
      const cond = await get(rt, p, { "if-none-match": etag! });
      expect(cond.status, p).toBe(304);
      expect(cond.headers.get("etag"), p).toBe(etag);
      expect(cond.headers.get("x-pulse-observation"), p).toBeTruthy();
    }

    // A bounded on-demand history route (estate-wide firing intervals) serves a direct 200 payload —
    // not a cycle representation, so no ETag/observation protocol.
    const hist = await get(rt, "/api/history/alerts");
    expect(hist.status).toBe(200);
    expect(hist.headers.get("cache-control")).toBe("private, no-cache");
    expect(hist.headers.get("etag")).toBeNull();

    // Every M1 history route is exercised directly (10 §8 "checks every route"). Estate-wide and
    // host-target curated series each serve a bounded 200 payload; the checks route rejects an
    // unknown endpoint with a safe TARGET_NOT_FOUND 404 — the sanitized fixture declares no Gatus
    // endpoints, so that is the representative outcome for that route here.
    expect((await get(rt, "/api/history/estate/estate.liveness")).status).toBe(200);

    const estate = (await (await get(rt, "/api/estate")).json()) as {
      liveTargets: readonly { target: { kind: string; id: string } | null }[];
    };
    const hostId = estate.liveTargets.find((t) => t.target?.kind === "host")!.target!.id;
    expect((await get(rt, `/api/history/target/${hostId}/host.load.1m`)).status, hostId).toBe(200);

    const checks = await get(rt, "/api/history/checks/unknown-endpoint-key");
    expect(checks.status).toBe(404);
    expect((await checks.json()).code).toBe("TARGET_NOT_FOUND");

    // History rejects any non-`range` query key before allocation (no client-supplied expression).
    expect((await get(rt, "/api/history/alerts?step=5")).status).toBe(400);
  });

  test("degraded: one source unreachable still publishes a coherent cycle; every current route stays 200", async () => {
    writeValidBundle();
    const rt = boot();
    failing.add("data:alerts"); // Alertmanager alerts source deliberately unreachable
    await rt.runOnce();

    // The cycle still publishes (degraded, never-silent-green): unaffected views stay current.
    expect(rt.getContext(null).cycle).not.toBeNull();
    for (const p of CYCLE_ROUTES) {
      expect((await get(rt, p)).status, p).toBe(200);
    }

    // Recovery is automatic on a later cycle once the source is reachable again.
    failing.clear();
    await rt.runOnce();
    expect((await get(rt, "/api/overview")).status).toBe(200);
  });

  test("error mode: a bundle loss clears the cycle → cycle routes 503 ESTATE_BUNDLE_*; operational stay live", async () => {
    writeValidBundle();
    const rt = boot();
    await rt.runOnce();
    expect(rt.getContext(null).cycle).not.toBeNull();

    // The rendered model becomes unparseable → bundle-error mode; the published cycle is cleared so no
    // stale authority is served.
    writeGeneration({ model: "{ not json", coverage: "", findings: "" });
    await rt.runOnce();
    expect(rt.getContext(null).cycle).toBeNull();

    for (const p of CYCLE_ROUTES) {
      const res = await get(rt, p);
      expect(res.status, p).toBe(503);
      expect(String((await res.json()).code), p).toMatch(/^ESTATE_BUNDLE_/);
    }

    // Operational, session, and events remain servable in bundle-error mode.
    expect((await get(rt, "/healthz")).status).toBe(200);
    expect((await get(rt, "/metrics")).status).toBe(200);
    expect((await get(rt, "/api/session")).status).toBe(200);
    const ev = await get(rt, "/api/events");
    expect(ev.status).toBe(200);
    await ev.body?.cancel();
  });
});

/* ===========================================================================================
 * WRITE PATH — auth mode none stays dark; SC-07 degraded write path (04 §11.2, 10 §7.2)
 * ========================================================================================= */

/** Every write-path capability reported by `/healthz` and `/api/session`. */
const WRITE_CAPABILITIES = ["silence", "ack", "proposeEstateEdit"] as const;

/** Write a complete valid rendered bundle (sanitized fixture) into `dir`; returns the model path. */
function writeFixtureBundle(dir: string): string {
  const f = makeEstateBundleFixture();
  const modelPath = join(dir, "web-estate-model.json");
  writeFileSync(modelPath, f.files.model);
  writeFileSync(join(dir, "web-coverage.json"), f.files.coverage ?? "");
  writeFileSync(join(dir, "web-findings.json"), f.files.findings ?? "");
  return modelPath;
}

describe("smoke:web (in-process) — write path is dark in auth mode none (REQ-COMPAT-03, REQ-CFG-03, SC-02)", () => {
  let dir: string;
  let runtime: ServerRuntime | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pulse-web-smoke-none-"));
  });

  afterEach(() => {
    runtime?.close();
    runtime = null;
    rmSync(dir, { recursive: true, force: true });
  });

  test("/healthz writePath is auth-mode-none, /api/session all false, POST /api/mutations/acks → 405, no write_path_status gauge", async () => {
    // The production compose env: data dir + secret set, auth mode unset (none) → inert.
    const env = {
      ...inProcessEnv(writeFixtureBundle(dir)),
      PULSE_WEB_DATA_DIR: join(dir, "data"),
      PULSE_PROPOSAL_SECRET: "",
    };
    const rt = createServerRuntime(loadServerConfig(env), {
      fetchImpl: makeRouter(() => new Set()),
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });
    runtime = rt;
    await rt.runOnce();
    const get = (path: string) => dispatch(new Request(`http://web:8080${path}`), path, rt, STUB_ASSETS);

    const health = await get("/healthz");
    expect(health.status).toBe(200);
    const hbody = (await health.json()) as HealthBody;
    expect(hbody.status).toBe("ok"); // write-path state never affects the top-level status
    for (const cap of WRITE_CAPABILITIES) {
      expect(hbody.writePath?.[cap], cap).toEqual({ ok: false, reason: "auth-mode-none" });
    }

    const sess = (await (await get("/api/session")).json()) as { capabilities: Record<string, boolean> };
    expect(sess.capabilities).toEqual({ silence: false, ack: false, proposeEstateEdit: false });

    // index.ts composes none mode as createFetchHandler(runtime): the default no-op mutation seam.
    const post = await dispatch(
      new Request("http://web:8080/api/mutations/acks", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "smoke-none-0001" },
        body: JSON.stringify({ fingerprint: "abc" }),
      }),
      "/api/mutations/acks",
      rt,
      STUB_ASSETS,
    );
    expect(post.status).toBe(405);
    expect(((await post.json()) as { code: string }).code).toBe("METHOD_NOT_ALLOWED");

    const metrics = await (await get("/metrics")).text();
    expect(metrics).not.toContain("pulse_web_write_path_status");
  });
});

describe("smoke:web (in-process) — SC-07 degraded write path: reads served, reasons reported, capabilities false (REQ-CFG-02)", () => {
  const IS_ROOT = process.getuid?.() === 0;
  let dir: string;
  let lockedParent: string;
  let runtime: ServerRuntime | null = null;
  let write: WriteRuntime | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pulse-web-smoke-sc07-"));
    lockedParent = mkdtempSync(join(tmpdir(), "pulse-web-smoke-sc07-ro-"));
  });

  afterEach(async () => {
    await write?.close(); // uninstalls session, metrics-status and proposal-store providers
    write = null;
    runtime?.close();
    runtime = null;
    chmodSync(lockedParent, 0o700);
    rmSync(lockedParent, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  // Root ignores directory permissions, so the chmod-0500 degradation cannot be produced there.
  test.skipIf(IS_ROOT)("an unwritable data dir under a chmod-0500 parent degrades every capability without affecting reads", async () => {
    chmodSync(lockedParent, 0o500);
    const env = {
      ...inProcessEnv(writeFixtureBundle(dir)),
      PULSE_WEB_AUTH_MODE: "proxy-header",
      PULSE_WEB_TRUSTED_PROXIES: "10.0.0.0/24",
      PULSE_WEB_DATA_DIR: join(lockedParent, "data"),
      PULSE_PROPOSAL_SECRET: "smoke-sc07-secret-0123456789-abcdefghij",
    };
    const config = loadServerConfig(env);
    const fetchImpl = makeRouter(() => new Set());
    write = await buildWriteRuntime(config, { secret: loadProposalSecret(env), fetchImpl });
    const rt = createServerRuntime(config, {
      ...write.runtimeDeps,
      fetchImpl,
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });
    runtime = rt;
    write.attachRuntime(rt);
    await rt.runOnce();

    const trusted = { peerIp: "10.0.0.7", disableTimeout() {} };
    const get = (path: string, headers?: Record<string, string>) =>
      dispatch(
        new Request(`http://web:8080${path}`, headers ? { headers } : undefined),
        path,
        rt,
        STUB_ASSETS,
        trusted,
        write!.dispatcher,
      );

    // Every read route is still served.
    for (const p of CYCLE_ROUTES) expect((await get(p)).status, p).toBe(200);

    const health = await get("/healthz");
    expect(health.status).toBe(200);
    const hbody = (await health.json()) as HealthBody;
    expect(hbody.status).toBe("ok");
    for (const cap of WRITE_CAPABILITIES) {
      expect(hbody.writePath?.[cap]?.ok, cap).toBe(false);
      expect(hbody.writePath?.[cap]?.reason, cap).not.toBe("auth-mode-none");
    }

    const metrics = await (await get("/metrics")).text();
    const audit = metrics.split("\n").find((l) => l.startsWith('pulse_web_write_path_status{store="audit"'));
    expect(audit, "audit write-path gauge series").toBeDefined();
    expect(audit).not.toContain('reason="ok"');

    // A trusted identity still gets all-false capabilities while the stores are degraded.
    const sess = await get("/api/session", { "remote-user": "alice" });
    expect(sess.status).toBe(200);
    const sbody = (await sess.json()) as { identity: unknown; capabilities: Record<string, boolean> };
    expect(sbody.identity).not.toBeNull();
    expect(sbody.capabilities).toEqual({ silence: false, ack: false, proposeEstateEdit: false });
  });
});

/* ===========================================================================================
 * COMPOSE / OPERATOR-DOC / SIGN-OFF EVIDENCE (10 §§8–9)
 *
 * The item bundles the compose wiring, operator docs, and the manual deployment checklist with the
 * smoke suite. These always-run (non-Docker) blocks are the automated evidence for those surfaces:
 * they parse the committed compose file and docs and assert the load-bearing invariants — the
 * four-origin/no-credential/optional-Grafana compose contract (AC-1), the documented routes/env/
 * ETag/SSE/limits/telemetry with no PromQL/audit/false-capability guidance (AC-2), and the honest
 * eight-item sign-off checklist that never asserts its own completion (AC-3).
 * ========================================================================================= */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const APP_DIR = resolve(import.meta.dir, "..");

describe("smoke:web — compose wires the four-origin web service (10 §8, AC-1)", () => {
  const compose = readFileSync(resolve(REPO_ROOT, "stack/compose/docker-compose.yml"), "utf8");

  /** Slice the `web:` service block out of the 2-space-indented service map (mirrors prod-build). */
  function webServiceBlock(): string {
    const lines = compose.split("\n");
    const start = lines.findIndex((l) => l === "  web:");
    expect(start, "compose must declare a `web:` service").toBeGreaterThanOrEqual(0);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join("\n");
  }

  test("declares exactly one web service/process (no scale/replicas fan-out) (REQ-SCALE-02)", () => {
    expect(compose.split("\n").filter((l) => l === "  web:")).toHaveLength(1);
    const block = webServiceBlock();
    expect(block).not.toMatch(/^\s*(replicas|scale):/m);
  });

  test("supplies the internal vmalert origin with no embedded credential", () => {
    const block = webServiceBlock();
    // Internal service DNS on the fixed vmalert port — no credentials.
    expect(block).toMatch(/^\s*PULSE_VMALERT_URL:\s*"http:\/\/vmalert:8880"\s*(#.*)?$/m);
    // No credential-bearing URL (`scheme://user:pass@host`) anywhere in the web service block.
    expect(block).not.toMatch(/:\/\/[^/"\s@]+@/);
  });

  test("leaves Grafana optional — unset on web and not a startup dependency", () => {
    const block = webServiceBlock();
    // web env does not set PULSE_GRAFANA_URL (deep links / server health stay off by default).
    expect(block).not.toMatch(/^\s*PULSE_GRAFANA_URL:/m);
    // web does not depend_on grafana, so a Grafana outage never blocks web startup.
    const dependsOn = block.slice(block.indexOf("depends_on:"));
    expect(dependsOn).not.toMatch(/^\s*grafana:/m);
  });

  test("mounts a writable /data volume with the write-path env and keeps /rendered read-only (REQ-CFG-04)", () => {
    const block = webServiceBlock();
    expect(block).toMatch(/^\s*- pulse-web-data:\/data\s*(#.*)?$/m);
    expect(block).toMatch(/^\s*PULSE_WEB_DATA_DIR: \/data\s*(#.*)?$/m);
    expect(block).toMatch(/^\s*PULSE_PROPOSAL_SECRET: \$\{PULSE_PROPOSAL_SECRET:-\}\s*(#.*)?$/m);
    expect(block).toMatch(/^\s*- \$\{PULSE_RENDERED_DIR:-\.\.\/rendered\}:\/rendered:ro\s*(#.*)?$/m);
    // Production stays in auth mode `none` (dark) until forward-auth is live: the mode is never set here.
    expect(block).not.toMatch(/PULSE_WEB_AUTH_MODE/);
  });

  test("declares the pulse-web-data top-level volume and the image owns /data before USER bun (REQ-CFG-04)", () => {
    const lines = compose.split("\n");
    const start = lines.findIndex((l) => l === "volumes:");
    expect(start, "compose must declare a top-level `volumes:` block").toBeGreaterThanOrEqual(0);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^[A-Za-z]/.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    expect(lines.slice(start, end).join("\n")).toMatch(/^ {2}pulse-web-data: \{\}\s*(#.*)?$/m);

    const dockerfile = readFileSync(resolve(APP_DIR, "Dockerfile"), "utf8");
    const chown = dockerfile.indexOf("RUN mkdir -p /data && chown bun:bun /data");
    const user = dockerfile.search(/^USER bun$/m);
    expect(chown, "Dockerfile must create and chown /data").toBeGreaterThanOrEqual(0);
    expect(user).toBeGreaterThan(chown);
  });
});

describe("smoke:web — operator docs are complete and safe (10 §8, AC-2)", () => {
  const readme = readFileSync(resolve(APP_DIR, "README.md"), "utf8");
  const developing = readFileSync(resolve(APP_DIR, "DEVELOPING.md"), "utf8");

  test("README documents every M1 route", () => {
    for (const route of [
      "/healthz",
      "/metrics",
      "/api/overview",
      "/api/alerts",
      "/api/estate",
      "/api/engine",
      "/api/timeline",
      "/api/session",
      "/api/events",
      "/api/history/estate/:queryId",
      "/api/history/target/:drilldownId/:queryId",
      "/api/history/alerts",
      "/api/history/checks/:endpoint",
    ]) {
      expect(readme, route).toContain(route);
    }
  });

  test("README documents env, ETag/gzip/SSE, limits, and every telemetry family", () => {
    for (const env of [
      "PULSE_VM_URL",
      "PULSE_ALERTMANAGER_URL",
      "PULSE_GATUS_URL",
      "PULSE_VMALERT_URL",
      "PULSE_GRAFANA_URL",
      "PULSE_WEB_AUTH_MODE",
    ]) {
      expect(readme, env).toContain(env);
    }
    expect(readme).toContain("ETag");
    expect(readme).toContain("X-Pulse-Observation");
    expect(readme).toContain("304");
    expect(readme).toContain("retry: 10000");
    // The fixed-limits table carries the body budgets and observation-header bound.
    expect(readme).toContain("5 MiB / 1 MiB");
    expect(readme).toContain("8 KiB");
    for (const fam of [
      "pulse_web_cycle_sequence",
      "pulse_web_cycle_duration_seconds",
      "pulse_web_cycle_publications_total",
      "pulse_web_source_up",
      "pulse_web_upstream_calls_total",
      "pulse_web_sse_streams",
      "pulse_web_sse_events_total",
      "pulse_web_history_requests_total",
      "pulse_web_history_cache_hits_total",
      "pulse_web_history_active",
      "pulse_web_history_queued",
    ]) {
      expect(readme, fam).toContain(fam);
    }
  });

  test("docs never tell users to supply PromQL; the write path is documented as inert in auth mode none", () => {
    // The curated-catalog contract is stated affirmatively; clients never send a query expression.
    // (The phrase may wrap across a line break in the source Markdown.)
    expect(readme).toMatch(/never send\s+PromQL/i);
    // M2 re-scope (04 §11.2): the write path exists but is inert in the default auth mode, and the
    // operator doc is linked for everything else.
    expect(readme).not.toMatch(/No audit path/i);
    expect(readme).toMatch(/write path[\s\S]{0,120}inert in auth mode\s+`none`/i);
    expect(readme).toContain("docs/operator/write-path.md");
    // Negative guards, kept only for instructions to ENABLE capabilities: neither app doc tells an
    // operator to set an audit env var or to switch the auth mode on.
    expect(readme).not.toMatch(/set\s+PULSE_\w*AUDIT/i);
    expect(developing).not.toMatch(/set\s+PULSE_\w*AUDIT/i);
    expect(readme).not.toMatch(/set\s+PULSE_WEB_AUTH_MODE\s*=?\s*`?proxy-header/i);
    expect(developing).not.toMatch(/set\s+PULSE_WEB_AUTH_MODE\s*=?\s*`?proxy-header/i);
  });

  test("DEVELOPING documents four-origin syntax, package watch, failure recovery, and fixtures", () => {
    expect(developing).toContain("--engine");
    expect(developing).toMatch(/VictoriaMetrics, Alertmanager, Gatus, vmalert/);
    expect(developing).toContain("vmalert.json");
    expect(developing).toMatch(/tsc -b/);
    expect(developing).toMatch(/package build FAILED/);
  });

  test("README documents the security posture, degradation behavior, and build", () => {
    // Security (AC-2 "security"): GET-only read-only stance + dark mutation/audit seams.
    expect(readme).toContain("no built-in authentication");
    expect(readme).toMatch(/only.{0,20}GET/i);
    expect(readme).toMatch(/mutation and audit seams ship dark/i);
    expect(readme).toMatch(/without reading a body/i);
    // Mode-qualified (V-003): read-only in `none`; `proxy-header` adds the write path, documented.
    expect(readme).toMatch(/default\s+auth mode `none` every route is read-only/);
    expect(readme).toMatch(/`proxy-header` mode the write path adds/);
    expect(readme).toContain("POST /api/mutations/proposals");
    expect(readme).toContain("PULSE_DEV_LOOP=1");
    // Degradation (AC-2 "degradation"): NOT_READY before first cycle + never-silent-green.
    expect(readme).toContain("Not-ready and degradation");
    expect(readme).toContain("NOT_READY");
    expect(readme).toContain("never-silent-green");
    // Build (AC-2 "build-watch"): README owns build; DEVELOPING owns the watch/failure half above.
    expect(readme).toContain("## Build");
    expect(readme).toMatch(/compiles the workspace package graph first/i);
  });
});

describe("smoke:web — deployment sign-off checklist is honest and complete (10 §9, AC-3)", () => {
  const signoff = readFileSync(resolve(APP_DIR, "DEPLOYMENT-SIGNOFF.md"), "utf8");

  test("all eight sign-off evidence topics are present", () => {
    const topics: readonly [string, RegExp][] = [
      ["1 SSE proxy heartbeats/ticks", /X-Accel-Buffering/i],
      ["1 heartbeat cadence", /heartbeat about every five seconds/i],
      ["2 reconnect convergence", /reconnect/i],
      ["3 gzip / bodyless 304", /bodyless\s+`?304/i],
      ["4 bounded telemetry", /pulse_web_\*/],
      ["5 per-source degradation + recovery", /deliberately unreachable/i],
      ["6 real consumed-field validators", /consumed-field validators/i],
      ["7 fixed VM load vs viewers", /scale with viewer/i],
      ["8 body budgets", /5 MiB plain/i],
    ];
    for (const [label, re] of topics) {
      expect(signoff, label).toMatch(re);
    }
  });

  test("nothing is marked complete — every box is unchecked (never asserts completion)", () => {
    // Eight evidence items + one final sign-off box, all unchecked `- [ ]`.
    const unchecked = signoff.match(/^- \[ \]/gm) ?? [];
    expect(unchecked.length).toBeGreaterThanOrEqual(9);
    // No checked box anywhere — the checklist never claims it ran.
    expect(signoff).not.toMatch(/- \[[xX]\]/);
    // The explicit not-yet-performed banner is present.
    expect(signoff).toMatch(/NOT YET PERFORMED/);
  });

  test("safe recording fields are present and secrets are forbidden", () => {
    for (const field of [
      /Date \(UTC\)/,
      /git SHA/i,
      /Bun version/i,
      /Image tag/i,
      /proxy config reference/i,
      /Estate counts/i,
      /Commands run/i,
      /Residual risk/i,
    ]) {
      expect(signoff, String(field)).toMatch(field);
    }
    // Explicitly forbids recording credentials / raw headers / source bodies.
    expect(signoff).toMatch(/record credentials.*source bodies/i);
  });
});
