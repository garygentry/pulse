// agent/prober/src/probe.ts
//
// Per-probe execution and the bounded probe cycle (02-deep-health-prober.md §4, §6.1,
// REQ-PROBE-01/04, REQ-PERF-02).
//
// `runProbe` is TOTAL: every probe-level failure (unreachable / timeout / non-JSON /
// JSONPath-miss / HTTP-status / credential-resolve) is caught and returned as
// `{ ok: false, error }` — it never throws, so one hung/erroring endpoint can neither crash
// the prober nor stall its siblings (§8). `runCycle` fans out under a bounded worker pool so
// a slow probe consumes exactly one slot. The `fetch`/`env` seams exist ONLY for hermetic
// tests (06-testing-strategy.md §3): production passes neither and falls back to the
// Bun-global `fetch` and `process.env`.

import type { DeepHealthProbeConfig } from "../../contract/types.js";
import type { ProbeOutcome } from "./probe-outcome.js"; // ProbeOutcome is defined in 00 §7
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_PROBE_CONCURRENCY,
} from "../../contract/constants.js";
import { ProbeExecutionError } from "./errors.js";
import { evalNumericPath } from "./jsonpath.js";
import { resolveBearer } from "./credential.js";

/** Options for one probe execution (all bounded — REQ-PERF-02). The `fetch`/`env` seams exist
 *  ONLY to make the prober hermetically testable (§8, `06-testing-strategy.md §3`): production
 *  code passes neither, so `runProbe`/`runCycle` fall back to the Bun-global `fetch` and
 *  `process.env`; tests inject a stub `fetch` and a fixture `env` so no real network call or
 *  ambient env read ever happens. */
export interface ProbeOptions {
  /** Per-probe HTTP timeout in ms. Default: {@link DEFAULT_PROBE_TIMEOUT_MS} (~5 s). */
  timeoutMs?: number;
  /** Injected `fetch` (test seam). Default: the Bun-global `fetch`. */
  fetch?: typeof fetch;
  /** Injected env map for credential resolution (test seam). Default: `process.env`. */
  env?: Record<string, string | undefined>;
}

/** Reconstruct the "svc:<host>/<service>" probe name for error context. `DeepHealthProbeConfig`
 *  (00 §5) carries `host`/`service` parsed out of the original name rather than the raw name. */
function probeName(probe: DeepHealthProbeConfig): string {
  return `svc:${probe.host}/${probe.service}`;
}

/**
 * Execute one deep-health probe: GET the JSON endpoint, map each `responseMapping` entry to a
 * numeric sample, and return a {@link ProbeOutcome} (REQ-PROBE-01). This function NEVER throws
 * for a probe-level failure (REQ-PROBE-04): unreachable / timeout / non-JSON / JSONPath-miss /
 * HTTP-status / credential-resolve are all caught and returned as `{ ok: false, error }`.
 *
 * @param probe - One narrowed deep-health probe from `loadProberConfig`.
 * @param options - Timeout override + test seams; defaults to the bounded constant.
 * @returns A success outcome carrying `samples` + `scrapedAt`, or a failure outcome carrying a
 *   {@link ProbeExecutionError} (drives `pulse_deep_health_up = 0`).
 */
export async function runProbe(
  probe: DeepHealthProbeConfig,
  options: ProbeOptions = {},
): Promise<ProbeOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const { host, service } = probe;
  try {
    const body = await fetchJson(probe, timeoutMs, options);
    const samples = mapResponse(probe, body); // may throw ProbeExecutionError("path-miss")
    return { ok: true, host, service, samples, scrapedAt: Math.floor(Date.now() / 1000) };
  } catch (err) {
    const error =
      err instanceof ProbeExecutionError
        ? err
        : new ProbeExecutionError(probeName(probe), "unreachable", String(err));
    return { ok: false, host, service, error };
  }
}

/**
 * GET `probe.target` with a bounded timeout and (optional) Bearer auth, returning the parsed
 * JSON body. Uses the WHATWG `fetch` provided by the Bun runtime (or the injected test seam).
 *
 * @throws {ProbeExecutionError} reason `"http-status"` (non-2xx), `"bad-json"` (unparseable
 *   body), `"timeout"` (aborted after `timeoutMs`), or `"unreachable"` (transport failure).
 *   A declared-but-unresolvable credential surfaces as its own `ProbeExecutionError` (§5).
 */
async function fetchJson(
  probe: DeepHealthProbeConfig,
  timeoutMs: number,
  options: ProbeOptions = {},
): Promise<unknown> {
  const doFetch = options.fetch ?? fetch; // test seam; defaults to the Bun-global fetch
  const name = probeName(probe);
  const headers: Record<string, string> = { accept: "application/json" };
  const bearer = resolveBearer(probe.credential, options.env); // §5 — from env, never a literal
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;

  let res: Response;
  try {
    res = await doFetch(probe.target, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = (err as Error).name === "TimeoutError" ? "timeout" : "unreachable";
    throw new ProbeExecutionError(name, reason, `GET ${probe.target} failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new ProbeExecutionError(name, "http-status", `GET ${probe.target} → HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new ProbeExecutionError(name, "bad-json", `non-JSON body from ${probe.target}: ${(err as Error).message}`);
  }
}

/**
 * Evaluate every `responseMapping` entry against the parsed body, producing a
 * `metricName → number` sample map (tech-spec §4.2). A path that is missing or resolves to a
 * non-numeric value is a **fail-visible** miss (REQ-PROBE-04): it throws
 * `ProbeExecutionError(reason:"path-miss")`, failing the whole probe so `_up = 0`.
 *
 * @throws {ProbeExecutionError} reason `"path-miss"` on a missing/non-numeric JSONPath result.
 */
function mapResponse(probe: DeepHealthProbeConfig, body: unknown): Record<string, number> {
  const samples: Record<string, number> = {};
  const name = probeName(probe);
  for (const [metricName, path] of Object.entries(probe.metrics)) {
    const value = evalNumericPath(body, path); // number | undefined
    if (value === undefined) {
      throw new ProbeExecutionError(
        name,
        "path-miss",
        `JSONPath ${JSON.stringify(path)} for metric ${JSON.stringify(metricName)} missing or non-numeric`,
      );
    }
    samples[metricName] = value;
  }
  return samples;
}

/**
 * Run every probe once under a bounded worker pool (REQ-PERF-02). Ordering is irrelevant; each
 * task is isolated ({@link runProbe} never throws), so one hung endpoint cannot stall the rest.
 * The result array is index-aligned with `probes` so callers may correlate outcomes to inputs.
 *
 * @param probes - The deep-health probe set from `loadProberConfig`.
 * @param options - Per-probe timeout + pool size (`concurrency`), all bounded by default.
 * @returns One {@link ProbeOutcome} per probe (index-aligned with `probes`).
 */
export async function runCycle(
  probes: DeepHealthProbeConfig[],
  options: ProbeOptions & { concurrency?: number } = {},
): Promise<ProbeOutcome[]> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_PROBE_CONCURRENCY);
  const outcomes: ProbeOutcome[] = new Array<ProbeOutcome>(probes.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < probes.length; i = next++) {
      const probe = probes[i];
      if (probe === undefined) continue; // unreachable (dense array) — satisfies noUncheckedIndexedAccess
      outcomes[i] = await runProbe(probe, options);
    }
  }
  const workerCount = Math.min(concurrency, probes.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return outcomes;
}
