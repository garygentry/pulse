---
title: Alert-path canary
description: What the PulseAlertPathCanary synthetic alert means and what to do when it stops arriving — the scheduled, auto-resolving delivery self-test that proves the live human channels (email/Telegram) actually deliver.
slug: canary
---

# Alert-path canary

This runbook is where the `runbook_url` on the **canary** family lands. `PulseAlertPathCanary` is a
**synthetic delivery self-test** (issue #17): it fires for a ~2-minute window every 6 hours (UTC),
auto-resolves, and — unlike the [dead man's switch](/deadman/), which routes to an opaque webhook —
is routed to the **live human receivers** (email/Telegram) with send-on-resolve. Four delivery proofs
a day. **It is never a real incident.**

The rule is `stack/compose/config/vmalert/rules/canary.yml` (group `canary`). Its expression is
`(hour() % 6 == 0) and (minute() < 2)`; it carries `severity: info` and `synthetic: "true"`.

## When this fires

- **PulseAlertPathCanary** (info, `synthetic: "true"`) — a scheduled self-test. **Seeing it in your
  inbox/Telegram on cadence is the healthy signal.** The failure mode is its *absence*: if it is not
  arriving through the human channels four times a day, a notification channel is silently broken —
  before the next real incident depends on it.

## Triage

The canary firing correctly but **not being delivered** points at the human channels. Work from
"did it fire" toward "did it deliver".

**Verify (content):** confirm the canary fired and reached Alertmanager on its last window. From the
engine host:

```bash
cd stack/compose
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- http://vmalert:8880/api/v1/alerts | grep -o PulseAlertPathCanary"
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- http://alertmanager:9093/api/v2/alerts | grep -o PulseAlertPathCanary"
```

If both show the alert during a firing window but it never arrived, the fault is receiver delivery.

**Verify (content):** check Alertmanager's delivery for the human receivers and look for a silence
hiding it:

```bash
docker compose logs --tail 100 alertmanager | grep -iE 'canary|notify|error'
docker compose run --rm --entrypoint sh alertmanager -c \
  "amtool --alertmanager.url=http://alertmanager:9093 silence query alertname=PulseAlertPathCanary"
```

An active silence explains a missing canary during maintenance; a delivery error in the log names the
broken channel (SMTP auth, expired Telegram token).

## Remediate

#### Step 1 — Repair the broken human channel

The canary and [pipeline-health](/pipeline-health/) point at the same receivers. Fix the failing
channel's credentials/endpoint in the environment and reload Alertmanager.

**Command**

```bash
cd stack/compose
$EDITOR .env                                   # fix the human-receiver secret (SMTP creds / Telegram token)
docker compose up -d --wait alertmanager
```

**Verify (content):** the **next** canary window delivers. Either wait for the next 6-hourly window
and confirm arrival in the inbox/Telegram, or confirm `AlertNotificationsFailing` has cleared for that
integration (see [pipeline-health](/pipeline-health/)). Judge by an actual delivered message, not by
the reload's exit code.

**Rollback:** restore the prior `.env` receiver values and reload.

#### Step 2 — Lift a stale silence

If a maintenance silence on the canary outlived its window, expire it so delivery proofs resume.

**Command**

```bash
cd stack/compose
docker compose run --rm --entrypoint sh alertmanager -c \
  "amtool --alertmanager.url=http://alertmanager:9093 silence expire SILENCE_ID"
```

**Verify (content):** `amtool ... silence query alertname=PulseAlertPathCanary` returns no active
silence, and the next window's canary is delivered.

**Rollback:** re-add the silence (`amtool ... silence add ...`) if the maintenance is still in effect.

## Where to go next

- **The pipeline heartbeat (opaque webhook, not the human channels)** → [dead man's switch](/deadman/).
- **Receiver delivery is failing or slow** → [pipeline-health](/pipeline-health/).
- **Wire and shake down alert channels** → [rollout session](/rollout-session/).
- **How the canary route is wired** → [alerting](/alerting/).
- **Full runbook index** → [runbooks](/runbooks/).
