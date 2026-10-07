---
title: Dead man's switch
description: What to do when the DeadMansSwitch heartbeat stops — the always-firing alert whose ABSENCE at the external dead-man receiver means Pulse's own evaluation or delivery path has stopped.
slug: deadman
---

# Dead man's switch

This runbook is where the `runbook_url` on the **deadman** family lands. `DeadMansSwitch` is an
**always-firing** alert (`expr: vector(1)`, no `for:`). You are almost never paged by it *firing* —
you are paged by its **absence**. It routes to an independent external dead-man receiver on a 5m
cadence; when that heartbeat stops arriving (the external service alarms after ~15m — three missed
sends), Pulse's evaluation or delivery path has stopped.

The rule is `stack/compose/config/vmalert/rules/deadman.yml` (group `deadman`). The route to the
`pulse-deadman` receiver — external isolation, `repeat_interval: 5m` — is owned by the Alertmanager
config, not this rule file.

## When this fires

- **DeadMansSwitch** (severity `deadman`) — always firing while vmalert evaluates. **A missing
  heartbeat at the external receiver is the alarm.** It proves rule evaluation *and* the delivery
  path are alive; unlike the [canary](/canary/), it routes to an opaque webhook, so it does not prove
  the human channels work.

## Triage

The heartbeat can stop for two broad reasons: **evaluation stopped** (vmalert/VictoriaMetrics down)
or **delivery stopped** (Alertmanager or the external hop). Work from the engine outward.

**Verify (content):** confirm the engine components that produce and route the heartbeat are up:

```bash
cd stack/compose
docker compose ps victoriametrics vmalert alertmanager    # all should be Up / healthy
```

**Verify (content):** confirm vmalert is still evaluating and the heartbeat rule is loaded and firing:

```bash
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- http://vmalert:8880/api/v1/alerts | grep -o DeadMansSwitch"
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- http://alertmanager:9093/api/v2/alerts | grep -o DeadMansSwitch"
```

The first proves vmalert is firing it; the second proves it reached Alertmanager. Where the chain
breaks tells you which component to fix.

**Verify (content):** confirm the external hop is reachable — the receiver URL is a non-secret
`.env` placeholder (`PULSE_DEADMANSSWITCH_URL`):

```bash
cd stack/compose && grep PULSE_DEADMANSSWITCH_URL .env
# Then, from a host with egress, confirm the external dead-man endpoint accepts a ping (per its docs).
```

## Remediate

#### Step 1 — Restart the stalled engine component

Bring back whichever component the triage chain showed as broken — most often `vmalert` (evaluation)
or `alertmanager` (routing).

**Command**

```bash
cd stack/compose
docker compose up -d --wait --wait-timeout 180 victoriametrics vmalert alertmanager
```

**Verify (content):** the heartbeat resumes end-to-end — `DeadMansSwitch` reappears at Alertmanager
(re-run the `api/v2/alerts` grep above) and, within ~5m, the external receiver records a fresh
heartbeat. Judge recovery by the heartbeat arriving downstream, not by `up --wait` exiting `0`.

**Rollback:** none for a restart. If a config change caused the stall, `git checkout` the offending
config and re-up.

#### Step 2 — Repair the external delivery hop

If the engine is healthy and the heartbeat reaches Alertmanager but the external receiver still alarms,
the fault is the external hop: a wrong `PULSE_DEADMANSSWITCH_URL`, a revoked token, or blocked egress.

**Command**

```bash
cd stack/compose
# Correct the endpoint in the environment, then reload Alertmanager so the receiver re-reads it:
$EDITOR .env                                   # fix PULSE_DEADMANSSWITCH_URL
docker compose up -d --wait alertmanager
```

**Verify (content):** the external dead-man service shows the heartbeat resuming on its 5m cadence
(check its dashboard/inbox). Confirm by the external side clearing, not by the local reload.

**Rollback:** restore the prior `.env` value (`git checkout -- stack/compose/.env` if committed, or
your secret store) and reload.

## Where to go next

- **Prove the human channels deliver, not just the pipeline** → [canary](/canary/).
- **An engine component is down** → [engine](/engine/).
- **Delivery is running but failing/slow** → [pipeline-health](/pipeline-health/).
- **How the deadman route is wired** → [alerting](/alerting/).
- **Full runbook index** → [runbooks](/runbooks/).
