// apps/web/tests/sources.test.ts — the three engine-source clients (03-engine-sources.md).
//
// Every case injects a mock `fetch` (no real network): asserts each client issues exactly one
// aggregate request per cycle to its frozen URL, parses the real engine wire shapes
// (VM instant-query vector, Alertmanager v0.27.0 `/api/v2/alerts` array, Gatus
// `/api/v1/endpoints/statuses` array) into the build-input types, enforces the 5s
// `SOURCE_TIMEOUT_MS` via `AbortSignal` (simulated — no real wait), and captures every failure
// (timeout / non-200 / malformed JSON / mis-shaped body / network) into an error `SourceResult`
// without ever throwing (REQ-LIVE-04 failure isolation).

import { describe, expect, test } from "bun:test";

import { SOURCE_TIMEOUT_MS } from "../src/shared/constants.js";
import type { FetchLike } from "../src/server/sources/types.js";
import {
  createVmClient,
  createAlertmanagerClient,
  createGatusClient,
} from "../src/server/sources/index.js";

// ── Mock-fetch helpers ───────────────────────────────────────────────────────────────────────

/** Record of one intercepted request. */
interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A JSON-body 200 response mock. Records every call into `calls`. */
function jsonFetch(body: unknown, calls: Call[]): FetchLike {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchLike;
}

/** A non-2xx response mock. */
function statusFetch(status: number, statusText: string): FetchLike {
  return (async () =>
    new Response("nope", { status, statusText })) as unknown as FetchLike;
}

/** A 200 response whose body is not valid JSON (truncated / HTML). */
function malformedFetch(): FetchLike {
  return (async () =>
    new Response("<html>not json", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as unknown as FetchLike;
}

/** A network-failure mock (connection refused): Bun's fetch throws a TypeError. */
function networkErrorFetch(): FetchLike {
  return (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as FetchLike;
}

/**
 * A fetch that simulates the `AbortSignal.timeout` firing — WITHOUT any real wait. It records the
 * `init.signal` it was handed (so we can assert an `AbortSignal` was actually wired) and then rejects
 * with the exact `DOMException` shape `AbortSignal.timeout(...)` produces on expiry.
 */
function timeoutFetch(seen: { signal?: AbortSignal | null | undefined }): FetchLike {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.signal = init?.signal;
    throw new DOMException("The operation timed out.", "TimeoutError");
  }) as unknown as FetchLike;
}

// ── The 5s timeout is enforced via AbortSignal (no real wait) ──────────────────────────────────

describe("fetchJson timeout enforcement (SOURCE_TIMEOUT_MS via AbortSignal)", () => {
  test("SOURCE_TIMEOUT_MS is 5s", () => {
    expect(SOURCE_TIMEOUT_MS).toBe(5_000);
  });

  test("every client wires an AbortSignal and maps a timeout to an error SourceResult", async () => {
    const seen: { signal?: AbortSignal | null } = {};
    const vm = createVmClient("http://vm:8428", timeoutFetch(seen));
    const res = await vm.queryLiveness();

    // The signal handed to fetch is a real AbortSignal — the 5s bound is enforced through it.
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    // The timeout DOMException is captured, never thrown, and names the 5s bound.
    expect(res).toEqual({ ok: false, error: "request timed out after 5000ms" });
  });

  test("Alertmanager and Gatus clients map a timeout identically without throwing", async () => {
    const am = await createAlertmanagerClient("http://am:9093", timeoutFetch({})).activeAlerts();
    const gatus = await createGatusClient("http://gatus:8080", timeoutFetch({})).endpointStatuses();
    expect(am).toEqual({ ok: false, error: "request timed out after 5000ms" });
    expect(gatus).toEqual({ ok: false, error: "request timed out after 5000ms" });
  });
});

// ── VictoriaMetrics client ─────────────────────────────────────────────────────────────────────

describe("createVmClient", () => {
  const VECTOR_BODY = {
    status: "success",
    data: {
      resultType: "vector",
      result: [
        { metric: { __name__: "up", job: "node", instance: "nas01:9100", host: "nas01" }, value: [1_700_000_000, "1"] },
        { metric: { __name__: "pulse_agent_up", host: "nas01" }, value: [1_700_000_000, "1"] },
        { metric: { __name__: "pulse_deep_health_up", host: "web01", service: "grafana" }, value: [1_700_000_000, "0"] },
      ],
    },
  };

  test("issues exactly one GET to the frozen liveness-union query and splits __name__ out of labels", async () => {
    const calls: Call[] = [];
    const vm = createVmClient("http://victoriametrics:8428", jsonFetch(VECTOR_BODY, calls));
    const res = await vm.queryLiveness();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://victoriametrics:8428/api/v1/query?query=up+or+pulse_agent_up+or+pulse_deep_health_up",
    );
    expect(calls[0]!.init?.method).toBe("GET");

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual([
      { name: "up", labels: { job: "node", instance: "nas01:9100", host: "nas01" }, value: 1 },
      { name: "pulse_agent_up", labels: { host: "nas01" }, value: 1 },
      { name: "pulse_deep_health_up", labels: { host: "web01", service: "grafana" }, value: 0 },
    ]);
  });

  test("trims a trailing slash on the injected base URL", async () => {
    const calls: Call[] = [];
    await createVmClient("http://vm:8428/", jsonFetch(VECTOR_BODY, calls)).queryLiveness();
    expect(calls[0]!.url).toBe(
      "http://vm:8428/api/v1/query?query=up+or+pulse_agent_up+or+pulse_deep_health_up",
    );
  });

  test("an empty vector is a success with data: [] (healthy engine, no series yet)", async () => {
    const body = { status: "success", data: { resultType: "vector", result: [] } };
    const res = await createVmClient("http://vm:8428", jsonFetch(body, [])).queryLiveness();
    expect(res).toEqual({ ok: true, data: [] });
  });

  test("a status:error body is captured as a shape error (does not throw)", async () => {
    const body = { status: "error", errorType: "422", error: "bad query" };
    const res = await createVmClient("http://vm:8428", jsonFetch(body, [])).queryLiveness();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error).toBe("unexpected VM response shape: bad query");
  });
});

