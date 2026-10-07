---
title: Engine self-monitoring
description: Triage and remediate the engine alert family — AlertPathDown (critical) when VictoriaMetrics, vmalert, or Alertmanager is unreachable, and AncillaryDown (warning) when a non-critical engine component is down.
slug: engine
---

# Engine self-monitoring

This runbook is where the `runbook_url` on an **engine** alert lands. The family is the Pulse stack
watching **itself**: `AlertPathDown` fires when a component required to *evaluate or deliver* alerts
is unreachable; `AncillaryDown` fires when a non-critical engine component is down.

The rule family is `stack/compose/config/vmalert/rules/engine.yml` (group `engine`). Job names are the
stack-core scrape jobs.

## When this fires

- **AlertPathDown** (critical) — `up{job=~"victoriametrics|vmalert|alertmanager"} == 0` for **2m**.
  A core alert-path component is down and the pipeline is compromised.
- **AncillaryDown** (warning) — `up{job=~"gatus|engine-cadvisor|pve-exporter"} == 0` for **5m**. A
  non-critical component (synthetic checks, engine cadvisor, PVE exporter) is down; investigate at
  leisure. Grafana and the profile-gated prober are deliberately excluded.

> **A blind spot by design.** vmalert evaluates this rule, so it detects loss of *VictoriaMetrics*
> or *Alertmanager*. Loss of *vmalert itself* (or VictoriaMetrics, which it reads from) cannot be
> self-detected — that gap is covered externally by the [dead man's switch](/deadman/), whose
> heartbeat stops when evaluation stops. If you were paged by a missing deadman rather than by
> `AlertPathDown`, start there.

## Triage

**Verify (content):** identify which component is down and why. From the engine host:

```bash
cd stack/compose
docker compose ps                       # find the unhealthy/exited service
# Confirm the scrape target the rule keys on:
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- 'http://victoriametrics:8428/api/v1/query?query=up%7Bjob%3D~%22victoriametrics%7Cvmalert%7Calertmanager%7Cgatus%7Cengine-cadvisor%7Cpve-exporter%22%7D'"
```

The `up` vector shows a `0` for each down job. Then read the failed component's logs:

```bash
docker compose logs --tail 100 SERVICE   # e.g. vmalert, alertmanager, victoriametrics, gatus
```

A crash loop is usually a bad mounted config (a malformed rule file fatals vmalert; a bad routing
tree fatals Alertmanager); an OOM or disk-full is a host-capacity problem — see
[capacity](/capacity/).

## Remediate

#### Step 1 — Restore the down component

Bring the component back up healthy. For `AlertPathDown` this is urgent — the pipeline is degraded
until it returns.

**Command**

```bash
cd stack/compose
docker compose up -d --wait --wait-timeout 180 SERVICE
```

**Verify (content):** the component reports healthy and its scrape target returns to `up == 1` —

```bash
docker compose ps SERVICE      # STATUS shows Up / healthy
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- 'http://victoriametrics:8428/api/v1/query?query=up%7Bjob%3D%22SERVICE%22%7D'"
```

returns `1`. Judge recovery by health + the target scraping, never by the `up --wait` exit code.

**Rollback:** if the restart won't hold because a config change broke it, revert that config
(`git checkout -- stack/compose/config/...` or `docker-compose.override.yml`) and re-up the base slot.

#### Step 2 — Fix a fatal config, then reload

If a component crash-loops on a bad config (vmalert on a malformed rule, Alertmanager on a bad route),
correct the config and reload rather than restart-looping.

**Command**

```bash
cd stack/compose
# Lint before reloading — e.g. rules for vmalert:
promtool check rules config/vmalert/rules/*.yml
docker compose up -d --wait SERVICE
```

**Verify (content):** the lint prints `SUCCESS` and the component stays Up across several minutes
(`docker compose ps SERVICE` holds `healthy`, no new restart in `docker compose logs`).

**Rollback:** `git checkout` the config you edited and re-up to return to the last-good state.

## Where to go next

- **The heartbeat that catches vmalert/VM loss** → [dead man's switch](/deadman/).
- **Delivery is up but failing or slow** → [pipeline-health](/pipeline-health/).
- **Host capacity is starving the engine** → [capacity](/capacity/).
- **Understand the running stack** → [runtime posture](/runtime-posture/).
- **Full runbook index** → [runbooks](/runbooks/).
