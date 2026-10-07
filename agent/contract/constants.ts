// agent/contract/constants.ts
//
// Shared host-agent constants (00-core-definitions.md §3). Referenced by the prober,
// the heartbeat exporter, the delivery-form templates, and the tests. Hand-authored;
// no runtime behavior lives here.

/** Per-host bundle component ports (published scrape-port contract, REQ-BUNDLE-03). */
export const NODE_EXPORTER_PORT = 9100 as const;
export const CADVISOR_PORT = 8080 as const; // present iff host.cadvisor === true
export const HEARTBEAT_PORT = 9110 as const;

/** Central deep-health prober port — one per stack, NOT per host (tech-spec §3.7 V-004). */
export const PROBER_PORT = 9120 as const;

/** Per-host command-exporter port (issue #3/#1). Present on a managed-linux host IFF it runs ≥1
 *  command signal; discovered through its dedicated managed-linux-command-exporter job. */
export const COMMAND_EXPORTER_PORT = 9130 as const;

/** Command-exporter per-command execution timeout (ms) — overridable via PULSE_COMMAND_TIMEOUT_MS.
 *  A command that exceeds it is killed and its signal reports blind (`_up = 0`). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000 as const;

/** The metric-contract version (REQ-METRIC-03). A single integer, bumped deliberately on
 *  any metric name/label change — mirrors core's CURRENT_SCHEMA_MAJOR. Bumped 1 → 2 (issue #3)
 *  when the `command` family was added (pulse_backup_freshness_age_seconds / _up delivered, plus
 *  pulse_command_signal_up) — adding a series is a version-bump event per the contract policy. */
export const CONTRACT_VERSION = 2 as const;

/** The only ProberEntry.kind host-agent's prober interprets (REQ-PROBE-06). */
export const DEEP_HEALTH_KIND = "deep-health" as const;

/** Prober bounds (REQ-PERF-02) — overridable through validated PULSE_PROBE_* env vars. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000 as const; // per-probe HTTP timeout
export const DEFAULT_PROBE_CADENCE_MS = 30_000 as const; // probe loop interval
export const DEFAULT_PROBE_CONCURRENCY = 8 as const; // bounded worker pool size

/** Pinned component tags (REQ-BUNDLE-06, REQ-DET-01) — never `latest`/floating.
 *  cAdvisor stays aligned with the stack's existing `gcr.io/cadvisor/cadvisor:v0.49.1`
 *  (stack/compose/docker-compose.yml). node_exporter is the pinned upstream stable
 *  release; the two Bun-based images built here pin the same base as the dev toolchain. */
export const PINNED = {
  nodeExporter: "prom/node-exporter:v1.8.2",
  cadvisor: "gcr.io/cadvisor/cadvisor:v0.49.1",
  proberBase: "oven/bun:1.3.9",
  heartbeatBase: "oven/bun:1.3.9",
  commandExporterBase: "oven/bun:1.3.9",
} as const;
