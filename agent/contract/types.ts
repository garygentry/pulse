// agent/contract/types.ts
//
// The only importable surface host-agent exposes (01-architecture-layout.md §4): the
// rendered-config shape, the prober config input/narrowed view, and the machine-readable
// metric-contract shapes. Self-contained by design — @pulse/core model types (Host,
// DeepHealthProbe, SecretRef) are consumed BY REFERENCE only and are never redeclared
// here (00-core-definitions.md §2 policy). Credentials cross this boundary as
// `SecretRef.raw` strings only (REQ-SEC-01), never as resolved material.

// ── Rendered per-host config (config.schema.json shape — REQ-CFG-01, 00 §4) ───────────

/** Bundle delivery form (REQ-BUNDLE-02). Selects compose fragment vs systemd units from
 *  one shared config; both consume the SAME AgentHostConfig (REQ-CFG-03). */
export type DeliveryForm = "compose" | "systemd";

/** Published local scrape ports for a host's bundle components (REQ-BUNDLE-03).
 *  `cadvisor` is present IFF the host opted into cAdvisor (REQ-CONT-01); `heartbeat` is present
 *  IFF the host opted into heartbeat (issue #30/#33).
 *
 *  DESIGN NOTE — cAdvisor and heartbeat are now SYMMETRIC (issue #33): each carries a top-level
 *  `AgentHostConfig` boolean (`cadvisor` / `heartbeat`) plus its port here, cross-checked by the
 *  schema's `allOf` coherence rules (port present IFF the boolean is true). Deploy-toolkit reads
 *  the ONE boolean per bundle member to decide whether to activate the compose profile / install
 *  the systemd unit. A consumer MUST test the boolean (or, equivalently, `scrapePorts.X !== undefined`)
 *  — never assume either exporter is always present. They default differently in the estate:
 *  cadvisor OFF, heartbeat ON (packages/core/src/schema/host.ts). */
export interface ScrapePorts {
  /** node_exporter port — always present (REQ-NODE-01). */
  node: number;
  /** cAdvisor port — present only when the host declares `cadvisor: true` (REQ-CONT-01). */
  cadvisor?: number;
  /** heartbeat exporter port — present only when the host declares `heartbeat: true` (`heartbeat`
   *  defaults true in the estate; issue #30/#33). Absent for a node-exporter-only host. Coherent
   *  with the top-level `AgentHostConfig.heartbeat` boolean via the schema's `allOf` rule. */
  heartbeat?: number;
}

/** The rendered per-host bundle config — the shape of `rendered/agent/<host>.yaml`
 *  (REQ-CFG-01). Estate-agnostic templates consume this to assemble the installed bundle;
 *  the deep-health probe set is NOT here (it is the central `prober/config.yaml`, §5). */
export interface AgentHostConfig {
  /** Host identity — matches the estate host `name`. */
  host: string;
  /** Which delivery form this host installs (REQ-BUNDLE-02). */
  deliveryForm: DeliveryForm;
  /** cAdvisor opt-in for this host (REQ-CONT-01). */
  cadvisor: boolean;
  /** heartbeat exporter opt-in for this host (issue #30/#33; defaults true in the estate). Gates
   *  the heartbeat container/unit install symmetrically with `cadvisor`. */
  heartbeat: boolean;
  /** Local scrape ports the central engine reaches (REQ-BUNDLE-03). */
  scrapePorts: ScrapePorts;
}

// ── Prober config input (consumed from pulse-cli — 00 §5) ─────────────────────────────

/** The shipped ProberEntry shape (packages/renderer/src/render/prober.ts) — consumed as
 *  data from `rendered/prober/config.yaml`. Host-agent owns only the interpretation of
 *  `kind: "deep-health"` entries (REQ-PROBE-06). */
export interface ProberEntry {
  /** Stable name: "svc:<host>/<service>", "svc:<host>/<service>#backup", or "host:<name>". */
  name: string;
  /** Probe endpoint/target/signal. */
  target: string;
  /** "deep-health" | "backup-freshness" | a host ProbeSpec.kind. */
  kind: string;
  /** JSONPath → metric-name map for a deep-health probe; omitted otherwise. */
  responseMapping?: Record<string, string>;
  /** The declared alert expression (opaque) for a deep-health probe; omitted otherwise. */
  alertExpression?: string;
  /** Backup-freshness threshold (opaque); omitted otherwise. */
  threshold?: string;
  /** A probe-only host's ProbeSpec.expect; omitted otherwise. */
  note?: string;
  /** Credential reference for an authed deep-health probe — SecretRef.raw only (ECR).
   *  Carried by the renderer per tech-spec §3.4; never a literal (REQ-SEC-01). */
  credential?: string;
}

/** The top-level shape of `rendered/prober/config.yaml` (consumed; may be absent). */
export interface ProberConfig {
  probes: ProberEntry[];
}

/** A ProberEntry narrowed to a deep-health probe the prober will execute (REQ-PROBE-06).
 *  `host`/`service` are parsed from `name` ("svc:<host>/<service>"); `metrics` is the
 *  responseMapping (required for a deep-health entry). */
