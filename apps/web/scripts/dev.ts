// apps/web/scripts/dev.ts — the dev supervisor (parent).
//
// Parses the CLI, resolves paths, runs the first client build, spawns the dev composition root
// (`src/server/dev/entry.ts`) as its child, installs watchers, and coalesces client rebuilds and
// server restarts. Never bypasses the child by binding a port itself (spec 04 §1.1) — item 017's
// prod-isolation walk depends on `scripts/dev.ts` only spawning `src/server/dev/entry.ts`.
//
// Architecture: docs/architecture/web-foundation/.

import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, resolve } from "node:path";

import {
  buildClient,
  type ClientBuildOptions,
  type ClientBuildResult,
} from "./build-client.js";
import { DEFAULT_SCENARIO } from "../src/server/dev/mock-engine.js";
import { DEV_DEFAULT_ESTATE_MODEL, DEV_ENV } from "../src/server/dev/protocol.js";
import { ENV } from "../src/shared/constants.js";

// ─── CLI types & constants (00 §2.1) ─────────────────────────────────────────────────────────────

export type DevMode =
  | {
      /** Selects the inherited-environment engine mode. */ kind: "env";
    }
  | {
      /** Selects the built-in mock-engine mode. */ kind: "mock";
      /** Named mock scenario to serve. */ scenario: string;
    }
  | {
      /** Selects the four-origin real-engine mode. */ kind: "engine";
      /** Absolute VictoriaMetrics origin. */ vmUrl: string;
      /** Absolute Alertmanager origin. */ alertmanagerUrl: string;
      /** Absolute Gatus origin. */ gatusUrl: string;
      /** Absolute vmalert origin. */ vmalertUrl: string;
    };

export interface DevOptions {
  /** Resolved engine/mock mode. */ mode: DevMode;
  /** TCP port the dev server listens on. */ port: number;
  /** Host interface the dev server binds. */ host: string;
  /** Injected deterministic clock ISO string, or null for real time. */ clock: string | null;
}

export type ParsedArgs =
  | {
      /** Success discriminator. */ ok: true;
      /** Parsed and validated dev options. */ options: DevOptions;
    }
  | {
      /** Failure discriminator. */ ok: false;
      /** Safe diagnostic explaining the parse failure. */ error: string;
      /** Usage text to print alongside the error. */ usage: string;
    };

export const DEV_DEFAULT_PORT = 8080 as const;
export const DEV_DEFAULT_HOST = "127.0.0.1" as const;

export const DEV_USAGE = `usage: bun run dev:web [--mock [<scenario>] | --engine <vm-url>,<alertmanager-url>,<gatus-url>,<vmalert-url>]
                       [--port <n>] [--host <addr>] [--clock <iso-8601>]`;

export const DEV_EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
} as const;

export const DEV_DEBOUNCE_MS = 50 as const;
export const DEV_CHILD_EXIT_GRACE_MS = 5_000 as const;

/** Sentinel `error` meaning "`-h`/`--help` was passed": `main()` prints `usage` to stdout and exits
 *  `DEV_EXIT.ok` instead of stderr + `DEV_EXIT.usage` (spec 04 §2.1). */
export const DEV_HELP_SENTINEL = "__help__" as const;

// ─── Path resolution (spec 04 §3.2) ──────────────────────────────────────────────────────────────

export interface DevPaths {
  /** `apps/web` — the child's cwd and the watch root. */
  appRoot: string;
  /** Repo root — the base for `DEV_DEFAULT_ESTATE_MODEL`. */
  repoRoot: string;
  /** Absolute `apps/web/dist/client` — the served asset dir. */
  clientDir: string;
  /** Absolute default estate model (REQ-DEV-08). */
  defaultEstateModel: string;
}

export function resolveDevPaths(scriptDir: string = import.meta.dir): DevPaths {
  const appRoot = resolve(scriptDir, "..");
  const repoRoot = resolve(appRoot, "..", "..");
  return {
    appRoot,
    repoRoot,
    clientDir: resolve(appRoot, "dist", "client"),
    defaultEstateModel: resolve(repoRoot, DEV_DEFAULT_ESTATE_MODEL),
  };
}

