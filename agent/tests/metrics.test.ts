// agent/tests/metrics.test.ts
//
// Focused coverage for the fail-visible metric state, deterministic exposition, and the prober
// entrypoint's pure seams (item 011; 02-deep-health-prober.md §6.2/§6.3/§7/§8):
//   - MetricStore last-good retention: success sets value/up=1/timestamp; a LATER failure flips
//     up→0 without refreshing value or timestamp; a never-successful service emits only up=0.
//   - renderExposition uses the exact three contract names, escapes labels, and is deterministic.
//   - handleRequest serves ONLY /metrics + /healthz (404 otherwise) — no real port is bound.
//   - runCycleInto folds outcomes into the store AND continues after a cycle-level error.
//
// Importing index.ts here does NOT start the server: `main()` is guarded by `import.meta.main`,
// so only executing the file as the entrypoint binds PROBER_PORT (06 §3 hermetic imports).

import { describe, expect, test } from "bun:test";

import { MetricStore, renderExposition } from "../prober/src/metrics.js";
import type { ServiceState } from "../prober/src/metrics.js";
import { handleRequest, runCycleInto } from "../prober/src/index.js";
import { ProbeExecutionError } from "../prober/src/errors.js";
import type { ProbeOutcome } from "../prober/src/probe-outcome.js";
import {
  PULSE_DEEP_HEALTH,
  PULSE_DEEP_HEALTH_UP,
  PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS,
} from "../contract/types.js";

// ── outcome builders ──────────────────────────────────────────────────────────────────

function ok(
  host: string,
  service: string,
  samples: Record<string, number>,
  scrapedAt: number,
): ProbeOutcome {
  return { ok: true, host, service, samples, scrapedAt };
}

function fail(
  host: string,
  service: string,
  reason: ProbeExecutionError["reason"] = "unreachable",
): ProbeOutcome {
  return {
    ok: false,
    host,
    service,
    error: new ProbeExecutionError(`svc:${host}/${service}`, reason, "probe failed"),
  };
}

// ── MetricStore + exposition ──────────────────────────────────────────────────────────

describe("MetricStore — last-good state (§6.2, REQ-PROBE-04)", () => {
  test("a successful outcome emits the exact value, up=1, and last-scrape series", () => {
    const store = new MetricStore();
    store.record([ok("web01", "frigate", { camera_count: 4 }, 1734300000)]);
    const text = store.render();

    expect(text).toContain(
      `${PULSE_DEEP_HEALTH}{host="web01",service="frigate",metric="camera_count"} 4`,
    );
    expect(text).toContain(`${PULSE_DEEP_HEALTH_UP}{host="web01",service="frigate"} 1`);
    expect(text).toContain(
      `${PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS}{host="web01",service="frigate"} 1734300000`,
    );
  });

  test("label values are escaped (backslash, quote)", () => {
    const state: ServiceState = {
      host: 'we\\b"01',
      service: "svc",
      up: 1,
      samples: { m: 1 },
      lastScrapeSeconds: 5,
    };
    const text = renderExposition([state]);
    // `\` → `\\` and `"` → `\"` in every label value.
    expect(text).toContain(
      `${PULSE_DEEP_HEALTH_UP}{host="we\\\\b\\"01",service="svc"} 1`,
    );
  });

  test("a LATER failure flips up→0 but keeps the last-good value AND timestamp", () => {
    const store = new MetricStore();
    store.record([ok("web01", "frigate", { camera_count: 4 }, 1734300000)]);
    store.record([fail("web01", "frigate", "timeout")]); // next cycle: unreachable
    const text = store.render();

    // Value + timestamp are STALE (unchanged from the last success)…
    expect(text).toContain(
      `${PULSE_DEEP_HEALTH}{host="web01",service="frigate",metric="camera_count"} 4`,
    );
    expect(text).toContain(
      `${PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS}{host="web01",service="frigate"} 1734300000`,
    );
    // …only `_up` flips to 0.
    expect(text).toContain(`${PULSE_DEEP_HEALTH_UP}{host="web01",service="frigate"} 0`);
    expect(text).not.toContain(`${PULSE_DEEP_HEALTH_UP}{host="web01",service="frigate"} 1`);
  });

  test("a never-successful service emits only up=0 — no value, no timestamp", () => {
    const store = new MetricStore();
    store.record([fail("nvr01", "api", "http-status")]);
    const text = store.render();

    expect(text).toContain(`${PULSE_DEEP_HEALTH_UP}{host="nvr01",service="api"} 0`);
    // No value series and no last-scrape timestamp for a service that never succeeded.
    expect(text).not.toContain(`${PULSE_DEEP_HEALTH}{host="nvr01"`);
    expect(text).not.toContain(`${PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS}{host="nvr01"`);
  });

  test("a later SUCCESS after a failure refreshes value, up=1, and timestamp", () => {
    const store = new MetricStore();
    store.record([fail("web01", "frigate")]);
    store.record([ok("web01", "frigate", { camera_count: 6 }, 1734399999)]);
    const text = store.render();
    expect(text).toContain(
      `${PULSE_DEEP_HEALTH}{host="web01",service="frigate",metric="camera_count"} 6`,
    );
    expect(text).toContain(`${PULSE_DEEP_HEALTH_UP}{host="web01",service="frigate"} 1`);
    expect(text).toContain(
      `${PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS}{host="web01",service="frigate"} 1734399999`,
    );
  });
});