export interface DeepHealthProbeConfig {
  /** Parsed from `name` — the "svc:<host>/<service>" prefix host segment. */
  host: string;
  /** Parsed from `name` — the service segment. */
  service: string;
  /** JSON health endpoint to GET (`ProberEntry.target`). */
  target: string;
  /** metricName → JSONPath, from `ProberEntry.responseMapping`. */
  metrics: Record<string, string>;
  /** The declared single-metric alert expression (opaque; carried, not evaluated here). */
  alertExpression?: string;
  /** SecretRef.raw for Bearer auth, resolved from env at runtime (REQ-PROBE-03). */
  credential?: string;
}

// ── Command-exporter config (rendered command-exporter/<host>.yaml — issue #3/#1) ─────

/** One rendered command signal (packages/renderer/src/render/command-exporter.ts). The exporter
 *  runs `command` (argv, no shell) every `intervalMs` and publishes its output per `output`:
 *   - `scalar`     — stdout is ONE number → `metric{labels}` (the value) + `upMetric{labels}` (1/0).
 *   - `exposition` — stdout is Prometheus text → passed through + `pulse_command_signal_up{signal}`.
 *  `credential` (SecretRef.raw only) is injected into the command's environment when present. */
export type CommandSignalConfig =
  | {
      output: "scalar";
      name: string;
      command: string[];
      intervalMs: number;
      metric: string;
      upMetric: string;
      labels?: Record<string, string>;
      credential?: string;
    }
  | {
      output: "exposition";
      name: string;
      command: string[];
      intervalMs: number;
      credential?: string;
    };

/** The top-level shape of a rendered `command-exporter/<host>.yaml` (consumed; may be absent). */
export interface CommandExporterConfig {
  signals: CommandSignalConfig[];
}

// ── Metric contract (agent-metrics-contract — REQ-METRIC-01..04, 00 §6) ───────────────

/** Pulse-owned metric series names (pulse_ prefix, REQ-METRIC-02). */
export const PULSE_DEEP_HEALTH = "pulse_deep_health" as const;
export const PULSE_DEEP_HEALTH_UP = "pulse_deep_health_up" as const;
export const PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS = "pulse_deep_health_last_scrape_seconds" as const;
export const PULSE_AGENT_UP = "pulse_agent_up" as const;
export const PULSE_AGENT_BUILD_INFO = "pulse_agent_build_info" as const;

/** Command-exporter liveness for an `exposition` signal (issue #3/#1): 1 = the command ran and
 *  produced output this cycle, 0 = it failed/couldn't run (never pretend healthy when blind). A
 *  `scalar` signal instead emits its own declared `up_metric` (config-driven), not this constant. */
export const PULSE_COMMAND_SIGNAL_UP = "pulse_command_signal_up" as const;

/** Delivered backup-freshness contract (issue #3) — the series `stack/alerting` selects. Emitted by
 *  a `scalar` command signal synthesized from a service's `backup_freshness.command`. */
export const PULSE_BACKUP_FRESHNESS_AGE_SECONDS = "pulse_backup_freshness_age_seconds" as const;
export const PULSE_BACKUP_FRESHNESS_UP = "pulse_backup_freshness_up" as const;

/** The exact set of Pulse-owned series names (union of the five PULSE_* constants). */
export type PulseSeriesName =
  | typeof PULSE_DEEP_HEALTH
  | typeof PULSE_DEEP_HEALTH_UP
  | typeof PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS
  | typeof PULSE_AGENT_UP
  | typeof PULSE_AGENT_BUILD_INFO;

/** A metric family in the published contract. `command` covers the command-exporter's delivered
 *  series (issue #3/#1): the backup-freshness contract, per-signal liveness, and operator-defined
 *  scalar/exposition series (whose exact names live in the estate config, not enumerated here). */
export type MetricFamilyKind = "node" | "container" | "deep-health" | "heartbeat" | "command";

/** One series in the contract: its name, the labels it carries, and whether it is a
 *  pass-through (upstream) series or a Pulse-owned (`pulse_`) series. */
export interface MetricSeries {
  /** Exact series name (e.g. "pulse_deep_health", or a "node_*" family reference). */
  name: string;
  /** Label keys every point of this series carries (REQ-METRIC-04). */
  labels: string[];
  /** true = upstream pass-through (node_ / container_ series); false = Pulse-owned (pulse_). */
  passthrough: boolean;
  /** One-line human description for `metrics-contract.md`. */
  description: string;
}

/** A metric family grouping (REQ-METRIC-01). */
export interface MetricFamily {
  kind: MetricFamilyKind;
  /** Name prefix: "node_", "container_", or "pulse_". */
  prefix: string;
  /** Enumerated series. Pass-through families reference the upstream set by prefix
   *  rather than enumerating every field (tech-spec §4.4). */
  series: MetricSeries[];
}

/** The machine-readable `agent-metrics-contract` — the shape of `agent/contract/metrics.json`
 *  (REQ-METRIC-01/03). A versioned surface downstream builds against. */
export interface MetricsContract {
  /** Bumped deliberately on any metric name/label change (REQ-METRIC-03). */
  contractVersion: number;
  /** The four families (REQ-METRIC-01). */
  families: MetricFamily[];
}
