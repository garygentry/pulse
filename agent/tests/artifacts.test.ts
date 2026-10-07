/// <reference path="./bun-test.d.ts" />
//
// Item 008 — the published static contract artifacts under `agent/contract/`:
//   • config.schema.json — the rendered per-host config schema (05 §2)
//   • metrics.json        — the authoritative agent-metrics-contract (04 §6)
//   • metrics-contract.md — the human companion (04 §7)
//
// This suite parses the on-disk artifacts and holds them to the TypeScript constants/types
// the prober and heartbeat actually emit against, so a name/label drift or an unbumped
// contractVersion fails the build (04 §9, 06 §7). It imports NO @pulse/* package — it asserts
// against on-disk JSON + the agent/contract TS surface only (06 §1).

import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { CONTRACT_VERSION } from "../contract/constants.js";
import {
  PULSE_AGENT_BUILD_INFO,
  PULSE_AGENT_UP,
  PULSE_BACKUP_FRESHNESS_AGE_SECONDS,
  PULSE_BACKUP_FRESHNESS_UP,
  PULSE_COMMAND_SIGNAL_UP,
  PULSE_DEEP_HEALTH,
  PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS,
  PULSE_DEEP_HEALTH_UP,
  type MetricsContract,
} from "../contract/types.js";
import {
  CONFIG_SCHEMA_PATH,
  METRICS_CONTRACT_MD_PATH,
  METRICS_JSON_PATH,
  validateJsonSchema,
} from "./harness.js";

const configSchema: unknown = JSON.parse(readFileSync(CONFIG_SCHEMA_PATH, "utf8"));
const metrics = JSON.parse(readFileSync(METRICS_JSON_PATH, "utf8")) as MetricsContract;
const metricsMd = readFileSync(METRICS_CONTRACT_MD_PATH, "utf8");

// ── config.schema.json (05 §2, §9) ────────────────────────────────────────────────────

/** A valid compose host with cAdvisor OFF, heartbeat ON — scrapePorts.heartbeat present, no cadvisor. */
const validCompose = {
  host: "web01",
  deliveryForm: "compose",
  cadvisor: false,
  heartbeat: true,
  scrapePorts: { node: 9100, heartbeat: 9110 },
};

/** A valid systemd host with cAdvisor ON, heartbeat ON — both scrapePorts present. */
const validSystemd = {
  host: "app02",
  deliveryForm: "systemd",
  cadvisor: true,
  heartbeat: true,
  scrapePorts: { node: 9100, cadvisor: 8080, heartbeat: 9110 },
};

describe("config.schema.json — accepts both valid delivery forms", () => {
  test("a cadvisor:false compose host validates", () => {
    expect(validateJsonSchema(configSchema, validCompose)).toEqual([]);
  });

  test("a cadvisor:true systemd host validates", () => {
    expect(validateJsonSchema(configSchema, validSystemd)).toEqual([]);
  });
});