// ─── parseDevArgs (spec 04 §2.1) ─────────────────────────────────────────────────────────────────

export function parseDevArgs(argv: readonly string[]): ParsedArgs {
  const fail = (error: string): ParsedArgs => ({ ok: false, error, usage: DEV_USAGE });
  const value = (i: number, missing: string): string | ParsedArgs => {
    const raw = argv[i + 1];
    return raw === undefined || raw.startsWith("--") ? fail(missing) : raw;
  };

  let mock: string | null = null;
  let engine: DevMode | null = null;
  let port: number = DEV_DEFAULT_PORT;
  let host: string = DEV_DEFAULT_HOST;
  let clock: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token === "-h" || token === "--help") return fail(DEV_HELP_SENTINEL);

    if (token === "--mock") {
      if (mock !== null) return fail("repeated flag: --mock");
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        if (next.length === 0) return fail("--mock scenario name is empty");
        mock = next;
        i += 1;
      } else {
        mock = DEFAULT_SCENARIO;
      }
      continue;
    }

    if (token === "--engine") {
      if (engine !== null) return fail("repeated flag: --engine");
      const raw = value(i, "--engine requires <vm-url>,<alertmanager-url>,<gatus-url>,<vmalert-url>");
      if (typeof raw !== "string") return raw;
      i += 1;
      const parts = raw.split(",");
      if (parts.length !== 4) {
        return fail(
          "--engine expects exactly 4 comma-separated URLs in the order " +
            `VictoriaMetrics,Alertmanager,Gatus,vmalert (got ${String(parts.length)})`,
        );
      }
      const urls: string[] = [];
      for (const part of parts) {
        const item = part.trim();
        if (item.length === 0) return fail("--engine contains an empty URL");
        let parsed: URL;
        try {
          parsed = new URL(item);
        } catch {
          return fail(`--engine URL is not an absolute URL: ${item}`);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return fail(`--engine URL must be http(s): ${item}`);
        }
        urls.push(item.replace(/\/+$/, ""));
      }
      engine = {
        kind: "engine",
        vmUrl: urls[0] as string,
        alertmanagerUrl: urls[1] as string,
        gatusUrl: urls[2] as string,
        vmalertUrl: urls[3] as string,
      };
      continue;
    }

    if (token === "--port") {
      const raw = value(i, "--port requires a number");
      if (typeof raw !== "string") return raw;
      i += 1;
      const bad = `--port must be an integer between 0 and 65535 (got ${raw})`;
      if (!/^\d+$/.test(raw)) return fail(bad);
      port = Number.parseInt(raw, 10);
      if (port > 65535) return fail(bad);
      continue;
    }

    if (token === "--host") {
      const raw = value(i, "--host requires an address");
      if (typeof raw !== "string") return raw;
      i += 1;
      if (raw.length === 0) return fail("--host address is empty");
      host = raw;
      continue;
    }

    if (token === "--clock") {
      const raw = value(i, "--clock requires an ISO-8601 timestamp");
      if (typeof raw !== "string") return raw;
      i += 1;
      if (Number.isNaN(Date.parse(raw))) return fail(`--clock is not a parseable timestamp: ${raw}`);
      clock = raw;
      continue;
    }

    return fail(token.startsWith("-") ? `unknown flag: ${token}` : `unexpected argument: ${token}`);
  }

  if (mock !== null && engine !== null) return fail("--mock and --engine are mutually exclusive");
  const mode: DevMode =
    mock !== null ? { kind: "mock", scenario: mock } : (engine ?? { kind: "env" });
  return { ok: true, options: { mode, port, host, clock } };
}

// ─── Build coalescing (spec 04 §4.3) ─────────────────────────────────────────────────────────────

/** Discriminant of the coalescing state machine (REQ-CONC-01: at most one build in flight). */
export type BuildState = "idle" | "building" | "building+dirty";

export interface BuildScheduler {
  /** Record a source change — debounced when idle, coalesced when building. */
  schedule(): Promise<void>;
  /** `true` while a build is executing. */
  running(): boolean;
  /** Current internal state (tests). */
  state(): BuildState;
}

