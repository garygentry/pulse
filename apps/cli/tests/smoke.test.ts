// apps/cli/tests/smoke.test.ts — the agent-loop end-to-end smoke (SC-01/SC-03, 07 §3.8).
//
// Wired as forge.config.json's `smokeCommand = "bun run smoke"` (root script, item 001). It
// drives the full author→validate→render→coverage loop on a SCRATCH estate using ONLY the
// `--json` payloads and exit codes — no human-text scraping — proving an automated operator
// could complete the loop unaided. Each step asserts stdout is exactly one parseable
// PulseEnvelope with `ok === (exitCode === 0)` and the expected `data` shape.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FINDING_CODES } from "@pulse/core";

import { runCli } from "./factories.js";
import type {
  PulseEnvelope,
  InitData,
  RenderData,
  CoverageData,
  ConnectLinkData,
  PushDevicesData,
  PushPairData,
  PushRevokeData,
  PushTestData,
} from "../src/envelope.js";
import type { ExitCode } from "../src/exit.js";
// Tests-only cross-tree import: the in-process push server harness and its fake APNs.
import { startPushTestServer, type PushTestServer } from "../../web/tests/push/helpers/push-server.js";
import { createTestTls } from "../../web/tests/push/helpers/tls.js";

/** Parse the sole stdout object into a typed envelope, asserting the universal invariants. */
function envelope<D>(
  stdout: string,
  exitCode: ExitCode,
  command: PulseEnvelope["command"],
): PulseEnvelope<D> {
  // Exactly one object: byte-for-byte the canonical 2-space serialization + one newline.
  const parsed = JSON.parse(stdout) as PulseEnvelope<D>;
  expect(stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  // The agent keys on these three signals alone (SC-05).
  expect(parsed.command).toBe(command);
  expect(parsed.exitCode).toBe(exitCode);
  expect(parsed.ok).toBe(exitCode === 0);
  return parsed;
}

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "pulse-smoke-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("agent-loop smoke: init → validate → render → coverage (SC-01/SC-03)", () => {
  test("an operator completes the loop on a scratch estate using only --json + exit codes", async () => {
    // (1) init — scaffold a valid estate into an EMPTY temp dir. Exit 0; scaffold created.
    const initRun = await runCli(["init", "--json"], { cwd: repo });
    expect(initRun.exitCode).toBe(0);
    const init = envelope<InitData>(initRun.stdout, 0, "init");
    expect(init.data).not.toBeNull();
    expect(init.data!.created).toContain("pulse.config.yaml");
    expect(init.data!.created).toContain("estate/estate.yaml");
    expect(init.data!.wouldClobber).toBeUndefined();
    // The scaffold is physically on disk (init is not a dry run).
    expect(existsSync(join(repo, "estate", "estate.yaml"))).toBe(true);

    // (2) validate — the fresh scaffold loads clean: exit 0, no findings, data null.
    const validateRun = await runCli(["validate", "--json"], { cwd: repo });
    expect(validateRun.exitCode).toBe(0);
    const validate = envelope<null>(validateRun.stdout, 0, "validate");
    expect(validate.findings).toEqual([]);
    expect(validate.data).toBeNull();

    // (3) render — writes a tree. Exit 0, write mode, at least one file, no drift key.
    const renderRun = await runCli(["render", "--json"], { cwd: repo });
    expect(renderRun.exitCode).toBe(0);
    const render = envelope<RenderData>(renderRun.stdout, 0, "render");
    expect(render.data).not.toBeNull();
    expect(render.data!.mode).toBe("write");
    expect(render.data!.filesWritten.length).toBeGreaterThan(0);
    expect(render.data!.drift).toBeUndefined();
    // Every listed relative path exists under the rendered output root (which the config
    // layer resolves to an absolute path; `resolve` handles absolute-or-relative).
    for (const rel of render.data!.filesWritten) {
      expect(existsSync(resolve(repo, render.data!.outputRoot, rel))).toBe(true);
    }

    // (4) coverage — the scaffold is fully covered: exit 0, no gaps, ≥1 covered entity.
    const coverageRun = await runCli(["coverage", "--json"], { cwd: repo });
    expect(coverageRun.exitCode).toBe(0);
    const coverage = envelope<CoverageData>(coverageRun.stdout, 0, "coverage");
    expect(coverage.data).not.toBeNull();
    expect(coverage.data!.gaps).toEqual([]);
    expect(coverage.data!.covered.length).toBeGreaterThan(0);
  });

  test("each step's stdout is a self-describing envelope — no stderr scraping needed", async () => {
    // Drive the loop and assert that for EVERY step the machine channel alone carries the
    // full outcome: `ok` matches the exit code and the command discriminant is present.
    await runCli(["init", "--json"], { cwd: repo });
    for (const command of ["validate", "render", "coverage"] as const) {
      const run = await runCli([command, "--json"], { cwd: repo });
      const parsed = JSON.parse(run.stdout) as PulseEnvelope;
      expect(parsed.command).toBe(command);
      expect(parsed.ok).toBe(run.exitCode === 0);
      // The whole outcome is decidable from stdout + exit code alone.
      expect(run.exitCode).toBe(0);
    }
  });
});

