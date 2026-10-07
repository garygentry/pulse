// apps/web/tests/dev-watch.test.ts — item 016 / REQ-PERF-02, REQ-CONC-01, REQ-DEV-10.
//
// Exercises the pure supervisor seams without a bundler, filesystem watch, or child process:
//   - createBuildScheduler coalesces N synchronous schedule() calls during a build into ONE
//     follow-up build regardless of how many events arrived (REQ-CONC-01);
//   - logBuildResult prints the exact line formats for both success and failure branches;
//   - isWatchedFile filters swap files, dotfiles, and the wrong extensions;
//   - a server-source change routes to the restart scheduler and NOT to the build scheduler
//     (the two are decoupled — restart-vs-rebuild routing).

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  createBuildScheduler,
  createPackageWatchController,
  createRestartScheduler,
  isWatchedFile,
  logBuildResult,
  logPackageBuildResult,
} from "../scripts/dev.js";
import type { ClientBuildResult } from "../scripts/build-client.js";
import type { PackageBuildResult } from "../scripts/dev.js";
import type { ClientManifest } from "../src/server/assets.js";

// A tiny deferred so tests can synchronously kick a build then complete it later.
function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const OK_MANIFEST: ClientManifest = {
  buildId: "3f9c2a1b7e40",
  entries: { js: ["/assets/main-abc.js"], css: ["/assets/main-def.css"] },
  chunks: [],
  chunkCss: {},
};
const okResult = (durationMs = 100): ClientBuildResult => ({
  ok: true,
  manifest: OK_MANIFEST,
  // Bun's metafile is not needed for these seams — cast a minimal stand-in.
  metafile: { inputs: {}, outputs: {} } as unknown as ClientBuildResult extends { metafile: infer M }
    ? M
    : never,
  durationMs,
});
const failResult = (errors: readonly string[], durationMs = 50): ClientBuildResult => ({
  ok: false,
  errors,
  durationMs,
});

describe("createBuildScheduler — REQ-CONC-01 single-writer + REQ-PERF-02 coalescing", () => {
  test("N synchronous schedules during one build produce EXACTLY ONE follow-up build", async () => {
    const results: ClientBuildResult[] = [];
    const gates = [defer<void>(), defer<void>()];
    let buildCount = 0;
    const scheduler = createBuildScheduler({
      debounceMs: 0,
      build: async () => {
        const gate = gates[buildCount] ?? gates[gates.length - 1]!;
        buildCount += 1;
        await gate.promise;
        return okResult();
      },
      onResult: (r) => results.push(r),
    });

    // Trigger initial build (kicks after 0ms debounce).
    void scheduler.schedule();
    // Yield to let the debounce timer fire and run() reach `await gate.promise`.
    await new Promise((r) => setTimeout(r, 10));
    expect(scheduler.state()).toBe("building");

    // Five more schedules during the in-flight build: coalesce into ONE follow-up.
    for (let i = 0; i < 5; i += 1) void scheduler.schedule();
    expect(scheduler.state()).toBe("building+dirty");

    // Finish the first build.
    gates[0]!.resolve();
    // Yield so the machine transitions and starts the follow-up.
    await new Promise((r) => setTimeout(r, 10));
    expect(scheduler.state()).toBe("building");

    // Finish the follow-up.
    gates[1]!.resolve();
    await new Promise((r) => setTimeout(r, 10));

    expect(buildCount).toBe(2);
    expect(results.length).toBe(2);
    expect(scheduler.state()).toBe("idle");
  });

  test("build() rejection is routed to onError and returns the machine to idle", async () => {
    const errors: unknown[] = [];
    const scheduler = createBuildScheduler({
      debounceMs: 0,
      build: () => Promise.reject(new Error("boom")),
      onError: (e) => errors.push(e),
    });
    await scheduler.schedule();
    // Give the run() finally block a tick to settle state.
    await new Promise((r) => setTimeout(r, 10));
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe("boom");
    expect(scheduler.state()).toBe("idle");
  });
});

