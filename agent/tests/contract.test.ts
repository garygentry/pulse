// agent/tests/contract.test.ts
//
// Focused coverage for the shared agent contract foundation (item 007): the constants,
// the exported contract types, the ProberError hierarchy, and the ProbeOutcome union.
// Importing the contract/prober source here also pulls those files into the agent/tests
// tsconfig program so `tsc -b` typechecks them (01-architecture-layout.md §3.1).

import { describe, expect, test } from "bun:test";

import {
  CADVISOR_PORT,
  CONTRACT_VERSION,
  DEEP_HEALTH_KIND,
  DEFAULT_PROBE_CADENCE_MS,
  DEFAULT_PROBE_CONCURRENCY,
  DEFAULT_PROBE_TIMEOUT_MS,
  HEARTBEAT_PORT,
  NODE_EXPORTER_PORT,
  PINNED,
  PROBER_PORT,
} from "../contract/constants.js";
import {
  PULSE_AGENT_BUILD_INFO,
  PULSE_AGENT_UP,
  PULSE_DEEP_HEALTH,
  PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS,
  PULSE_DEEP_HEALTH_UP,
  type AgentHostConfig,
  type DeepHealthProbeConfig,
  type MetricsContract,
  type ProberConfig,
  type PulseSeriesName,
} from "../contract/types.js";
import { ProbeExecutionError, ProberConfigError, ProberError } from "../prober/src/errors.js";
import type { ProbeOutcome } from "../prober/src/probe-outcome.js";

describe("contract constants", () => {
  test("expose the four published ports", () => {
    expect(NODE_EXPORTER_PORT).toBe(9100);
    expect(CADVISOR_PORT).toBe(8080);
    expect(HEARTBEAT_PORT).toBe(9110);
    expect(PROBER_PORT).toBe(9120);
  });

  test("contract version is 2 and deep-health kind is stable", () => {
    expect(CONTRACT_VERSION).toBe(2); // bumped 1 → 2 when the command family landed (issue #3)
    expect(DEEP_HEALTH_KIND).toBe("deep-health");
  });

  test("probe bounds are the documented defaults", () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(5_000);
    expect(DEFAULT_PROBE_CADENCE_MS).toBe(30_000);
    expect(DEFAULT_PROBE_CONCURRENCY).toBe(8);
  });

  test("image pins are concrete and non-floating", () => {
    expect(PINNED.cadvisor).toBe("gcr.io/cadvisor/cadvisor:v0.49.1"); // aligned with the stack
    const tags = [PINNED.nodeExporter, PINNED.cadvisor, PINNED.proberBase, PINNED.heartbeatBase];
    for (const tag of tags) {
      const version = tag.split(":")[1] ?? "";
      expect(version.length).not.toBe(0);
      expect(version).not.toBe("latest");
      expect(version).not.toBe("PINNED");
      // A concrete pin carries at least one digit and no floating/placeholder marker.
      expect(/\d/.test(version)).toBe(true);
      expect(/PINNED|latest|vPINNED/.test(tag)).toBe(false);
    }
  });
});

describe("contract types", () => {
  test("the five Pulse series names are exact and cover PulseSeriesName", () => {
    const names: PulseSeriesName[] = [
      PULSE_DEEP_HEALTH,
      PULSE_DEEP_HEALTH_UP,
      PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS,
      PULSE_AGENT_UP,
      PULSE_AGENT_BUILD_INFO,
    ];
    expect(names).toEqual([
      "pulse_deep_health",
      "pulse_deep_health_up",
      "pulse_deep_health_last_scrape_seconds",
      "pulse_agent_up",
      "pulse_agent_build_info",
    ]);
  });

  test("AgentHostConfig / prober / metric shapes are constructible", () => {
    const cfg: AgentHostConfig = {
      host: "web01",
      deliveryForm: "compose",
      cadvisor: true,
      heartbeat: true,
      scrapePorts: { node: NODE_EXPORTER_PORT, cadvisor: CADVISOR_PORT, heartbeat: HEARTBEAT_PORT },
    };
    expect(cfg.scrapePorts.cadvisor).toBe(8080);

    const probes: ProberConfig = {
      probes: [{ name: "svc:web01/frigate", target: "http://x/health", kind: DEEP_HEALTH_KIND }],
    };
    expect(probes.probes.length).toBe(1);

    const narrowed: DeepHealthProbeConfig = {
      host: "web01",
      service: "frigate",
      target: "http://x/health",
      metrics: { camera_count: "$.cameras.length" },
    };
    expect(narrowed.credential).toBe(undefined);

    const contract: MetricsContract = {
      contractVersion: CONTRACT_VERSION,
      families: [{ kind: "heartbeat", prefix: "pulse_", series: [] }],
    };
    expect(contract.contractVersion).toBe(2);
  });
});

describe("prober error hierarchy", () => {
  test("ProberConfigError preserves instanceof and typed context", () => {
    const err = new ProberConfigError("/rendered/prober/config.yaml", "bad yaml");
    expect(err instanceof ProberConfigError).toBe(true);
    expect(err instanceof ProberError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err.code).toBe("PROBER_CONFIG_INVALID");
    expect(err.configPath).toBe("/rendered/prober/config.yaml");
    expect(err.name).toBe("ProberConfigError");
  });

  test("ProbeExecutionError preserves instanceof and typed reason", () => {
    const err = new ProbeExecutionError("svc:web01/frigate", "timeout", "took too long");
    expect(err instanceof ProbeExecutionError).toBe(true);
    expect(err instanceof ProberError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err.code).toBe("PROBE_EXECUTION_FAILED");
    expect(err.probeName).toBe("svc:web01/frigate");
    expect(err.reason).toBe("timeout");
  });
});

describe("ProbeOutcome discriminated union", () => {
  test("success carries samples and scrapedAt", () => {
    const outcome: ProbeOutcome = {
      ok: true,
      host: "web01",
      service: "frigate",
      samples: { camera_count: 6 },
      scrapedAt: 1_700_000_000,
    };
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.samples.camera_count).toBe(6);
      expect(outcome.scrapedAt).toBe(1_700_000_000);
    }
  });

  test("failure carries only the error and no samples/scrapedAt", () => {
    const outcome: ProbeOutcome = {
      ok: false,
      host: "web01",
      service: "frigate",
      error: new ProbeExecutionError("svc:web01/frigate", "unreachable", "connection refused"),
    };
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.reason).toBe("unreachable");
      expect("samples" in outcome).toBe(false);
      expect("scrapedAt" in outcome).toBe(false);
    }
  });
});
