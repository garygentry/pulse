# Integration Guide

This guide is for two audiences: operators installing the per-host bundle onto managed-linux
hosts, and authors of the downstream Pulse features that produce or consume host-agent's outputs
(`pulse-cli`, `deploy-toolkit`, `alerting`, `dashboards`). host-agent ships estate-agnostic
component templates and a versioned metric contract; you specialize them through the rendered
tree, never by editing a template.

## What host-agent expects from the renderer

For each managed-linux host, `pulse-cli` renders the configs host-agent's components consume. As
the renderer you own their *content*; host-agent owns *where they mount and how they're parsed*:

| You render | Consumed by | When |
|------------|-------------|------|
| `agent/<host>.yaml` (`AgentHostConfig`) | `deploy-toolkit` | assembly time — selects delivery form, cAdvisor, ports |
| `command-exporter/<host>.yaml` | command-exporter | runtime — the signal set it runs |
| `prober/config.yaml` (central) | central prober | runtime — every non-host-local deep-health probe |
| `agent/<host>/prober/config.yaml` | that host's per-host prober | runtime — its host-local probes |
| `scrape/file_sd/managed-linux.json` | VictoriaMetrics | scrape time — node-exporter `:9100` target + `host` label |
| `scrape/file_sd/cadvisor.json` | VictoriaMetrics | scrape time — opted-in per-host cAdvisor targets |
| `scrape/file_sd/process-exporter.json` | VictoriaMetrics | scrape time — declared process-exporter `:9256` targets |
| `scrape/file_sd/managed-linux-*.json` | VictoriaMetrics | scrape time — heartbeat, prober, command, and other custom exporter targets |

Contract points to hold:

- **`AgentHostConfig` is authoritative at assembly, not runtime.** Its `scrapePorts.cadvisor` must
  be present iff `cadvisor: true` (the schema rejects any other combination).
- **The `host` label is applied at scrape time**, from each exporter-specific `file_sd` group —
  never bake it into a rendered exposition. Every managed-host scrape job promotes `host` to
  `instance`, preserving `instance == host`. The per-host prober suppresses its self-set `host`
  label for exactly this reason; the central prober is the one exception (it self-labels `host` +
  `service`).
- **Credentials are `SecretRef` references only.** A deep-health probe or command signal carries
  `${ENV}` (or another `SecretRef` form); the renderer's secret choke point refuses a literal and
  emits a `SECRET_LITERAL` finding against the owning file.

## Installing the bundle (operator)

`deploy-toolkit` reads `rendered/agent/<host>.yaml` and installs the components a host needs.

**Compose.** Point the fragment at the rendered tree and the host:

```bash
PULSE_RENDERED_DIR=/path/to/rendered \
PULSE_AGENT_HOST=harbor-web-01 \
COMPOSE_PROFILES=heartbeat,cadvisor,command-exporter,deep-health \
  docker compose -f agent/compose/agent.fragment.yml up -d
```

`node-exporter` is the only always-on bundle member. `heartbeat` is profile-gated symmetric with
cAdvisor (issue #33): the estate `heartbeat: false` opt-out drops the central scrape target, the
descriptor's `scrapePorts.heartbeat`, **and** the container itself (a node-exporter-only host;
issue #30). Add a profile for each component this host runs: `heartbeat` (default-on — activate it
unless the rendered config says `heartbeat: false`), `cadvisor` (when the rendered config enables
it), `command-exporter` (when the host declares ≥1 command signal), `deep-health` (when the host
owns a host-local probe).

**systemd.** Install node_exporter as the always-on bundle member on every managed-linux host;
install heartbeat, cAdvisor, command-exporter, and the per-host prober **only** on hosts whose
rendered config calls for them (heartbeat unless `heartbeat: false`; the rest on their opt-in flags).
`deploy-toolkit` places each host's runtime configs at the fixed paths the units read
(`/etc/pulse/rendered/command-exporter/config.yaml`, `/etc/pulse/rendered/prober/config.yaml`) and
`systemctl enable --now`s each unit. Every bind is read-only and every unit restarts on failure.

Both forms run the same pinned images and expose the same ports. All ports are local, read-only
metric endpoints; firewalling them to the stack is `deploy-toolkit`'s job.

## Enabling a host-local deep-health probe (issue #8)

A deep-health probe whose endpoint is only reachable from the service's **own** host — a
`127.0.0.1` or bridge-local address — must run on that host, not the central prober. Mark it in the
estate:

```yaml
services:
  - name: frigate
    host: harbor-nvr-01          # MUST be a managed-linux host
    deep_health:
      endpoint: http://127.0.0.1:5000/api/stats
      host_local: true           # route to the per-host prober (issue #8)
      response_mapping:
        detections_fps: $.detection_fps
```

The renderer routes this out of the central `prober/config.yaml` into
`agent/harbor-nvr-01/prober/config.yaml`; `deploy-toolkit` gates the per-host prober unit on that
file's presence, runs it under `network_mode: host` (so `127.0.0.1` resolves on the host), and
sets `PULSE_PROBER_SUPPRESS_HOST_LABEL=1` so the scrape-time `host` label owns identity. The probe
then uses that host's `managed-linux-prober` scrape group on `:9120`.

