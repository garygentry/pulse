/** vm.test.ts — evidence for item 011 (03-source-clients-and-validation.md §5).
 *  Covers the VictoriaMetrics client:
 *   - each method issues the exact fixed method/path/query and returns a typed SourceResult
 *     without normal rejection (criterion 1);
 *   - the instant union contains all seven engine projections and parsing retains unique
 *     aliases despite colliding non-name labels (criterion 2);
 *   - missing/NaN/non-finite/absent projections stay unavailable (null) rather than zero,
 *     while malformed consumed structure fails the whole operation (criterion 3);
 *   - pinned success/additive/malformed fixtures cover vector, matrix, targets, buildinfo,
 *     cancellation, and recovery without sensitive values (criterion 4).
 *
 * Pure module: no DOM registration required. Fixtures are read from tests/fixtures/vm/**.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "../../src/sources/types.js";
import { createVmClient, buildStatusUnionQuery } from "../../src/sources/vm.js";
import { SourceConfigError } from "../../src/sources/fetch.js";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "vm");
const BASE = "http://victoriametrics.internal:8428";

/** Read a pinned fixture file as text. */
function fixtureText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf-8");
}

/** A fetch that serves a fixture body, capturing the request URL and init it received. */
function fetchFromFixture(
  name: string,
  status = 200,
): { fetchImpl: FetchLike; url: () => string; init: () => RequestInit | undefined } {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchImpl: FetchLike = (input, init) => {
    capturedUrl = input.toString();
    capturedInit = init;
    return Promise.resolve(new Response(fixtureText(name), { status }));
  };
  return { fetchImpl, url: () => capturedUrl, init: () => capturedInit };
}

/** A fetch returning a raw body (for status/recovery cases). */
function fetchReturning(body: string, status: number): { fetchImpl: FetchLike; url: () => string } {
  let capturedUrl = "";
  const fetchImpl: FetchLike = (input) => {
    capturedUrl = input.toString();
    return Promise.resolve(new Response(body, { status }));
  };
  return { fetchImpl, url: () => capturedUrl };
}

/** A fetch that never resolves until aborted, then rejects like a real aborted fetch. */
const hangingFetch: FetchLike = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

describe("createVmClient — factory validation", () => {
  test("fails closed on a credential-bearing or non-HTTP(S) base URL", () => {
    expect(() => createVmClient("http://user:pw@vm:8428")).toThrow(SourceConfigError);
    expect(() => createVmClient("ftp://vm:8428")).toThrow(SourceConfigError);
    expect(() => createVmClient("not a url")).toThrow(SourceConfigError);
  });
});

