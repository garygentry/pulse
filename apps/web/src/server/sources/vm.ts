// src/server/sources/vm.ts — the VictoriaMetrics liveness client.
//
// One Prometheus-compatible instant query per cycle returns every liveness series across the whole
// estate (REQ-PERF-03) — the O(1)-in-estate-size aggregate. The query string is a frozen constant
// (REQ-SEC-02); the base URL is injected (REQ-PKG-02). Never throws (REQ-LIVE-04).

import type { SourceResult, FetchLike, LiveSeries } from "./types.js"; // LiveSeries declared in types.ts (§2)
import { fetchJson, trimTrailingSlash } from "./types.js";

/** Raw VictoriaMetrics `/api/v1/query` (instant) response — Prometheus vector result. */
export interface VmQueryResponse {
  /** `"success"` on a well-formed query; `"error"` carries `errorType`/`error`. */
  status: "success" | "error";
  data?: {
    /** Always `"vector"` for an instant query. */
    resultType: "vector";
    result: VmVectorSample[];
  };
  errorType?: string;
  error?: string;
}

/** One element of an instant-query vector result. */
export interface VmVectorSample {
  /** All labels including the reserved `__name__` (the metric name). */
  metric: Record<string, string>;
  /** `[unixSeconds, sampleValueAsString]` — VM encodes the value as a string. */
  value: [number, string];
}

/** The VictoriaMetrics source client — the single liveness aggregate query (REQ-PERF-03). */
export interface VmClient {
  /**
   * Issue the one liveness union instant query and return every series (§3.1).
   * @returns `{ ok: true, data: LiveSeries[] }` (possibly empty) or `{ ok: false, error }`.
   *          Never throws (REQ-LIVE-04).
   */
  queryLiveness(): Promise<SourceResult<LiveSeries[]>>;
}

/** The frozen liveness union expression (REQ-STATE-05). */
const LIVENESS_QUERY = "up or pulse_agent_up or pulse_deep_health_up" as const;

/**
 * Construct a `VmClient` bound to an injected VictoriaMetrics base URL (REQ-PKG-02).
 * @param baseUrl - `PULSE_VM_URL` from `ServerConfig` (e.g. `http://victoriametrics:8428`)
 * @param fetchImpl - injectable fetch (tests supply a mock; defaults to global `fetch`)
 */
export function createVmClient(baseUrl: string, fetchImpl: FetchLike = fetch): VmClient {
  const url = `${trimTrailingSlash(baseUrl)}/api/v1/query?${new URLSearchParams({ query: LIVENESS_QUERY })}`;
  return {
    async queryLiveness(): Promise<SourceResult<LiveSeries[]>> {
      const raw = await fetchJson<VmQueryResponse>(url, fetchImpl);
      if (!raw.ok) return raw;
      try {
        return { ok: true, data: parseLiveness(raw.data) };
      } catch (err) {
        return { ok: false, error: `unexpected VM response shape: ${(err as Error).message}` };
      }
    },
  };
}

/** Parse a `VmQueryResponse` into `LiveSeries[]`. Throws on a mis-shaped/`status:"error"` body. */
export function parseLiveness(res: VmQueryResponse): LiveSeries[] {
  if (res.status !== "success" || !res.data) {
    throw new Error(res.error ?? `status=${res.status}`);
  }
  if (res.data.resultType !== "vector" || !Array.isArray(res.data.result)) {
    throw new Error(`expected vector result, got ${res.data.resultType}`);
  }
  return res.data.result.map((sample) => {
    const { __name__, ...labels } = sample.metric;
    return {
      name: __name__ ?? "",
      labels,
      value: Number(sample.value[1]),
    };
  });
}
