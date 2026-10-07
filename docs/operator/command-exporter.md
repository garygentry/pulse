---
title: Command-exporter (host-computed signals)
description: Run read-only commands on a managed-linux host and publish their output as metrics — the delivery path for backup_freshness and the nvidia-smi GPU-contention panel.
slug: command-exporter
---

# Command-exporter (host-computed signals)

Some signals cannot be scraped from an off-the-shelf exporter: the **age of the newest backup
artifact**, **GPU utilization and per-process VRAM** from `nvidia-smi`, a **config-drift count**.
The **command-exporter** is one primitive for all of them — it runs read-only commands a host
declares (`command_signals`) on a cadence and publishes their numeric output as metrics on
`:9130`, alongside the rest of the [per-host agent bundle](/agent-install/).

It is a **managed-linux** capability (that is where the bundle runs), profile-gated so a host with
no signals never runs it. Like `node_exporter` and the heartbeat, it is **estate-agnostic**: the
`host` label is applied at scrape time via the `managed-linux` file_sd group, never baked into the
exporter. And it is **honest when blind** — a command that fails, times out, or can't run publishes
its liveness as `0`, never a stale "healthy".

## Declaring a command signal

A `command_signals` list on a managed-linux host declares each signal. Two output modes:

```yaml
hosts:
  - name: gpu-01
    collection_class: managed-linux
    delivery_form: compose
    addresses: [gpu-01.internal.example]     # illustrative
    exporter_ports: [9100]
    command_signals:
      # exposition — the command prints Prometheus text; the exporter passes it through and adds
      # pulse_command_signal_up{signal="gpu"} for liveness.
      - name: gpu
        command: ["/opt/pulse/gpu-metrics.sh"]
        interval: 30s
        output: exposition
      # scalar — the command prints ONE number; the exporter emits `metric{labels}` (the value)
      # and `up_metric{labels}` (1 ok / 0 blind).
      - name: drift
        command: ["/opt/pulse/drift-count"]
        interval: 5m
        output: scalar
        metric: pulse_config_drift_count
        up_metric: pulse_config_drift_up
        labels: { scope: estate }
```

| Field | Modes | Meaning |
|-------|-------|---------|
| `name` | both | Unique per host; the `signal` label on the liveness series. |
| `command` | both | Read-only argv, run **verbatim, no shell** (no interpolation). |
| `interval` | both | Cadence, a duration string (`30s`, `5m`, `1d12h`). |
| `output` | both | `scalar` or `exposition`. |
| `metric` / `up_metric` | scalar | The value series name and its honest-when-blind sibling. |
| `labels` | scalar | Fixed non-`host` labels baked onto both series. |
| `credential` | both | Optional `SecretRef` (`${ENV}` / `op://…`) injected into the command's environment as `PULSE_SIGNAL_CREDENTIAL`. Never a literal. |

> The commands themselves run **inside** the exporter container. Making a specific command
> available (a `gpu-metrics.sh`, a `backup-age` helper, `nvidia-smi`) is a **deploy-time** concern
> — put the scripts on the host under `/opt/pulse` (bind-mounted read-only) and, for `nvidia-smi`,
> use the NVIDIA container runtime with the GPU devices. The image itself is command-agnostic.

## `backup_freshness` delivery

A `backup_freshness` service that adds a **`command`** is delivered through the command-exporter:
the renderer synthesizes a `scalar` signal on the service's (managed-linux) host that emits the
series `stack/alerting` already alerts on.

```yaml
services:
  - name: nas-backups
    host: backup-orchestrator-01        # must be a managed-linux host
    kind: backup
    managed: true
    backup_freshness:
      signal: pulse_backup_freshness_age_seconds   # the emitted series (documentary)
      threshold: "24h"
      command: ["/opt/pulse/backup-age", "/mnt/backups"]  # prints newest-backup AGE, in seconds
      interval: "15m"                    # optional; default 15m
```

The command must **print the age of the newest backup artifact, in seconds**, to stdout — e.g.
`echo $(( $(date +%s) - $(stat -c %Y "$(ls -t /mnt/backups/* | head -1)") ))`. The exporter emits:

- `pulse_backup_freshness_age_seconds{service="nas-backups"}` — the value.
- `pulse_backup_freshness_up{service="nas-backups"}` — `1` on success, `0` when the command
  couldn't run (missing data is **not** a healthy backup).

The [backup-freshness alert family](/getting-started/) selects these by `{service}`:
`BackupStale` (> threshold), `BackupCritical` (> 2× threshold), `BackupNoData` (`_up == 0` or
absent). A `backup_freshness` **without** a `command` stays a declaration-only alert threshold
(unchanged) — it just never delivers a live series.

> The backup service must resolve to a **managed-linux** host: the command-exporter that delivers
> the metric only runs in that bundle. A `command` on any other class is a `backup_command_host`
> validation error.

## GPU-contention panel (nvidia-smi)

The GPU signal is an `exposition` command that runs a wrapper around `nvidia-smi` and prints
Prometheus text. The shipped **`Pulse — GPU`** dashboard (`pulse-gpu`) is a correlation surface —
**no alert** — reading these conventional series (scoped by the host `instance`):

| Series | Labels | From |
|--------|--------|------|
| `pulse_gpu_utilization_ratio` | `instance`, `gpu` | `nvidia-smi --query-gpu=utilization.gpu` |
| `pulse_gpu_memory_used_bytes` | `instance`, `gpu` | `--query-gpu=memory.used` |
| `pulse_gpu_temperature_celsius` | `instance`, `gpu` | `--query-gpu=temperature.gpu` |
| `pulse_gpu_process_memory_bytes` | `instance`, `gpu`, `pid`, `process` | `--query-compute-apps=used_memory,pid,process_name` |
| `pulse_command_signal_up{signal="gpu"}` | `instance` | the exporter (liveness) |

Your `gpu-metrics.sh` prints those lines; the exporter adds the `_up`. The container needs the
NVIDIA runtime and the GPU devices — wire them into the `command-exporter` service (compose) or the
`podman run` unit (systemd) at deploy time.

## How it is scraped and delivered

- **Scrape:** the exporter's `:9130` uses the dedicated `managed-linux-command-exporter` file_sd
  job. It appears **only when the host runs ≥1 command signal**, so there are no dead `:9130`
  targets. `host` (and its `instance` promotion) come from that group.
- **Rendered config:** `pulse render` emits `command-exporter/<host>.yaml` per host with signals;
  the exporter reads it read-only at `/rendered/command-exporter/config.yaml`.
- **Profile activation:** the `command-exporter` compose profile / systemd unit is enabled for a
  host **exactly when that host has a rendered `command-exporter/<host>.yaml`** — the config's
  presence is the authority (as the central prober's config gates the `deep-health` profile).
- **Build:** `pulse/command-exporter:1.0.0` is a non-upstream image — see the
  [build-vs-pull table](/bootstrap/).

## Metric contract

The fixed command series (`pulse_backup_freshness_age_seconds` / `_up`, `pulse_command_signal_up`)
are the **`command`** family of the agent metric contract (`agent/contract/metrics.json` +
`metrics-contract.md`, contract version `2`). An operator's own scalar/exposition series names live
in the estate config, not the fixed contract.