describe("buildStatusUnionQuery — fixed instant union (criterion 2)", () => {
  const query = buildStatusUnionQuery();
  const ALIASES = [
    "pulse_web_engine_ingestion_rows_per_second",
    "pulse_web_engine_hourly_active_series",
    "pulse_web_engine_data_bytes",
    "pulse_web_engine_free_disk_bytes",
    "pulse_web_engine_notification_failures_per_second",
    "pulse_web_engine_notification_latency_p95_seconds",
    "pulse_web_engine_process_start_seconds",
  ];

  test("preserves the existing status selectors at the head", () => {
    expect(query.startsWith("up or pulse_agent_up or pulse_deep_health_up")).toBe(true);
  });

  test("adds bounded declared overview metrics deterministically without duplicating status selectors", () => {
    const expanded = buildStatusUnionQuery([
      "pulse_config_drift_count", "pulse_backup_freshness_age_seconds", "pulse_config_drift_count",
      "up", "invalid metric",
    ]);
    expect(expanded).toContain("pulse_backup_freshness_age_seconds or on (__name__) pulse_config_drift_count");
    expect(expanded.match(/pulse_config_drift_count/g)).toHaveLength(1);
    expect(expanded).not.toContain("invalid metric");
  });

  test("contains all seven aliases wrapped in label_replace and joined with `or on (__name__)`", () => {
    for (const alias of ALIASES) {
      expect(query).toContain(`"__name__", "${alias}", "job", ".*"`);
    }
    // status head + 7 projections => 7 join operators.
    expect(query.split(" or on (__name__) ")).toHaveLength(8);
    expect((query.match(/label_replace\(/g) ?? [])).toHaveLength(7);
  });
});

describe("statusSignals — exact request and vector parsing", () => {
  test("issues one GET /api/v1/query with the fixed union and returns typed samples", async () => {
    const fx = fetchFromFixture("instant-success.json");
    const client = createVmClient(BASE, { fetchImpl: fx.fetchImpl });
    const result = await client.statusSignals();

    const url = new URL(fx.url());
    expect(fx.init()?.method).toBe("GET");
    expect(url.pathname).toBe("/api/v1/query");
    expect(url.searchParams.get("query")).toBe(buildStatusUnionQuery());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toHaveLength(11);
  });

  test("retains both colliding aliases and strips __name__ into projection", async () => {
    const client = createVmClient(BASE, { fetchImpl: fetchFromFixture("instant-success.json").fetchImpl });
    const result = await client.statusSignals();
    if (!result.ok) throw new Error("unreachable");

    const byProjection = new Map(result.data.map((s) => [s.projection, s]));
    // data_bytes and free_disk_bytes both have empty non-name labels (they collide) yet
    // both survive because their aliases differ.
    const dataBytes = byProjection.get("pulse_web_engine_data_bytes");
    const freeDisk = byProjection.get("pulse_web_engine_free_disk_bytes");
    expect(dataBytes).toBeDefined();
    expect(freeDisk).toBeDefined();
    expect(dataBytes?.metric).toEqual({});
    expect(freeDisk?.metric).toEqual({});
    expect(dataBytes?.value).toBe(10737418240);
    expect(freeDisk?.value).toBe(53687091200);
    // __name__ never leaks into the label record.
    for (const sample of result.data) {
      expect("__name__" in sample.metric).toBe(false);
    }
  });

  test("NaN and non-finite samples remain unavailable (null), never zero", async () => {
    const client = createVmClient(BASE, { fetchImpl: fetchFromFixture("instant-success.json").fetchImpl });
    const result = await client.statusSignals();
    if (!result.ok) throw new Error("unreachable");
    const byProjection = new Map(result.data.map((s) => [s.projection, s]));
    expect(byProjection.get("pulse_web_engine_notification_failures_per_second")?.value).toBeNull();
    expect(byProjection.get("pulse_web_engine_notification_latency_p95_seconds")?.value).toBeNull();
    // A present finite projection is preserved with its timestamp.
    const ingestion = byProjection.get("pulse_web_engine_ingestion_rows_per_second");
    expect(ingestion?.value).toBe(1234.5);
    expect(ingestion?.timestampMs).toBe(1726450000000);
  });

  test("insufficient-window (empty value) and every non-finite token stay unavailable (null), never zero", async () => {
    const client = createVmClient(BASE, { fetchImpl: fetchFromFixture("instant-unavailable.json").fetchImpl });
    const result = await client.statusSignals();
    if (!result.ok) throw new Error("unreachable");
    const byProjection = new Map(result.data.map((s) => [s.projection, s.value]));
    // Empty string = insufficient-window/insufficient-rate → unavailable, distinct from a real 0.
    expect(byProjection.get("pulse_web_engine_ingestion_rows_per_second")).toBeNull();
    // NaN, +Inf, and -Inf (both non-finite directions) all collapse to unavailable.
    expect(byProjection.get("pulse_web_engine_hourly_active_series")).toBeNull();
    expect(byProjection.get("pulse_web_engine_notification_failures_per_second")).toBeNull();
    expect(byProjection.get("pulse_web_engine_free_disk_bytes")).toBeNull();
    // A genuine "0" is preserved as the number 0, proving unavailable never masquerades as zero.
    expect(byProjection.get("pulse_web_engine_data_bytes")).toBe(0);
  });

  test("accepts additive unknown fields and strips them; absent projections simply do not appear", async () => {
    const client = createVmClient(BASE, { fetchImpl: fetchFromFixture("instant-additive.json").fetchImpl });
    const result = await client.statusSignals();
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toHaveLength(2);
    const projections = result.data.map((s) => s.projection);
    expect(projections).toContain("pulse_web_engine_data_bytes");
    // Absent projections are unavailable by absence, not zeroed.
    expect(projections).not.toContain("pulse_web_engine_free_disk_bytes");
  });

  test("malformed top-level and malformed consumed nested field fail the whole operation", async () => {
    const top = createVmClient(BASE, { fetchImpl: fetchFromFixture("instant-malformed-top.json").fetchImpl });
    const topResult = await top.statusSignals();
    expect(topResult.ok).toBe(false);
    if (topResult.ok) throw new Error("unreachable");
    expect(topResult.error.kind).toBe("invalid-shape");

    const nested = createVmClient(BASE, { fetchImpl: fetchFromFixture("instant-malformed-nested.json").fetchImpl });
    const nestedResult = await nested.statusSignals();
    expect(nestedResult.ok).toBe(false);
    if (nestedResult.ok) throw new Error("unreachable");
    expect(nestedResult.error.kind).toBe("invalid-shape");
  });
});

describe("targets — exact request and validation", () => {
  test("issues one GET /api/v1/targets and maps scrape targets, stripping empty errors", async () => {
    const fx = fetchFromFixture("targets-success.json");
    const client = createVmClient(BASE, { fetchImpl: fx.fetchImpl });
    const result = await client.targets();

    expect(fx.init()?.method).toBe("GET");
    expect(new URL(fx.url()).pathname).toBe("/api/v1/targets");
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toEqual({
      job: "victoriametrics",
      instance: "harbor-1:8428",
      scrapeUrl: "http://harbor-1:8428/metrics",
      health: "up",
      lastScrapeAt: "2026-09-16T00:00:00.000Z",
      lastError: null,
    });
    expect(result.data[1]?.health).toBe("down");
    expect(result.data[1]?.lastError).toBe("connection refused");
  });

  test("accepts additive fields; missing consumed nested field fails the whole operation", async () => {
    const additive = createVmClient(BASE, { fetchImpl: fetchFromFixture("targets-additive.json").fetchImpl });
    const additiveResult = await additive.targets();
    expect(additiveResult.ok).toBe(true);

    const malformed = createVmClient(BASE, { fetchImpl: fetchFromFixture("targets-malformed-nested.json").fetchImpl });
    const malformedResult = await malformed.targets();
    expect(malformedResult.ok).toBe(false);
    if (malformedResult.ok) throw new Error("unreachable");
    expect(malformedResult.error.kind).toBe("invalid-shape");
  });

  test("strips credentials from a scrape URL", async () => {
    const body = JSON.stringify({
      status: "success",
      data: {
        activeTargets: [
          {
            labels: { job: "node", instance: "harbor-9:9100" },
            scrapeUrl: "http://scraper:SECRET_PW@harbor-9:9100/metrics",
            lastError: "",
            lastScrape: "2026-09-16T00:00:00.000Z",
            health: "up",
          },
        ],
      },
    });
    const client = createVmClient(BASE, { fetchImpl: fetchReturning(body, 200).fetchImpl });
    const result = await client.targets();
    if (!result.ok) throw new Error("unreachable");
    expect(result.data[0]?.scrapeUrl).toBe("http://harbor-9:9100/metrics");
    expect(JSON.stringify(result)).not.toContain("SECRET_PW");
    expect(JSON.stringify(result)).not.toContain("scraper:");
  });
});

describe("buildInfo — exact request and validation", () => {
  test("issues one GET /api/v1/status/buildinfo and returns the version", async () => {
    const fx = fetchFromFixture("buildinfo-success.json");
    const client = createVmClient(BASE, { fetchImpl: fx.fetchImpl });
    const result = await client.buildInfo();
    expect(fx.init()?.method).toBe("GET");
    expect(new URL(fx.url()).pathname).toBe("/api/v1/status/buildinfo");
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toEqual({ version: "1.102.1", startedAt: null });
  });

  test("accepts additive fields; missing version fails the whole operation", async () => {
    const additive = createVmClient(BASE, { fetchImpl: fetchFromFixture("buildinfo-additive.json").fetchImpl });
    expect((await additive.buildInfo()).ok).toBe(true);

    const malformed = createVmClient(BASE, { fetchImpl: fetchFromFixture("buildinfo-malformed.json").fetchImpl });
    const result = await malformed.buildInfo();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });
});

describe("queryRange — exact request, matrix parsing, and cancellation", () => {
  const REQUEST = { promql: 'node_load1{job="node"}', startSeconds: 1726440000, endSeconds: 1726440180, stepSeconds: 60 };

  test("issues one GET /api/v1/query_range built only from the request", async () => {
    const fx = fetchFromFixture("range-success.json");
    const client = createVmClient(BASE, { fetchImpl: fx.fetchImpl });
    const result = await client.queryRange(REQUEST);

    const url = new URL(fx.url());
    expect(fx.init()?.method).toBe("GET");
    expect(url.pathname).toBe("/api/v1/query_range");
    expect(url.searchParams.get("query")).toBe(REQUEST.promql);
    expect(url.searchParams.get("start")).toBe("1726440000");
    expect(url.searchParams.get("end")).toBe("1726440180");
    expect(url.searchParams.get("step")).toBe("60");

    if (!result.ok) throw new Error("unreachable");
    expect(result.data.series).toHaveLength(2);
    const first = result.data.series[0];
    expect(first?.metric).toEqual({ __name__: "node_load1", host: "harbor-1", instance: "harbor-1:9100" });
    expect(first?.samples).toHaveLength(4);
    // NaN sample preserved as unavailable.
    expect(first?.samples[2]?.value).toBeNull();
    expect(first?.samples[0]).toEqual({ timestampMs: 1726440000000, value: 0.42 });
  });

  test("matrix samples preserve empty-window and non-finite values as unavailable, never zero", async () => {
    const result = await createVmClient(BASE, {
      fetchImpl: fetchFromFixture("range-unavailable.json").fetchImpl,
    }).queryRange(REQUEST);
    if (!result.ok) throw new Error("unreachable");
    const samples = result.data.series[0]?.samples;
    expect(samples?.map((s) => s.value)).toEqual([0.42, null, null, 0]);
    // Timestamps of the unavailable samples are still retained in ascending order.
    expect(samples?.map((s) => s.timestampMs)).toEqual([
      1726440000000, 1726440060000, 1726440120000, 1726440180000,
    ]);
  });

  test("accepts additive fields; malformed and unsorted samples fail the whole operation", async () => {
    expect((await createVmClient(BASE, { fetchImpl: fetchFromFixture("range-additive.json").fetchImpl }).queryRange(REQUEST)).ok).toBe(true);

    const malformed = await createVmClient(BASE, { fetchImpl: fetchFromFixture("range-malformed-nested.json").fetchImpl }).queryRange(REQUEST);
    expect(malformed.ok).toBe(false);
    if (malformed.ok) throw new Error("unreachable");
    expect(malformed.error.kind).toBe("invalid-shape");

    const unsorted = await createVmClient(BASE, { fetchImpl: fetchFromFixture("range-unsorted.json").fetchImpl }).queryRange(REQUEST);
    expect(unsorted.ok).toBe(false);
    if (unsorted.ok) throw new Error("unreachable");
    expect(unsorted.error.kind).toBe("invalid-shape");
  });

  test("an already-aborted caller signal cancels before fetching (transport)", async () => {
    let called = false;
    const fetchImpl: FetchLike = () => {
      called = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const controller = new AbortController();
    controller.abort();
    const result = await createVmClient(BASE, { fetchImpl }).queryRange(REQUEST, { signal: controller.signal });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("transport");
  });

  test("forwards a mid-flight caller abort through the range fetch (transport)", async () => {
    const controller = new AbortController();
    const promise = createVmClient(BASE, { fetchImpl: hangingFetch }).queryRange(REQUEST, { signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("transport");
  });
});

describe("recovery and failure-as-data (criterion 1/4)", () => {
  test("a non-2xx failure never rejects and a later success recovers", async () => {
    const failing = createVmClient(BASE, { fetchImpl: fetchReturning("upstream boom", 503).fetchImpl });
    const failure = await failing.statusSignals();
    expect(failure.ok).toBe(false);
    if (failure.ok) throw new Error("unreachable");
    expect(failure.error.kind).toBe("upstream-status");
    expect(failure.error.status).toBe(503);

    const recovered = createVmClient(BASE, { fetchImpl: fetchFromFixture("instant-success.json").fetchImpl });
    expect((await recovered.statusSignals()).ok).toBe(true);
  });

  test("no pinned vm fixture leaks credentials or authorization headers", () => {
    // Scan every checked-in vm fixture, not a hand-maintained subset, so any fixture
    // added later is covered automatically (criterion 4 — sanitized, no sensitive values).
    const names = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".json"));
    expect(names.length).toBeGreaterThanOrEqual(14);
    for (const name of names) {
      const text = fixtureText(name);
      expect(text.toLowerCase()).not.toContain("authorization");
      expect(text.toLowerCase()).not.toContain("password");
      expect(text.toLowerCase()).not.toContain("secret");
      // No embedded userinfo credentials in any URL.
      expect(text).not.toContain("@");
    }
  });
});
