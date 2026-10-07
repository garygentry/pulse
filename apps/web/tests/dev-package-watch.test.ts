// apps/web/tests/dev-package-watch.test.ts — item 054 / web-data-tier 02 §9.
//
// Covers the integrated dependency-package watch: renderer/web-data are compiled before the first
// client build/server spawn, package edits coalesce off-side, a SUCCESSFUL package build triggers
// exactly one client rebuild + one ordered server restart, a FAILED build preserves the last valid
// outputs/manifest/server and reloads nothing, and a later valid edit recovers without restarting
// the supervisor. Two layers:
//   1. deterministic controller tests (injected build fn, gates) — exact cycle/coalescing counts;
//   2. one temp-workspace integration test with REAL fs watchers proving a source edit builds and
//      that emitted `dist` writes never self-trigger.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  buildDevPackages,
  createPackageWatchController,
  installPackageWatchers,
  isPackageConfigFile,
  isWatchedFile,
  type PackageBuildResult,
} from "../scripts/dev.js";

function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve0!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve0 = res;
  });
  return { promise, resolve: resolve0 };
}

const okResult = (durationMs = 10): PackageBuildResult => ({ ok: true, durationMs });
const failResult = (durationMs = 10): PackageBuildResult => ({ ok: false, durationMs });

async function tick(ms = 5): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await tick(10);
  }
}

describe("createPackageWatchController — §9 dependency build orchestration", () => {
  test("primeBuild sets health WITHOUT firing a consumer cycle (§9 point 1)", async () => {
    let cycles = 0;
    const controller = createPackageWatchController({
      build: async () => okResult(),
      onConsumerCycle: () => {
        cycles += 1;
      },
      debounceMs: 0,
    });

    const result = await controller.primeBuild();
    expect(result.ok).toBe(true);
    expect(cycles).toBe(0);
    expect(controller.healthy()).toBe(true);
    expect(controller.suspended()).toBe(false);
  });

  test("a single package edit triggers EXACTLY ONE consumer cycle after dist is complete (AC2)", async () => {
    let cycles = 0;
    let built = 0;
    const controller = createPackageWatchController({
      build: async () => {
        built += 1;
        return okResult();
      },
      onConsumerCycle: () => {
        cycles += 1;
      },
      debounceMs: 0,
    });

    await controller.schedule();
    await tick();
    expect(built).toBe(1);
    expect(cycles).toBe(1);
    expect(controller.suspended()).toBe(false);
  });

  test("a compile error preserves outputs (no cycle) and a later valid edit recovers exactly once (AC3)", async () => {
    let cycles = 0;
    const results: PackageBuildResult[] = [];
    let outcome: PackageBuildResult = failResult();
    const controller = createPackageWatchController({
      build: async () => outcome,
      onConsumerCycle: () => {
        cycles += 1;
      },
      onResult: (r) => results.push(r),
      debounceMs: 0,
    });

    // Failed build: diagnostics recorded, NO consumer cycle, consumers suspended.
    await controller.schedule();
    await tick();
    expect(results.at(-1)?.ok).toBe(false);
    expect(cycles).toBe(0);
    expect(controller.healthy()).toBe(false);
    expect(controller.suspended()).toBe(true);

    // Correction: one successful build → exactly one consumer cycle, recovered.
    outcome = okResult();
    await controller.schedule();
    await tick();
    expect(cycles).toBe(1);
    expect(controller.healthy()).toBe(true);
    expect(controller.suspended()).toBe(false);
  });

  test("burst edits coalesce to one in-flight plus EXACTLY ONE follow-up build (AC4)", async () => {
    let built = 0;
    let cycles = 0;
    const gates = [defer<void>(), defer<void>()];
    const controller = createPackageWatchController({
      build: async () => {
        const gate = gates[built] ?? gates[gates.length - 1]!;
        built += 1;
        await gate.promise;
        return okResult();
      },
      onConsumerCycle: () => {
        cycles += 1;
      },
      debounceMs: 0,
    });

    // Kick the first build, then a burst of N schedules while it is in flight.
    void controller.schedule();
    await tick();
    expect(controller.running()).toBe(true);
    void controller.schedule();
    void controller.schedule();
    void controller.schedule();
    void controller.schedule();

    gates[0]!.resolve();
    await tick();
    // First build settled → one cycle; the coalesced follow-up is now in flight.
    expect(built).toBe(2);
    expect(cycles).toBe(1);

    gates[1]!.resolve();
    await tick();
    // Exactly two builds total (in-flight + one follow-up); no third build for the burst.
    expect(built).toBe(2);
    expect(cycles).toBe(2);
    expect(controller.state()).toBe("idle");
  });

  test("consumers are suspended while a build is in flight (§9 point 4)", async () => {
    const gate = defer<void>();
    let blocking = false;
    const controller = createPackageWatchController({
      build: async () => {
        if (blocking) await gate.promise;
        return okResult();
      },
      onConsumerCycle: () => {},
      debounceMs: 0,
    });

    await controller.primeBuild(); // healthy baseline
    expect(controller.suspended()).toBe(false);

    blocking = true;
    void controller.schedule();
    await tick();
    expect(controller.running()).toBe(true);
    expect(controller.suspended()).toBe(true); // building → suspended

    gate.resolve();
    await tick();
    expect(controller.suspended()).toBe(false); // back to healthy + idle
  });
});

describe("buildDevPackages — off-side tsc -b, never rejects", () => {
  test("maps a zero exit to ok and a non-zero exit to a preserved failure", async () => {
    const ok = await buildDevPackages("/repo", () => ({ exited: Promise.resolve(0) }));
    expect(ok.ok).toBe(true);

    const bad = await buildDevPackages("/repo", () => ({ exited: Promise.resolve(2) }));
    expect(bad.ok).toBe(false);
  });

  test("a spawn throw is normalized to a failure result, never a rejection", async () => {
    const result = await buildDevPackages("/repo", () => {
      throw new Error("spawn failed");
    });
    expect(result.ok).toBe(false);
  });
});