describe("connect-link smoke", () => {
  test("connect-link --url --json exits 0 with the link in the envelope", async () => {
    const run = await runCli(["connect-link", "--url", "https://pulse.example.com", "--json"], {
      cwd: repo,
    });
    expect(run.exitCode).toBe(0);
    const parsed = envelope<ConnectLinkData>(run.stdout, 0, "connect-link");
    expect(parsed.findings).toEqual([]);
    expect(parsed.data).toEqual({
      link: "pulse://connect?v=1&url=https%3A%2F%2Fpulse.example.com",
      baseUrl: "https://pulse.example.com",
      source: "flag",
    });
  });
});

// The push harness needs openssl for the fake APNs certificate: createTestTls() returns null
// locally when it is missing (the describe skips) and throws under CI=true.
const pushTls = createTestTls();
const REPO_ROOT = resolve(import.meta.dir, "../../..");

describe.skipIf(pushTls === null)("push smoke against the in-process push server (openssl required)", () => {
  let server: PushTestServer;
  let disabled: PushTestServer;
  /** Every stdout/stderr this describe captures, checked for the operator secret at the end. */
  const streams: string[] = [];

  beforeAll(async () => {
    server = await startPushTestServer();
    disabled = await startPushTestServer({ state: "disabled" });
  });
  afterAll(async () => {
    await server?.close();
    await disabled?.close();
  });

  /** runCli with the operator secret in env (or `secret`), recording both streams. */
  async function push(
    args: string[],
    opts: { secret?: string; fetch?: typeof fetch } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const run = await runCli(["push", ...args], {
      cwd: repo,
      env: { PULSE_PUSH_OPERATOR_SECRET: opts.secret ?? server.secrets.operator },
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    });
    streams.push(run.stdout, run.stderr);
    return run;
  }

  /** The real-network flags for the configured harness listener. */
  const local = (): string[] => ["--server", server.baseUrl, "--insecure-local", "--json"];

  test("injected fetch, no socket: push devices lists no device", async () => {
    const handlerFetch = ((input: string | URL | Request, init?: RequestInit) =>
      server.handler(new Request(input, init))) as typeof fetch;
    const run = await push(["devices", "--server", "https://pulse.example.com", "--json"], {
      fetch: handlerFetch,
    });
    expect(run.exitCode).toBe(0);
    const env = envelope<PushDevicesData>(run.stdout, 0, "push");
    expect(env.data!.devices).toEqual([]);
  });

  test("real network: test, pair, register, devices, test, revoke, wrong secret in order", async () => {
    // (1) No device yet: the test send has nothing to reach.
    const empty = await push(["test", ...local()]);
    expect(empty.exitCode).toBe(1);
    const emptyEnv = envelope<PushTestData>(empty.stdout, 1, "push");
    expect(emptyEnv.findings.map((f) => f.code)).toContain(FINDING_CODES.PUSH_NO_DEVICES);

    // (2) Pair: the link base is the server's external URL, not the 127.0.0.1 listener.
    const pairRun = await push(["pair", ...local()]);
    expect(pairRun.exitCode).toBe(0);
    const pair = envelope<PushPairData>(pairRun.stdout, 0, "push");
    const link = pair.data!.link;
    expect(new URL(link).searchParams.get("url")).toBe("https://pulse.example.com");

    // (3) Redeem and register a device from the link.
    const { deviceId } = await server.register(link);

    // (4) One device listed.
    const listed = await push(["devices", ...local()]);
    expect(listed.exitCode).toBe(0);
    const devices = envelope<PushDevicesData>(listed.stdout, 0, "push").data!.devices;
    expect(devices.map((d) => d.id)).toEqual([deviceId]);

    // (5) The test send reaches the fake APNs once.
    const before = server.apns.requests.length;
    const tested = await push(["test", ...local()]);
    expect(tested.exitCode).toBe(0);
    const results = envelope<PushTestData>(tested.stdout, 0, "push").data!.results;
    expect(results).toHaveLength(1);
    expect(results[0]!.deviceId).toBe(deviceId);
    expect(results[0]!.outcome).toBe("delivered");
    const received = server.apns.requests.slice(before);
    expect(received).toHaveLength(1);
    expect(JSON.stringify(received[0]!.body)).toContain("PULSE_TEST");

    // (6) Revoke, then the list is empty.
    const revoked = await push(["revoke", deviceId, ...local()]);
    expect(revoked.exitCode).toBe(0);
    expect(envelope<PushRevokeData>(revoked.stdout, 0, "push").data).toEqual({ deviceId });
    const after = await push(["devices", ...local()]);
    expect(after.exitCode).toBe(0);
    expect(envelope<PushDevicesData>(after.stdout, 0, "push").data!.devices).toEqual([]);

    // (7) A wrong secret is refused.
    const wrong = await push(["devices", ...local()], { secret: "w".repeat(48) });
    expect(wrong.exitCode).toBe(1);
    const wrongEnv = envelope<PushDevicesData>(wrong.stdout, 1, "push");
    expect(wrongEnv.findings.map((f) => f.code)).toEqual([FINDING_CODES.PUSH_OPERATOR_REFUSED]);
  });

  test("the real entry point as an async subprocess", async () => {
    // Async Bun.spawn: a synchronous spawn would block this process's event loop, and with it
    // the in-process server the subprocess talks to.
    const proc = Bun.spawn(
      ["bun", "apps/cli/src/index.ts", "push", "devices", "--server", server.baseUrl, "--insecure-local", "--json"],
      {
        cwd: REPO_ROOT,
        env: { PULSE_PUSH_OPERATOR_SECRET: server.secrets.operator, PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    streams.push(stdout, stderr);
    expect(exitCode).toBe(0);
    const env = envelope<PushDevicesData>(stdout, 0, "push");
    expect(Array.isArray(env.data!.devices)).toBe(true);
    expect(stderr).toContain("warning: --insecure-local:");
  });

  test("push disabled: devices (404) and revoke (405, no probe) give PUSH_NOT_CONFIGURED", async () => {
    const seen: { method: string; path: string; status: number }[] = [];
    const recording = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const res = await fetch(request);
      seen.push({ method: request.method, path: new URL(request.url).pathname, status: res.status });
      return res;
    }) as typeof fetch;
    const flags = ["--server", disabled.baseUrl, "--insecure-local", "--json"];

    const list = await push(["devices", ...flags], { secret: disabled.secrets.operator, fetch: recording });
    expect(list.exitCode).toBe(1);
    expect(envelope<PushDevicesData>(list.stdout, 1, "push").findings.map((f) => f.code)).toEqual([
      FINDING_CODES.PUSH_NOT_CONFIGURED,
    ]);
    expect(seen).toEqual([{ method: "GET", path: "/api/push/admin/devices", status: 404 }]);

    seen.length = 0;
    const revoke = await push(["revoke", "dev_AbCdEfGhIjK", ...flags], {
      secret: disabled.secrets.operator,
      fetch: recording,
    });
    expect(revoke.exitCode).toBe(1);
    expect(envelope<PushRevokeData>(revoke.stdout, 1, "push").findings.map((f) => f.code)).toEqual([
      FINDING_CODES.PUSH_NOT_CONFIGURED,
    ]);
    // A 405 is not device-scoped, so no probe GET follows it.
    expect(seen).toEqual([{ method: "DELETE", path: "/api/push/admin/devices/dev_AbCdEfGhIjK", status: 405 }]);
  });

  test("no captured stream contains the operator secret", () => {
    expect(streams.length).toBeGreaterThan(0);
    for (const s of streams) {
      expect(s.includes(server.secrets.operator)).toBe(false);
      expect(s.includes(disabled.secrets.operator)).toBe(false);
    }
  });
});
