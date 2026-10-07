// src/server/sources/alertmanager.ts — the Alertmanager v2 active-alerts client
//.
//
// One `GET /api/v2/alerts` per cycle (prom/alertmanager:v0.27.0) returns the whole active,
// non-silenced, non-inhibited set. The client is PURE TRANSPORT: it reduces each raw `GettableAlert`
// to the `RawActiveAlert` build-input shape (labels/annotations/startsAt pass-through) — all
// normalisation, severity coercion, target attribution, and the DeadMansSwitch drop are deferred to
// 04's `matchAlerts` (§4.3). Frozen query (REQ-SEC-02), injected base URL (REQ-PKG-02), never throws
// (REQ-LIVE-04).

import type { SourceResult, FetchLike, RawActiveAlert } from "./types.js"; // RawActiveAlert declared in types.ts (§2)
import { fetchJson, trimTrailingSlash } from "./types.js";

/** Raw Alertmanager v2 `GettableAlert` (prom/alertmanager:v0.27.0). See §4 WARNING. */
export interface AmGettableAlert {
  /** Alert label set — carries `alertname`, `severity`, and optional `host`/`service`/`endpoint`/`estate`. */
  labels: Record<string, string>;
  /** Alert annotations — `summary`/`description` when the rule provides them. */
  annotations?: Record<string, string>;
  /** RFC3339/ISO-8601 UTC alert start. */
  startsAt: string;
  /** RFC3339/ISO-8601 UTC alert end (future while firing). */
  endsAt?: string;
  updatedAt?: string;
  fingerprint?: string;
  status?: { state: "active" | "suppressed" | "unprocessed"; silencedBy?: string[]; inhibitedBy?: string[] };
  receivers?: { name: string }[];
}

/** The v2 alerts endpoint returns a bare array of gettable alerts. */
export type AmAlertsResponse = AmGettableAlert[];

/** The Alertmanager source client — the single active-alerts query. */
export interface AlertmanagerClient {
  /**
   * Fetch active, non-silenced, non-inhibited alerts (§4.1).
   * @returns `{ ok: true, data: RawActiveAlert[] }` (possibly empty) or `{ ok: false, error }`.
   *          Never throws (REQ-LIVE-04).
   */
  activeAlerts(): Promise<SourceResult<RawActiveAlert[]>>;
}

/**
 * Construct an `AlertmanagerClient` bound to an injected base URL (REQ-PKG-02).
 * @param baseUrl - `PULSE_ALERTMANAGER_URL` (e.g. `http://alertmanager:9093`)
 * @param fetchImpl - injectable fetch (tests supply a mock)
 */
export function createAlertmanagerClient(baseUrl: string, fetchImpl: FetchLike = fetch): AlertmanagerClient {
  const q = new URLSearchParams({ active: "true", silenced: "false", inhibited: "false" });
  const url = `${trimTrailingSlash(baseUrl)}/api/v2/alerts?${q}`;
  return {
    async activeAlerts(): Promise<SourceResult<RawActiveAlert[]>> {
      const raw = await fetchJson<AmAlertsResponse>(url, fetchImpl);
      if (!raw.ok) return raw;
      try {
        return { ok: true, data: parseAlerts(raw.data) };
      } catch (err) {
        return { ok: false, error: `unexpected Alertmanager response shape: ${(err as Error).message}` };
      }
    },
  };
}

/** Reduce the v2 alerts array to `RawActiveAlert[]` (labels/annotations/startsAt pass-through — NO
 *  normalisation; `04` interprets). Throws if the body is not an array. */
export function parseAlerts(res: AmAlertsResponse): RawActiveAlert[] {
  if (!Array.isArray(res)) throw new Error("expected a JSON array of alerts");
  return res.map((a) => ({
    fingerprint: a.fingerprint ?? "",
    labels: a.labels,
    annotations: a.annotations ?? {},
    startsAt: a.startsAt,
  }));
}