describe("package watch filters — dist/tsbuildinfo never self-trigger (§9 point 2)", () => {
  test("isPackageConfigFile admits only tsconfig.json / package.json", () => {
    expect(isPackageConfigFile("tsconfig.json")).toBe(true);
    expect(isPackageConfigFile("package.json")).toBe(true);
    expect(isPackageConfigFile("dist")).toBe(false);
    expect(isPackageConfigFile("out.js")).toBe(false);
    expect(isPackageConfigFile(".tsbuildinfo")).toBe(false);
    expect(isPackageConfigFile(null)).toBe(false);
  });

  test("isWatchedFile rejects emitted declaration/buildinfo artifacts", () => {
    expect(isWatchedFile("mod.ts")).toBe(true);
    expect(isWatchedFile(".tsbuildinfo")).toBe(false); // dotfile
    expect(isWatchedFile("index.d.ts")).toBe(true); // .ts by extension — but lives under dist, never watched (src-only)
  });
});

// ─── Temp-workspace integration (§9.1) ────────────────────────────────────────────────────────────

describe("installPackageWatchers + controller — real fs watch integration (§9.1)", () => {
  let repoRoot: string;
  let srcIndex: string;
  let distOut: string;
  let handle: { close(): void } | null = null;

  beforeEach(() => {
    repoRoot = mkdtempSync(resolve(tmpdir(), "pulse-devpkg-"));
    for (const pkg of ["core", "renderer", "web-data"]) {
      mkdirSync(resolve(repoRoot, "packages", pkg, "src"), { recursive: true });
    }
    const wd = resolve(repoRoot, "packages", "web-data");
    mkdirSync(resolve(wd, "dist"), { recursive: true });
    srcIndex = resolve(wd, "src", "index.ts");
    distOut = resolve(wd, "dist", "out.js");
    writeFileSync(srcIndex, "export const v = 1;\n");
    writeFileSync(resolve(wd, "tsconfig.json"), "{}\n");
    writeFileSync(resolve(wd, "package.json"), '{ "name": "@pulse/web-data" }\n');
  });

  afterEach(() => {
    handle?.close();
    handle = null;
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("source edit → package output changes → one consumer cycle; dist writes never self-trigger", async () => {
    // A deterministic fake compiler standing in for `tsc -b`: it reads the package source and emits
    // dist/out.js keyed by the source hash, EXCEPT when the source carries a syntax-error marker, in
    // which case it fails and leaves the last valid dist untouched (mirrors tsc -b's no-emit-on-error).
    const compile = async (): Promise<PackageBuildResult> => {
      const src = readFileSync(srcIndex, "utf8");
      if (src.includes("SYNTAX_ERROR")) return failResult();
      const id = createHash("sha256").update(src).digest("hex").slice(0, 12);
      writeFileSync(distOut, `export const buildId = ${JSON.stringify(id)};\n`);
      return okResult();
    };

    let cycles = 0;
    let manifest = "";
    let scheduleCalls = 0;
    const controller = createPackageWatchController({
      build: compile,
      onConsumerCycle: () => {
        cycles += 1;
        manifest = readFileSync(distOut, "utf8"); // the consumer authority after dist is complete
      },
      debounceMs: 20,
    });

    // §9 point 1: build the package before wiring consumers; no cycle from the prime build.
    await controller.primeBuild();
    expect(cycles).toBe(0);
    const primed = readFileSync(distOut, "utf8");

    handle = installPackageWatchers(repoRoot, () => {
      scheduleCalls += 1;
      void controller.schedule();
    });

    // (a) A real source edit → build → dist changes → exactly one consumer cycle.
    writeFileSync(srcIndex, "export const v = 2;\n");
    await waitFor(() => cycles === 1);
    expect(manifest).not.toBe(primed);
    const afterEdit = manifest;

    // (b) A syntax error → build fails → dist unchanged, NO new cycle, consumers suspended.
    writeFileSync(srcIndex, "export const v = 2; // SYNTAX_ERROR\n");
    await waitFor(() => !controller.healthy());
    await tick(150);
    expect(cycles).toBe(1); // still one — the failed build reloaded nothing
    expect(readFileSync(distOut, "utf8")).toBe(afterEdit); // last valid dist preserved
    expect(controller.suspended()).toBe(true);

    // (c) Correcting the error → one successful build → exactly one more consumer cycle (recovery).
    writeFileSync(srcIndex, "export const v = 3;\n");
    await waitFor(() => cycles === 2);
    expect(controller.healthy()).toBe(true);
    expect(manifest).not.toBe(afterEdit);

    // (d) Emitted dist writes must NOT self-trigger a build (§9 point 2).
    const cyclesBefore = cycles;
    const scheduleBefore = scheduleCalls;
    writeFileSync(resolve(repoRoot, "packages", "web-data", "dist", "extra.js"), "// emitted\n");
    writeFileSync(resolve(repoRoot, "packages", "web-data", "dist", ".tsbuildinfo"), "{}\n");
    await tick(300);
    expect(scheduleCalls).toBe(scheduleBefore);
    expect(cycles).toBe(cyclesBefore);

    // (e) A config (export map) edit DOES route through the controller.
    writeFileSync(resolve(repoRoot, "packages", "web-data", "package.json"), '{ "name": "@pulse/web-data", "version": "0.0.1" }\n');
    await waitFor(() => cycles === cyclesBefore + 1);
  }, 20_000);
});
