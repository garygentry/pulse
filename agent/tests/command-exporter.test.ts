// agent/tests/command-exporter.test.ts
//
// Focused coverage for the per-host command-exporter (issue #3/#1). Exercises the pure,
// side-effect-free seams so importing this file never binds COMMAND_EXPORTER_PORT:
//   - narrowSignals: ABSENT/malformed/invalid config states; scalar + exposition narrowing.
//   - MetricStore / renderExposition: scalar value+up, exposition passthrough + generic up,
//     fail-visibility (keep last-good value, flip _up), never-run → _up 0, TYPE dedup, label
//     escaping, and NO self-emitted host label (host is scrape-applied).
//   - runSignal: a real command's stdout → scalar number / exposition text; failure → { ok:false }.
//   - handleRequest routing + runSignalInto resilience (a throwing runFn is recorded as blind).

import { describe, expect, test } from "bun:test";

import {
  loadCommandExporterConfig,
  loadTimeoutMs,
  narrowSignals,
} from "../command-exporter/src/config.js";
import { MetricStore, renderExposition } from "../command-exporter/src/metrics.js";
import { runSignal } from "../command-exporter/src/run.js";
import { handleRequest, runSignalInto } from "../command-exporter/src/index.js";
import { CommandExporterConfigError } from "../command-exporter/src/errors.js";
import type { CommandSignalConfig } from "../contract/types.js";
import { PULSE_COMMAND_SIGNAL_UP } from "../contract/types.js";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "../contract/constants.js";

const scalar = (over: Partial<Extract<CommandSignalConfig, { output: "scalar" }>> = {}) =>
  ({
    output: "scalar",
    name: "backup:db",
    command: ["/opt/pulse/backup-age", "/mnt/backups"],
    intervalMs: 900_000,
    metric: "pulse_backup_freshness_age_seconds",
    upMetric: "pulse_backup_freshness_up",
    labels: { service: "db" },
    ...over,
  }) as CommandSignalConfig;

const exposition = (over: Partial<Extract<CommandSignalConfig, { output: "exposition" }>> = {}) =>
  ({
    output: "exposition",
    name: "gpu",
    command: ["/opt/pulse/gpu-metrics.sh"],
    intervalMs: 30_000,
    ...over,
  }) as CommandSignalConfig;

// ── config: narrowSignals + load states ──────────────────────────────────────

describe("narrowSignals (config)", () => {
  test("narrows a scalar signal, mapping up_metric → upMetric and keeping labels/credential", () => {
    const [s] = narrowSignals(
      {
        signals: [
          {
            output: "scalar",
            name: "drift",
            command: ["/bin/drift"],
            intervalMs: 300_000,
            metric: "pulse_config_drift_count",
            upMetric: "pulse_config_drift_up",
            labels: { scope: "estate" },
            credential: "${DRIFT_TOKEN}",
          },
        ],
      },
      "config.yaml",
    );
    expect(s).toEqual({
      output: "scalar",
      name: "drift",
      command: ["/bin/drift"],
      intervalMs: 300_000,
      metric: "pulse_config_drift_count",
      upMetric: "pulse_config_drift_up",
      labels: { scope: "estate" },
      credential: "${DRIFT_TOKEN}",
    });
  });

  test("narrows an exposition signal", () => {
    const [s] = narrowSignals(
      { signals: [{ output: "exposition", name: "gpu", command: ["/x"], intervalMs: 30_000 }] },
      "config.yaml",
    );
    expect(s).toEqual({ output: "exposition", name: "gpu", command: ["/x"], intervalMs: 30_000 });
  });

  test("a non-{signals:[]} top-level shape throws a fatal config error", () => {
    expect(() => narrowSignals({ nope: true }, "config.yaml")).toThrow(CommandExporterConfigError);
  });

  test("a scalar signal missing its metric throws", () => {
    expect(() =>
      narrowSignals(
        { signals: [{ output: "scalar", name: "x", command: ["/x"], intervalMs: 1, upMetric: "x_up" }] },
        "config.yaml",
      ),
    ).toThrow(/no metric/);
  });

  test("an unknown output kind throws", () => {
    expect(() =>
      narrowSignals(
        { signals: [{ output: "weird", name: "x", command: ["/x"], intervalMs: 1 }] },
        "config.yaml",
      ),
    ).toThrow(/unknown output/);
  });

  test("a non-positive intervalMs throws", () => {
    expect(() =>
      narrowSignals(
        { signals: [{ output: "exposition", name: "x", command: ["/x"], intervalMs: 0 }] },
        "config.yaml",
      ),
    ).toThrow(/invalid intervalMs/);
  });

  test("an ABSENT config file resolves to [] (a non-event; the exporter idles healthy)", async () => {
    const signals = await loadCommandExporterConfig("/definitely/not/here/config.yaml");
    expect(signals).toEqual([]);
  });

  test("loadTimeoutMs defaults, parses, and rejects a non-positive value", () => {
    expect(loadTimeoutMs({})).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    expect(loadTimeoutMs({ PULSE_COMMAND_TIMEOUT_MS: "2500" })).toBe(2500);
    expect(() => loadTimeoutMs({ PULSE_COMMAND_TIMEOUT_MS: "-1" })).toThrow(CommandExporterConfigError);
  });
});

// ── metrics: exposition rendering + fail-visibility ──────────────────────────

