// src/server/sources/gatus.ts — the Gatus endpoint-statuses client.
//
// One `GET /api/v1/endpoints/statuses` per cycle (twinproduction/gatus:v5.13.1) returns every
// endpoint. The client preserves each endpoint `name` verbatim (the identity convention parsed by
// 04's `matchChecks`) and reduces each endpoint to its LATEST evaluation into `RawCheckStatus`
// (never-evaluated kept with `latest: null`), converting Go `duration` ns→ms. Freshness comparison is
// 04's job, not here. Frozen path (REQ-SEC-02), injected base URL (REQ-PKG-02), never throws
// (REQ-LIVE-04).

import type { SourceResult, FetchLike, RawCheckStatus } from "./types.js"; // RawCheckStatus declared in types.ts (§2)
import { fetchJson, trimTrailingSlash } from "./types.js";

/** Raw Gatus `/api/v1/endpoints/statuses` element (gatus v5.13.1). */
export interface GatusEndpointStatus {
  /** The endpoint name — the identity convention (§3.6). PRESERVED verbatim as `RawCheckStatus.name`. */
  name: string;
  /** The endpoint's group (may be empty). */
  group?: string;
  /** Gatus's composite key (`<group>_<name>`); not used for identity. */
  key?: string;
  /** Recent evaluations, oldest→newest; the LAST element is the latest. May be empty/absent. */
  results?: GatusResult[];
}

/** One Gatus evaluation result. */
export interface GatusResult {
  /** Whether the evaluation's conditions all passed. */
  success: boolean;
  /** Evaluation time — RFC3339/ISO-8601 UTC. */
  timestamp: string;
  /** Round-trip duration in **nanoseconds** (Go `time.Duration`); converted to ms in the parse. */
  duration?: number;
  /** Observed HTTP status code (0 for non-HTTP checks). */
  status?: number;
  /** Condition failure messages, when unsuccessful. */
  errors?: string[];
}

/** The endpoint-statuses endpoint returns a bare array. */
export type GatusStatusesResponse = GatusEndpointStatus[];

/** The Gatus source client — the single endpoint-statuses query. */
export interface GatusClient {
  /**
   * Fetch all endpoint statuses and reduce each to its latest evaluation (§5.1).
   * @returns `{ ok: true, data: RawCheckStatus[] }` (possibly empty) or `{ ok: false, error }`.
   *          Never throws (REQ-LIVE-04).
   */
  endpointStatuses(): Promise<SourceResult<RawCheckStatus[]>>;
}

/**
 * Construct a `GatusClient` bound to an injected base URL (REQ-PKG-02).
 * @param baseUrl - `PULSE_GATUS_URL` (e.g. `http://gatus:8080`)
 * @param fetchImpl - injectable fetch (tests supply a mock)
 */
export function createGatusClient(baseUrl: string, fetchImpl: FetchLike = fetch): GatusClient {
  const url = `${trimTrailingSlash(baseUrl)}/api/v1/endpoints/statuses`;
  return {
    async endpointStatuses(): Promise<SourceResult<RawCheckStatus[]>> {
      const raw = await fetchJson<GatusStatusesResponse>(url, fetchImpl);
      if (!raw.ok) return raw;
      try {
        return { ok: true, data: parseChecks(raw.data) };
      } catch (err) {
        return { ok: false, error: `unexpected Gatus response shape: ${(err as Error).message}` };
      }
    },
  };
}

/**
 * Reduce each endpoint to a `RawCheckStatus` from its latest evaluation. Endpoints with no results
 * (declared but never evaluated) are KEPT with `latest: null` — `04`'s liveness reads `latest === null`
 * as "no affirmative signal" ⇒ `unknown` (REQ-STATE-05), and its detail-panel reduction still lists
 * the endpoint. `duration` (Go ns) is converted to `durationMs` here. Throws if the body is not an array.
 */
export function parseChecks(res: GatusStatusesResponse): RawCheckStatus[] {
  if (!Array.isArray(res)) throw new Error("expected a JSON array of endpoint statuses");
  return res.map((ep) => {
    const latest = ep.results?.at(-1);
    return {
      name: ep.name,
      ...(ep.group ? { group: ep.group } : {}),
      latest: latest
        ? {
            success: latest.success,
            timestamp: latest.timestamp,
            ...(typeof latest.duration === "number"
              ? { durationMs: Math.round(latest.duration / 1e6) } // ns → ms
              : {}),
          }
        : null,
    };
  });
}
