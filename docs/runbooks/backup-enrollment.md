---
title: Backup enrollment
description: Declare backup freshness on a service on day one, re-render, run the alerting transform, and confirm the BackupStale, BackupCritical, and BackupNoData rules wire and load in vmalert — shipped as declaration and alert-wiring only, with a known limitation until host-agent emits the backup-freshness series.
slug: backup-enrollment
---

# Backup enrollment

This runbook enrolls a service's **backup freshness** so a freshly bootstrapped estate is
**never run without backups declared**. You declare `backup_freshness` on a service,
re-render, run the alerting transform, and confirm the `BackupStale`, `BackupCritical`, and
`BackupNoData` rules wire and load in vmalert. Run it as part of the first
[rollout session](/rollout-session/), before retiring any incumbent backup monitoring.

> **Read the Known limitation below before treating these alerts as trustworthy.** Backup
> enrollment ships today as **declaration + alert-wiring only**: the rules render, load, and
> are correct, but end-to-end freshness evaluation is not yet functional because the
> host-agent does not emit the underlying series. Day-one enrollment is still required so the
> estate is never *undeclared*.

The worked estate is the committed reference fixture at `examples/reference/`, which already
declares `backup_freshness` on its `nas-backups` service — the live example the rendered
rules below are drawn from. The steps show enrolling an **additional** service; substitute
your own estate directory and service.

## About the exit contract

The `pulse validate` and `pulse render` steps branch on the stable exit contract: **`0`**
clean, **`1`** findings or drift (fix the estate or re-render, then re-run), **`2`** a tool
fault you fix in the environment and **never** by editing the estate. `bun run
alerting:render` is a sibling transform, not a `pulse` verb; it is whole-or-nothing, so you
verify its output by content.

## Steps

#### Step 1 — Declare `backup_freshness` on a service

Add a `backup_freshness` block to the target service in the estate. The `signal` names the
backup-freshness signal for that service; the `threshold` is the age past which the backup is
considered stale.

**Command**

```bash
# Edit examples/reference/estate/estate.yaml and add, under the target service
# (fictional host db01.example.invalid, service `postgres`):
#
#   backup_freshness:
#     signal: postgres-nightly-dump
#     threshold: "24h"
```

**Verify (content):** the declaration parses against the inventory schema —

```bash
( cd examples/reference && "$PULSE_BIN" validate )
```

reports **zero error findings** and exits `0`. Run it from the estate directory so
`estateDir` resolves there. **Exit `1`** means the block was malformed — read the finding and
fix the YAML; **exit `2`** is a tool fault to resolve in the environment.

**Rollback:** `git checkout -- examples/reference/estate/estate.yaml` restores the prior
estate; nothing has been rendered or applied yet.

#### Step 2 — Re-render and produce the backup rules

Re-render the estate, then run the alerting transform to emit the backup rule family.

**Command**

```bash
( cd examples/reference && "$PULSE_BIN" render )
bun run alerting:render examples/reference/estate examples/reference/rendered
```

**Verify (content):** the three backup rules appear for the enrolled service —

```bash
grep -E 'BackupStale|BackupCritical|BackupNoData' \
  examples/reference/rendered/vmalert/rules/backup.yml
```

prints all three rule names. Confirm the thresholds match the declaration by content: the
`BackupStale` expression compares against `24h` in seconds (`86400`), and `BackupCritical`
against twice that (`172800`) — the transform derives critical as `2×` the stale threshold.

**Rollback:** `git checkout -- examples/reference/rendered/` restores the prior rendered
tree, including the prior `backup.yml`.

#### Step 3 — Confirm the rules load in vmalert

Lint the rendered rules, then confirm vmalert loaded them once the rendered-rule mount is in
place (added in the [rollout session](/rollout-session/), Step 3).

**Command**

```bash
promtool check rules examples/reference/rendered/vmalert/rules/backup.yml
cd stack/compose && docker compose up --wait --wait-timeout 180
```

**Verify (content):** promtool prints `SUCCESS` and lists the three backup rules; then, with
the rendered-rule mount active, vmalert reports the rule as live —

```bash
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- http://vmalert:8880/api/v1/rules | grep -o 'BackupNoData'"
```

returns `BackupNoData`, proving the rule is loaded in the running engine by state, not by the
`up --wait` exit code.

**Rollback:** remove the two rendered `vmalert` rule mounts from
`stack/compose/docker-compose.override.yml` and `docker compose up --wait` — the base slot
mounts return and no committed file changed.

## Known limitation — backups alert as NoData until host-agent ships the signal

> **The host-agent does not yet emit the `pulse_backup_freshness_*` series.** The backup
> rules evaluate over `pulse_backup_freshness_age_seconds` and `pulse_backup_freshness_up`,
> but **no component currently produces them** — the renderer emits the
> `kind: "backup-freshness"` entries so each service's threshold is captured, yet the runtime
> prober drops the series. This is tracked as epic verification item **V-001**, blocking on
> host-agent.
>
> **Consequence:** `BackupNoData` — whose expression is `… == 0 or absent(...)` with a
> `for: 15m` grace — **fires perpetually for every enrolled service**, because the series is
> absent. `BackupStale` and `BackupCritical` cannot evaluate meaningfully until real
> freshness ages arrive.
>
> **Ship anyway, on day one.** This runbook therefore delivers backup enrollment as
> **declaration + alert-wiring only**: the rules render, load, and are correct, and the
> declaration keeps the estate from ever being *undeclared*. Operators should **expect and
> acknowledge the standing `BackupNoData`** for enrolled services, and should **not** treat
> `BackupStale` / `BackupCritical` as trustworthy until V-001 lands and the host-agent ships
> the `pulse_backup_freshness_*` emitter. Track V-001 before relying on backup alerting for
> real cutover decisions.

## Where to go next

- **Wire alert channels and the rendered-rule mount** → [rollout session](/rollout-session/).
- **Retire an incumbent (backups must be enrolled first)** → [retirement checklist](/retirement-checklist/).
- **Full runbook index** → [runbooks](/runbooks/).
