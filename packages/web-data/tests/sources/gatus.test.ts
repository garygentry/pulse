/** gatus.test.ts — evidence for item 016 (03-source-clients-and-validation.md §8).
 *  Covers the Gatus source client:
 *   - endpointStatuses always issues exactly one `page=1&pageSize=512` request independent of
 *     estate size/viewers (criterion 1);
 *   - complete attempts succeed through 511 expected endpoints and fail wholly at 512 returned
 *     rows, expected count ≥512, a missing expected identity, a duplicate identity/key, or a
 *     malformed nested result (criterion 2);
 *   - all valid recent status results are retained; endpointHistory is exact-key, bounded,
 *     complete, and cancellable through body reading (criterion 3);
 *   - boundary and recovery fixtures cover service, probe-only-host, and domain endpoint
 *     identity with no subset salvage (criterion 4).
 *
 * Pure module: no DOM registration required. Fixtures are read from tests/fixtures/gatus/**.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "../../src/sources/types.js";
import { createGatusClient, GATUS_HISTORY_PAGE_SIZE } from "../../src/sources/gatus.js";
import { SourceConfigError } from "../../src/sources/fetch.js";
import { GATUS_STATUS_PAGE_SIZE, GATUS_MAX_ENDPOINTS } from "../../src/wire/common.js";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "gatus");
const BASE = "http://gatus.internal:8080";

/** Read a pinned fixture file as text. */
function fixtureText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf-8");
}

/** A fetch serving a fixture body, capturing the request URL and init it received. */
function fetchFromFixture(
  name: string,
  status = 200,
): { fetchImpl: FetchLike; url: () => string; calls: () => number } {
  let capturedUrl = "";
  let count = 0;
  const fetchImpl: FetchLike = (input) => {
    capturedUrl = input.toString();
    count += 1;
    return Promise.resolve(new Response(fixtureText(name), { status }));
  };
  return { fetchImpl, url: () => capturedUrl, calls: () => count };
}

/** A fetch serving a raw JSON string body, capturing the request URL and call count. */
function fetchReturning(body: string, status = 200): { fetchImpl: FetchLike; url: () => string; calls: () => number } {
  let capturedUrl = "";
  let count = 0;
  const fetchImpl: FetchLike = (input) => {
    capturedUrl = input.toString();
    count += 1;
    return Promise.resolve(new Response(body, { status }));
  };
  return { fetchImpl, url: () => capturedUrl, calls: () => count };
}

/** A fetch that never resolves until aborted, then rejects like a real aborted fetch. */
const hangingFetch: FetchLike = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

/**
 * A fetch that returns a 200 Response whose body stream enqueues one chunk and then stalls,
 * erroring the stream when the request signal aborts — as a real fetch does. This exercises
 * cancellation reaching the streamed body reader (`readBounded`'s read loop), which
 * `hangingFetch` (rejecting at the fetch stage, before a Response exists) cannot.
 */
const streamingAbortFetch: FetchLike = (_input, init) => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('[{"name":"e",'));
      init?.signal?.addEventListener(
        "abort",
        () => controller.error(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    },
  });
  return Promise.resolve(new Response(stream, { status: 200 }));
};

/** Build a synthetic statuses page of `n` distinct endpoints. */
function syntheticPage(n: number): string {
  const rows = Array.from({ length: n }, (_, i) => ({
    name: `harbor-host-${i}/svc`,
    group: `harbor-host-${i}`,
    key: `harbor-host-${i}_svc`,
    results: [{ success: true, timestamp: "2025-12-31T23:59:30.000Z", duration: 100000000, status: 200 }],
  }));
  return JSON.stringify(rows);
}

/** The expected identities matching a synthetic page of `n` endpoints. */
function syntheticExpected(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `harbor-host-${i}/svc`);
}

