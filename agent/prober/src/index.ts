// agent/prober/src/index.ts
//
// Prober process entrypoint (02-deep-health-prober.md §7). Wires the three pieces: load the
// deep-health probe set once, serve `/metrics` + `/healthz` on PROBER_PORT (9120) immediately,
// then re-probe on the bounded cadence — folding each cycle's outcomes into the MetricStore.
//
// Startup contract (§7, §8, tech-spec §3.10):
//   - MALFORMED/unreadable config → ProberConfigError → exit(1) → failed healthcheck. Fatal.
//   - ABSENT config               → empty probe set → healthy idle (serves empty exposition).
//   - A per-probe failure is DATA, not a process failure: runProbe is total and the cycle is
//     additionally wrapped in a catch-all, so the loop never dies (REQ-PROBE-04).
//
// The server request router (`handleRequest`) and the cycle folder (`runCycleInto`) are exported
// as pure, side-effect-free seams so unit tests can exercise routing + cycle-error resilience
// WITHOUT binding the real production port (item 011 note; 06 §3 hermetic imports). Only running
// this file as the entrypoint (guarded by `import.meta.main`) starts the server.

import { loadProberConfig, loadRuntimeOptions } from "./config.js";
import { runCycle } from "./probe.js";
import type { ProbeOptions } from "./probe.js";
import { MetricStore } from "./metrics.js";
import { ProberConfigError } from "./errors.js";
import type { DeepHealthProbeConfig } from "../../contract/types.js";
import { PROBER_PORT } from "../../contract/constants.js";

/** Prometheus text-format content type for the `/metrics` body (0.0.4). */
const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** A truthy boolean env value: `1`, `true`, `yes`, `on` (case-insensitive). Anything else — unset,
 *  empty, `0`, `false` — is false. Used to toggle per-host prober mode (issue #8). */
export function isTruthyEnv(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * Pure request router — the prober serves ONLY `/metrics` and `/healthz`; every other path is a
 * 404 (§7, §8: no write/control surface). Exported so server-unit tests can assert routing
 * against the {@link MetricStore} without binding {@link PROBER_PORT}.
 *
 * @param req - The incoming request.
 * @param store - The live metric store (its `.render()` produces the exposition body).
 * @returns The response — `/metrics` exposition, `/healthz` "ok", or a 404.
 */
export function handleRequest(req: Request, store: MetricStore): Response {
  const { pathname } = new URL(req.url);
  if (pathname === "/metrics") {
    return new Response(store.render(), { headers: { "content-type": METRICS_CONTENT_TYPE } });
  }
  if (pathname === "/healthz") {
    return new Response("ok");
  }
  return new Response("not found", { status: 404 });
}

/**
 * Run one probe cycle and fold its outcomes into `store`, catching any UNEXPECTED cycle-level
 * error so the loop continues (§7, §8, REQ-PROBE-04). `runProbe` is already total, so this catch
 * is defensive — a probe failure is recorded as `_up = 0`, never a thrown error. Exported (with
 * an injectable `cycleFn` seam) so a unit test can force the catch path and prove the process
 * continues after a cycle-level failure.
 *
 * @param store - The metric store to fold outcomes into.
 * @param probes - The deep-health probe set.
 * @param options - Per-probe timeout + pool size (bounded by default).
 * @param cycleFn - The cycle runner (test seam). Default: {@link runCycle}.
 */
export async function runCycleInto(
  store: MetricStore,
  probes: DeepHealthProbeConfig[],
  options: ProbeOptions & { concurrency?: number } = {},
  cycleFn: typeof runCycle = runCycle,
): Promise<void> {
  try {
    store.record(await cycleFn(probes, options));
  } catch (err) {
    // A cycle-level throw is unexpected (runProbe is total); log and continue — never crash.
    console.error(`cycle error (continuing): ${(err as Error).message}`);
  }
}

/**
 * Prober process entrypoint. Loads the deep-health probe set once, serves `/metrics` +
 * `/healthz` on {@link PROBER_PORT} immediately (so scrapes never 404, even before the first
 * cycle), primes one cycle, then re-probes at the validated runtime cadence (REQ-PERF-02).
 * A fatal {@link ProberConfigError} at startup exits non-zero → failed healthcheck (§7). An
 * absent config yields an empty probe set → healthy idle.
 */
export async function main(): Promise<void> {
  let probes: DeepHealthProbeConfig[];
  let runtime: ReturnType<typeof loadRuntimeOptions>;
  try {
    runtime = loadRuntimeOptions();
    probes = await loadProberConfig();
  } catch (err) {
    if (err instanceof ProberConfigError) {
      console.error(`FATAL ${err.code}: ${err.message} (${err.configPath})`);
      process.exit(1); // → failed container healthcheck, NOT a silent stop
    }
    throw err;
  }

  // Per-host prober mode (issue #8): when PULSE_PROBER_SUPPRESS_HOST_LABEL is truthy the exposition
  // omits the self-set `host` label, letting the scrape-time file_sd `host` label own it (this
  // prober uses the managed-linux-prober job under network_mode: host). The central prober leaves it
  // unset and self-labels host+service, unchanged.
  const suppressHostLabel = isTruthyEnv(process.env.PULSE_PROBER_SUPPRESS_HOST_LABEL);
  const store = new MetricStore({ suppressHostLabel });

  // Serve immediately (empty until the first cycle completes) so scrapes never 404.
  Bun.serve({
    port: PROBER_PORT,
    fetch: (req) => handleRequest(req, store),
  });

  const probeOptions = { timeoutMs: runtime.timeoutMs, concurrency: runtime.concurrency };
  await runCycleInto(store, probes, probeOptions); // prime once at startup
  setInterval(() => void runCycleInto(store, probes, probeOptions), runtime.cadenceMs);
}

// Bun runs this file directly as the container command (Dockerfile CMD). The `import.meta.main`
// guard means importing `handleRequest`/`runCycleInto`/`MetricStore` in a test does NOT start
// the server — only executing this file as the entrypoint does (06 §3 hermetic imports).
if (import.meta.main) {
  await main();
}