describe("logBuildResult — REQ-DEV-10 line formats", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errSpy = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test("success prints one stdout line with buildId AND durationMs", () => {
    logBuildResult(okResult(412));
    expect(logSpy).toHaveBeenCalledTimes(1);
    const arg = logSpy.mock.calls[0]?.[0] as string;
    expect(arg).toContain("[dev] client build ok");
    expect(arg).toContain("buildId=3f9c2a1b7e40");
    expect(arg).toContain("412ms");
  });

  test("failure prints '[dev] client build FAILED' then each error verbatim on its own line", () => {
    logBuildResult(failResult(["error: Unexpected token", "  at foo.ts:1:2"]));
    expect(errSpy).toHaveBeenCalledTimes(3);
    expect(errSpy.mock.calls[0]?.[0]).toBe("[dev] client build FAILED");
    expect(errSpy.mock.calls[1]?.[0]).toBe("error: Unexpected token");
    expect(errSpy.mock.calls[2]?.[0]).toBe("  at foo.ts:1:2");
  });
});

describe("logPackageBuildResult — §9 point 6 diagnostics line formats (AC3)", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errSpy = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test("success prints one stdout line with the build duration", () => {
    logPackageBuildResult({ ok: true, durationMs: 318 } satisfies PackageBuildResult);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).not.toHaveBeenCalled();
    const arg = logSpy.mock.calls[0]?.[0] as string;
    expect(arg).toContain("[dev] package build ok");
    expect(arg).toContain("318ms");
  });

  test("failure prints a stderr FAILED line that points at the verbatim tsc diagnostics", () => {
    // tsc -b streams its own diagnostics to the inherited stderr (§9 point 6); the supervisor's
    // failure line must merely mark the failure and reference them, never swallow or reformat them.
    logPackageBuildResult({ ok: false, durationMs: 77 } satisfies PackageBuildResult);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    const arg = errSpy.mock.calls[0]?.[0] as string;
    expect(arg).toContain("[dev] package build FAILED");
    expect(arg).toContain("77ms");
    expect(arg).toContain("diagnostics above");
  });
});

describe("isWatchedFile — filter", () => {
  test.each([
    ["src/client/main.tsx", true],
    ["src/server/router.ts", true],
    ["src/client/index.html", true],
    ["src/client/styles.css", true],
    ["src/client/data.json", true],
    ["src/client/.hidden.ts", false],
    ["src/client/main.tsx~", false],
    ["src/client/README.md", false],
    ["", false],
  ] as const)("%s → %s", (filename, expected) => {
    expect(isWatchedFile(filename)).toBe(expected);
  });

  test("null filename → false", () => {
    expect(isWatchedFile(null)).toBe(false);
  });
});

describe("restart-vs-rebuild routing — schedulers are decoupled", () => {
  test("triggering the restart scheduler does NOT trigger a client build", async () => {
    let restarts = 0;
    let builds = 0;
    const restartGate = defer<void>();
    const restart = createRestartScheduler({
      debounceMs: 0,
      restart: async (_reason) => {
        restarts += 1;
        await restartGate.promise;
      },
    });
    const rebuild = createBuildScheduler({
      debounceMs: 0,
      build: async () => {
        builds += 1;
        return okResult();
      },
    });

    // Simulate a server-source change: caller (installWatchers sink) routes ONLY to `restart`.
    void restart.schedule("src/server/refresh.ts");
    await new Promise((r) => setTimeout(r, 10));
    expect(restarts).toBe(1);
    expect(builds).toBe(0);
    // Rebuild scheduler stays idle.
    expect(rebuild.state()).toBe("idle");

    restartGate.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(restart.busy()).toBe(false);
    expect(builds).toBe(0);
  });

  test("restart scheduler coalesces N schedules during a restart into ONE follow-up with the LAST reason", async () => {
    const seen: string[] = [];
    const gates = [defer<void>(), defer<void>()];
    let index = 0;
    const restart = createRestartScheduler({
      debounceMs: 0,
      restart: async (reason) => {
        seen.push(reason);
        const gate = gates[index] ?? gates[gates.length - 1]!;
        index += 1;
        await gate.promise;
      },
    });

    void restart.schedule("first.ts");
    await new Promise((r) => setTimeout(r, 10));
    expect(restart.busy()).toBe(true);

    void restart.schedule("second.ts");
    void restart.schedule("third.ts");
    void restart.schedule("last.ts");

    gates[0]!.resolve();
    await new Promise((r) => setTimeout(r, 10));
    gates[1]!.resolve();
    await new Promise((r) => setTimeout(r, 10));

    expect(seen).toEqual(["first.ts", "last.ts"]);
  });
});

