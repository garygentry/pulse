# `agent-metrics-contract` — the published Pulse host-agent metrics

## Contract version: 2

This document is the human-readable companion to `metrics.json`, which is the
**authoritative, machine-readable** artifact. If the two ever disagree, `metrics.json`
(validated against `MetricsContract` in `types.ts`) is the source of truth; this file is
authored by hand to mirror it. Both carry the same contract version, sourced from
`CONTRACT_VERSION` in `constants.ts` (currently `2`).

> **Version history.** `2` (issue #3) added the **`command`** family — the per-host
> command-exporter (`agent/command-exporter/`) delivers `pulse_backup_freshness_age_seconds` /
> `pulse_backup_freshness_up` (previously REQUIRED-but-undelivered) plus `pulse_command_signal_up`.

Downstream features (`alerting`, `dashboards`) build against this contract: `alerting` binds
rules against `pulse_agent_up`, `pulse_deep_health*`, and `pulse_backup_freshness_*`,
`dashboards` builds panels against all five families. They reference the `PULSE_*` constants
or parse `metrics.json`, never a hard-coded string literal.

## Naming convention

- **Pulse's own components carry a `pulse_` prefix.** The heartbeat exporter emits
  `pulse_agent_*`; the deep-health prober emits `pulse_deep_health*`. These are series Pulse
  itself produces, so Pulse owns their names.
- **node and container series pass through under their upstream names.** node_exporter series
  keep their `node_*` names; cAdvisor series keep their `container_*` names. They are **not**
  re-prefixed — community Grafana dashboards keyed on `node_*` / `container_*` import and work
  unmodified.

Pass-through governs the metric **name** only. It does **not** mean the exporter self-emits
host identity — see the host-identity note below. The two concerns are orthogonal.

## The five families

The contract enumerates exactly five families: `node`, `container`, `deep-health`,
`heartbeat`, and `command`. The three Pulse-owned families (`deep-health`, `heartbeat`,
`command`) enumerate every **fixed** series with its exact name and label set. The two
pass-through families (`node`, `container`) are referenced by family/prefix (`node_*`,
`container_*`), **not** enumerated field-by-field — enumerating every upstream field would
couple the contract to exporter releases.

### Family: node (`node_`, pass-through)

| Series | Labels | Description |
|---|---|---|
| `node_*` | instance | Upstream node_exporter host metrics (CPU, memory, disk, filesystem, network, load). Referenced as a family, not enumerated. Host identity via `instance`, promoted from the rendered `host` label at scrape time. |

### Family: container (`container_`, pass-through, opt-in)

| Series | Labels | Description |
|---|---|---|
| `container_*` | instance, name | Upstream cAdvisor per-container metrics, present only on hosts that opt into cAdvisor. Referenced as a family, not enumerated. Host/workload telemetry only. |

> **Container health is NOT a service liveness signal.** A service's liveness-of-function is
> the deep-health family; a host's liveness is the heartbeat (`pulse_agent_up`). The
> `container_*` family is host/workload telemetry only (CPU, memory, restarts) and MUST NOT be
> read as a "service is up" signal (REQ-CONT-03). `alerting` MUST NOT key a service-liveness or
> service-health rule off a `container_*` series; `dashboards` MAY show it as workload
> telemetry but MUST NOT present it as a service-up indicator.

### Family: deep-health (`pulse_`, Pulse-owned)

Emitted by the central deep-health prober (`agent/prober/`). `host` and `service` are
self-emitted, derived from each probe entry's `name` (`svc:<host>/<service>`).

| Series | Labels | Description |
|---|---|---|
| `pulse_deep_health` | host, service, metric | Gauge: the mapped JSON value for one `responseMapping` metric of one probed service. |
| `pulse_deep_health_up` | host, service | `1` = last probe succeeded, `0` = last probe failed (fail-visibility, REQ-PROBE-04). |
| `pulse_deep_health_last_scrape_seconds` | host, service | Unix seconds of the last **successful** probe. A stale value signals a silently failing probe target. |

### Family: heartbeat (`pulse_`, Pulse-owned)

Emitted by the per-host heartbeat exporter (`agent/heartbeat/`). `host` is applied at scrape
time; `version` and `component="agent"` are self-emitted, baked at image build time.

| Series | Labels | Description |
|---|---|---|
| `pulse_agent_up` | host | `1` while the per-host agent is alive. An explicit per-host liveness signal, distinct from node_exporter's `up` (REQ-HB-01). |
| `pulse_agent_build_info` | host, version, component | Always `1`; carries the agent build `version` (REQ-HB-02). `component` is the fixed value `"agent"`. |

### Family: command (`pulse_`, Pulse-owned)

Emitted by the per-host **command-exporter** (`agent/command-exporter/`, issue #3/#1), which
runs a host's estate-declared `command_signals` on a cadence and publishes their output. Like
node/heartbeat, `host` is applied at scrape time via the command-exporter's dedicated file_sd job
relabel (the bundle stays estate-agnostic); the exporter bakes only the signal's declared labels.

Two output modes. A **scalar** signal declares the metric name it emits (below for the shipped
`backup_freshness` wiring; an operator's other scalar signals declare their own names, not
enumerated here). An **exposition** signal passes its command's Prometheus text through, and
the exporter adds `pulse_command_signal_up{signal}` for it.

| Series | Labels | Description |
|---|---|---|
| `pulse_backup_freshness_age_seconds` | host, service | Gauge: seconds since the newest backup artifact of a service. Delivered by a scalar command signal synthesized from a service's `backup_freshness.command`; `service` is baked, `host` is scrape-applied. The backup-freshness rule family selects this by `{service}`. |
| `pulse_backup_freshness_up` | host, service | `1` = the backup-age command ran this cycle, `0` = it failed/couldn't run. Missing data is **not** a healthy backup (REQ-BACKUP-03). |
| `pulse_command_signal_up` | host, signal | `1` = an **exposition**-mode command signal ran and produced output this cycle, `0` = blind. `signal` is the estate-declared `command_signals` name. (A scalar signal instead emits its own declared `up_metric`.) |

## Host-identity labelling

Every series carries consistent host-identity labels so all four families join cleanly, but
the label **key** differs by mechanism:

- **Pass-through families + heartbeat** do **not** self-emit host identity. Their exporter-specific
  file_sd groups carry a `host` label, and every managed-host VictoriaMetrics job promotes
  `host` → `instance` via `relabel_configs` at scrape time. They therefore identify the host under
  **`instance`** (post-relabel). Only heartbeat's `version` / `component` labels are self-emitted.
- **deep-health** is served by the single **central** prober, which has no per-host file_sd
  relabel, so it **self-emits** `host` and `service` on every `pulse_deep_health*` series.
  Pulse-owned families therefore identify the host under **`host`**.

> **Downstream reconciliation.** Pass-through families identify the host under `instance`;
> Pulse-owned families under `host`. A cross-family join (e.g. `pulse_agent_up` × `node_load1`)
> must reconcile `host` ⇔ `instance` — a label rename, not a lookup: the `host` value and the
> `instance` value are the same host string. This is an intentional consequence of keeping
> upstream names untouched; `alerting` / `dashboards` author the join deliberately.

## Versioning

The contract is a **stable, versioned surface**. Versioning is a single integer
`contractVersion` in `metrics.json`, mirrored as the "Contract version" line above, both
sourced from `CONTRACT_VERSION` (`constants.ts`). A change is a legible, versioned event —
mirroring how `@pulse/core` versions its schema with `CURRENT_SCHEMA_MAJOR`.

**A change requiring a version bump** (any of):

- Renaming a series (e.g. `pulse_agent_up` → anything else).
- Adding or removing a series in any family.
- Adding, removing, or renaming a **label key** on any series.
- Changing a family's `prefix`, `kind`, or a series' `passthrough` classification.

**Does NOT require a bump:**

- Editing a `description` string (documentation, not surface).
- The set of upstream `node_*` / `container_*` **fields** changing because node_exporter or
  cAdvisor was version-bumped — those are referenced by family, not enumerated, so the contract
  surface is unchanged.

An editor changing the metric surface increments `CONTRACT_VERSION` by 1 in the **same**
change, and both `metrics.json` and this file carry the new value. Because `CONTRACT_VERSION`
is the single source, the `metrics.json` conformance test fails if the two disagree — the
version is not silently forgeable.