export interface BuildSchedulerOptions {
  /** One client build — must resolve (never reject); `buildClient` already satisfies this. */
  build: () => Promise<ClientBuildResult>;
  /** Receives every result, success or failure, for logging (§6). */
  onResult?: (result: ClientBuildResult) => void;
  /** Called immediately before each build — prints `[dev] client build started`. */
  onStart?: () => void;
  /** Debounce window; default `DEV_DEBOUNCE_MS`. Tests pass `0`. */
  debounceMs?: number;
  /** Called if `build` rejects despite the contract; the machine returns to `idle`. */
  onError?: (err: unknown) => void;
}

export function createBuildScheduler(opts: BuildSchedulerOptions): BuildScheduler {
  const debounceMs = opts.debounceMs ?? DEV_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let state: BuildState = "idle";
  let inflight: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    state = "building";
    try {
      opts.onStart?.();
      const result = await opts.build();
      opts.onResult?.(result);
    } catch (err) {
      if (opts.onError !== undefined) opts.onError(err);
      else console.error(`[dev] client build crashed: ${String(err)}`);
    } finally {
      // `state` can be mutated to "building+dirty" by concurrent schedule() calls during the
      // await above; the top-level `state = "building"` narrows TS's view, so re-read through
      // the exported accessor to keep the comparison honest.
      const wasDirty: boolean = (state as BuildState) === "building+dirty";
      state = "idle";
      inflight = null;
      if (wasDirty) {
        inflight = run();
      }
    }
  };

  return {
    schedule(): Promise<void> {
      if (state !== "idle") {
        state = "building+dirty";
        return inflight ?? Promise.resolve();
      }
      return new Promise<void>((resolve0) => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          inflight = run().then(resolve0, resolve0);
        }, debounceMs);
      });
    },
    running: () => state !== "idle",
    state: () => state,
  };
}

// ─── Restart coalescing (spec 04 §4.2) ───────────────────────────────────────────────────────────

export interface RestartScheduler {
  /** Record a change; the most recent `reason` wins if one is in flight. */
  schedule(reason?: string): Promise<void>;
  /** `true` while a restart is in flight. */
  busy(): boolean;
}

export interface RestartSchedulerOptions {
  /** Perform one server restart for the given reason. */ restart: (reason: string) => Promise<void>;
  /** Coalescing debounce window in milliseconds; defaults to DEV_DEBOUNCE_MS. */ debounceMs?: number;
  /** Optional restart-failure observer. */ onError?: (err: unknown) => void;
}

export function createRestartScheduler(opts: RestartSchedulerOptions): RestartScheduler {
  const debounceMs = opts.debounceMs ?? DEV_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let state: "idle" | "restarting" | "restarting+dirty" = "idle";
  let pendingReason: string | null = null;
  let currentReason = "";
  let inflight: Promise<void> | null = null;

  const run = async (reason: string): Promise<void> => {
    state = "restarting";
    currentReason = reason;
    try {
      await opts.restart(reason);
    } catch (err) {
      if (opts.onError !== undefined) opts.onError(err);
      else console.error(`[dev] server restart crashed: ${String(err)}`);
    } finally {
      const carry = pendingReason;
      pendingReason = null;
      state = "idle";
      inflight = null;
      if (carry !== null) {
        inflight = run(carry);
      }
    }
  };

  return {
    schedule(reason: string = "unknown"): Promise<void> {
      if (state !== "idle") {
        pendingReason = reason;
        state = "restarting+dirty";
        return inflight ?? Promise.resolve();
      }
      currentReason = reason;
      return new Promise<void>((resolve0) => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          inflight = run(currentReason).then(resolve0, resolve0);
        }, debounceMs);
      });
    },
    busy: () => state !== "idle",
  };
}

// ─── Dependency package build (spec web-data-tier 02 §9) ─────────────────────────────────────────

/** Discriminated outcome of one dependency-package build. Diagnostics are printed verbatim by the
 *  underlying `tsc -b` via inherited stdio (§9 point 6); this carries only the pass/fail signal and
 *  timing the supervisor logs. */
