// agent/tests/prober.test.ts
//
// The AUTHORITATIVE hermetic prober suite (item 015; 06-testing-strategy.md §3, §8, §9).
// It complements the focused unit suites (config/probe/metrics.test.ts) with committed
// GOLDEN coverage: each `agent/tests/golden/<name>.config.yaml` input is driven through the
// real pipeline (loadProberConfig → runCycle(stub fetch) → pinned clock → MetricStore →
// render) and its exact exposition text is compared byte-for-byte against the committed
// `<name>.exposition.txt` golden. The goldens are regenerated deliberately with
// `bun agent/tests/golden-update.ts` and reviewed before commit (the renderer's workflow).
//
// Everything here is hermetic: probe targets are stubbed via the injected `fetch` seam and
// credentials via the injected `env` seam (ProbeOptions, 02 §4.1); the clock is pinned at
// the outcome boundary (scenarios.ts). NO real network call or ambient env read happens.
//
// Coverage (acceptance criteria):
//   - healthy mapping + EXACT exposition for host/service/metric labels (golden compare)
//   - unreachable, timeout, bad-json, path-miss, http-status, malformed config, absent config
//   - non-deep-health entries ignored; one failure does not affect siblings; last-good retained
//   - authenticated ${ENV} Bearer header asserted; raw + resolved credential never leak

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  SCENARIOS,
  renderScenario,
  scenarioConfigPath,
  scenarioExpositionPath,
  GOLDEN_DIR,
} from "./golden/scenarios.js";
import { loadProberConfig } from "../prober/src/config.js";
import { runCycle, runProbe } from "../prober/src/probe.js";
import type { ProbeOptions } from "../prober/src/probe.js";
import { MetricStore } from "../prober/src/metrics.js";
import { ProbeExecutionError, ProberConfigError } from "../prober/src/errors.js";
import type { DeepHealthProbeConfig } from "../contract/types.js";

// ── golden compare: exact exposition per scenario ─────────────────────────────────────

