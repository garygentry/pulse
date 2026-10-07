---
title: Container churn
description: Triage and remediate the churn alert family — ContainerRestarting and ContainerChurn — cadvisor-derived workload telemetry that a container on a monitored host is restarting or flapping, never a service-liveness signal.
slug: churn
---

# Container churn

This runbook is where the `runbook_url` on a **churn** alert lands. It fires when cadvisor
observes a container **restarting** (`ContainerRestarting`) or **flapping** (`ContainerChurn`) on
a monitored host. Both are **workload telemetry only** — a churning container is never treated as a
service-liveness signal (`REQ-AVAIL-04`); host and service liveness are owned by the
[availability runbook](/availability/).

The rule family is `stack/compose/config/vmalert/rules/churn.yml` (group `churn`). Both alerts gate
on cadvisor's own uptime (`process_start_time_seconds{job="cadvisor"}`) so a freshly (re)started
cadvisor — whose `container_start_time_seconds` series all appear at once — never storms the family
(see issue #25, resolved).

## When this fires

- **ContainerRestarting** (warning) — a container restarted **at least once in the last 15m**,
  and cadvisor has been up longer than 15m. `for: 5m` rides out a single-eval blip as the gate opens.
- **ContainerChurn** (warning) — a container restarted **3+ times in the last hour** (flapping),
  with cadvisor up longer than 1h.

The `name` label carries the container name; the `host` label carries the monitored host.

## Triage

**Verify (content):** confirm the restart count is real, not a fresh-cadvisor artifact. From the
engine host, query the same series the rule evaluates and read cadvisor's uptime:

```bash
cd stack/compose
# Restart count for the named container over the last 15m (substitute the alert's name/host):
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- 'http://victoriametrics:8428/api/v1/query?query=changes(container_start_time_seconds%7Bname%3D%22CONTAINER%22%7D%5B15m%5D)'"
# cadvisor uptime in seconds — must exceed the rule's range window (900 / 3600) for the count to be trusted:
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- 'http://victoriametrics:8428/api/v1/query?query=time()-process_start_time_seconds%7Bjob%3D%22cadvisor%22%7D'"
```

A non-empty result with cadvisor uptime well above the window means the restarts are genuine. If
cadvisor uptime is only slightly above 900s and every container reports one restart at once, cadvisor
itself just restarted — the gate should already suppress this; see the engine runbook.

**Verify (content):** on the monitored host, read the container's own restart history and recent exit
reason — this is the ground truth the metric is derived from:

```bash
# On the monitored host:
docker inspect -f '{{.RestartCount}} {{.State.ExitCode}} {{.State.Error}}' CONTAINER
docker logs --tail 100 CONTAINER
```

A non-zero `ExitCode` with a repeating stack trace or OOM message in the logs identifies the cause.

## Remediate

Remediation is workload-specific; the steps below are the common path. Because a churning container
is not itself a Pulse concern, changes happen on the **monitored host**, not the engine.

#### Step 1 — Address the container's crash cause

Fix the underlying fault the logs point to — an OOM kill, a failing dependency, a bad config, or an
image regression. For an OOM kill, raise the container's memory limit or reduce its footprint; for a
crash loop, roll back to the last-good image tag.

**Command**

```bash
# On the monitored host — example: roll a crash-looping container back to a known-good tag.
docker compose -f /path/to/service/compose.yml up -d SERVICE   # after pinning the good tag
```

**Verify (content):** the restart count stops advancing. Re-run the `changes(...)` query above after
one full 15m window and confirm it returns `0` (or the container's `RestartCount` in `docker inspect`
holds steady across several minutes) — judge by the count settling, never by the deploy command's
exit code.

**Rollback:** if the change regresses, restore the previous compose/tag on the host
(`git checkout` the service's compose file, or re-pin the prior image) and re-up.

#### Step 2 — Silence expected churn, don't mute the family

If the churn is expected (a scheduled batch job, a deliberate rolling restart), suppress **that
container** for the maintenance window rather than the whole rule. Churn alerts are the designated
target of expected-churn suppressions (`REQ-SUPP-03`).

**Command**

```bash
cd stack/compose
# Silence one container in Alertmanager for 2h (adjust matchers/duration):
docker compose run --rm --entrypoint sh alertmanager -c \
  "amtool --alertmanager.url=http://alertmanager:9093 silence add alertname=~'ContainerRestarting|ContainerChurn' name=CONTAINER --duration=2h --comment='expected maintenance churn'"
```

**Verify (content):** the silence appears and matches —

```bash
docker compose run --rm --entrypoint sh alertmanager -c \
  "amtool --alertmanager.url=http://alertmanager:9093 silence query name=CONTAINER"
```

lists the active silence with its matchers and expiry.

**Rollback:** `amtool ... silence expire <id>` ends the silence early once the window closes.

## Where to go next

- **Understand the running stack and cadvisor** → [runtime posture](/runtime-posture/).
- **A host or service is actually down (not just a container)** → [availability](/availability/).
- **How runbook links are wired** → [alerting](/alerting/).
- **Full runbook index** → [runbooks](/runbooks/).