// ── Alertmanager client (v0.27.0 GET /api/v2/alerts array shape) ────────────────────────────────

describe("createAlertmanagerClient", () => {
  // The v0.27.0 GettableAlert array shape (§4 WARNING) — includes the always-firing DeadMansSwitch,
  // which this client passes through raw (04 drops it, not here).
  const AM_BODY = [
    {
      labels: { alertname: "HostDown", severity: "critical", estate: "home", host: "nas01" },
      annotations: { summary: "nas01 is unreachable" },
      startsAt: "2026-08-22T11:59:00.000Z",
      endsAt: "2026-08-22T12:10:00.000Z",
      status: { state: "active" },
      fingerprint: "abc123",
      receivers: [{ name: "default" }],
    },
    {
      labels: { alertname: "DeadMansSwitch", severity: "none", estate: "home" },
      startsAt: "2026-08-22T00:00:00.000Z",
      status: { state: "active" },
    },
  ];

  test("issues exactly one GET to the frozen v2 filter and parses the array into RawActiveAlert", async () => {
    const calls: Call[] = [];
    const am = createAlertmanagerClient("http://alertmanager:9093", jsonFetch(AM_BODY, calls));
    const res = await am.activeAlerts();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://alertmanager:9093/api/v2/alerts?active=true&silenced=false&inhibited=false",
    );
    expect(calls[0]!.init?.method).toBe("GET");

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // Raw pass-through: labels/annotations/startsAt only; the DeadMansSwitch is NOT filtered here.
    expect(res.data).toEqual([
      {
        fingerprint: "abc123",
        labels: { alertname: "HostDown", severity: "critical", estate: "home", host: "nas01" },
        annotations: { summary: "nas01 is unreachable" },
        startsAt: "2026-08-22T11:59:00.000Z",
      },
      {
        fingerprint: "",
        labels: { alertname: "DeadMansSwitch", severity: "none", estate: "home" },
        annotations: {},
        startsAt: "2026-08-22T00:00:00.000Z",
      },
    ]);
  });

  test("a missing annotations field defaults to an empty object", async () => {
    const res = await createAlertmanagerClient(
      "http://am:9093",
      jsonFetch([{ labels: { alertname: "X" }, startsAt: "2026-08-22T12:00:00.000Z" }], []),
    ).activeAlerts();
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data[0]!.annotations).toEqual({});
  });

  test("a non-array body is captured as a shape error (does not throw)", async () => {
    const res = await createAlertmanagerClient(
      "http://am:9093",
      jsonFetch({ not: "an array" }, []),
    ).activeAlerts();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error).toBe("unexpected Alertmanager response shape: expected a JSON array of alerts");
  });
});

// ── Gatus client (GET /api/v1/endpoints/statuses array shape) ───────────────────────────────────