describe("renderExposition / MetricStore", () => {
  test("a scalar signal emits metric{labels} value + upMetric{labels} up; host is NOT baked", () => {
    const store = new MetricStore([scalar()]);
    store.record("backup:db", { ok: true, value: 3600 });
    const text = store.render();
    expect(text).toContain('pulse_backup_freshness_age_seconds{service="db"} 3600');
    expect(text).toContain('pulse_backup_freshness_up{service="db"} 1');
    expect(text).toContain("# TYPE pulse_backup_freshness_age_seconds gauge");
    expect(text).not.toContain("host="); // host is applied at scrape time, never baked here
  });

  test("fail-visibility: on a later failure _up flips to 0 but the last-good value is retained", () => {
    const store = new MetricStore([scalar()]);
    store.record("backup:db", { ok: true, value: 3600 });
    store.record("backup:db", { ok: false });
    const text = store.render();
    expect(text).toContain('pulse_backup_freshness_age_seconds{service="db"} 3600'); // stale value kept
    expect(text).toContain('pulse_backup_freshness_up{service="db"} 0'); // but up = 0
  });

  test("a never-run scalar signal emits only its _up 0 (no value line)", () => {
    const text = new MetricStore([scalar()]).render();
    expect(text).toContain('pulse_backup_freshness_up{service="db"} 0');
    expect(text).not.toContain("pulse_backup_freshness_age_seconds{");
  });

  test("an exposition signal passes command text through and adds pulse_command_signal_up{signal}", () => {
    const store = new MetricStore([exposition()]);
    store.record("gpu", { ok: true, text: "pulse_gpu_util{gpu=\"0\"} 42\n" });
    const text = store.render();
    expect(text).toContain('pulse_gpu_util{gpu="0"} 42');
    expect(text).toContain(`${PULSE_COMMAND_SIGNAL_UP}{signal="gpu"} 1`);
  });

  test("an exposition failure flips the generic up to 0 and keeps the last-good passthrough", () => {
    const store = new MetricStore([exposition()]);
    store.record("gpu", { ok: true, text: "pulse_gpu_util 7\n" });
    store.record("gpu", { ok: false });
    const text = store.render();
    expect(text).toContain("pulse_gpu_util 7");
    expect(text).toContain(`${PULSE_COMMAND_SIGNAL_UP}{signal="gpu"} 0`);
  });

  test("TYPE headers are deduped across signals sharing an up_metric and emitted once", () => {
    const states = renderExposition([]); // empty → no headers, valid empty body
    expect(states).toBe("\n");
    const text = new MetricStore([
      scalar({ name: "backup:a", labels: { service: "a" } }),
      scalar({ name: "backup:b", labels: { service: "b" } }),
    ]).render();
    const typeLines = text.split("\n").filter((l) => l === "# TYPE pulse_backup_freshness_up gauge");
    expect(typeLines.length).toBe(1);
  });

  test("label values are escaped per the Prometheus text format", () => {
    const store = new MetricStore([scalar({ labels: { service: 'a"b\\c' } })]);
    store.record("backup:db", { ok: true, value: 1 });
    expect(store.render()).toContain('service="a\\"b\\\\c"');
  });
});

// ── run: real subprocess execution (argv, no shell) ──────────────────────────

describe("runSignal", () => {
  test("a scalar command's numeric stdout is parsed", async () => {
    const out = await runSignal(scalar({ command: ["printf", "3600"] }), 5_000);
    expect(out).toEqual({ ok: true, value: 3600 });
  });

  test("a scalar command whose stdout is not a number reports blind", async () => {
    const out = await runSignal(scalar({ command: ["printf", "not-a-number"] }), 5_000);
    expect(out).toEqual({ ok: false });
  });

  test("an exposition command's stdout is returned verbatim", async () => {
    const out = await runSignal(exposition({ command: ["printf", "pulse_x 1\\n"] }), 5_000);
    expect(out.ok).toBe(true);
    expect(out.text).toContain("pulse_x 1");
  });

  test("a non-zero exit reports blind", async () => {
    const out = await runSignal(exposition({ command: ["false"] }), 5_000);
    expect(out).toEqual({ ok: false });
  });

  test("a missing command binary reports blind (never throws)", async () => {
    const out = await runSignal(exposition({ command: ["/no/such/binary/here"] }), 5_000);
    expect(out).toEqual({ ok: false });
  });

  test("a hanging command is killed at the timeout and reports blind (never blocks)", async () => {
    const t0 = Date.now();
    const out = await runSignal(exposition({ command: ["sleep", "10"] }), 300);
    // Killed well before the command's own 10s — proves the timeout bounds a hang.
    expect(Date.now() - t0 < 5_000).toBe(true);
    expect(out).toEqual({ ok: false });
  }, 10_000);
});

// ── index: routing + tick resilience ─────────────────────────────────────────

describe("handleRequest routing", () => {
  const store = new MetricStore([exposition()]);
  test("GET /metrics returns the exposition with the 0.0.4 content type", () => {
    const res = handleRequest(new Request("http://x/metrics"), store);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("version=0.0.4");
  });
  test("/healthz returns ok and any other path is 404", () => {
    expect(handleRequest(new Request("http://x/healthz"), store).status).toBe(200);
    expect(handleRequest(new Request("http://x/nope"), store).status).toBe(404);
  });
});

describe("runSignalInto resilience", () => {
  test("a throwing runFn is caught and recorded as blind (_up 0), never crashing the loop", async () => {
    const store = new MetricStore([exposition()]);
    await runSignalInto(store, exposition(), 1_000, () => {
      throw new Error("boom");
    });
    expect(store.render()).toContain(`${PULSE_COMMAND_SIGNAL_UP}{signal="gpu"} 0`);
  });
});