export type PackageBuildResult =
  | {
      /** Success discriminator. */
      ok: true;
      /** Wall time of the build in ms. */
      durationMs: number;
    }
  | {
      /** Failure discriminator. */
      ok: false;
      /** Wall time of the build in ms. */
      durationMs: number;
    };

/** Minimal child-process handle `buildDevPackages` awaits — the real seam is `Bun.spawn`. */
export interface PackageBuildProcess {
  /** Resolves with the build process exit code. */ readonly exited: Promise<number>;
}

/** The off-side dependency build command. `tsc -b` builds core → renderer → web-data in project-
 *  reference order and, being incremental build mode, does NOT re-emit a project whose sources fail
 *  to type-check — so a failed edit cannot replace the last valid consumer graph (§9). It is a
 *  one-shot compile, never `tsc --watch` (which would be a second writer against the same `dist`). */
export const DEV_PACKAGE_BUILD_CMD = ["bunx", "tsc", "-b", "packages/web-data"] as const;

/**
 * Run one dependency-package build from the repository root and normalize it to a
 * {@link PackageBuildResult}. Diagnostics stream verbatim to the inherited stderr; only the exit
 * code drives the pass/fail signal. Never rejects on a compile failure — a non-zero exit is
 * reported as `{ ok: false }` so the coalescing controller can preserve the last valid outputs.
 */
export async function buildDevPackages(
  repoRoot: string,
  spawn: (cmd: readonly string[], cwd: string) => PackageBuildProcess = (cmd, cwd) =>
    Bun.spawn({
      cmd: [...cmd],
      cwd,
      stdout: "inherit",
      stderr: "inherit",
    }) as unknown as PackageBuildProcess,
): Promise<PackageBuildResult> {
  const started = performance.now();
  let code: number;
  try {
    code = await spawn(DEV_PACKAGE_BUILD_CMD, repoRoot).exited;
  } catch {
    code = 1;
  }
  return { ok: code === 0, durationMs: Math.round(performance.now() - started) };
}

export function logPackageBuildResult(result: PackageBuildResult): void {
  if (result.ok) {
    console.log(`[dev] package build ok  ${result.durationMs}ms`);
    return;
  }
  console.error(`[dev] package build FAILED  ${result.durationMs}ms (diagnostics above)`);
}

export interface PackageWatchControllerOptions {
  /** One off-side dependency build — must resolve (never reject); `buildDevPackages` satisfies this. */
  build: () => Promise<PackageBuildResult>;
  /** Invoked once after each SUCCESSFUL non-priming build: trigger exactly one client rebuild and
   *  one ordered server restart now that the fresh `dist` is the consumer authority (§9 point 5). */
  onConsumerCycle: () => void;
  /** Receives every result, success or failure, for logging (§9 point 6). */
  onResult?: (result: PackageBuildResult) => void;
  /** Called immediately before each build. */
  onStart?: () => void;
  /** Debounce window; default `DEV_DEBOUNCE_MS`. Tests pass `0`. */
  debounceMs?: number;
  /** Called if `build` rejects despite the contract; the machine returns to `idle`, last-failed. */
  onError?: (err: unknown) => void;
}

export interface PackageWatchController {
  /** Record a package source/config change — debounced when idle, coalesced when building. */
  schedule(): Promise<void>;
  /** Run the initial pre-spawn build (§9 point 1). Sets health WITHOUT firing a consumer cycle. */
  primeBuild(): Promise<PackageBuildResult>;
  /** `true` while a build is executing. */
  running(): boolean;
  /** Current internal state (tests). */
  state(): BuildState;
  /** `true` while a build is pending OR the last build failed — consumers are suspended (§9 point 4). */
  suspended(): boolean;
  /** `true` once the most recent build succeeded. */
  healthy(): boolean;
}

/**
 * The dependency-build coalescer. Reuses the exact `idle | building | building+dirty` model as
 * {@link createBuildScheduler} (a source change during a build coalesces into ONE follow-up), and
 * adds the §9 consumer contract:
 *   - a SUCCESSFUL scheduled build fires `onConsumerCycle` exactly once (client rebuild + ordered
 *     restart) after the fresh `dist` is complete;
 *   - a FAILED build fires no cycle, leaving the last valid manifest/server untouched;
 *   - `suspended()` is `true` while building or last-failed, so callers gate consumer rebuilds/
 *     restarts and a later valid edit recovers without restarting the supervisor (§9 points 4, 7).
 */