describe("config.schema.json — rejects malformed configs", () => {
  test("an unknown top-level key is rejected (additionalProperties: false)", () => {
    const bad = { ...validCompose, surprise: 1 };
    expect(validateJsonSchema(configSchema, bad).length).not.toBe(0);
  });

  test("an unknown scrapePorts key is rejected", () => {
    const bad = { ...validCompose, scrapePorts: { node: 9100, heartbeat: 9110, extra: 1 } };
    expect(validateJsonSchema(configSchema, bad).length).not.toBe(0);
  });

  test("a missing required field is rejected", () => {
    const { host: _host, ...noHost } = validCompose;
    expect(validateJsonSchema(configSchema, noHost).length).not.toBe(0);
    // node is the only required scrape port (heartbeat is optional since issue #30); dropping it
    // must be rejected.
    const { node: _node, ...noNode } = validCompose.scrapePorts;
    expect(
      validateJsonSchema(configSchema, { ...validCompose, scrapePorts: noNode }).length,
    ).not.toBe(0);
  });

  test("a node-exporter-only config (heartbeat: false, no heartbeat port) is accepted (issue #30/#33)", () => {
    const { heartbeat: _hb, ...noHeartbeat } = validCompose.scrapePorts;
    expect(
      // heartbeat: false coherent with the dropped port (mirror of a cadvisor: false host).
      validateJsonSchema(configSchema, { ...validCompose, heartbeat: false, scrapePorts: noHeartbeat }),
    ).toEqual([]);
  });

  test("a deliveryForm outside the enum is rejected", () => {
    const bad = { ...validCompose, deliveryForm: "ansible" };
    expect(validateJsonSchema(configSchema, bad).length).not.toBe(0);
  });

  test("a port outside 1..65535 or a non-integer port is rejected", () => {
    const zero = { ...validCompose, scrapePorts: { node: 0, heartbeat: 9110 } };
    const tooBig = { ...validCompose, scrapePorts: { node: 9100, heartbeat: 70000 } };
    const float = { ...validCompose, scrapePorts: { node: 9100.5, heartbeat: 9110 } };
    expect(validateJsonSchema(configSchema, zero).length).not.toBe(0);
    expect(validateJsonSchema(configSchema, tooBig).length).not.toBe(0);
    expect(validateJsonSchema(configSchema, float).length).not.toBe(0);
  });

  test("both cAdvisor coherence violations are rejected", () => {
    // cadvisor: true but scrapePorts.cadvisor absent (heartbeat kept coherent to isolate the cadvisor rule)
    const missingPort = {
      host: "web01",
      deliveryForm: "compose",
      cadvisor: true,
      heartbeat: true,
      scrapePorts: { node: 9100, heartbeat: 9110 },
    };
    // cadvisor: false but scrapePorts.cadvisor present
    const strayPort = {
      host: "web01",
      deliveryForm: "compose",
      cadvisor: false,
      heartbeat: true,
      scrapePorts: { node: 9100, cadvisor: 8080, heartbeat: 9110 },
    };
    expect(validateJsonSchema(configSchema, missingPort).length).not.toBe(0);
    expect(validateJsonSchema(configSchema, strayPort).length).not.toBe(0);
  });

  test("both heartbeat coherence violations are rejected (issue #33)", () => {
    // heartbeat: true but scrapePorts.heartbeat absent (cadvisor kept coherent to isolate the heartbeat rule)
    const missingPort = {
      host: "web01",
      deliveryForm: "compose",
      cadvisor: false,
      heartbeat: true,
      scrapePorts: { node: 9100 },
    };
    // heartbeat: false but scrapePorts.heartbeat present
    const strayPort = {
      host: "web01",
      deliveryForm: "compose",
      cadvisor: false,
      heartbeat: false,
      scrapePorts: { node: 9100, heartbeat: 9110 },
    };
    expect(validateJsonSchema(configSchema, missingPort).length).not.toBe(0);
    expect(validateJsonSchema(configSchema, strayPort).length).not.toBe(0);
  });

  test("a missing required heartbeat boolean is rejected (issue #33)", () => {
    const { heartbeat: _hb, ...noHeartbeatFlag } = validCompose;
    expect(validateJsonSchema(configSchema, noHeartbeatFlag).length).not.toBe(0);
  });
});

// ── metrics.json conformance (04 §6, §9; 06 §7) ───────────────────────────────────────

const EXPECTED_KINDS = ["node", "container", "deep-health", "heartbeat", "command"] as const;

/** The exact per-series label sets (04 §3.1–§3.4; issue #3 command family). `host` is scrape-applied
 *  for the command series (like node's `instance`); it is listed as a carried label, not baked. */
const EXPECTED_LABELS: Record<string, string[]> = {
  "node_*": ["instance"],
  "container_*": ["instance", "name"],
  [PULSE_DEEP_HEALTH]: ["host", "service", "metric"],
  [PULSE_DEEP_HEALTH_UP]: ["host", "service"],
  [PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS]: ["host", "service"],
  [PULSE_AGENT_UP]: ["host"],
  [PULSE_AGENT_BUILD_INFO]: ["host", "version", "component"],
  [PULSE_BACKUP_FRESHNESS_AGE_SECONDS]: ["host", "service"],
  [PULSE_BACKUP_FRESHNESS_UP]: ["host", "service"],
  [PULSE_COMMAND_SIGNAL_UP]: ["host", "signal"],
};

/** The Pulse-owned series names, in family order — sourced from the TS constants so a drift
 *  in either the JSON or the constants surfaces as a mismatch. */
const PULSE_SERIES = [
  PULSE_DEEP_HEALTH,
  PULSE_DEEP_HEALTH_UP,
  PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS,
  PULSE_AGENT_UP,
  PULSE_AGENT_BUILD_INFO,
  PULSE_BACKUP_FRESHNESS_AGE_SECONDS,
  PULSE_BACKUP_FRESHNESS_UP,
  PULSE_COMMAND_SIGNAL_UP,
];

/**
 * The full conformance check, factored so a drift test can run it against a mutated copy and
 * prove it fails (AC: "Contract tests fail on a Pulse name/label drift or contractVersion
 * mismatch"). Returns the list of conformance errors; empty means conformant.
 */
