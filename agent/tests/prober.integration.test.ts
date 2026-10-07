/// <reference path="./bun-test.d.ts" />

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROBER_PORT } from "../contract/constants.js";
import { AGENT_ROOT, CURL_IMAGE, run } from "./harness.js";

const RUN_ID = `${process.pid}-${randomUUID()}`;
const IMAGE = `pulse/prober:smoke-${RUN_ID}`;
const NETWORK = `pulse-test-prober-${RUN_ID}-net`;
const CONTAINER = `pulse-test-prober-${RUN_ID}`;

function dockerDaemonReachable(): boolean {
  try {
    return run(["docker", "version"]).exitCode === 0;
  } catch {
    return false;
  }
}

const dockerDescribe = dockerDaemonReachable() ? describe : describe.skip;
let renderedDir = "";

function docker(...args: string[]): ReturnType<typeof run> {
  return run(["docker", ...args]);
}

function removeContainer(): void {
  docker("rm", "-f", CONTAINER);
}

function startProber(): ReturnType<typeof run> {
  removeContainer();
  return docker(
    "run", "-d", "--name", CONTAINER, "--network", NETWORK,
    "-v", `${renderedDir}:/rendered/prober:ro`, IMAGE,
  );
}

function poll(path: string, timeoutSeconds = 30): ReturnType<typeof run> {
  let result = run(["false"]);
  for (let elapsed = 0; elapsed < timeoutSeconds; elapsed += 1) {
    result = docker(
      "run", "--rm", "--network", NETWORK, CURL_IMAGE,
      "-fsS", "--max-time", "2", `http://${CONTAINER}:${PROBER_PORT}${path}`,
    );
    if (result.exitCode === 0) return result;
    run(["sleep", "1"]);
  }
  return result;
}

dockerDescribe("central prober container runtime", () => {
  beforeAll(() => {
    renderedDir = mkdtempSync(join(tmpdir(), "pulse-prober-smoke-"));
    chmodSync(renderedDir, 0o755);
    const build = docker(
      "build", AGENT_ROOT, "-f", join(AGENT_ROOT, "prober", "Dockerfile"), "-t", IMAGE,
    );
    if (build.exitCode !== 0) {
      throw new Error(`prober image build failed:\n${build.stderr}`);
    }
    const network = docker("network", "create", NETWORK);
    if (network.exitCode !== 0) throw new Error(`network create failed: ${network.stderr}`);
  }, 420_000);

  afterAll(() => {
    const failures: string[] = [];
    try {
      const container = docker("rm", "-f", CONTAINER);
      if (container.exitCode !== 0 && !/No such container/i.test(container.stderr)) {
        failures.push(`container cleanup failed: ${container.stderr}`);
      }
      const network = docker("network", "rm", NETWORK);
      if (network.exitCode !== 0 && !/not found|No such network/i.test(network.stderr)) {
        failures.push(`network cleanup failed: ${network.stderr}`);
      }
      const image = docker("image", "rm", IMAGE);
      if (image.exitCode !== 0 && !/No such image/i.test(image.stderr)) {
        failures.push(`image cleanup failed: ${image.stderr}`);
      }
    } finally {
      rmSync(renderedDir, { recursive: true, force: true });
    }
    if (failures.length > 0) throw new Error(failures.join("\n"));
  }, 120_000);

  test("absent config idles healthy and serves metrics", () => {
    const started = startProber();
    expect(started.exitCode).toBe(0);
    expect(poll("/healthz").stdout).toBe("ok");
    expect(poll("/metrics").exitCode).toBe(0);
  }, 90_000);

  test("valid config starts and serves metrics", () => {
    writeFileSync(join(renderedDir, "config.yaml"), "probes: []\n", "utf8");
    const started = startProber();
    expect(started.exitCode).toBe(0);
    expect(poll("/metrics").exitCode).toBe(0);
  }, 90_000);

  test("malformed config exits non-zero instead of reporting healthy", () => {
    writeFileSync(join(renderedDir, "config.yaml"), "probes: [ malformed: yaml: value\n", "utf8");
    const started = startProber();
    expect(started.exitCode).toBe(0);
    let running = true;
    for (let elapsed = 0; elapsed < 30 && running; elapsed += 1) {
      const inspect = docker("inspect", "-f", "{{.State.Running}}", CONTAINER);
      running = inspect.exitCode === 0 && inspect.stdout.trim() === "true";
      if (running) run(["sleep", "1"]);
    }
    expect(running).toBe(false);
    const inspect = docker("inspect", "-f", "{{.State.ExitCode}}", CONTAINER);
    expect(inspect.exitCode).toBe(0);
    expect(Number(inspect.stdout.trim()) > 0).toBe(true);
  }, 90_000);
});
