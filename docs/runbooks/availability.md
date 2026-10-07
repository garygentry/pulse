---
title: Availability
description: Triage and remediate the availability alert family — HostDown, DeepHealthProbeFailed, and DeepHealthProbeStale — the host-reachability and deep-health-probe signals where missing data is always treated as failure, never as healthy.
slug: availability
---

# Availability

This runbook is where the `runbook_url` on an **availability** alert lands. The family covers a
monitored host going unreachable (`HostDown`) and the deep-health **probe** failing or going stale
(`DeepHealthProbeFailed`, `DeepHealthProbeStale`). Its guiding invariant: **missing data is treated
as failure, never as healthy** (`REQ-RULE-05`).

The rule family is `stack/compose/config/vmalert/rules/availability.yml` (group `availability`).
Note the split: this family owns **probe reachability**; the per-service **functional** deep-health
expression is a separate critical rule covered by the [deep-health runbook](/deep-health/).

## When this fires

- **HostDown** (critical) — no successful scrape from a `managed-linux` target for **90s** (three
  consecutive missed 30s scrapes). Keys on `up == 0`, not `pulse_agent_up`.
- **DeepHealthProbeFailed** (warning) — `pulse_deep_health_up == 0` for **2m**: the probe ran and
  failed (unreachable, malformed, or errored). Mapped `pulse_deep_health` values are stale meanwhile.
- **DeepHealthProbeStale** (warning) — `time() - pulse_deep_health_last_scrape_seconds > 300`: no
  successful probe for over 5m, so functional-health evaluation cannot be trusted.

## Triage

**Verify (content):** confirm whether the host is truly unreachable or only its scrape target is.
From the engine host:

```bash
cd stack/compose
# Is the managed-linux target up? (substitute the host):
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- 'http://victoriametrics:8428/api/v1/query?query=up%7Bjob%3D%22managed-linux%22%7D'"
```

A `0` value for the host confirms `HostDown`. Then prove reachability directly:

```bash
# From the engine host (or your jump host):
ping -c 3 HOST
curl -sS --max-time 5 http://HOST:9100/metrics | head -n 3   # node_exporter still serving?
```

If `node_exporter` answers but the scrape failed, the fault is network/firewall between engine and
host, not the host itself.

**Verify (content):** for the deep-health probe alerts, read the probe series directly:

```bash
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- 'http://victoriametrics:8428/api/v1/query?query=pulse_deep_health_up'"
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- 'http://victoriametrics:8428/api/v1/query?query=time()-pulse_deep_health_last_scrape_seconds'"
```

`pulse_deep_health_up == 0` confirms a failing probe; a last-scrape age over 300 confirms staleness.

## Remediate

#### Step 1 — Restore the host or its agent (HostDown)

Bring the host back and confirm its agent is scraping. If the host is up but the agent is down,
restart the host-agent bundle (see [agent install](/agent-install/) for the bundle layout).

**Command**

```bash
# On the monitored host — restart the host-agent metrics unit (name per your enrollment):
systemctl restart pulse-host-agent    # or: docker compose -f /path/to/agent/compose.yml up -d
```

**Verify (content):** the target returns to `up == 1` and the alert clears —

```bash
cd stack/compose && docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- 'http://victoriametrics:8428/api/v1/query?query=up%7Bjob%3D%22managed-linux%22%7D'"
```

reports `1` for the host. Judge recovery by the value returning, not by the restart command's exit
code.

**Rollback:** none — restoring a down host has no state to undo. If the restart was the wrong fix,
investigate the host's own service manager.

#### Step 2 — Repair the deep-health probe (DeepHealthProbeFailed / Stale)

A failing or stale probe means the deep-health endpoint is unreachable, returning malformed data, or
the prober is not scraping it. Confirm the target endpoint is serving, then confirm the prober is
running (the deep-health profile is opt-in).

**Command**

```bash
# Confirm the deep-health target responds on the monitored host:
curl -sS --max-time 5 https://SERVICE-ENDPOINT/health
cd stack/compose && docker compose ps prober      # prober present only with the deep-health profile
```

**Verify (content):** after the endpoint is healthy and the prober is scraping, `pulse_deep_health_up`
returns `1` and the last-scrape age drops below 300 — re-run the triage queries and read the values.

**Rollback:** if you toggled the deep-health profile or a prober config to test, revert the compose
override (`git checkout -- stack/compose/docker-compose.override.yml`) and re-up.

## Where to go next

- **A declared functional deep-health expression is failing** → [deep-health](/deep-health/).
- **Enroll or re-deliver a host agent** → [agent install](/agent-install/).
- **Capacity pressure on a reachable host** → [capacity](/capacity/).
- **Full runbook index** → [runbooks](/runbooks/).