describe("golden exposition compare (REQ-PROBE-01, exact host/service/metric labels)", () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario.name}: rendered exposition equals the committed golden`, async () => {
      const expected = await readFile(scenarioExpositionPath(scenario), "utf8");
      const actual = await renderScenario(scenario);
      // Byte-for-byte equality — proves headers, per-service ordering, metric ordering, label
      // escaping, value formatting, and the trailing newline all match the reviewed golden.
      expect(actual).toBe(expected);
    });
  }

  test("healthy: exact labels for every host/service/metric are present", async () => {
    const text = await renderScenario(SCENARIOS[0]!);
    // web01/frigate — a single-metric service.
    expect(text).toContain(
      'pulse_deep_health{host="web01",service="frigate",metric="camera_count"} 4',
    );
    expect(text).toContain('pulse_deep_health_up{host="web01",service="frigate"} 1');
    expect(text).toContain(
      'pulse_deep_health_last_scrape_seconds{host="web01",service="frigate"} 1734300000',
    );
    // app02/grafana — TWO metrics, numeric-string coercion ("12" → 12), metric-sorted order.
    expect(text).toContain(
      'pulse_deep_health{host="app02",service="grafana",metric="db_connections"} 12',
    );
    expect(text).toContain(
      'pulse_deep_health{host="app02",service="grafana",metric="dashboards"} 3',
    );
    expect(text).toContain('pulse_deep_health_up{host="app02",service="grafana"} 1');
  });

  test("healthy: non-deep-health entries (backup-freshness, icmp) emit NO series", async () => {
    const text = await renderScenario(SCENARIOS[0]!);
    // The backup + host-reachability entries in the same file are filtered out (REQ-PROBE-06):
    // no `postgres` and no `host:web01` series appear anywhere.
    expect(text).not.toContain("postgres");
    expect(text).not.toContain("host:web01");
    // Exactly the two probed services are represented (two `_up` lines).
    const upLines = text.split("\n").filter((l) => l.startsWith("pulse_deep_health_up{"));
    expect(upLines.length).toBe(2);
  });

  test("retention: after a failure, _up=0 but the last-good value + timestamp persist", async () => {
    const text = await renderScenario(SCENARIOS[2]!);
    // The stale value + timestamp survive the failing second cycle (fail-visible, §6.2)…
    expect(text).toContain(
      'pulse_deep_health{host="web01",service="frigate",metric="camera_count"} 4',
    );
    expect(text).toContain(
      'pulse_deep_health_last_scrape_seconds{host="web01",service="frigate"} 1734300000',
    );
    // …only `_up` flips to 0.
    expect(text).toContain('pulse_deep_health_up{host="web01",service="frigate"} 0');
    expect(text).not.toContain('pulse_deep_health_up{host="web01",service="frigate"} 1');
  });
});

// ── authenticated probe: Bearer header + non-leakage (REQ-PROBE-03, REQ-SEC-01) ────────

describe("authenticated ${ENV} probe (02 §5)", () => {
  const authedScenario = SCENARIOS.find((s) => s.name === "authed")!;

  /** Load the single authed probe from its committed golden config. */
  async function loadAuthedProbe(): Promise<DeepHealthProbeConfig> {
    const probes = await loadProberConfig(scenarioConfigPath(authedScenario));
    expect(probes.length).toBe(1);
    const probe = probes[0]!;
    // The credential crosses as the raw ${ENV} reference only — never a literal, never resolved.
    expect(probe.credential).toBe("${NVR_TOKEN}");
    return probe;
  }

  test("sends Authorization: Bearer <resolved> from the injected env, not the raw ref", async () => {
    const probe = await loadAuthedProbe();
    let seenAuth: string | undefined;
    const capturingFetch = ((_url: unknown, init?: { headers?: Record<string, string> }) => {
      seenAuth = init?.headers?.authorization;
      return Promise.resolve(
        new Response(JSON.stringify({ status: { cameras_online: 6 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const outcome = await runProbe(probe, {
      fetch: capturingFetch,
      env: { NVR_TOKEN: "s3cr3t-token-value" },
    });
    expect(outcome.ok).toBe(true);
    // The RESOLVED token is on the wire — never the raw `${NVR_TOKEN}` reference.
    expect(seenAuth).toBe("Bearer s3cr3t-token-value");
    expect(seenAuth).not.toContain("NVR_TOKEN");
    expect(seenAuth).not.toContain("${");
  });

  test("neither the raw reference nor the resolved token appears in the exposition", async () => {
    const text = await renderScenario(authedScenario);
    expect(text).not.toContain("s3cr3t-token-value"); // resolved value never emitted
    expect(text).not.toContain("NVR_TOKEN"); // raw env-var name never emitted
    expect(text).not.toContain("${"); // no unresolved reference emitted
    // The mapped sample DID land, so the auth path actually ran.
    expect(text).toContain(
      'pulse_deep_health{host="nvr01",service="api",metric="cameras_online"} 6',
    );
  });

  test("a declared credential with an unset env var fails visibly — token never in the error", async () => {
    const probe = await loadAuthedProbe();
    const outcome = await runProbe(probe, {
      fetch: (async () =>
        new Response(JSON.stringify({ status: { cameras_online: 6 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
      env: {}, // NVR_TOKEN unset → fail-visible, no crash
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.error).toBeInstanceOf(ProbeExecutionError);
    expect(outcome.error.reason).toBe("unreachable");
    // The error names the env var but carries no token value (there is none) and no raw ref.
    expect(outcome.error.message).toContain("NVR_TOKEN");
  });
});

// ── every fail-visible reason (REQ-PROBE-04) ───────────────────────────────────────────

describe("every fail-visible reason maps to the exact typed reason (§4.1)", () => {
  const frigate: DeepHealthProbeConfig = {
    host: "web01",
    service: "frigate",
    target: "http://web01:5000/api/health",
    metrics: { camera_count: "$.cameras.recording" },
  };

  /** A stub returning `body` as JSON with `status` (default 200). */
  function jsonFetch(body: unknown, status = 200): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  async function reasonFor(options: ProbeOptions): Promise<ProbeExecutionError["reason"]> {
    const outcome = await runProbe(frigate, options);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.error).toBeInstanceOf(ProbeExecutionError);
    return outcome.error.reason;
  }

  test("non-2xx status → http-status", async () => {
    expect(await reasonFor({ fetch: jsonFetch({}, 503) })).toBe("http-status");
  });

  test("transport rejection → unreachable", async () => {
    const unreachableFetch = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await reasonFor({ fetch: unreachableFetch })).toBe("unreachable");
  });

  test("bounded timeout → timeout", async () => {
    const hangingFetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    expect(await reasonFor({ fetch: hangingFetch, timeoutMs: 10 })).toBe("timeout");
  });

  test("non-JSON body → bad-json", async () => {
    const badJson = (async () =>
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    expect(await reasonFor({ fetch: badJson })).toBe("bad-json");
  });

  test("missing / non-numeric JSONPath → path-miss", async () => {
    expect(await reasonFor({ fetch: jsonFetch({ cameras: {} }) })).toBe("path-miss");
  });

  test("a failing probe never refreshes the value series (fail-visible)", async () => {
    const store = new MetricStore();
    store.record(await runCycle([frigate], { fetch: jsonFetch({}, 503) }));
    const text = store.render();
    expect(text).toContain('pulse_deep_health_up{host="web01",service="frigate"} 0');
    // Never-successful → no value line, no timestamp line.
    expect(text).not.toContain('pulse_deep_health{host="web01",service="frigate",metric=');
    expect(text).not.toContain(
      'pulse_deep_health_last_scrape_seconds{host="web01",service="frigate"}',
    );
  });
});

// ── config load states (§3.1) ──────────────────────────────────────────────────────────

describe("config load states (§3.1)", () => {
  test("ABSENT config resolves to an empty probe set — the prober idles healthy", async () => {
    const probes = await loadProberConfig(resolve(GOLDEN_DIR, "does-not-exist.yaml"));
    expect(probes).toEqual([]);
    // An empty probe set renders a valid, empty exposition body (just the three headers).
    expect(new MetricStore().render()).toBe(
      "# TYPE pulse_deep_health gauge\n" +
        "# TYPE pulse_deep_health_up gauge\n" +
        "# TYPE pulse_deep_health_last_scrape_seconds gauge\n",
    );
  });

  test("MALFORMED config (wrong top-level shape) throws ProberConfigError", async () => {
    await expect(
      loadProberConfig(resolve(GOLDEN_DIR, "malformed.config.yaml")),
    ).rejects.toBeInstanceOf(ProberConfigError);
  });
});

// ── isolation under bounded concurrency (REQ-PERF-02, §6.1) ─────────────────────────────

describe("bounded concurrency + isolation (§6.1)", () => {
  function makeProbes(n: number): DeepHealthProbeConfig[] {
    return Array.from({ length: n }, (_v, i) => ({
      host: `h${i}`,
      service: "svc",
      target: `http://h${i}/health`,
      metrics: { ok: "$.ok" },
    }));
  }

  test("never exceeds the concurrency bound; every probe still yields one outcome", async () => {
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

    const outcomes = await runCycle(makeProbes(9), { fetch: countingFetch, concurrency: 3 });
    expect(outcomes.length).toBe(9);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(peak <= 3).toBe(true);
  });

  test("one slow/failing probe does not prevent sibling outcomes (index-aligned)", async () => {
    const probes = makeProbes(4);
    // h1 hangs to its bounded timeout; h2 is a transport failure; h0/h3 succeed regardless.
    const routingFetch = ((url: unknown, init?: { signal?: AbortSignal }) => {
      const u = String(url);
      if (u === "http://h1/health") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
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
    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[3]?.ok).toBe(true);
    const h1 = outcomes[1];
    const h2 = outcomes[2];
    expect(h1?.ok).toBe(false);
    expect(h2?.ok).toBe(false);
    if (h1 && !h1.ok) expect(h1.error.reason).toBe("timeout");
    if (h2 && !h2.ok) expect(h2.error.reason).toBe("unreachable");
  });
});