describe("createGatusClient — factory validation", () => {
  test("fails closed on a credential-bearing or non-HTTP(S) base URL", () => {
    expect(() => createGatusClient("http://user:pw@gatus:8080")).toThrow(SourceConfigError);
    expect(() => createGatusClient("ftp://gatus:8080")).toThrow(SourceConfigError);
    expect(() => createGatusClient("not a url")).toThrow(SourceConfigError);
  });
});

describe("endpointStatuses — exact request (criterion 1)", () => {
  test("always issues exactly one page=1&pageSize=512 GET regardless of expected size", async () => {
    for (const expected of [[], syntheticExpected(3), syntheticExpected(400)]) {
      const f = fetchFromFixture("statuses-success.json");
      await createGatusClient(BASE, { fetchImpl: f.fetchImpl }).endpointStatuses(expected);
      const url = new URL(f.url());
      expect(url.pathname).toBe("/api/v1/endpoints/statuses");
      expect(url.searchParams.get("page")).toBe("1");
      expect(url.searchParams.get("pageSize")).toBe(String(GATUS_STATUS_PAGE_SIZE));
      expect(f.calls()).toBe(1);
    }
  });
});

describe("endpointStatuses — retention and identity kinds (criteria 3/4)", () => {
  test("retains name/group/key, all recent results, and all three identity kinds", async () => {
    const f = fetchFromFixture("statuses-success.json");
    const result = await createGatusClient(BASE, { fetchImpl: f.fetchImpl }).endpointStatuses([]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const byName = new Map(result.data.map((e) => [e.name, e]));

    // Service endpoint: two retained results, condition results preserved.
    const service = byName.get("harbor-web-01/portal-web");
    expect(service?.group).toBe("harbor-web-01");
    expect(service?.key).toBe("harbor-web-01_portal-web");
    expect(service?.identity).toBe("harbor-web-01/portal-web");
    expect(service?.results.length).toBe(2);
    expect(service?.results[0]?.durationMs).toBe(122);
    expect(service?.results[0]?.conditionResults[0]?.condition).toBe("[STATUS] == 200");

    // Probe-only host + domain identity kinds present.
    expect(byName.has("host:harbor-edge-01")).toBe(true);
    expect(byName.get("host:harbor-edge-01")?.results[1]?.success).toBe(false);
    expect(byName.has("dns:nimbus.example")).toBe(true);

    // Unexpected identities are retained but explicitly attributed as not expected.
    for (const e of result.data) expect(e.expected).toBe(false);
  });

  test("flags matched expected identities and rejects a missing expected identity", async () => {
    const present = ["harbor-web-01/portal-web", "host:harbor-edge-01", "dns:nimbus.example"];
    const ok = await createGatusClient(BASE, {
      fetchImpl: fetchFromFixture("statuses-success.json").fetchImpl,
    }).endpointStatuses(present);
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("unreachable");
    for (const e of ok.data) expect(e.expected).toBe(true);

    const missing = await createGatusClient(BASE, {
      fetchImpl: fetchFromFixture("statuses-success.json").fetchImpl,
    }).endpointStatuses([...present, "host:absent-host"]);
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("unreachable");
    expect(missing.error.kind).toBe("overflow");
  });
});

describe("endpointStatuses — completeness boundaries (criterion 2)", () => {
  test("succeeds through 511 expected endpoints", async () => {
    const f = fetchReturning(syntheticPage(GATUS_MAX_ENDPOINTS));
    const result = await createGatusClient(BASE, { fetchImpl: f.fetchImpl }).endpointStatuses(
      syntheticExpected(GATUS_MAX_ENDPOINTS),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.length).toBe(GATUS_MAX_ENDPOINTS);
    expect(result.data.every((e) => e.expected)).toBe(true);
  });

  test("fails wholly with overflow when the page is saturated at 512 rows", async () => {
    const f = fetchReturning(syntheticPage(GATUS_STATUS_PAGE_SIZE));
    const result = await createGatusClient(BASE, { fetchImpl: f.fetchImpl }).endpointStatuses([]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("overflow");
  });

  test("fails wholly with overflow when the expected count is at least 512", async () => {
    const f = fetchReturning(syntheticPage(3));
    const result = await createGatusClient(BASE, { fetchImpl: f.fetchImpl }).endpointStatuses(
      syntheticExpected(GATUS_STATUS_PAGE_SIZE),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("overflow");
  });

  test("fails wholly with overflow on a duplicate identity/key with no subset salvage", async () => {
    const f = fetchFromFixture("statuses-duplicate.json");
    const result = await createGatusClient(BASE, { fetchImpl: f.fetchImpl }).endpointStatuses([]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("overflow");
    // No partial data is exposed on the failure result.
    expect("data" in result).toBe(false);
  });

  test("fails wholly with overflow on a duplicate KEY under distinct identities", async () => {
    // Distinct names but a shared Gatus key exercises the `seenKey` overflow branch (the
    // duplicate fixture covers the `seenIdentity`/name branch); "duplicate identity/key"
    // must reject on either. No subset is salvaged.
    const body = JSON.stringify([
      { name: "harbor-a/svc", group: "harbor-a", key: "shared_key", results: [] },
      { name: "harbor-b/svc", group: "harbor-b", key: "shared_key", results: [] },
    ]);
    const result = await createGatusClient(BASE, {
      fetchImpl: fetchReturning(body).fetchImpl,
    }).endpointStatuses([]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("overflow");
    expect("data" in result).toBe(false);
  });
});

describe("endpointStatuses — malformed shape (criterion 2)", () => {
  test.each([
    ["statuses-malformed-top.json", "non-array body"],
    ["statuses-malformed-endpoint.json", "missing key"],
    ["statuses-malformed-nested.json", "unparseable result timestamp"],
  ])("fails the whole operation with invalid-shape: %s (%s)", async (name) => {
    const result = await createGatusClient(BASE, {
      fetchImpl: fetchFromFixture(name).fetchImpl,
    }).endpointStatuses([]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });
});

describe("endpointHistory — exact key, completeness, and cancellation (criterion 3)", () => {
  test("issues the pinned per-endpoint history GET with the encoded key and returns all results", async () => {
    const f = fetchFromFixture("endpoint-history-success.json");
    const result = await createGatusClient(BASE, { fetchImpl: f.fetchImpl }).endpointHistory(
      "harbor-web-01_portal-web",
    );
    const url = new URL(f.url());
    expect(url.pathname).toBe("/api/v1/endpoints/harbor-web-01_portal-web/statuses");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.key).toBe("harbor-web-01_portal-web");
    // Every valid result is returned (no range/600 truncation — that is the history service).
    expect(result.data.results.length).toBe(3);
    expect(result.data.results[1]?.success).toBe(false);
    expect(result.data.results[1]?.durationMs).toBe(5000);
  });

  test("percent-encodes a key with reserved characters into one path segment", async () => {
    const f = fetchReturning(fixtureText("endpoint-history-success.json"));
    await createGatusClient(BASE, { fetchImpl: f.fetchImpl }).endpointHistory("group/name with space");
    const url = new URL(f.url());
    expect(url.pathname).toBe("/api/v1/endpoints/group%2Fname%20with%20space/statuses");
  });

  test("keeps a literal ':' in the key segment (Gatus does not decode %3A)", async () => {
    const f = fetchReturning(fixtureText("endpoint-history-success.json"));
    await createGatusClient(BASE, { fetchImpl: f.fetchImpl }).endpointHistory("_dns:status-example-com");
    const url = new URL(f.url());
    expect(url.pathname).toBe("/api/v1/endpoints/_dns:status-example-com/statuses");
  });

  test("requests every retained result: page=1&pageSize=100 (Gatus defaults to 20)", async () => {
    const f = fetchReturning(fixtureText("endpoint-history-success.json"));
    await createGatusClient(BASE, { fetchImpl: f.fetchImpl }).endpointHistory("e_k");
    const url = new URL(f.url());
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("pageSize")).toBe(String(GATUS_HISTORY_PAGE_SIZE));
    expect(GATUS_HISTORY_PAGE_SIZE).toBe(100);
  });

  test("rejects an empty or control-bearing key as invalid-shape before any request", async () => {
    for (const bad of ["", "has null", "line\nbreak"]) {
      const f = fetchReturning("{}");
      const result = await createGatusClient(BASE, { fetchImpl: f.fetchImpl }).endpointHistory(bad);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.kind).toBe("invalid-shape");
      expect(f.calls()).toBe(0);
    }
  });

  test("fails with invalid-shape on a malformed nested history result", async () => {
    const body = JSON.stringify({
      name: "e",
      key: "e_k",
      results: [{ success: true, timestamp: "nope", duration: 1 }],
    });
    const result = await createGatusClient(BASE, {
      fetchImpl: fetchReturning(body).fetchImpl,
    }).endpointHistory("e_k");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });

  test("an already-aborted caller signal cancels before fetching (transport)", async () => {
    let called = false;
    const fetchImpl: FetchLike = () => {
      called = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const controller = new AbortController();
    controller.abort();
    const result = await createGatusClient(BASE, { fetchImpl }).endpointHistory("e_k", {
      signal: controller.signal,
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("transport");
  });

  test("forwards a mid-flight caller abort through the history fetch/body reading (transport)", async () => {
    const controller = new AbortController();
    const promise = createGatusClient(BASE, { fetchImpl: hangingFetch }).endpointHistory("e_k", {
      signal: controller.signal,
    });
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("transport");
  });

  test("forwards a caller abort through the STREAMED history body reader (transport)", async () => {
    // Cancellation reaches the response-body read loop after headers are received, not just the
    // fetch stage — the exact "cancellable through body reading" path for endpointHistory.
    const controller = new AbortController();
    const promise = createGatusClient(BASE, { fetchImpl: streamingAbortFetch }).endpointHistory(
      "e_k",
      { signal: controller.signal },
    );
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("transport");
    expect("data" in result).toBe(false);
  });
});

describe("recovery, additive tolerance, and fixture hygiene (criteria 1/4)", () => {
  test("additive unknown fields pass and are stripped from the closed value", async () => {
    const result = await createGatusClient(BASE, {
      fetchImpl: fetchFromFixture("statuses-additive.json").fetchImpl,
    }).endpointStatuses([]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const endpoint = result.data[0];
    expect(Object.keys(endpoint ?? {}).sort()).toEqual([
      "expected",
      "group",
      "identity",
      "key",
      "name",
      "results",
    ]);
    expect(Object.keys(endpoint?.results[0] ?? {}).sort()).toEqual([
      "conditionResults",
      "durationMs",
      "success",
      "timestamp",
    ]);
  });

  test("a non-2xx failure never rejects and a later success recovers", async () => {
    const failing = createGatusClient(BASE, { fetchImpl: fetchReturning("upstream boom", 503).fetchImpl });
    const failure = await failing.endpointStatuses([]);
    expect(failure.ok).toBe(false);
    if (failure.ok) throw new Error("unreachable");
    expect(failure.error.kind).toBe("upstream-status");
    expect(failure.error.status).toBe(503);

    const recovered = createGatusClient(BASE, { fetchImpl: fetchFromFixture("statuses-success.json").fetchImpl });
    expect((await recovered.endpointStatuses([])).ok).toBe(true);
  });

  test("no pinned gatus fixture leaks credentials or authorization headers", () => {
    const names = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".json"));
    expect(names.length).toBeGreaterThanOrEqual(7);
    for (const name of names) {
      const text = fixtureText(name);
      expect(text.toLowerCase()).not.toContain("authorization");
      expect(text.toLowerCase()).not.toContain("password");
      expect(text.toLowerCase()).not.toContain("secret");
      expect(text).not.toContain("@");
    }
  });
});
