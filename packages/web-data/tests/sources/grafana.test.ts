/** grafana.test.ts — evidence for item 018 (03-source-clients-and-validation.md §9).
 *  Covers the optional Grafana health client:
 *   - health() performs exactly one GET /api/health and validates only the required bounded
 *     database/version fields; additive unknown fields pass and are stripped (criterion 1);
 *   - resolveGrafanaClient returns null when PULSE_GRAFANA_URL is absent, so an unconfigured
 *     Grafana issues zero calls and is represented distinctly as not-configured (criterion 2);
 *   - configured transport/status/JSON/shape failures surface as data (never reject) and a
 *     later success recovers, isolated from any other source (criterion 3);
 *   - pinned success/additive/malformed/recovery fixtures carry no credentials/estate values,
 *     and the client never forwards request headers or adds credentials (criterion 4).
 *
 * Pure module: no DOM registration required. Fixtures live in tests/fixtures/grafana/**.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "../../src/sources/types.js";
import { createGrafanaClient, resolveGrafanaClient } from "../../src/sources/grafana.js";
import { SourceConfigError } from "../../src/sources/fetch.js";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "grafana");
const BASE = "http://grafana.internal:3000";

function fixtureText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf-8");
}

/** A fetch serving a fixture body, capturing the request URL and init. */
function fetchFromFixture(
  name: string,
  status = 200,
): { fetchImpl: FetchLike; url: () => string; init: () => RequestInit | undefined; calls: () => number } {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  let calls = 0;
  const fetchImpl: FetchLike = (input, init) => {
    calls += 1;
    capturedUrl = input.toString();
    capturedInit = init;
    return Promise.resolve(new Response(fixtureText(name), { status }));
  };
  return { fetchImpl, url: () => capturedUrl, init: () => capturedInit, calls: () => calls };
}

/** A fetch returning a raw body, counting invocations (for status/recovery checks). */
function fetchReturning(body: string, status: number): { fetchImpl: FetchLike; calls: () => number } {
  let calls = 0;
  const fetchImpl: FetchLike = () => {
    calls += 1;
    return Promise.resolve(new Response(body, { status }));
  };
  return { fetchImpl, calls: () => calls };
}

describe("createGrafanaClient — factory validation", () => {
  test("fails closed on a credential-bearing or non-HTTP(S) base URL", () => {
    expect(() => createGrafanaClient("http://user:pw@grafana:3000")).toThrow(SourceConfigError);
    expect(() => createGrafanaClient("ftp://grafana:3000")).toThrow(SourceConfigError);
  });
});

describe("health() — exact request and validated envelope (criterion 1)", () => {
  test("issues exactly one GET /api/health with no credentials or forwarded headers", async () => {
    const fx = fetchFromFixture("health-success.json");
    const result = await createGrafanaClient(BASE, { fetchImpl: fx.fetchImpl }).health();
    expect(fx.calls()).toBe(1);
    expect(fx.init()?.method ?? "GET").toBe("GET");
    const url = new URL(fx.url());
    expect(url.pathname).toBe("/api/health");
    expect(url.search).toBe("");
    // The client never adds credentials or forwards request headers: only `accept` is set.
    const headers = new Headers(fx.init()?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(result.ok).toBe(true);
  });

  test("returns only the required bounded database/version fields", async () => {
    const result = await createGrafanaClient(BASE, {
      fetchImpl: fetchFromFixture("health-success.json").fetchImpl,
    }).health();
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toEqual({ database: "ok", version: "11.4.0" });
    // The additive upstream `commit` field is stripped and never surfaces.
    expect("commit" in result.data).toBe(false);
  });

  test("preserves a non-ok database token verbatim (never coerced)", async () => {
    const result = await createGrafanaClient(BASE, {
      fetchImpl: fetchFromFixture("health-recovery.json").fetchImpl,
    }).health();
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.database).toBe("failing");
    expect(result.data.version).toBe("11.4.0");
  });

  test("accepts additive unknown fields and strips them", async () => {
    const result = await createGrafanaClient(BASE, {
      fetchImpl: fetchFromFixture("health-additive.json").fetchImpl,
    }).health();
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toEqual({ database: "ok", version: "11.4.0" });
    expect(JSON.stringify(result)).not.toContain("enterpriseCommit");
    expect(JSON.stringify(result)).not.toContain("hasUpdate");
    expect(JSON.stringify(result)).not.toContain("unknownHealthField");
  });
});

