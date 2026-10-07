// agent/tests/probe.test.ts
//
// Focused hermetic coverage for bounded JSONPath probing and worker execution (item 010):
//   - evalNumericPath numeric-or-miss contract (§4.2)
//   - runProbe success mapping + every typed failure reason (§4.1, REQ-PROBE-01/04)
//   - runCycle bounded concurrency + isolation (one slow/failing probe cannot stall siblings, §6.1)
//
// No real network: every test injects a stub `fetch` (and, where relevant, an `env` map) via the
// ProbeOptions seams (06-testing-strategy.md §3). Importing probe.ts / jsonpath.ts here also
// pulls them into the agent/tests tsconfig program so `tsc -b` typechecks them.

import { describe, expect, test } from "bun:test";

import { evalNumericPath } from "../prober/src/jsonpath.js";
import { runCycle, runProbe } from "../prober/src/probe.js";
import type { ProbeOptions } from "../prober/src/probe.js";
import { ProbeExecutionError } from "../prober/src/errors.js";
import type { DeepHealthProbeConfig } from "../contract/types.js";

// ── stub-fetch helpers (no real network) ──────────────────────────────────────────────

/** A stub `fetch` that returns `body` serialized as JSON with `status` (default 200). */
function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** A stub `fetch` returning a 200 response whose body is NOT valid JSON. */
function badJsonFetch(): typeof fetch {
  return (async () =>
    new Response("<html>not json</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
}

/** A stub `fetch` that rejects with a transport-style error (no `TimeoutError` name). */
function unreachableFetch(): typeof fetch {
  return (async () => {
    throw new TypeError("Unable to connect");
  }) as unknown as typeof fetch;
}

/** A stub `fetch` that never resolves on its own but rejects with the abort reason when the
 *  bounded `AbortSignal.timeout` fires — mirroring how the runtime aborts a hung request. */
function hangingFetch(): typeof fetch {
  return ((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener("abort", () => reject(signal.reason));
      }
    })) as unknown as typeof fetch;
}

const frigate: DeepHealthProbeConfig = {
  host: "web01",
  service: "frigate",
  target: "http://web01:5000/api/health",
  metrics: { camera_count: "$.cameras.recording" },
  alertExpression: "camera_count < 6",
};

// ── evalNumericPath — the numeric-or-miss contract ────────────────────────────────────

describe("evalNumericPath — numeric-or-miss (§4.2)", () => {
  test("accepts a single finite number", () => {
    expect(evalNumericPath({ cameras: { recording: 4 } }, "$.cameras.recording")).toBe(4);
    expect(evalNumericPath({ n: 0 }, "$.n")).toBe(0);
    expect(evalNumericPath({ n: -12.5 }, "$.n")).toBe(-12.5);
  });

  test("accepts a numeric string (coerced)", () => {
    expect(evalNumericPath({ n: "4" }, "$.n")).toBe(4);
    expect(evalNumericPath({ n: "  7.5 " }, "$.n")).toBe(7.5);
  });

  test("a missing path is a miss", () => {
    expect(evalNumericPath({ a: 1 }, "$.nope")).toBeUndefined();
    expect(evalNumericPath({ a: { b: 1 } }, "$.a.c")).toBeUndefined();
  });

  test("a malformed path expression is a miss (fail-visible, no throw)", () => {
    expect(evalNumericPath({ a: 1 }, "$[")).toBeUndefined();
    expect(evalNumericPath({ a: 1 }, "$[?(@.a")).toBeUndefined();
  });

  test("multiple matches are ambiguous → miss", () => {
    const body = { items: [{ v: 1 }, { v: 2 }] };
    expect(evalNumericPath(body, "$.items[*].v")).toBeUndefined();
  });

  test("boolean, object, array, and null results are misses", () => {
    expect(evalNumericPath({ b: true }, "$.b")).toBeUndefined();
    expect(evalNumericPath({ b: false }, "$.b")).toBeUndefined();
    expect(evalNumericPath({ o: { x: 1 } }, "$.o")).toBeUndefined();
    expect(evalNumericPath({ z: null }, "$.z")).toBeUndefined();
  });

  test("NaN and Infinity are misses (non-finite)", () => {
    expect(evalNumericPath({ n: Number.NaN }, "$.n")).toBeUndefined();
    expect(evalNumericPath({ n: Number.POSITIVE_INFINITY }, "$.n")).toBeUndefined();
    expect(evalNumericPath({ n: Number.NEGATIVE_INFINITY }, "$.n")).toBeUndefined();
    // Non-finite numeric strings coerce to non-finite numbers → miss.
    expect(evalNumericPath({ n: "Infinity" }, "$.n")).toBeUndefined();
    expect(evalNumericPath({ n: "not-a-number" }, "$.n")).toBeUndefined();
    expect(evalNumericPath({ n: "" }, "$.n")).toBeUndefined();
  });
});

// ── runProbe — success mapping ────────────────────────────────────────────────────────

