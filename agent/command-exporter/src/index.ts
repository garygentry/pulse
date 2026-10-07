// agent/command-exporter/src/index.ts
//
// Command-exporter process entrypoint (issue #3/#1). Mirrors the prober (02 §7): load the command
// signals once, serve `/metrics` + `/healthz` on COMMAND_EXPORTER_PORT (9130) immediately, then run
// each signal on ITS OWN cadence (per-signal `intervalMs`), folding each run's outcome into the
// MetricStore.
//
// Startup contract:
//   - MALFORMED/unreadable config → CommandExporterConfigError → exit(1) → failed healthcheck. Fatal.
//   - ABSENT config               → empty signal set → healthy idle (serves an empty exposition).
//   - A per-command failure is DATA, not a process failure: runSignal is total and each tick is
//     additionally wrapped, so the loop never dies (fail-visibility: the signal reports `_up = 0`).
//
// `handleRequest` and `runSignalInto` are exported as pure, side-effect-free seams so unit tests can
// exercise routing + tick-error resilience WITHOUT binding the real port. Only running this file as
// the entrypoint (guarded by `import.meta.main`) starts the server.

import { loadCommandExporterConfig, loadTimeoutMs } from "./config.js";
import { runSignal } from "./run.js";
import { MetricStore } from "./metrics.js";
import { CommandExporterConfigError } from "./errors.js";
import type { CommandSignalConfig } from "../../contract/types.js";
import { COMMAND_EXPORTER_PORT } from "../../contract/constants.js";

/** Prometheus text-format content type for the `/metrics` body (0.0.4). */
const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * Pure request router — the exporter serves ONLY `/metrics` and `/healthz`; every other path is a
 * 404 (no write/control surface). Exported so server-unit tests can assert routing against the
 * {@link MetricStore} without binding {@link COMMAND_EXPORTER_PORT}.
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
 * Run one signal and fold its outcome into `store`, catching any UNEXPECTED error so the loop
 * continues (runSignal is already total, so this catch is defensive). Exported (with an injectable
 * `runFn` seam) so a unit test can force the catch path and prove ticks survive a failure.
 */
export async function runSignalInto(
  store: MetricStore,
  signal: CommandSignalConfig,
  timeoutMs: number,
  runFn: typeof runSignal = runSignal,
): Promise<void> {
  try {
    store.record(signal.name, await runFn(signal, timeoutMs));
  } catch (err) {
    // A run-level throw is unexpected (runSignal is total); record blind and continue — never crash.
    store.record(signal.name, { ok: false });
    console.error(`signal "${signal.name}" tick error (continuing): ${(err as Error).message}`);
  }
}

/**
 * Command-exporter entrypoint. Loads the signal set once, serves `/metrics` + `/healthz` on
 * {@link COMMAND_EXPORTER_PORT} immediately (so scrapes never 404, even before the first run), primes
 * every signal once, then re-runs each on its own `intervalMs`. A fatal
 * {@link CommandExporterConfigError} at startup exits non-zero → failed healthcheck. An absent config
 * yields an empty signal set → healthy idle.
 */
export async function main(): Promise<void> {
  let signals: CommandSignalConfig[];
  let timeoutMs: number;
  try {
    timeoutMs = loadTimeoutMs();
    signals = await loadCommandExporterConfig();
  } catch (err) {
    if (err instanceof CommandExporterConfigError) {
      console.error(`FATAL ${err.code}: ${err.message} (${err.configPath})`);
      process.exit(1); // → failed container healthcheck, NOT a silent stop
    }
    throw err;
  }

  const store = new MetricStore(signals);

  // Serve immediately (empty until the first runs complete) so scrapes never 404.
  Bun.serve({
    port: COMMAND_EXPORTER_PORT,
    fetch: (req) => handleRequest(req, store),
  });

  // Prime every signal once, then schedule each on its own cadence (signals differ in interval).
  await Promise.all(signals.map((signal) => runSignalInto(store, signal, timeoutMs)));
  for (const signal of signals) {
    setInterval(() => void runSignalInto(store, signal, timeoutMs), signal.intervalMs);
  }
}

// Bun runs this file directly as the container command (Dockerfile CMD). The `import.meta.main`
// guard means importing `handleRequest`/`runSignalInto`/`MetricStore` in a test does NOT start the
// server — only executing this file as the entrypoint does.
if (import.meta.main) {
  await main();
}