describe("resolveGrafanaClient — conditional creation / not-configured (criterion 2)", () => {
  test("returns null (no client) when the URL is absent, empty, or whitespace", () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    expect(resolveGrafanaClient(null, { fetchImpl })).toBeNull();
    expect(resolveGrafanaClient("", { fetchImpl })).toBeNull();
    expect(resolveGrafanaClient("   ", { fetchImpl })).toBeNull();
    // Unconfigured Grafana performs zero calls: no client means no fetch can occur.
    expect(calls).toBe(0);
  });

  test("returns a working client when the URL is configured", async () => {
    const fx = fetchFromFixture("health-success.json");
    const client = resolveGrafanaClient(BASE, { fetchImpl: fx.fetchImpl });
    expect(client).not.toBeNull();
    const result = await client!.health();
    expect(fx.calls()).toBe(1);
    expect(result.ok).toBe(true);
  });
});

describe("malformed rejection (criterion 1 & 3)", () => {
  test("a non-object top-level body fails the whole operation", async () => {
    const result = await createGrafanaClient(BASE, {
      fetchImpl: fetchFromFixture("health-malformed-top.json").fetchImpl,
    }).health();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });

  test("a wrong-typed consumed field fails the whole operation", async () => {
    const result = await createGrafanaClient(BASE, {
      fetchImpl: fetchFromFixture("health-malformed-nested.json").fetchImpl,
    }).health();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });

  test("a missing required field fails the whole operation", async () => {
    const result = await createGrafanaClient(BASE, {
      fetchImpl: fetchReturning(JSON.stringify({ database: "ok" }), 200).fetchImpl,
    }).health();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });

  test("an empty-string consumed field fails the whole operation", async () => {
    const result = await createGrafanaClient(BASE, {
      fetchImpl: fetchReturning(JSON.stringify({ database: "", version: "11.4.0" }), 200).fetchImpl,
    }).health();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });
});

describe("failure-as-data, isolation, and recovery (criterion 3)", () => {
  test("a non-2xx never rejects and a later success recovers", async () => {
    const failure = await createGrafanaClient(BASE, {
      fetchImpl: fetchReturning("upstream boom", 503).fetchImpl,
    }).health();
    expect(failure.ok).toBe(false);
    if (failure.ok) throw new Error("unreachable");
    expect(failure.error.kind).toBe("upstream-status");
    expect(failure.error.status).toBe(503);
    // The raw upstream body never leaks into the error.
    expect(JSON.stringify(failure)).not.toContain("boom");

    const recovered = await createGrafanaClient(BASE, {
      fetchImpl: fetchFromFixture("health-recovery.json").fetchImpl,
    }).health();
    expect(recovered.ok).toBe(true);
  });

  test("malformed JSON surfaces as data and never leaks the raw body", async () => {
    const result = await createGrafanaClient(BASE, {
      fetchImpl: fetchReturning("{ not valid json", 200).fetchImpl,
    }).health();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("malformed-json");
  });

  test("a transport rejection surfaces as data without leaking the exception text", async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new TypeError("ECONNREFUSED 10.0.0.9:3000"));
    const result = await createGrafanaClient(BASE, { fetchImpl }).health();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("transport");
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });

  test("a deadline timeout surfaces as data", async () => {
    // A fetch that never settles until aborted models an unresponsive Grafana; the internal
    // finite timeout aborts it and the result is `timeout`, isolated to this client.
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    const result = await createGrafanaClient(BASE, { fetchImpl, timeoutMs: 5 }).health();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("timeout");
    expect(result.error.status).toBeNull();
  });
});

describe("fixture hygiene (criterion 4)", () => {
  test("no pinned grafana fixture leaks credentials, hostnames, headers, or secrets", () => {
    const names = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".json"));
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const name of names) {
      const text = fixtureText(name).toLowerCase();
      expect(text).not.toContain("authorization");
      expect(text).not.toContain("password");
      expect(text).not.toContain("secret");
      expect(text).not.toContain("token");
      // No embedded userinfo credentials in any URL.
      expect(fixtureText(name)).not.toContain("@");
    }
  });
});