describe("runProbe — success (REQ-PROBE-01)", () => {
  test("maps every responseMapping path to numeric samples with a success timestamp", async () => {
    const probe: DeepHealthProbeConfig = {
      host: "web01",
      service: "frigate",
      target: "http://web01:5000/api/health",
      metrics: { camera_count: "$.cameras.recording", uptime: "$.uptime_seconds" },
      alertExpression: "camera_count < 6", // carried, never evaluated by the prober (§9)
    };
    const outcome = await runProbe(probe, {
      fetch: jsonFetch({ cameras: { recording: 4 }, uptime_seconds: "120" }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.host).toBe("web01");
    expect(outcome.service).toBe("frigate");
    expect(outcome.samples).toEqual({ camera_count: 4, uptime: 120 });
    expect(typeof outcome.scrapedAt).toBe("number");
    expect(Number.isFinite(outcome.scrapedAt)).toBe(true);
    // The success outcome carries samples/scrapedAt only — no evaluated alert state.
    expect("error" in outcome).toBe(false);
  });

  test("attaches a Bearer header resolved from the injected env, never a literal", async () => {
    let seenAuth: string | undefined;
    const capturingFetch = ((_url: unknown, init?: { headers?: Record<string, string> }) => {
      seenAuth = init?.headers?.authorization;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const authed: DeepHealthProbeConfig = {
      host: "nvr01",
      service: "api",
      target: "http://nvr01:8080/health",
      metrics: { ok: "$.ok" },
      credential: "${NVR_TOKEN}",
    };
    const outcome = await runProbe(authed, {
      fetch: capturingFetch,
      env: { NVR_TOKEN: "s3cr3t" },
    });
    expect(outcome.ok).toBe(true);
    expect(seenAuth).toBe("Bearer s3cr3t");
  });
});

// ── runProbe — every typed failure reason ─────────────────────────────────────────────

describe("runProbe — typed failure reasons (REQ-PROBE-04)", () => {
  async function reasonFor(options: ProbeOptions): Promise<ProbeExecutionError["reason"]> {
    const outcome = await runProbe(frigate, options);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.error).toBeInstanceOf(ProbeExecutionError);
    return outcome.error.reason;
  }

  test("non-2xx HTTP status → http-status", async () => {
    expect(await reasonFor({ fetch: jsonFetch({}, 503) })).toBe("http-status");
  });

  test("bounded timeout → timeout", async () => {
    expect(await reasonFor({ fetch: hangingFetch(), timeoutMs: 10 })).toBe("timeout");
  });

  test("transport failure → unreachable", async () => {
    expect(await reasonFor({ fetch: unreachableFetch() })).toBe("unreachable");
  });

  test("non-JSON body → bad-json", async () => {
    expect(await reasonFor({ fetch: badJsonFetch() })).toBe("bad-json");
  });

  test("missing / non-numeric JSONPath → path-miss", async () => {
    // Body is valid JSON but the mapped path is absent.
    expect(await reasonFor({ fetch: jsonFetch({ cameras: {} }) })).toBe("path-miss");
  });

  test("a declared credential with an unset env var fails visibly (unreachable), no throw", async () => {
    const authed: DeepHealthProbeConfig = { ...frigate, credential: "${NVR_TOKEN}" };
    const outcome = await runProbe(authed, { fetch: jsonFetch({ cameras: { recording: 4 } }), env: {} });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.error.reason).toBe("unreachable");
  });

  test("runProbe never throws for a probe-level failure", async () => {
    // The catch-all path: even an unexpected fetch rejection is captured, not propagated.
    let threw = false;
    try {
      await runProbe(frigate, { fetch: unreachableFetch() });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

// ── runCycle — bounded concurrency + isolation ────────────────────────────────────────

describe("runCycle — bounded worker pool (REQ-PERF-02, §6.1)", () => {
  function makeProbes(n: number): DeepHealthProbeConfig[] {
    return Array.from({ length: n }, (_v, i) => ({
      host: `h${i}`,
      service: "svc",
      target: `http://h${i}/health`,
      metrics: { ok: "$.ok" },
    }));
  }

  test("never exceeds the configured concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const countingFetch = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const outcomes = await runCycle(makeProbes(10), { fetch: countingFetch, concurrency: 3 });
    expect(outcomes.length).toBe(10);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(peak <= 3).toBe(true);
  });

  test("one slow/failing probe does not prevent sibling outcomes", async () => {
    const probes = makeProbes(4);
    // Route by URL: h1 hangs until its bounded timeout; h2 is a transport failure; the rest succeed.
    const routingFetch = ((url: unknown, init?: { signal?: AbortSignal }) => {
      const u = String(url);
      if (u === "http://h1/health") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        });
      }
      if (u === "http://h2/health") return Promise.reject(new TypeError("connect ECONNREFUSED"));
      return Promise.resolve(
        new Response(JSON.stringify({ ok: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const outcomes = await runCycle(probes, { fetch: routingFetch, concurrency: 4, timeoutMs: 20 });
    expect(outcomes.length).toBe(4);
    // Index-aligned with the input: the healthy siblings (h0, h3) succeed regardless of h1/h2.
    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[3]?.ok).toBe(true);
    const h1 = outcomes[1];
    const h2 = outcomes[2];
    expect(h1?.ok).toBe(false);
    expect(h2?.ok).toBe(false);
    if (h1 && !h1.ok) expect(h1.error.reason).toBe("timeout");
    if (h2 && !h2.ok) expect(h2.error.reason).toBe("unreachable");
  });

  test("an empty probe set yields no outcomes and never touches fetch", async () => {
    let called = false;
    const neverFetch = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const outcomes = await runCycle([], { fetch: neverFetch });
    expect(outcomes).toEqual([]);
    expect(called).toBe(false);
  });
});