export function createPackageWatchController(
  opts: PackageWatchControllerOptions,
): PackageWatchController {
  const debounceMs = opts.debounceMs ?? DEV_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let state: BuildState = "idle";
  let inflight: Promise<void> | null = null;
  let lastOk = false;

  const settle = (result: PackageBuildResult, fireCycle: boolean): void => {
    lastOk = result.ok;
    opts.onResult?.(result);
    if (result.ok && fireCycle) opts.onConsumerCycle();
  };

  const run = async (): Promise<void> => {
    state = "building";
    try {
      opts.onStart?.();
      const result = await opts.build();
      settle(result, true);
    } catch (err) {
      lastOk = false;
      if (opts.onError !== undefined) opts.onError(err);
      else console.error(`[dev] package build crashed: ${String(err)}`);
    } finally {
      // A concurrent schedule() during the await above can flip `state` to "building+dirty"; the
      // top-level assignment narrows TS's view, so re-read through the cast to stay honest.
      const wasDirty: boolean = (state as BuildState) === "building+dirty";
      state = "idle";
      inflight = null;
      if (wasDirty) {
        inflight = run();
      }
    }
  };

  return {
    schedule(): Promise<void> {
      if (state !== "idle") {
        state = "building+dirty";
        return inflight ?? Promise.resolve();
      }
      return new Promise<void>((resolve0) => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          inflight = run().then(resolve0, resolve0);
        }, debounceMs);
      });
    },
    async primeBuild(): Promise<PackageBuildResult> {
      opts.onStart?.();
      const result = await opts.build();
      settle(result, false);
      return result;
    },
    running: () => state !== "idle",
    state: () => state,
    suspended: () => state !== "idle" || !lastOk,
    healthy: () => lastOk,
  };
}

// ─── Watched file filter (spec 04 §4.1) ──────────────────────────────────────────────────────────

const WATCHED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".css", ".json", ".html"] as const;

export function isWatchedFile(filename: string | null): boolean {
  if (filename === null || filename.length === 0) return false;
  const base = basename(filename);
  if (base.startsWith(".") || base.endsWith("~")) return false;
  return WATCHED_EXTENSIONS.some((ext) => base.endsWith(ext));
}

/** The two package files whose edits change the consumer graph without living under `src/`: the
 *  project config and the `exports` map. Package `dist/` outputs and `.tsbuildinfo` are deliberately
 *  NOT matched — they are emitted outputs and must never self-trigger a rebuild (§9 point 2). */
export function isPackageConfigFile(filename: string | null): boolean {
  if (filename === null || filename.length === 0) return false;
  const base = basename(filename);
  return base === "tsconfig.json" || base === "package.json";
}

// ─── Child env (spec 04 §5.2) ────────────────────────────────────────────────────────────────────

/**
 * Compute the environment for the child process. Precedence for `PULSE_WEB_ESTATE_MODEL`:
 * an operator-provided value wins; otherwise the absolute path of `DEV_DEFAULT_ESTATE_MODEL`
 * (REQ-DEV-08). `MOCK_ENV` is NOT applied here — the child merges it inside itself so
 * `process.env` is never mutated (REQ-MOCK-08). `buildId` is stamped so the child can carry it
 * through `appVersion` (feeds CON-08 skew reload).
 */
export function buildChildEnv(
  opts: DevOptions,
  buildId: string,
  paths: DevPaths = resolveDevPaths(),
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env[DEV_ENV.DEV] = "1";
  env[DEV_ENV.PORT] = String(opts.port);
  env[DEV_ENV.HOST] = opts.host;
  env[DEV_ENV.CLIENT_DIR] = paths.clientDir;
  env[DEV_ENV.BUILD_ID] = buildId;
  if (opts.mode.kind === "mock") env[DEV_ENV.MOCK_SCENARIO] = opts.mode.scenario;
  if (opts.clock !== null) env[DEV_ENV.MOCK_CLOCK] = opts.clock;
  if (opts.mode.kind === "engine") {
    env[ENV.VM_URL] = opts.mode.vmUrl;
    env[ENV.ALERTMANAGER_URL] = opts.mode.alertmanagerUrl;
    env[ENV.GATUS_URL] = opts.mode.gatusUrl;
    env[ENV.VMALERT_URL] = opts.mode.vmalertUrl;
  }
  const configured = env[ENV.WEB_ESTATE_MODEL];
  if (configured === undefined || configured.length === 0) {
    env[ENV.WEB_ESTATE_MODEL] = paths.defaultEstateModel;
  }
  return env;
}