describe("renderExposition — deterministic ordering + exact names (§6.3)", () => {
  test("emits exactly the three # TYPE headers, in contract order, first", () => {
    const text = renderExposition([]);
    expect(text).toBe(
      `# TYPE ${PULSE_DEEP_HEALTH} gauge\n` +
        `# TYPE ${PULSE_DEEP_HEALTH_UP} gauge\n` +
        `# TYPE ${PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS} gauge\n`,
    );
  });

  test("service and metric ordering is deterministic regardless of input order", () => {
    const a = renderExposition([
      { host: "b-host", service: "z", up: 1, samples: { b: 2, a: 1 }, lastScrapeSeconds: 10 },
      { host: "a-host", service: "y", up: 1, samples: { m: 3 }, lastScrapeSeconds: 11 },
    ]);
    const b = renderExposition([
      { host: "a-host", service: "y", up: 1, samples: { m: 3 }, lastScrapeSeconds: 11 },
      { host: "b-host", service: "z", up: 1, samples: { a: 1, b: 2 }, lastScrapeSeconds: 10 },
    ]);
    expect(a).toBe(b);

    // a-host sorts before b-host; within b-host, metric "a" sorts before "b".
    const lines = a.trimEnd().split("\n");
    const aHostIdx = lines.findIndex((l) => l.includes('host="a-host"'));
    const bHostIdx = lines.findIndex((l) => l.includes('host="b-host"'));
    expect(aHostIdx < bHostIdx).toBe(true);
    const metricAIdx = lines.findIndex((l) => l.includes('metric="a"'));
    const metricBIdx = lines.findIndex((l) => l.includes('metric="b"'));
    expect(metricAIdx < metricBIdx).toBe(true);
  });

  test("output uses only the three exact deep-health family names", () => {
    const text = renderExposition([
      { host: "h", service: "s", up: 0, samples: { m: 1 }, lastScrapeSeconds: 1 },
    ]);
    for (const line of text.trimEnd().split("\n")) {
      const name = line.startsWith("# TYPE ") ? line.split(" ")[2] : line.split("{")[0];
      expect(
        name === PULSE_DEEP_HEALTH ||
          name === PULSE_DEEP_HEALTH_UP ||
          name === PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS,
      ).toBe(true);
    }
  });

  test("body is terminated by a single trailing newline", () => {
    const text = renderExposition([
      { host: "h", service: "s", up: 1, samples: { m: 1 }, lastScrapeSeconds: 1 },
    ]);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});

describe("renderExposition — per-host prober host-label suppression (issue #8)", () => {
  const state: ServiceState = { host: "web01", service: "frigate", up: 1, samples: { detectors: 4 }, lastScrapeSeconds: 1710000000 };

  test("default: the host label is emitted (central prober, unchanged)", () => {
    const text = renderExposition([state]);
    expect(text).toContain('host="web01"');
    expect(text).toContain('service="frigate"');
  });

  test("suppressHostLabel omits host but keeps service (scrape-time SD applies host)", () => {
    const text = renderExposition([state], { suppressHostLabel: true });
    expect(text).not.toContain("host=");
    expect(text).toContain('{service="frigate",metric="detectors"}');
    expect(text).toContain('pulse_deep_health_up{service="frigate"} 1');
  });

  test("MetricStore threads the suppression option into render()", () => {
    const store = new MetricStore({ suppressHostLabel: true });
    store.record([
      { host: "web01", service: "frigate", ok: true, samples: { detectors: 4 }, scrapedAt: 1 } as ProbeOutcome,
    ]);
    const text = store.render();
    expect(text).not.toContain("host=");
    expect(text).toContain('service="frigate"');
  });
});

// ── entrypoint seams: routing + cycle resilience (no port bound) ──────────────────────

describe("handleRequest — serves metrics/health only (§7, §8)", () => {
  const store = new MetricStore();
  store.record([ok("web01", "frigate", { camera_count: 4 }, 1734300000)]);

  test("/metrics returns the exposition body with the 0.0.4 content type", async () => {
    const res = handleRequest(new Request("http://localhost:9120/metrics"), store);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(await res.text()).toBe(store.render());
  });

  test("/healthz returns 200 ok", async () => {
    const res = handleRequest(new Request("http://localhost:9120/healthz"), store);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("any other path is a 404 — no write/control surface", () => {
    for (const path of ["/", "/metrics/reload", "/probe", "/admin", "/config"]) {
      const res = handleRequest(new Request(`http://localhost:9120${path}`), store);
      expect(res.status).toBe(404);
    }
  });
});

describe("runCycleInto — fold + cycle-error resilience (§8, REQ-PROBE-04)", () => {
  test("folds one cycle's outcomes into the store", async () => {
    const store = new MetricStore();
    const stubCycle = (async () => [
      ok("web01", "frigate", { camera_count: 4 }, 1734300000),
    ]) as unknown as typeof import("../prober/src/probe.js").runCycle;
    await runCycleInto(store, [], {}, stubCycle);
    expect(store.render()).toContain(`${PULSE_DEEP_HEALTH_UP}{host="web01",service="frigate"} 1`);
  });

  test("an unexpected cycle-level throw is swallowed — the loop continues", async () => {
    const store = new MetricStore();
    store.record([ok("web01", "frigate", { camera_count: 4 }, 1734300000)]);
    const before = store.render();

    const throwingCycle = (async () => {
      throw new Error("boom");
    }) as unknown as typeof import("../prober/src/probe.js").runCycle;

    let threw = false;
    try {
      await runCycleInto(store, [], {}, throwingCycle);
    } catch {
      threw = true;
    }
    // It never propagates (the process would keep looping)…
    expect(threw).toBe(false);
    // …and the last-good store is untouched by the failed cycle.
    expect(store.render()).toBe(before);
  });
});
