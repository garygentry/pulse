---
title: Agent install
description: Deliver and enroll the host-agent bundle on a monitored host in both delivery forms — the Docker compose fragment and the systemd units — with cadvisor gated on the rendered flag and the metric ports firewalled to the engine host only.
slug: agent-install
---

# Agent install

This runbook delivers and enrolls the **host-agent bundle** on one monitored Linux host, so
its metrics become reachable by the engine's scrape. It covers **both delivery forms** — the
Docker **compose fragment** and the **systemd units** — gates cAdvisor on the host's rendered
configuration, and firewalls the metric ports to the engine host only.

> **These install steps are written here for the first time.** The `agent/` tree ships the
> compose fragment, the systemd units, and the pinned images — but **no install script**.
> This runbook is the authoritative install procedure; it uses only the shipped,
> estate-agnostic artifacts and never introduces a host-touching script of its own.

The worked hosts are two `managed-linux` hosts from the reference estate:

- **`harbor-web-01`** (`10.20.0.11`) — `deliveryForm: compose`, `cadvisor: true`. Installed
  via the compose fragment with the `cadvisor` profile enabled.
- **`harbor-app-02`** (`10.20.0.12`) — `deliveryForm: systemd`, `cadvisor: false`. Installed
  via the systemd units, with **no** cAdvisor unit.

The monitoring engine host is `monhost01.nimbus.example` (`10.20.0.10`); substitute your own
hosts and addresses throughout.

## The rendered per-host config drives every choice

The renderer emits one config file per `managed-linux` host at `rendered/agent/<host>.yaml`.
It records exactly three decisions the install reads:

```yaml
# rendered/agent/harbor-web-01.yaml (from the reference estate)
cadvisor: true
deliveryForm: compose
host: harbor-web-01
scrapePorts:
  cadvisor: 8080
  heartbeat: 9110
  node: 9100
```

- **`deliveryForm`** — `compose` (this host runs Docker → use the fragment) or `systemd`
  (podman host → use the units).
- **`cadvisor`** — whether to install and enable cAdvisor at all (the **cadvisor gate**).
- **`scrapePorts`** — node-exporter on **9100** (always), heartbeat on **9110** unless the host
  opts out, and, when cadvisor is enabled, cAdvisor on **8080**.

This file is authoritative at *assembly time*; no bundled process parses it at runtime. Read
it first, then follow the matching delivery form below.