// ─── Watchers (spec 04 §4.4) ─────────────────────────────────────────────────────────────────────

export interface WatcherHandle {
  /** Stop all filesystem watchers and release their resources. */ close(): void;
}

export function installWatchers(
  paths: DevPaths,
  onClientChange: (relPath: string) => void,
  onServerChange: (relPath: string) => void,
): WatcherHandle {
  const watchers: FSWatcher[] = [];
  const add = (
    rel: string,
    recursive: boolean,
    sinks: ReadonlyArray<(p: string) => void>,
  ): void => {
    const abs = resolve(paths.appRoot, rel);
    const dispatch = (filename: string | null): void => {
      if (recursive && !isWatchedFile(filename)) return;
      const relPath = recursive && filename !== null ? `${rel}/${filename}` : rel;
      for (const sink of sinks) sink(relPath);
    };
    try {
      const w = watch(abs, { recursive }, (_event, filename) => dispatch(filename));
      w.on("error", (err) =>
        console.error(`[dev] watcher error on ${rel}: ${String(err)}`),
      );
      watchers.push(w);
    } catch (err) {
      // Recursive-watch fallback: enumerate subdirectories and install one non-recursive watcher
      // per directory (spec 04 §4.4). We do NOT re-scan on subsequent directory creation — the
      // supervisor is a dev-only tool and a manual restart is acceptable in that edge case.
      if (recursive) {
        try {
          const dirs = collectDirs(abs);
          for (const d of dirs) {
            try {
              const w = watch(d, { recursive: false }, (_e, filename) => dispatch(filename));
              w.on("error", (e) =>
                console.error(`[dev] watcher error on ${rel}: ${String(e)}`),
              );
              watchers.push(w);
            } catch (e) {
              console.error(`[dev] cannot watch ${d}: ${String(e)}`);
            }
          }
          console.error(
            `[dev] recursive watch unavailable — watching ${dirs.length} directories individually`,
          );
          return;
        } catch (e) {
          console.error(`[dev] cannot watch ${rel}: ${String(err)} / fallback: ${String(e)}`);
          return;
        }
      }
      console.error(`[dev] cannot watch ${rel}: ${String(err)} — changes there will be ignored`);
    }
  };

  add("src/client", true, [onClientChange]);
  add("src/shared", true, [onClientChange, onServerChange]);
  add("src/server", true, [onServerChange]);
  add("src/version.ts", false, [onServerChange]);
  return {
    close: () => {
      for (const w of watchers) w.close();
    },
  };
}

function collectDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    out.push(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(resolve(dir, entry.name));
    }
  };
  try {
    if (statSync(root).isDirectory()) walk(root);
  } catch {
    // ignore
  }
  return out;
}

// ─── Dependency package watchers (spec web-data-tier 02 §9) ───────────────────────────────────────

/** Dependency packages compiled by `tsc -b packages/web-data`, in reference order. */
export const DEV_PACKAGE_DIRS = ["core", "renderer", "web-data"] as const;

/**
 * Watch every dependency package's `src/**` tree (recursively, for referenced core/renderer/web-data
 * inputs) plus each package root non-recursively for its `tsconfig.json`/`package.json` (config +
 * export map). Emitted `dist/**` and `.tsbuildinfo` are excluded two ways: the `src` watch never
 * reaches a sibling `dist`, and the non-recursive root watch only fires for its direct children,
 * where `isPackageConfigFile` admits nothing under `dist/` — so package output writes never
 * self-trigger a rebuild (§9 point 2).
 */
