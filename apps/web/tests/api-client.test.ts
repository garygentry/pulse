// apps/web/tests/api-client.test.ts — the conditional API client (01 §11, 08 §§5–6; item 045).
//
// Covers `apiFetch`'s exact discriminated results, cycle-route metadata validation
// (ETag/payload-id/observation) before accepting a 200 or 304, the one-unconditional-retry on an
// invalid/validator-less 304, the session/history null-cycle-metadata contract, and bounded
// failure (network/protocol → INTERNAL_ERROR, never an uncaught throw). No DOM: `apiFetch` uses
// only Bun globals (`Headers`, `Response`, `atob`, `TextDecoder`).

import { describe, expect, test } from "bun:test";

import { apiFetch, type ApiFetchResult } from "../src/client/api/client.js";
import type { CycleObservation, SourceId } from "@pulse/web-data/wire";

const SOURCE_IDS: readonly SourceId[] = [
  "victoriametrics-signals",
  "victoriametrics-targets",
  "victoriametrics-buildinfo",
  "alertmanager-alerts",
  "alertmanager-silences",
  "alertmanager-status",
  "alertmanager-receivers",
  "vmalert-rules",
  "gatus-statuses",
  "grafana-health",
];

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

/** A well-formed `CycleObservation` (all ten source ids, positive seq, valid timestamps). */
function makeObservation(seq = 1): CycleObservation {
  const sources = {} as Record<SourceId, { state: "current"; lastAttemptAt: string; lastSuccess: string }>;
  for (const id of SOURCE_IDS) {
    sources[id] = { state: "current", lastAttemptAt: "2026-09-17T00:00:00.000Z", lastSuccess: "2026-09-17T00:00:00.000Z" };
  }
  return {
    generation: "11111111-1111-4111-8111-111111111111",
    seq,
    observedAt: "2026-09-17T00:00:00.000Z",
    appVersion: "0.0.0-test",
    sources,
  };
}

/** base64url of an observation (canonical form is not required — the validator re-checks bytes). */
function encodeObs(obs: unknown): string {
  return Buffer.from(JSON.stringify(obs)).toString("base64url");
}

/** The header set a cycle route serves on 200/304, with overridable pieces. */
function cycleHeaders(
  opts: { etag?: string; payloadId?: string; observation?: string | null } = {},
): Record<string, string> {
  const h: Record<string, string> = {};
  if (opts.etag !== undefined) h["etag"] = `"${opts.etag}"`;
  if (opts.payloadId !== undefined) h["x-pulse-payload-id"] = opts.payloadId;
  const obs = opts.observation === undefined ? encodeObs(makeObservation()) : opts.observation;
  if (obs !== null) h["x-pulse-observation"] = obs;
  return h;
}

interface Call {
  readonly url: string;
  readonly ifNoneMatch: string | null;
}