> **Node-exporter-only hosts (`heartbeat: false`).** A host with only a native `node_exporter`
> binary and no container runtime (e.g. a systemd-Caddy or DNS box) sets `heartbeat: false` in the
> estate. Its rendered config carries `heartbeat: false` and `scrapePorts: { node: 9100 }` alone, so
> the engine scrapes no `:9110` heartbeat target **and** the bundle install skips the heartbeat
> container/unit entirely: the heartbeat compose service is profile-gated and its systemd unit is
> gated on the same rendered boolean, symmetric with cAdvisor (issue #33). node-exporter (`:9100`)
> stays mandatory: `HostDown` reads `up{job="managed-linux"}` (issue #30).

> **Optional per-host member — the command-exporter (`:9130`).** A host that declares
> `command_signals` (or a `backup_freshness.command`) also renders a
> `command-exporter/<host>.yaml`; enable the `command-exporter` profile / install its unit for
> that host. It runs read-only host commands (backup age, `nvidia-smi` GPU metrics) and publishes
> them on `:9130`. See [Command-exporter](/command-exporter/).

> **Optional per-host member — the per-host prober (`:9120`).** A host with a service whose
> `deep_health` is marked `host_local: true` also renders a
> `agent/<host>/prober/config.yaml`; enable the `deep-health` profile / install its unit to probe
> loopback/bridge-local targets the central prober can't reach. See
> [Per-host prober](#per-host-prober-bridge-local--loopback-deep-health-targets) below.

## About the exit contract

The only `pulse` command this runbook invokes is `pulse render` (on the engine host, to
regenerate a missing per-host config). It branches on the stable contract: **`0`** clean,
**`1`** findings — fix the estate and re-render, **`2`** a tool fault to resolve in the
environment. Everything else here is host state, verified by content.

## Compose delivery form (Docker hosts — worked host `harbor-web-01`)

#### Step 1 — Confirm the rendered per-host config is present

**Command**

```bash
# on the agent host, in the consumer repo checkout
cat rendered/agent/harbor-web-01.yaml
```

**Verify (content):** the file exists and shows this host's `deliveryForm:`, `cadvisor:`, and
`scrapePorts:`. Note the `cadvisor:` value now — it decides Step 3. If the file is **absent**,
re-run `pulse render` on the **engine host** (from the estate directory, so `estateDir`
resolves there) and re-sync the tree — **never hand-author this file**.

**Rollback:** none — this is a read-only inspection.

#### Step 2 — Copy the compose fragment into place

**Command**

```bash
mkdir -p /opt/pulse-agent
cp agent/compose/agent.fragment.yml /opt/pulse-agent/docker-compose.yml
printf 'PULSE_AGENT_HOST=harbor-web-01\nPULSE_RENDERED_DIR=/opt/pulse-agent/rendered\n' \
  > /opt/pulse-agent/.env
# sync the rendered/agent/<host>.yaml tree under /opt/pulse-agent/rendered
mkdir -p /opt/pulse-agent/rendered/agent
cp rendered/agent/harbor-web-01.yaml /opt/pulse-agent/rendered/agent/
```

**Verify (content):**

```bash
docker compose -f /opt/pulse-agent/docker-compose.yml --env-file /opt/pulse-agent/.env config
```

resolves with the heartbeat volume pointing at
`/opt/pulse-agent/rendered/agent/harbor-web-01.yaml` and **no unresolved `${…}`** in the
merged output.

**Rollback:** `rm -rf /opt/pulse-agent` — nothing is running yet.

#### Step 3 — Bring the agent up (heartbeat + cAdvisor gated on the rendered flags)

The fragment pins its images (node-exporter, cAdvisor, and the heartbeat exporter) — copy it
verbatim and never hand-edit a tag; the exact pins live in `agent/compose/agent.fragment.yml`.
Both cAdvisor and the heartbeat exporter are **profile-gated**, each activated **only** because
the rendered config declares the matching boolean `true` — but they default oppositely:

- **heartbeat** defaults **on** (`heartbeat: true` is the estate default), so `harbor-web-01`'s
  rendered config has it and you pass `--profile heartbeat`. Drop that flag **only** for a
  node-exporter-only host whose rendered config says `heartbeat: false`.
- **cAdvisor** defaults **off**, so add `--profile cadvisor` **only** because
  `rendered/agent/harbor-web-01.yaml` has `cadvisor: true`; omit it when `cadvisor: false`.

**Command**

```bash
cd /opt/pulse-agent
# activate one profile per bundle member whose rendered boolean is true:
docker compose --profile heartbeat --profile cadvisor up -d
#   drop --profile heartbeat when rendered heartbeat: false (node-exporter-only host)
#   drop --profile cadvisor  when rendered cadvisor: false
```

**Verify (content):** `docker compose ps` shows `node-exporter` running (and `heartbeat` unless
opted out), then confirm the exporters actually serve — content, not exit code:

```bash
curl -fsS http://127.0.0.1:9100/metrics | head -c 40      # node_exporter exposition
curl -fsS http://127.0.0.1:9110/metrics | head -c 40      # heartbeat  — only when enabled
curl -fsS http://127.0.0.1:8080/healthz                   # cAdvisor   — only when enabled
```

Each enabled exporter returns an exposition body / `ok`, proving it is live. On a
`heartbeat: false` (node-exporter-only) host, the `:9110` probe should refuse the connection —
the heartbeat container was correctly **not** started; likewise `:8080` on a `cadvisor: false` host.

**Rollback:** `cd /opt/pulse-agent && docker compose down`. The agent has no durable volumes,
so this is clean and the bring-up is idempotent on re-run.

#### Step 4 — Restrict the metric ports to the engine host (firewall)

The metric ports **9100** (node), **9110** (heartbeat), and **8080** (cAdvisor) are read-only
metric surfaces with no write or control path — but they must be reachable **from the engine
host only, never publicly**. Allow the engine host and drop everything else.

**Command** (nftables example — adapt to your host firewall)

```bash
# allow ONLY the engine host (monhost01.nimbus.example → 10.20.0.10) to 9100/9110/8080
nft add rule inet filter input ip saddr 10.20.0.10 tcp dport {9100,9110,8080} accept
nft add rule inet filter input tcp dport {9100,9110,8080} drop
```

**Verify (content):** from the **engine host**,
`nc -z harbor-web-01.nimbus.example 9100 && echo reachable` prints `reachable`; from **any
other** host, the same connect **times out** — proving the ports are engine-only, not public.

**Rollback:** delete the two rules by handle (`nft -a list ruleset` to read the handles, then
`nft delete rule inet filter input handle <n>`) to restore the prior firewall policy.

## Systemd delivery form (podman hosts — worked host `harbor-app-02`)

When the host's rendered config has `deliveryForm: "systemd"`, install the unit set instead of
the compose fragment. Steps 1 and 4 are identical (read the rendered config; firewall the
ports); replace Steps 2–3 with the unit install below. The worked host `harbor-app-02` has
`cadvisor: false`, so its cAdvisor unit is **not** installed.

#### Step 3′ — Install and enable the units (heartbeat + cAdvisor gated on the rendered flags)

The units run the **same pinned images** as the compose form via `podman run` — no separate
artifact; the exact pins live in `agent/systemd/pulse-*.service`. Install each gated unit **only**
when the rendered config declares its boolean `true`: the heartbeat unit unless `heartbeat: false`
(it is `true` for `harbor-app-02`, so it **is** installed here), and the cAdvisor unit only when
`cadvisor: true` (it is `false` for `harbor-app-02`, so it is omitted here).

**Command**

```bash
cp agent/systemd/pulse-node-exporter.service /etc/systemd/system/
# install pulse-heartbeat.service UNLESS the rendered config has heartbeat: false
cp agent/systemd/pulse-heartbeat.service /etc/systemd/system/
# install pulse-cadvisor.service ONLY when the rendered config has cadvisor: true
systemctl daemon-reload
systemctl enable --now pulse-node-exporter pulse-heartbeat
#   drop pulse-heartbeat from the enable list when heartbeat: false
#   append pulse-cadvisor to the enable list ONLY when cadvisor: true
```

**Verify (content):**

```bash
systemctl is-active pulse-node-exporter pulse-heartbeat     # prints `active` for each installed unit
curl -fsS http://127.0.0.1:9100/metrics | head -c 40        # node_exporter exposition body
curl -fsS http://127.0.0.1:9110/metrics | head -c 40        # heartbeat exposition body — only when enabled
```

`is-active` printing `active` and the exporters returning bodies proves the units took —
state, not the `systemctl` exit code. Because `harbor-app-02` is `cadvisor: false`, there is
no `pulse-cadvisor` unit and nothing should listen on `:8080`.

**Rollback:**

```bash
systemctl disable --now pulse-node-exporter pulse-heartbeat   # + pulse-cadvisor if it was installed
rm /etc/systemd/system/pulse-node-exporter.service /etc/systemd/system/pulse-heartbeat.service
systemctl daemon-reload
```

## Per-host prober (bridge-local / loopback deep-health targets)

Deep-health probes are run by a **central prober** on the engine host by default: it reads
`rendered/prober/config.yaml` and probes each service's `endpoint`. That works for any endpoint
the engine can reach over the network. It does **not** work for an endpoint that is only
reachable **from the service's own host** — a service bound to `127.0.0.1` or to a Docker
bridge-local address. From the central prober's container, `127.0.0.1` is the *central container
itself*, so the probe would hit the wrong target (or nothing).

For those targets, a probe is marked **host-local** and a **per-host prober** runs on the host.

### Mark a probe host-local

Set `host_local: true` on the service's `deep_health` block in the estate. The host must be
`managed-linux` (the only class that runs the agent bundle) — otherwise the estate fails to
validate with a `host_local_probe_host` finding.

```yaml
# estate.yaml — a loopback-only NVR health API on a managed-linux host
services:
  - name: frigate
    host: harbor-web-01
    kind: http
    managed: true
    deep_health:
      endpoint: http://127.0.0.1:5000/api/stats   # only reachable on harbor-web-01
      host_local: true                            # → run from harbor-web-01's own prober
      response_mapping:
        detectors: "$.detectors.count"
      alert_expression: pulse_deep_health_up == 0
```

The renderer routes every host-local probe **out** of the central `prober/config.yaml` and into
a **per-host** config at `rendered/agent/<host>/prober/config.yaml`. A host with no host-local
probe renders no such file (and the central prober keeps every other probe, unchanged).

```yaml
# rendered/agent/harbor-web-01/prober/config.yaml
probes:
  - alertExpression: pulse_deep_health_up == 0
    kind: deep-health
    name: svc:harbor-web-01/frigate
    responseMapping:
      detectors: $.detectors.count
    target: http://127.0.0.1:5000/api/stats
```

### Deliver the per-host prober

The per-host prober is the **same pinned image** as the central prober; it reads its config from
the fixed in-container path `/rendered/prober/config.yaml`, so the delivery just binds this
host's `agent/<host>/prober/config.yaml` there. It runs under **host networking** so
`127.0.0.1` / bridge-local targets resolve on the host, and it publishes `/metrics` on
**`:9120`**, which is discovered through the host's dedicated
`scrape/file_sd/managed-linux-prober.json` group. Activation is gated on the
rendered per-host config's presence — exactly like the command-exporter.

**Compose (Docker hosts).** Enable the `deep-health` profile and sync the per-host config:

```bash
# sync this host's per-host prober config under the rendered tree
mkdir -p /opt/pulse-agent/rendered/agent/harbor-web-01/prober
cp rendered/agent/harbor-web-01/prober/config.yaml \
   /opt/pulse-agent/rendered/agent/harbor-web-01/prober/
docker compose -f /opt/pulse-agent/docker-compose.yml --env-file /opt/pulse-agent/.env \
  --profile deep-health up -d prober
```

**Systemd (podman hosts).** Place the per-host config at the fixed path the unit reads, then
enable the unit:

```bash
install -D rendered/agent/harbor-app-02/prober/config.yaml \
  /etc/pulse/rendered/prober/config.yaml
cp agent/systemd/pulse-prober.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pulse-prober
```

**Firewall:** add `:9120` to the same engine-host-only allowlist as the other metric ports
(Step 4 / Step 4′) — it is a read-only metric endpoint with no control surface.

> **Label provenance.** The per-host prober **suppresses** its self-set `host` label
> (`PULSE_PROBER_SUPPRESS_HOST_LABEL=1`, already set in both delivery forms), so the scrape-time
> `host` label from the `managed-linux` file_sd group owns it — correct, because for a host-local
> probe the probing host *is* the target host. The `service` label is still self-set. (The
> central prober self-labels both `host` and `service`; do not set this env there.)

## Where to go next

- **Wire alerting and shake it down** → [rollout session](/rollout-session/).
- **Enroll backups on day one** → [backup enrollment](/backup-enrollment/).
- **Stand the engine up first** → [bootstrap](/bootstrap/).
- **Full runbook index** → [runbooks](/runbooks/).