// The §9 point 5 consumer-cycle wiring exactly as main() composes it: a SUCCESSFUL dependency-package
// build fires the controller's onConsumerCycle, which schedules ONE client rebuild (a fresh build-id/
// manifest) and ONE ordered server restart with reason "packages"; a FAILED build fires neither and
// leaves the running server untouched (AC2 + AC3's "zero reload/restart").
describe("dependency consumer cycle — one client rebuild + one ordered restart per package build", () => {
  test("a successful package build drives exactly one client rebuild and one restart('packages')", async () => {
    const restartReasons: string[] = [];
    const builtManifests: string[] = [];
    let outcome: PackageBuildResult = { ok: true, durationMs: 10 };

    const restart = createRestartScheduler({
      debounceMs: 0,
      restart: async (reason) => {
        restartReasons.push(reason);
      },
    });
    const rebuild = createBuildScheduler({
      debounceMs: 0,
      build: async () => okResult(),
      onResult: (r) => {
        if (r.ok) builtManifests.push(r.manifest.buildId);
      },
    });
    // Wire the controller exactly as main() does.
    const controller = createPackageWatchController({
      debounceMs: 0,
      build: async () => outcome,
      onConsumerCycle: () => {
        void rebuild.schedule();
        void restart.schedule("packages");
      },
    });

    await controller.schedule();
    await new Promise((r) => setTimeout(r, 20));
    // Exactly one consumer client build (a fresh manifest/build-id) and one ordered restart.
    expect(builtManifests).toEqual([OK_MANIFEST.buildId]);
    expect(restartReasons).toEqual(["packages"]);

    // A second successful package build fires exactly one more cycle — no accumulation, no duplication.
    await controller.schedule();
    await new Promise((r) => setTimeout(r, 20));
    expect(builtManifests).toEqual([OK_MANIFEST.buildId, OK_MANIFEST.buildId]);
    expect(restartReasons).toEqual(["packages", "packages"]);
  });

  test("a FAILED package build fires no client rebuild and no restart (server preserved)", async () => {
    const restartReasons: string[] = [];
    let builds = 0;
    let outcome: PackageBuildResult = { ok: false, durationMs: 5 };

    const restart = createRestartScheduler({
      debounceMs: 0,
      restart: async (reason) => {
        restartReasons.push(reason);
      },
    });
    const rebuild = createBuildScheduler({
      debounceMs: 0,
      build: async () => {
        builds += 1;
        return okResult();
      },
    });
    const controller = createPackageWatchController({
      debounceMs: 0,
      build: async () => outcome,
      onConsumerCycle: () => {
        void rebuild.schedule();
        void restart.schedule("packages");
      },
    });

    await controller.schedule();
    await new Promise((r) => setTimeout(r, 20));
    expect(builds).toBe(0);
    expect(restartReasons).toEqual([]);
    expect(controller.suspended()).toBe(true); // consumers gated until a valid edit recovers

    // Recovery: the next valid package build releases exactly one consumer cycle.
    outcome = { ok: true, durationMs: 8 };
    await controller.schedule();
    await new Promise((r) => setTimeout(r, 20));
    expect(builds).toBe(1);
    expect(restartReasons).toEqual(["packages"]);
    expect(controller.suspended()).toBe(false);
  });
});
