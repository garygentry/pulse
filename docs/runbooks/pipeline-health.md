---
title: Pipeline health
description: Triage and remediate the pipeline-health alert family — AlertRuleEvalErrors, AlertNotificationsFailing, AlertNotificationLatencyHigh, and AlertRemoteWriteBacklog — which distinguish a running-but-degraded alert path from a healthy one.
slug: pipeline-health
---

# Pipeline health

This runbook is where the `runbook_url` on a **pipeline-health** alert lands. These alerts catch the
alert path being **up but degraded** — vmalert running yet erroring, Alertmanager running yet failing
or slow to deliver. Process liveness alone never proves a healthy path (`REQ-OBS-03`); that is why
this family exists alongside the [engine](/engine/) up/down checks.

The rule family is `stack/compose/config/vmalert/rules/pipeline-health.yml` (group `pipeline-health`),
built from the vmalert/Alertmanager self-monitoring series.

## When this fires

- **AlertRuleEvalErrors** (warning) — `increase(vmalert_execution_errors_total[10m]) > 0`: vmalert is
  up but rule-group evaluation is erroring; some rules may not be evaluating.
- **AlertNotificationsFailing** (critical) — `increase(alertmanager_notifications_failed_total[10m]) > 0`:
  the router is up but notifications are **not reaching recipients**.
- **AlertNotificationLatencyHigh** (warning) — p99 notification latency > **10s** for 10m; delivery
  is degraded though the router is up.
- **AlertRemoteWriteBacklog** (warning) — `increase(vmalert_remotewrite_packets_dropped_total[10m]) > 0`:
  ALERTS/recording series are not being persisted; self-monitoring and downstream views lag.

## Triage

**Verify (content):** read the self-monitoring counters the rules key on, and note the
`integration` label (which receiver is failing/slow). From the engine host:

```bash
cd stack/compose
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- 'http://victoriametrics:8428/api/v1/query?query=increase(alertmanager_notifications_failed_total%5B10m%5D)'"
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- 'http://victoriametrics:8428/api/v1/query?query=increase(vmalert_execution_errors_total%5B10m%5D)'"
```

**Verify (content):** read the component logs to find the concrete cause — an SMTP auth failure, an
expired Telegram token, a bad rule expression, or a VictoriaMetrics write rejection:

```bash
docker compose logs --tail 100 alertmanager    # AlertNotificationsFailing / LatencyHigh
docker compose logs --tail 100 vmalert         # AlertRuleEvalErrors / RemoteWriteBacklog
```

## Remediate

#### Step 1 — Fix the failing integration (AlertNotificationsFailing / LatencyHigh)

The `integration` label and Alertmanager logs name the broken receiver. Correct its credentials or
endpoint in the environment, then reload Alertmanager so the receiver re-reads config. Retry/backoff
is Alertmanager-native, so a fixed receiver drains its backlog on its own.

**Command**

```bash
cd stack/compose
$EDITOR .env                                   # fix the receiver secret/URL (SMTP creds, Telegram token, webhook URL)
docker compose up -d --wait alertmanager
```

**Verify (content):** the failed-notification counter stops advancing —

```bash
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- 'http://victoriametrics:8428/api/v1/query?query=increase(alertmanager_notifications_failed_total%5B10m%5D)'"
```

returns `0` for that integration after a fresh window, and the [canary](/canary/) delivers on its next
cycle. Judge by the counter settling, not by the reload's exit code.

**Rollback:** restore the prior `.env` receiver values and reload.

#### Step 2 — Fix rule-eval errors or the remote-write backlog

For `AlertRuleEvalErrors`, the vmalert log names the failing rule group — correct the rule expression
and reload. For `AlertRemoteWriteBacklog`, the drop is usually VictoriaMetrics being unhealthy, full,
or unreachable — restore it (see [engine](/engine/) / [capacity](/capacity/)).

**Command**

```bash
cd stack/compose
promtool check rules config/vmalert/rules/*.yml   # for eval errors
docker compose up -d --wait vmalert victoriametrics
```

**Verify (content):** the relevant counter (`vmalert_execution_errors_total` or
`vmalert_remotewrite_packets_dropped_total`) shows **no increase** over a fresh 10m window when
re-queried, confirming the degraded condition has cleared.

**Rollback:** `git checkout` any rule/config you edited and re-up to the last-good state.

## Where to go next

- **A component is fully down, not just degraded** → [engine](/engine/).
- **Prove the human channels actually deliver** → [canary](/canary/).
- **The heartbeat proving eval+delivery is alive** → [dead man's switch](/deadman/).
- **How receivers are wired** → [alerting](/alerting/).
- **Full runbook index** → [runbooks](/runbooks/).