export function installPackageWatchers(
  repoRoot: string,
  onChange: (relPath: string) => void,
): WatcherHandle {
  const watchers: FSWatcher[] = [];
  const packagesRoot = resolve(repoRoot, "packages");

  for (const pkg of DEV_PACKAGE_DIRS) {
    const srcAbs = resolve(packagesRoot, pkg, "src");
    try {
      const w = watch(srcAbs, { recursive: true }, (_event, filename) => {
        if (!isWatchedFile(filename)) return;
        onChange(`packages/${pkg}/src/${filename ?? ""}`);
      });
      w.on("error", (err) =>
        console.error(`[dev] package watcher error on ${pkg}/src: ${String(err)}`),
      );
      watchers.push(w);
    } catch (err) {
      console.error(`[dev] cannot watch packages/${pkg}/src: ${String(err)}`);
    }

    const rootAbs = resolve(packagesRoot, pkg);
    try {
      const w = watch(rootAbs, { recursive: false }, (_event, filename) => {
        if (!isPackageConfigFile(filename)) return;
        onChange(`packages/${pkg}/${filename ?? ""}`);
      });
      w.on("error", (err) =>
        console.error(`[dev] package watcher error on ${pkg}: ${String(err)}`),
      );
      watchers.push(w);
    } catch (err) {
      console.error(`[dev] cannot watch packages/${pkg} config: ${String(err)}`);
    }
  }

  return {
    close: () => {
      for (const w of watchers) w.close();
    },
  };
}

// ─── Build logging (spec 04 §6) ──────────────────────────────────────────────────────────────────

export function logBuildResult(result: ClientBuildResult): void {
  if (result.ok) {
    console.log(
      `[dev] client build ok  buildId=${result.manifest.buildId}  ${result.durationMs}ms`,
    );
    return;
  }
  console.error("[dev] client build FAILED");
  for (const message of result.errors) console.error(message);
}

// ─── Child process seam (00 §2.5) ────────────────────────────────────────────────────────────────

export interface DevChildHandle {
  /** Send a termination signal to the child process. */ kill(signal?: string): void;
  /** Resolves with the child's exit code once it terminates. */ readonly exited: Promise<number>;
}