/** A capturing fetch that returns the queued responses in order. */
function queuedFetch(responses: Response[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), ifNoneMatch: headers.get("if-none-match") });
    const res = responses[i++];
    if (res === undefined) throw new Error("no queued response");
    return res;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("apiFetch — cycle route 200 metadata validation", () => {
  test("valid 200 returns ok with unquoted etag, identity, and validated observation", async () => {
    const { fetchImpl, calls } = queuedFetch([
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: cycleHeaders({ etag: HASH_A, payloadId: HASH_B }),
      }),
    ]);
    const result = await apiFetch<{ hello: string }>("/api/overview", undefined, fetchImpl);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.value).toEqual({ hello: "world" });
    expect(result.etag).toBe(HASH_A); // unquoted
    expect(result.identity).toBe(HASH_B);
    expect(result.observation).not.toBeNull();
    expect(result.observation?.seq).toBe(1);
    expect(calls[0]?.ifNoneMatch).toBeNull(); // no retained validator → no conditional header
  });

  test("options.etag is sent as a strong If-None-Match on a cycle route", async () => {
    const { fetchImpl, calls } = queuedFetch([
      new Response(JSON.stringify({}), { status: 200, headers: cycleHeaders({ etag: HASH_A, payloadId: HASH_B }) }),
    ]);
    await apiFetch("/api/alerts", { etag: HASH_A }, fetchImpl);
    expect(calls[0]?.ifNoneMatch).toBe(`"${HASH_A}"`);
  });

  test("a 200 with an invalid ETag fails safely as INTERNAL_ERROR and does not parse the body", async () => {
    let bodyRead = false;
    // A minimal fake exposing exactly the surface `apiFetch` reads, so we can observe that `json()`
    // is never called once metadata validation fails (native Response getters resist proxying).
    const fake = {
      status: 200,
      ok: true,
      headers: new Headers(cycleHeaders({ etag: "not-a-hash", payloadId: HASH_B })),
      json: (): Promise<unknown> => {
        bodyRead = true;
        return Promise.resolve({});
      },
    } as unknown as Response;
    const { fetchImpl } = queuedFetch([fake]);
    const result = await apiFetch("/api/estate", undefined, fetchImpl);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(result.httpStatus).toBe(200);
    expect(bodyRead).toBe(false); // metadata validated before the body is touched
  });

  test("a 200 with a missing payload-id fails safely as INTERNAL_ERROR", async () => {
    const { fetchImpl } = queuedFetch([
      new Response(JSON.stringify({}), { status: 200, headers: cycleHeaders({ etag: HASH_A }) }),
    ]);
    const result = await apiFetch("/api/engine", undefined, fetchImpl);
    expect(result.status).toBe("error");
  });

  test("a 200 with an oversized observation header fails safely", async () => {
    const bloated = { ...makeObservation(), appVersion: "x".repeat(9000) };
    const { fetchImpl } = queuedFetch([
      new Response(JSON.stringify({}), {
        status: 200,
        headers: cycleHeaders({ etag: HASH_A, payloadId: HASH_B, observation: encodeObs(bloated) }),
      }),
    ]);
    const result = await apiFetch("/api/timeline", undefined, fetchImpl);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("apiFetch — cycle route 304 conditional reuse and retry", () => {
  test("a valid 304 with a retained validator returns not-modified", async () => {
    const { fetchImpl, calls } = queuedFetch([
      new Response(null, { status: 304, headers: cycleHeaders({ payloadId: HASH_B }) }),
    ]);
    const result = await apiFetch("/api/overview", { etag: HASH_A }, fetchImpl);
    expect(result.status).toBe("not-modified");
    if (result.status !== "not-modified") throw new Error("unreachable");
    expect(result.etag).toBe(HASH_A); // the retained validator, re-confirmed
    expect(result.identity).toBe(HASH_B);
    expect(result.observation?.seq).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ifNoneMatch).toBe(`"${HASH_A}"`);
  });

  test("a 304 WITHOUT a retained validator retries once unconditionally, then accepts the 200", async () => {
    const { fetchImpl, calls } = queuedFetch([
      new Response(null, { status: 304, headers: cycleHeaders({ payloadId: HASH_B }) }),
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: cycleHeaders({ etag: HASH_A, payloadId: HASH_B }),
      }),
    ]);
    const result = await apiFetch("/api/overview", undefined, fetchImpl); // no etag retained
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.ifNoneMatch).toBeNull();
    expect(calls[1]?.ifNoneMatch).toBeNull(); // the retry is unconditional
  });

  test("a 304 with malformed metadata (bad payload-id) retries once unconditionally", async () => {
    const { fetchImpl, calls } = queuedFetch([
      new Response(null, { status: 304, headers: cycleHeaders({ payloadId: "nope" }) }),
      new Response(JSON.stringify({}), { status: 200, headers: cycleHeaders({ etag: HASH_A, payloadId: HASH_B }) }),
    ]);
    const result = await apiFetch("/api/alerts", { etag: HASH_A }, fetchImpl);
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.ifNoneMatch).toBeNull();
  });

  test("a 304 with a present-but-oversized observation retries", async () => {
    const bloated = encodeObs({ ...makeObservation(), appVersion: "y".repeat(9000) });
    const { fetchImpl, calls } = queuedFetch([
      new Response(null, { status: 304, headers: cycleHeaders({ payloadId: HASH_B, observation: bloated }) }),
      new Response(JSON.stringify({}), { status: 200, headers: cycleHeaders({ etag: HASH_A, payloadId: HASH_B }) }),
    ]);
    const result = await apiFetch("/api/estate", { etag: HASH_A }, fetchImpl);
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  test("a persistent 304 (server ignores the retry) resolves to INTERNAL_ERROR, never empty success", async () => {
    const { fetchImpl, calls } = queuedFetch([
      new Response(null, { status: 304, headers: cycleHeaders({ payloadId: "bad" }) }),
      new Response(null, { status: 304, headers: cycleHeaders({ payloadId: "bad" }) }),
    ]);
    const result = await apiFetch("/api/overview", { etag: HASH_A }, fetchImpl);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(calls).toHaveLength(2);
  });
});