function conformanceErrors(contract: MetricsContract): string[] {
  const errors: string[] = [];

  if (contract.contractVersion !== CONTRACT_VERSION) {
    errors.push(`contractVersion ${contract.contractVersion} !== CONTRACT_VERSION ${CONTRACT_VERSION}`);
  }

  const kinds = contract.families.map((f) => f.kind);
  if (JSON.stringify(kinds) !== JSON.stringify(EXPECTED_KINDS)) {
    errors.push(`families must be exactly ${JSON.stringify(EXPECTED_KINDS)}, got ${JSON.stringify(kinds)}`);
  }

  const seenPulse: string[] = [];
  for (const family of contract.families) {
    for (const series of family.series) {
      if (!series.name.startsWith(family.prefix)) {
        errors.push(`series '${series.name}' does not carry family prefix '${family.prefix}'`);
      }
      const isPulseOwned = family.prefix === "pulse_";
      if (series.passthrough !== !isPulseOwned) {
        errors.push(`series '${series.name}' passthrough ${series.passthrough} inconsistent with prefix '${family.prefix}'`);
      }
      if (isPulseOwned) seenPulse.push(series.name);

      const expectedLabels = EXPECTED_LABELS[series.name];
      if (expectedLabels === undefined) {
        errors.push(`series '${series.name}' is not a known contract series`);
      } else if (JSON.stringify(series.labels) !== JSON.stringify(expectedLabels)) {
        errors.push(`series '${series.name}' labels ${JSON.stringify(series.labels)} !== ${JSON.stringify(expectedLabels)}`);
      }
    }
  }

  if (JSON.stringify(seenPulse) !== JSON.stringify(PULSE_SERIES)) {
    errors.push(`pulse-owned series ${JSON.stringify(seenPulse)} !== constants ${JSON.stringify(PULSE_SERIES)}`);
  }

  return errors;
}

describe("metrics.json — conforms to MetricsContract", () => {
  test("contractVersion equals CONTRACT_VERSION and is 2", () => {
    expect(metrics.contractVersion).toBe(CONTRACT_VERSION);
    expect(metrics.contractVersion).toBe(2); // bumped when the command family landed (issue #3)
  });

  test("exactly the five families in canonical order", () => {
    expect(metrics.families.map((f) => f.kind)).toEqual([...EXPECTED_KINDS]);
  });

  test("every Pulse-owned series name equals its PULSE_* constant", () => {
    const pulseNames = metrics.families
      .filter((f) => f.prefix === "pulse_")
      .flatMap((f) => f.series.map((s) => s.name));
    expect(pulseNames).toEqual(PULSE_SERIES);
  });

  test("passthrough flags and prefixes are coherent per family", () => {
    for (const family of metrics.families) {
      const isPulseOwned = family.prefix === "pulse_";
      for (const series of family.series) {
        expect(series.name.startsWith(family.prefix)).toBe(true);
        expect(series.passthrough).toBe(!isPulseOwned);
      }
    }
  });

  test("every series carries its exact contract label set", () => {
    for (const family of metrics.families) {
      for (const series of family.series) {
        expect(series.labels).toEqual(EXPECTED_LABELS[series.name]);
      }
    }
  });

  test("the container family is telemetry, never a liveness signal (REQ-CONT-03)", () => {
    const container = metrics.families.find((f) => f.kind === "container");
    expect(container?.series.map((s) => s.name)).toEqual(["container_*"]);
    // No container series is named or flagged as a liveness/up signal.
    for (const series of container?.series ?? []) {
      expect(series.name.includes("_up")).toBe(false);
      expect(series.description.toLowerCase().includes("never a service liveness")).toBe(true);
    }
  });

  test("the live artifact is fully conformant", () => {
    expect(conformanceErrors(metrics)).toEqual([]);
  });
});

describe("metrics.json — the conformance check catches drift (AC)", () => {
  test("a renamed Pulse series fails conformance", () => {
    const drifted = JSON.parse(JSON.stringify(metrics)) as MetricsContract;
    const hb = drifted.families.find((f) => f.kind === "heartbeat");
    const first = hb?.series[0];
    if (first) first.name = "pulse_agent_alive"; // drift from PULSE_AGENT_UP
    expect(conformanceErrors(drifted).length).not.toBe(0);
  });

  test("a changed label key fails conformance", () => {
    const drifted = JSON.parse(JSON.stringify(metrics)) as MetricsContract;
    const dh = drifted.families.find((f) => f.kind === "deep-health");
    const first = dh?.series[0];
    if (first) first.labels = ["host", "service"]; // dropped the `metric` label
    expect(conformanceErrors(drifted).length).not.toBe(0);
  });

  test("a bumped contractVersion without a constant bump fails conformance", () => {
    const drifted = JSON.parse(JSON.stringify(metrics)) as MetricsContract;
    drifted.contractVersion = CONTRACT_VERSION + 1;
    expect(conformanceErrors(drifted).length).not.toBe(0);
  });
});

// ── metrics-contract.md mirrors the JSON (04 §7) ──────────────────────────────────────

describe("metrics-contract.md — mirrors the JSON and states the normative rules", () => {
  test("carries the same contract version as metrics.json", () => {
    expect(metricsMd.includes(`Contract version: ${metrics.contractVersion}`)).toBe(true);
  });

  test("names every contract series present in metrics.json", () => {
    for (const family of metrics.families) {
      for (const series of family.series) {
        expect(metricsMd.includes(series.name)).toBe(true);
      }
    }
  });

  test("states versioning, host-label reconciliation, and container-not-liveness", () => {
    expect(metricsMd.toLowerCase().includes("versioning")).toBe(true);
    expect(metricsMd.includes("host` ⇔ `instance") || metricsMd.includes("host ⇔ instance")).toBe(true);
    expect(metricsMd.includes("Container health is NOT a service liveness signal")).toBe(true);
  });
});