export async function stopChildProcess(
  child: DevChildHandle,
  opts: { graceMs?: number; onKill?: (signal: string) => void } = {},
): Promise<void> {
  const graceMs = opts.graceMs ?? DEV_CHILD_EXIT_GRACE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), graceMs);
  });
  try {
    child.kill("SIGTERM");
    opts.onKill?.("SIGTERM");
    const exited = await Promise.race([child.exited.then(() => true), grace]);
    if (!exited) {
      console.error(`[dev] server did not exit in ${graceMs}ms — SIGKILL`);
      child.kill("SIGKILL");
      opts.onKill?.("SIGKILL");
      await child.exited;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function restartSequence(
  stop: () => Promise<void>,
  spawn: () => DevChildHandle,
): Promise<DevChildHandle> {
  await stop();
  return spawn();
}

// ─── main() (private — spec 04 §3.1) ─────────────────────────────────────────────────────────────

const CHILD_ENTRY = "src/server/dev/entry.ts";

async function pumpChildStdout(
  stream: ReadableStream<Uint8Array>,
  onListening: (e: { event: string; port?: number; host?: string; mock?: string | null }) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          // not JSON — plain child output
        }
        if (
          parsed !== null
          && typeof parsed === "object"
          && (parsed as { event?: unknown }).event === "dev_server_listening"
        ) {
          onListening(parsed as { event: string; port: number; host: string; mock: string | null });
        } else {
          console.log(line);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function main(): Promise<never> {
  const parsed = parseDevArgs(Bun.argv.slice(2));
  if (!parsed.ok) {
    if (parsed.error === DEV_HELP_SENTINEL) {
      console.log(parsed.usage);
      process.exit(DEV_EXIT.ok);
    }
    console.error(parsed.error);
    console.error(parsed.usage);
    process.exit(DEV_EXIT.usage);
  }
  const opts = parsed.options;
  const paths = resolveDevPaths();

  let watcherHandle: WatcherHandle | null = null;
  let packageWatcherHandle: WatcherHandle | null = null;

  // The dependency-build controller. onConsumerCycle references `rebuild`/`restart`, declared below;
  // it is only ever invoked after they are initialized (from a scheduled — never primed — build).
  const controller = createPackageWatchController({
    build: () => buildDevPackages(paths.repoRoot),
    onConsumerCycle: () => {
      void rebuild.schedule();
      void restart.schedule("packages");
    },
    onStart: () => console.log("[dev] package build started"),
    onResult: logPackageBuildResult,
  });

  // Build renderer/web-data dependencies from source BEFORE the first client build / server spawn
  // (§9 point 1). Diagnostics stream verbatim; a failure preserves any last valid dist and the
  // first client build below surfaces its own errors.
  await controller.primeBuild();

  // First build (REQ-CONC-04: clean:true).
  const firstBuildOpts: ClientBuildOptions = {
    outdir: paths.clientDir,
    minify: false,
    sourcemap: "linked",
    clean: true,
  };
  console.log("[dev] client build started");
  const firstBuild = await buildClient(firstBuildOpts);
  logBuildResult(firstBuild);
  const initialBuildId = firstBuild.ok ? firstBuild.manifest.buildId : "nobuild";

  const env = buildChildEnv(opts, initialBuildId, paths);

  let current: DevChildHandle | null = null;
  let intentionalStop = false;

  const spawnChild = (): DevChildHandle => {
    const child = Bun.spawn(["bun", CHILD_ENTRY], {
      cwd: paths.appRoot,
      env,
      stdio: ["ignore", "pipe", "inherit"],
    }) as unknown as DevChildHandle & { stdout: ReadableStream<Uint8Array>; exited: Promise<number> };
    void pumpChildStdout(child.stdout, (ev) => {
      const port = typeof ev.port === "number" ? ev.port : opts.port;
      const host = typeof ev.host === "string" ? ev.host : opts.host;
      const mock = typeof ev.mock === "string" ? `mock=${ev.mock}` : "mock=none";
      console.log(`[dev] server listening on http://${host}:${port}  ${mock}`);
    });
    void child.exited.then((code) => {
      if (!intentionalStop) {
        console.error(`[dev] server exited code=${code}`);
        if (current === child && code === DEV_EXIT.usage) {
          watcherHandle?.close();
          packageWatcherHandle?.close();
          process.exit(DEV_EXIT.usage);
        }
      }
    });
    return child;
  };

  const stopChild = async (): Promise<void> => {
    const child = current;
    if (child === null) return;
    current = null;
    intentionalStop = true;
    try {
      await stopChildProcess(child);
    } finally {
      intentionalStop = false;
    }
  };

  const restart = createRestartScheduler({
    restart: async (reason) => {
      console.log(`[dev] server restarting (${reason} changed)`);
      current = await restartSequence(stopChild, spawnChild);
    },
  });

  const rebuild = createBuildScheduler({
    build: () => buildClient({ ...firstBuildOpts, clean: false }),
    onStart: () => console.log("[dev] client build started"),
    onResult: logBuildResult,
  });

  current = spawnChild();

  // App-source watchers. While a dependency build is pending or last-failed the consumer graph is
  // in flux/broken, so suspend client rebuild and server restart (§9 point 4); the trailing
  // consumer cycle from the next successful package build picks up any edit made in that window.
  watcherHandle = installWatchers(
    paths,
    () => {
      if (!controller.suspended()) void rebuild.schedule();
    },
    (reason) => {
      if (!controller.suspended()) void restart.schedule(reason);
    },
  );

  // Dependency-package watchers route to the coalescing controller (§9 points 2, 3).
  packageWatcherHandle = installPackageWatchers(paths.repoRoot, () => void controller.schedule());

  const shutdown = async (): Promise<never> => {
    console.log("[dev] shutting down");
    watcherHandle?.close();
    packageWatcherHandle?.close();
    await stopChild();
    process.exit(DEV_EXIT.ok);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  // Park forever — watchers, the child's stdout pump, and the signal handlers keep the loop alive.
  await new Promise<void>(() => {});
  process.exit(DEV_EXIT.ok);
}

if (import.meta.main) {
  await main();
}
