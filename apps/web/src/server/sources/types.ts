// src/server/sources/types.ts — the engine-source boundary shapes + shared fetch primitive
//.
//
// The single home for the discriminated `SourceResult<T>`, the injectable `fetchJson<T>` primitive
// (5s timeout, never throws), the three build-input types the snapshot layer consumes
// (`LiveSeries`/`RawActiveAlert`/`RawCheckStatus`), and the `trimTrailingSlash` URL helper. Imported
// by the three clients here and by 04's snapshot modules.

import { SOURCE_TIMEOUT_MS } from "../../shared/constants.js";

/**
 * The result of one engine fetch+parse. Discriminated on `ok`. A client method NEVER throws;
 * every failure mode (timeout, non-2xx, network error, malformed/mis-shaped JSON) is captured
 * here as `{ ok: false }` so the refresh loop can fold it into `SourceHealth` (REQ-LIVE-04).
 */
export type SourceResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string };

/** One parsed liveness series from the single VM union query (§3). `name` is the metric name. */
export interface LiveSeries {
  /** The metric name (`__name__`): `"up" | "pulse_agent_up" | "pulse_deep_health_up"`. */
  name: string;
  /** Every label except `__name__` (e.g. `host`, `job`, `service`, `instance`, `collection_class`). */
  labels: Readonly<Record<string, string>>;
  /** The instant sample value; `0` or `1` for these gauges. `NaN` if VM emitted a non-numeric value. */
  value: number;
}

/** One active alert, raw labels/annotations passed through for `04`'s `matchAlerts` to interpret (§4). */
export interface RawActiveAlert {
  /** Stable Alertmanager fingerprint. */
  fingerprint: string;
  /** Raw alert labels; `alertname`, `severity`, `estate` guaranteed; `host`/`service`/`endpoint` optional. */
  labels: Record<string, string>;
  /** Raw alert annotations; `summary` present on estate alerts, optional on Gatus-sourced. Empty object when absent. */
  annotations: Record<string, string>;
  /** ISO-8601 UTC start (`startsAt`, passed through). */
  startsAt: string;
}

/** One endpoint reduced to its latest evaluation (§5); `latest: null` when never evaluated. */
export interface RawCheckStatus {
  /** Endpoint name (the identity convention). */
  name: string;
  /** Owning-host group label (omitted for a bare `dns:` endpoint). */
  group?: string;
  /** Most-recent evaluation, or `null` when the endpoint has produced no result yet. `durationMs` is
   *  ns→ms converted here so `04` never sees Go nanoseconds. */
  latest: { success: boolean; timestamp: string; durationMs?: number } | null;
}

/** Injectable fetch implementation; defaults to the global `fetch` (Bun-native). Tests pass a mock. */
export type FetchLike = typeof fetch;

/**
 * GET `url` with a `SOURCE_TIMEOUT_MS` (5s) timeout and parse the JSON body as `T`.
 * Returns `{ ok: true, data }` on a 2xx JSON response; `{ ok: false, error }` on timeout,
 * non-2xx status, network failure, or unparseable JSON. NEVER throws.
 *
 * @typeParam T - the expected raw wire shape (validated later by the caller's parse step)
 * @param url - the fully-formed request URL (base + fixed path + fixed query — §2.3)
 * @param fetchImpl - injectable fetch; defaults to global `fetch` (tests supply a mock)
 * @returns a `SourceResult<T>` carrying the raw parsed body or a short, agent-actionable error
 */
export async function fetchJson<T>(
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<SourceResult<T>> {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText || ""}`.trim() };
    }
    const data = (await res.json()) as T; // throws on malformed JSON → caught below
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: describeFetchError(err) };
  }
}

/** Map a thrown fetch/parse error to a short, stable, human/agent-readable string. */
export function describeFetchError(err: unknown): string {
  // `AbortSignal.timeout` aborts with a DOMException named "TimeoutError".
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return `request timed out after ${SOURCE_TIMEOUT_MS}ms`;
  }
  if (err instanceof SyntaxError) return `malformed JSON response: ${err.message}`;
  if (err instanceof Error) return err.message; // e.g. TypeError "fetch failed" (connection refused)
  return String(err);
}

/** Strip a single trailing `/` so an injected `baseUrl` may or may not carry one. Shared by all
 *  three clients (§3.2). */
export function trimTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}