describe("apiFetch — error responses and bounded failure", () => {
  test("a validated error envelope is returned with its httpStatus", async () => {
    const { fetchImpl } = queuedFetch([
      new Response(JSON.stringify({ code: "NOT_READY", message: "Current data is not ready yet." }), { status: 503 }),
    ]);
    const result = await apiFetch("/api/overview", undefined, fetchImpl);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.code).toBe("NOT_READY");
    expect(result.error.message).toBe("Current data is not ready yet.");
    expect(result.httpStatus).toBe(503);
  });

  test("a malformed error body falls back to a bounded INTERNAL_ERROR envelope with the real status", async () => {
    const { fetchImpl } = queuedFetch([
      new Response("<html>gateway</html>", { status: 502 }),
    ]);
    const result = await apiFetch("/api/alerts", undefined, fetchImpl);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(result.httpStatus).toBe(502);
  });

  test("a network failure resolves to INTERNAL_ERROR httpStatus 0, never an uncaught throw", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const result: ApiFetchResult<unknown> = await apiFetch("/api/overview", undefined, fetchImpl);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(result.httpStatus).toBe(0);
  });
});

describe("apiFetch — non-cycle routes permit null cycle metadata", () => {
  test("session 200 returns ok with null etag/identity/observation even without metadata headers", async () => {
    const { fetchImpl, calls } = queuedFetch([
      new Response(JSON.stringify({ identity: null, authMode: "none", capabilities: {} }), { status: 200 }),
    ]);
    const result = await apiFetch<{ authMode: string }>("/api/session", { etag: HASH_A }, fetchImpl);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.value.authMode).toBe("none");
    expect(result.etag).toBeNull();
    expect(result.identity).toBeNull();
    expect(result.observation).toBeNull();
    expect(calls[0]?.ifNoneMatch).toBeNull(); // non-cycle route sends no conditional header
  });

  test("a history route 200 returns ok with null cycle metadata", async () => {
    const { fetchImpl } = queuedFetch([
      new Response(JSON.stringify({ series: [] }), { status: 200 }),
    ]);
    const result = await apiFetch("/api/history/estate/estate.liveness?range=1h", undefined, fetchImpl);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.observation).toBeNull();
  });

  test("a history route error envelope is still validated and returned", async () => {
    const { fetchImpl } = queuedFetch([
      new Response(JSON.stringify({ code: "HISTORY_OVERLOADED", message: "History capacity is temporarily exhausted." }), { status: 503 }),
    ]);
    const result = await apiFetch("/api/history/alerts", undefined, fetchImpl);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.code).toBe("HISTORY_OVERLOADED");
    expect(result.httpStatus).toBe(503);
  });
});