`host_local: true` **requires a managed-linux host** — `@pulse/core`'s `checkHostLocalProbeHost`
invariant raises a `host_local_probe_host` error at validate time otherwise, because only a
managed-linux host carries the bundle that runs a per-host prober. Drop `host_local` to let the
central prober handle a network-reachable endpoint.

## Wiring backup-freshness and command signals (issue #3)

The command-exporter delivers the backup-freshness contract and any other command-to-metric
signal. Two entry points in the estate:

**A service's `backup_freshness.command`** — an argv that prints the newest backup's age in
**seconds**. The renderer synthesizes a scalar command signal on the service's host emitting
`pulse_backup_freshness_age_seconds{host,service}` and `pulse_backup_freshness_up{host,service}`
(the series `stack/alerting` selects):

```yaml
services:
  - name: photos
    host: harbor-app-01          # a managed-linux host (checkBackupCommandHost)
    backup_freshness:
      threshold: 26h
      command: ["/opt/pulse/backup-age.sh", "photos"]   # prints age in seconds
```

**A host's `command_signals`** — a general command-to-metric bridge, either `scalar` (declares its
own `metric` / `up_metric`) or `exposition` (prints Prometheus text; the exporter adds
`pulse_command_signal_up{signal}`):

```yaml
hosts:
  - name: harbor-gpu-01
    collection_class: managed-linux
    command_signals:
      - name: gpu
        output: exposition
        interval: 15s
        command: ["/opt/pulse/nvidia-smi-exporter.sh"]
```

Either entry point makes the host run the command-exporter on `:9130`. The image is
command-agnostic: populate `/opt/pulse` on the host with the scripts your signals name (for
`nvidia-smi`, add the NVIDIA container runtime and devices in the fragment). Commands run as argv
without a shell, bounded by `PULSE_COMMAND_TIMEOUT_MS`; a failure reports `_up = 0` rather than
pretending healthy. See [`docs/operator/command-exporter.md`](../../../operator/command-exporter.md).

## Building the images

The two Bun-based exporters and the prober build from the `agent/` context:

```bash
docker build agent -f agent/heartbeat/Dockerfile \
  --build-arg AGENT_VERSION=1.0.0 -t pulse/agent-heartbeat:1.0.0
docker build agent -f agent/prober/Dockerfile           -t pulse/prober:1.0.0
docker build agent -f agent/command-exporter/Dockerfile -t pulse/command-exporter:1.0.0
```

The `AGENT_VERSION` build arg is baked into `pulse_agent_build_info{version}`; keep it label-safe.
node_exporter and cAdvisor need no build — they run their pinned upstream images.

## Consuming the metrics downstream

`alerting` and `dashboards` build against `agent/contract/metrics.json` (version 2), referencing
the `PULSE_*` constants or parsing the JSON, never a hard-coded literal:

- **Reconcile `host` ⇔ `instance`.** Pass-through families (`node_*`, `container_*`) and the
  heartbeat identify the host under `instance` (promoted from the `file_sd` `host` label);
  deep-health identifies it under `host` (the central prober self-labels). A cross-family join is a
  label rename, authored deliberately.
- **Container health is not service liveness.** `container_*` is workload telemetry; a service's
  liveness-of-function is `pulse_deep_health_up`, a host's is `pulse_agent_up`. Do not key a
  service-liveness rule off `container_*`.
- **Missing backup data is not a healthy backup.** Alert on `pulse_backup_freshness_up == 0` and on
  a stale `_age_seconds`, not on presence alone.

## What you can rely on

- **Every shipped template is estate-agnostic** — no host, domain, or credential literal; a guard
  refuses one.
- **Both delivery forms are behaviorally identical** — same pinned images, ports, and rendered
  configs; the form is an install detail.
- **Failures are visible** — a failed probe or command sets `_up = 0` and retains the last-good
  value; it never silently disappears.
- **The metric contract is versioned** — a series or label change bumps `CONTRACT_VERSION`, so a
  drift is a legible event, not a silent break.

## What not to do

- **Don't bake a `host` label into a rendered exposition** — it arrives at scrape time. The
  per-host prober suppresses its own; only the central prober self-labels.
- **Don't put a host-local probe on a non-managed-linux host** — validation rejects it; only a
  managed-linux host runs a per-host prober.
- **Don't add a write or control route to a component** — every surface is read-only `/metrics`
  (+ `/healthz`); a non-matching request is a 404/405 by contract.
- **Don't embed a credential literal** — carry a `SecretRef` reference; the renderer refuses a
  literal and the prober/command-exporter resolve it from the environment at runtime.

## Further Reading

- [README](../README.md) — What host-agent is and its rendered-config overview
- [Architecture](../architecture.md) — The components, delivery forms, the two probers, and the command-exporter
- [API Reference](../api-reference.md) — Ports, the metric contract, rendered-config input shapes, and environment variables
