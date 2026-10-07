---
title: Capacity
description: Triage and remediate the capacity alert family — HighCPU, HighMemory, LowDisk, and CriticalDisk — sustained-utilization thresholds on a monitored host, where CriticalDisk pages on imminent filesystem exhaustion.
slug: capacity
---

# Capacity

This runbook is where the `runbook_url` on a **capacity** alert lands. The family covers sustained
CPU, memory, and filesystem pressure on a monitored host. All four are **sustained** signals — they
fire only after the threshold holds for **15m**, so a transient spike never pages.

The rule family is `stack/compose/config/vmalert/rules/capacity.yml` (group `capacity`). Thresholds
come from `CAPACITY_THRESHOLDS` in `stack/alerting/src/constants.ts` (CPU/mem 90%, disk warn 20% free,
disk crit 10% free).

## When this fires

- **HighCPU** (warning) — CPU utilization > **90%** for 15m.
- **HighMemory** (warning) — memory utilization > **90%** for 15m.
- **LowDisk** (warning) — a real filesystem under **20% free** for 15m; reclaim before it reaches crit.
- **CriticalDisk** (critical) — a real filesystem under **10% free** for 15m; imminent exhaustion.

`tmpfs`, `overlay`, `squashfs`, `ramfs`, and `fuse.*` filesystems are excluded from the disk rules.
The `host` label names the affected host; the `mountpoint` label names the filesystem for disk alerts.

## Triage

**Verify (content):** confirm the utilization is sustained, not a reading artifact, by querying the
same series the rule evaluates. From the engine host:

```bash
cd stack/compose
# Free-percent for the alerting mountpoint (substitute host/mount):
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- 'http://victoriametrics:8428/api/v1/query?query=node_filesystem_avail_bytes%7Bfstype!~%22tmpfs%7Coverlay%7Csquashfs%7Cramfs%7Cfuse.%2A%22%7D%2Fnode_filesystem_size_bytes%2A100'"
```

**Verify (content):** on the monitored host, find the actual consumer:

```bash
# On the monitored host:
df -h                                  # confirm the mountpoint and free space
du -x -d1 -h /var 2>/dev/null | sort -h | tail   # largest subtrees (repeat on the full mount)
top -b -n1 | head -20                  # CPU/mem hogs for HighCPU / HighMemory
```

This identifies the process or path driving the pressure — the target of remediation.

## Remediate

Remediation is host-workload-specific; the steps below are the common disk path (the most likely to
page via `CriticalDisk`). CPU/memory pressure is remediated by shedding or resizing the workload.

#### Step 1 — Reclaim space (LowDisk / CriticalDisk)

Free the filesystem the alert names. On a container host, pruning dangling images/volumes and rotating
logs is usually the fastest safe win.

**Command**

```bash
# On the monitored host — reclaim from Docker and journald (safe, non-destructive to running state):
docker system prune -f
journalctl --vacuum-size=200M
```

**Verify (content):** free capacity climbs back above the threshold. Re-run the free-percent query
above (or `df -h` on the host) and confirm the mount reads above 20% free for `LowDisk` / 10% for
`CriticalDisk` — judge by the number recovering, not by the prune command's exit code.

**Rollback:** none — reclaiming space is not reversible and should not be. If a prune removed
something needed, restore it from its source (re-pull the image, re-create the volume).

#### Step 2 — Shed or resize a sustained CPU/memory workload

For `HighCPU` / `HighMemory`, cap or relocate the workload the triage `top` identified, or provision
more headroom.

**Command**

```bash
# On the monitored host — example: constrain a hungry container's resources.
docker update --cpus 2 --memory 2g CONTAINER
```

**Verify (content):** utilization falls back under 90% and holds. Re-query CPU/memory utilization
after several minutes and confirm it stays below the threshold across the window.

**Rollback:** `docker update` back to the prior limits (or `git checkout` the service compose file
and re-up) if the constraint starves the workload.

## Where to go next

- **Size disks and headroom up front** → [sizing](/sizing/).
- **A host is unreachable rather than just loaded** → [availability](/availability/).
- **A container is restarting under the pressure** → [churn](/churn/).
- **Full runbook index** → [runbooks](/runbooks/).
