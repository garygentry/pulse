# API Reference

host-agent's runtime code is three small Bun servers with no callable API — each serves only
`GET /metrics` (and, for the probers and command-exporter, `GET /healthz`). Its "API" is the set
of stable **contracts** a deploy and downstream features build against: the component ports, the
HTTP surface, the published metric contract, the rendered-config input shapes it consumes, the
environment variables that tune it, the pinned images, and the one importable TypeScript surface.

Unless noted, every constant below is exported from `agent/contract/constants.ts` or
`agent/contract/types.ts` — the hand-authored contract modules the components and tests share.

## Component ports

```typescript
export const NODE_EXPORTER_PORT     = 9100;  // always present (REQ-NODE-01)
export const CADVISOR_PORT          = 8080;  // present iff host.cadvisor === true
export const HEARTBEAT_PORT         = 9110;  // always present
export const PROBER_PORT            = 9120;  // central prober (one per stack) AND per-host prober
export const COMMAND_EXPORTER_PORT  = 9130;  // present iff the host runs ≥1 command signal
```

`:9120` is shared by both prober modes: the central prober binds it inside its container; the
per-host prober binds it on the host under `network_mode: host`. They never collide — the central
prober does not run on a managed-linux host.

## HTTP surface

Every component serves an immutable, read-only surface — no write or control route.

| Component | Routes | Non-matching |
|-----------|--------|--------------|
| heartbeat | `GET /metrics` | other path → 404; non-GET on `/metrics` → 405 |
| central / per-host prober | `GET /metrics`, `GET /healthz` | other path → 404 |
| command-exporter | `GET /metrics`, `GET /healthz` | other path → 404 |

`/metrics` returns `text/plain; version=0.0.4`. The probers and command-exporter serve `/metrics`
**immediately** at startup (empty until the first cycle completes) so a scrape never 404s; a fatal
config error exits non-zero **before** the server binds, which surfaces as a failed healthcheck.
node_exporter and cAdvisor expose their upstream surfaces unchanged.

## Metric contract

The published, versioned surface downstream builds against — machine-readable in
`agent/contract/metrics.json` (validated against `MetricsContract`), human-readable in
`agent/contract/metrics-contract.md`. Both carry `contractVersion`, sourced from
`CONTRACT_VERSION` (currently **2**). Five families:

| Family | Prefix | Emitted by | Kind |
|--------|--------|-----------|------|
| `node` | `node_` | node_exporter | pass-through (referenced by prefix, not enumerated) |
| `container` | `container_` | cAdvisor (opt-in) | pass-through |
| `heartbeat` | `pulse_` | heartbeat exporter | Pulse-owned |
| `deep-health` | `pulse_` | central / per-host prober | Pulse-owned |
| `command` | `pulse_` | command-exporter | Pulse-owned |

The Pulse-owned series (from `types.ts`):

```typescript
export const PULSE_AGENT_UP                      = "pulse_agent_up";                       // {host}
export const PULSE_AGENT_BUILD_INFO              = "pulse_agent_build_info";               // {host,version,component}
export const PULSE_DEEP_HEALTH                   = "pulse_deep_health";                    // {host,service,metric}
export const PULSE_DEEP_HEALTH_UP                = "pulse_deep_health_up";                 // {host,service}
export const PULSE_DEEP_HEALTH_LAST_SCRAPE_SECONDS = "pulse_deep_health_last_scrape_seconds"; // {host,service}
export const PULSE_BACKUP_FRESHNESS_AGE_SECONDS  = "pulse_backup_freshness_age_seconds";   // {host,service}
export const PULSE_BACKUP_FRESHNESS_UP           = "pulse_backup_freshness_up";            // {host,service}
export const PULSE_COMMAND_SIGNAL_UP             = "pulse_command_signal_up";              // {host,signal}
```

`pulse_backup_freshness_age_seconds`/`_up` are delivered by a scalar command signal synthesized
from a service's `backup_freshness.command`; `pulse_command_signal_up` is the generic liveness an
**exposition** command signal carries (a **scalar** signal instead emits its own declared
`up_metric`). An operator's other scalar/exposition series names live in the estate config, not in
this contract.

Adding or removing a series, renaming one, or changing a label key bumps `CONTRACT_VERSION` by 1
in the same change (a `metrics.json` conformance test fails if the file and the constant disagree).
A `node_*`/`container_*` **field set** changing because the upstream exporter was version-bumped
does **not** bump the version — pass-through families are referenced by prefix, not enumerated.

## Rendered-config input shapes

host-agent consumes three rendered configs. Their shapes mirror what `pulse-cli` emits; the
renderer is the source of truth.

### `AgentHostConfig` — `rendered/agent/<host>.yaml`

The single per-host bundle descriptor, validated by `agent/contract/config.schema.json`, consumed
at **assembly** time by `deploy-toolkit` (not parsed by any running component):

```typescript
export type DeliveryForm = "compose" | "systemd";

export interface ScrapePorts {
  node: number;        // always
  cadvisor?: number;   // present iff cadvisor === true (schema-enforced)
  heartbeat?: number;  // present iff heartbeat === true (schema-enforced; default on, issue #30/#33)
}

export interface AgentHostConfig {
  host: string;
  deliveryForm: DeliveryForm;
  cadvisor: boolean;   // opt-in (default off); gates the cAdvisor container/unit install
  heartbeat: boolean;  // opt-in (default on); gates the heartbeat container/unit install (issue #33)
  scrapePorts: ScrapePorts;
}
```

### `ProberConfig` — `rendered/prober/config.yaml` (central) and `agent/<host>/prober/config.yaml` (per-host)