describe("createGatusClient", () => {
  const GATUS_BODY = [
    {
      name: "web01/grafana",
      group: "web01",
      key: "web01_web01-grafana",
      results: [
        { success: false, timestamp: "2026-08-22T11:58:00.000Z", duration: 5_000_000 },
        { success: true, timestamp: "2026-08-22T11:59:30.000Z", duration: 12_345_678, status: 200 },
      ],
    },
    { name: "dns:example.com", results: [] }, // declared but never evaluated → latest: null
  ];

  test("issues exactly one GET to the frozen path and reduces each endpoint to its latest, preserving name", async () => {
    const calls: Call[] = [];
    const gatus = createGatusClient("http://gatus:8080", jsonFetch(GATUS_BODY, calls));
    const res = await gatus.endpointStatuses();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://gatus:8080/api/v1/endpoints/statuses");
    expect(calls[0]!.init?.method).toBe("GET");

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual([
      {
        name: "web01/grafana",
        group: "web01",
        // latest = the LAST results element; Go ns → ms (12_345_678 / 1e6 ≈ 12).
        latest: { success: true, timestamp: "2026-08-22T11:59:30.000Z", durationMs: 12 },
      },
      { name: "dns:example.com", latest: null },
    ]);
    // The endpoint name is preserved verbatim (the identity convention 04 parses).
    expect(res.data.map((c) => c.name)).toEqual(["web01/grafana", "dns:example.com"]);
  });

  test("a non-array body is captured as a shape error (does not throw)", async () => {
    const res = await createGatusClient(
      "http://gatus:8080",
      jsonFetch({ not: "an array" }, []),
    ).endpointStatuses();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error).toBe(
      "unexpected Gatus response shape: expected a JSON array of endpoint statuses",
    );
  });
});

// ── Cross-cutting failure isolation (REQ-LIVE-04) ───────────────────────────────────────────────

describe("failure isolation — every transport fault becomes an error SourceResult, never a throw", () => {
  test("non-200 → HTTP error string", async () => {
    const res = await createVmClient("http://vm:8428", statusFetch(422, "Unprocessable Entity")).queryLiveness();
    expect(res).toEqual({ ok: false, error: "HTTP 422 Unprocessable Entity" });
  });

  test("malformed JSON body → malformed-JSON error string", async () => {
    const res = await createGatusClient("http://gatus:8080", malformedFetch()).endpointStatuses();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error).toMatch(/^malformed JSON response:/);
  });

  test("network failure → the thrown TypeError's message", async () => {
    const res = await createAlertmanagerClient("http://am:9093", networkErrorFetch()).activeAlerts();
    expect(res).toEqual({ ok: false, error: "fetch failed" });
  });

  test("one failing source does not poison the other two (per-source isolation)", async () => {
    // VM ok, Alertmanager failing, Gatus ok — all three resolve; only AM is an error.
    const vm = await createVmClient(
      "http://vm:8428",
      jsonFetch({ status: "success", data: { resultType: "vector", result: [] } }, []),
    ).queryLiveness();
    const am = await createAlertmanagerClient("http://am:9093", networkErrorFetch()).activeAlerts();
    const gatus = await createGatusClient("http://gatus:8080", jsonFetch([], [])).endpointStatuses();

    expect(vm.ok).toBe(true);
    expect(am.ok).toBe(false);
    expect(gatus.ok).toBe(true);
  });
});

// ── Aggregate-request guarantee (REQ-PERF-03) ───────────────────────────────────────────────────

describe("aggregate O(1) request count", () => {
  test("one cycle issues exactly three engine requests regardless of estate size", async () => {
    const calls: Call[] = [];
    const vmBody = {
      status: "success",
      data: {
        resultType: "vector",
        // A 100-host fixture — the client must NOT fan out per host.
        result: Array.from({ length: 100 }, (_, i) => ({
          metric: { __name__: "pulse_agent_up", host: `h${i}` },
          value: [1_700_000_000, "1"],
        })),
      },
    };
    const vm = createVmClient("http://vm:8428", jsonFetch(vmBody, calls));
    const am = createAlertmanagerClient("http://am:9093", jsonFetch([], calls));
    const gatus = createGatusClient("http://gatus:8080", jsonFetch([], calls));

    await Promise.all([vm.queryLiveness(), am.activeAlerts(), gatus.endpointStatuses()]);

    expect(calls).toHaveLength(3); // exactly three — O(1) in estate size
  });
});