Both prober modes read the identical `{ probes: ProberEntry[] }` shape at runtime; the file the
per-host prober reads is bound to the same in-container path. The prober interprets **only**
`kind: "deep-health"` entries — `backup-freshness`, reachability, and any other kind in the shared
file are silently ignored.

```typescript
export interface ProberEntry {
  name: string;   // "svc:<host>/<service>", "svc:<host>/<service>#backup", or "host:<name>"
  target: string; // endpoint / target / signal
  kind: string;   // "deep-health" | "backup-freshness" | a host ProbeSpec.kind
  responseMapping?: Record<string, string>;  // JSONPath → metric name (deep-health)
  alertExpression?: string;                   // opaque; never evaluated by the prober
  threshold?: string;                         // backup-freshness (opaque)
  note?: string;                              // probe-only host ProbeSpec.expect
  credential?: string;                        // SecretRef.raw only (${ENV}); never a literal
}

export interface ProberConfig { probes: ProberEntry[]; }
```

A deep-health entry is narrowed to the executed `DeepHealthProbeConfig` (`host`/`service` parsed
from `name`; `metrics` = `responseMapping`, required and non-empty). A structurally invalid
deep-health entry (malformed `name`, empty `responseMapping`, non-string `credential`) is a fatal
config error. `alertExpression` is carried opaquely (evaluated downstream by `alerting`, never by
the prober); `credential` crosses as `SecretRef.raw` only.

### `CommandExporterConfig` — `rendered/command-exporter/<host>.yaml`

Parsed at runtime by the command-exporter. **Every** entry must be a valid signal (unlike the
prober's shared file, a structurally invalid signal here is fatal):

```typescript
export type CommandSignalConfig =
  | { output: "scalar"; name: string; command: string[]; intervalMs: number;
      metric: string; upMetric: string; labels?: Record<string, string>; credential?: string }
  | { output: "exposition"; name: string; command: string[]; intervalMs: number; credential?: string };

export interface CommandExporterConfig { signals: CommandSignalConfig[]; }
```

`command` is argv run without a shell; `intervalMs` is the per-signal cadence (the renderer parses
the estate's duration string, e.g. `"30s"`, to ms). A `scalar` signal requires `metric` and
`upMetric`; the loader tolerates a snake_case `up_metric` defensively. `credential` (a
`SecretRef.raw`) is injected into the command's `PULSE_SIGNAL_CREDENTIAL` environment.

## Environment variables

| Variable | Consumer | Default | Purpose |
|----------|----------|---------|---------|
| `PULSE_RENDERED_DIR` | prober, command-exporter | `/rendered` | Root the config path resolves under |
| `PULSE_AGENT_HOST` | compose fragment | *(required)* | Selects which host's rendered configs mount in |
| `PULSE_PROBE_TIMEOUT_MS` | prober | `5000` | Per-probe HTTP timeout (positive int) |
| `PULSE_PROBE_CADENCE_MS` | prober | `30000` | Delay between probe cycles (positive int) |
| `PULSE_PROBE_CONCURRENCY` | prober | `8` | Bounded worker-pool size (positive int) |
| `PULSE_PROBER_SUPPRESS_HOST_LABEL` | prober | *(off)* | Truthy (`1`/`true`/`yes`/`on`) omits the self-set `host` label — set for the per-host prober so the scrape-time `file_sd` label owns identity |
| `PULSE_COMMAND_TIMEOUT_MS` | command-exporter | `10000` | Per-command execution timeout (positive int) |
| `COMPOSE_PROFILES` | compose fragment | *(none)* | Activates gated services (`cadvisor`, `command-exporter`, `deep-health`) |

A zero, negative, fractional, or non-numeric value for any `PULSE_*_MS`/`PULSE_PROBE_CONCURRENCY`
is a fatal startup configuration error — never a silent fallback.

## Pinned images

```typescript
export const PINNED = {
  nodeExporter:        "prom/node-exporter:v1.8.2",
  cadvisor:            "gcr.io/cadvisor/cadvisor:v0.49.1",  // aligned with the engine stack
  proberBase:          "oven/bun:1.3.9",
  heartbeatBase:       "oven/bun:1.3.9",
  commandExporterBase: "oven/bun:1.3.9",
};
```

Every tag is a concrete patch — never `latest`, never a floating or digest-only tag
(`REQ-BUNDLE-06`, `REQ-DET-01`). The compose fragment and the systemd units run the **same** tags,
so the two delivery forms are byte-identical in what they pull.

## Importable TypeScript surface

`agent/contract/types.ts` is the only importable surface host-agent exposes: the rendered-config
shapes above, the narrowed `DeepHealthProbeConfig`, the `PULSE_*` series-name constants, and the
`MetricsContract`/`MetricFamily`/`MetricSeries` types. It is self-contained — `@pulse/core` model
types (`Host`, `SecretRef`) are consumed by reference only, never redeclared. There is no other
package export; the exporters and prober are container entrypoints, not a library.

## Verification commands

| Command | What it runs |
|---------|--------------|
| `bun run typecheck` | `tsc -b` across the contract, exporters, prober, and tests |
| `bun test` | All suites; Docker-backed tiers self-skip with no daemon |
| `bun run smoke` | The aggregate smoke gate (builds local images, verifies runtime behavior) |

`agent/tests/compose.config.test.ts` validates the delivery structure statically (no containers);
`agent/tests/contract.test.ts` and the golden agent-config test hold the metric contract and the
rendered-config shape in sync with the renderer.

## Further Reading

- [README](./README.md) — What host-agent is and its rendered-config overview
- [Architecture](./architecture.md) — The components, delivery forms, the two probers, and the command-exporter
- [Integration Guide](./guides/integration.md) — Installing the bundle and wiring host-local probes and command signals
