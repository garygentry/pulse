---
title: Alerting
description: How Pulse alerting fits together — severity routing, the deadman, per-endpoint synthetic paging, runbook links on every page, and the end-to-end delivery canary.
slug: alerting
---

# Alerting

Pulse has **one routing brain**: every alert — a vmalert rule, a Gatus synthetic check, the
deadman — flows through **Alertmanager**, which owns routing, grouping, silences, and delivery. This
page is the operator's map of that machine and the ergonomics layered on top of it. To *activate*
routing (transform the rendered config into the native Alertmanager config and mount it), follow the
[rollout-session runbook](/rollout-session/); this page is the concepts behind it.

## The shape of the pipeline

```
vmalert rules ─┐
Gatus checks ──┼─▶ Alertmanager ──▶ receivers (email / Telegram / Slack / webhook)
deadman  ──────┘     routing, grouping, silences, templates
```

- **Rules** live in two places: the committed **static** library
  (`stack/compose/config/vmalert/rules/*.yml` — availability, capacity, churn, engine,
  pipeline-health, deadman, canary) and the **rendered** families the engine derives from the estate
  (deep-health functional + backup-freshness).
- **Severity** drives routing. `critical` pages a human channel immediately (≤30s budget) and
  mirrors to the automation webhook; `warning` is a grouped, non-paging ops route (deferred during
  quiet hours); `info` is a daily 09:00 digest. `deadman` and the synthetic canary are matched by
  alertname, not severity (below).
- **Receivers** carry the credential as a `${VAR}`/`op://` **reference** only — never a literal
  (`REQ-SEC-01`). The estate declares channels; the renderer maps each kind to its Alertmanager
  slot (chat→slack, email→email, telegram→telegram, push/webhook→webhook).

## Runbook links on every page (`runbook_url`)

Every alert carries a Prometheus-style **`runbook_url`** annotation, so an operator paged at 2am has
the runbook one click away — not a grep through a repo. It is carried through vmalert →
Alertmanager and **rendered as a link** in the notification body:

- **Email + Telegram** notification bodies render it via the shipped templates
  (`stack/compose/config/alertmanager/templates/pulse.tmpl`), which the rendered Alertmanager config
  registers and the email/telegram receivers reference.
- **Grafana** surfaces it automatically: the `alertGroups` panels render each alert's annotations,
  and Grafana links a `runbook_url`.

The links default to a documented, estate-agnostic base host, **`https://runbooks.pulse.local`**,
with a per-family path (e.g. `…/deep-health`, `…/backup-freshness`, `…/availability`). Repoint that
host (DNS or your reverse proxy) at your published runbooks — the base lives in one place,
`RUNBOOK_BASE_URL` in `stack/alerting/src/constants.ts`.

Each per-family path resolves to a shipped incident runbook under `docs/runbooks/`, whose page slug
equals the `runbook_url` slug — so repointing the host at the published runbook suite lands each alert
on its authored page. The nine families and their pages:

| `runbook_url` path | Runbook page |
|--------------------|--------------|
| `/availability` | [Availability](/availability/) |
| `/capacity` | [Capacity](/capacity/) |
| `/churn` | [Container churn](/churn/) |
| `/deep-health` | [Deep health](/deep-health/) |
| `/backup-freshness` | [Backup freshness](/backup-freshness/) |
| `/engine` | [Engine self-monitoring](/engine/) |
| `/pipeline-health` | [Pipeline health](/pipeline-health/) |
| `/deadman` | [Dead man's switch](/deadman/) |
| `/canary` | [Alert-path canary](/canary/) |

A `stack/alerting` test (`runbook-coverage.test.ts`) enforces the mapping: every slug the rules and
`RUNBOOK_SLUGS` emit must have a matching runbook page, so a new alert family cannot ship a dangling
`runbook_url`.

## Synthetic (Gatus) paging: the `alerts:` binding

Gatus blackbox checks page through Alertmanager **only for endpoints that declare an `alerts:`
block**. Declare that binding on a service in the estate and the renderer emits it into the Gatus
config, flipping the check from silent to paging:

```yaml
services:
  - name: portal-web
    host: harbor-web-01
    kind: http
    managed: true
    ingress_url: https://portal.aurora.example   # the check target
    alerts:
      - type: custom                # the shipped Gatus→Alertmanager provider
        failure_threshold: 3        # omitted fields inherit the provider's default-alert
        send_on_resolved: true
        description: "Portal ingress synthetic check failing"
```

Field notes:

- **`type`** names the Gatus provider to bind; `custom` is the shipped Alertmanager provider
  (`stack/gatus/alerting-provider.yaml`).
- Optional: **`enabled`**, **`description`**, **`failure_threshold`**, **`success_threshold`**,
  **`send_on_resolved`**. Anything omitted inherits the provider's `default-alert` thresholds.
- A binding only fires on a service that **renders a Gatus endpoint** — one with an `ingress_url`,
  not suppressed. On any other service it is inert and raises an `inert_alert_binding` **warning** at
  validation.

## The deadman: proving the pipeline is alive

The **deadman** (`DeadMansSwitch`, `expr: vector(1)`) fires continuously and routes to an **external
webhook** (`${PULSE_DEADMANSSWITCH_URL}`, e.g. an external heartbeat-monitor ping URL). Its
*absence* — expected
every 5 minutes — tells an external watchdog that Pulse's rule-eval or delivery path has stopped. It
proves the pipeline is **alive**, but because it routes to a webhook it does **not** prove delivery
through your real human channels.

## The delivery canary: proving real channels work

To catch a **silently-broken channel** (an expired Telegram token, an SMTP auth failure) *before* the
next real incident, Pulse ships an alert-path **delivery canary** (`PulseAlertPathCanary`). It:

- **fires on a schedule and auto-resolves** — a ~2-minute window every 6 hours (four proofs a day);
- is routed (matched by alertname, like the deadman) to the **live human receivers** — the real
  email/Telegram path, distinct from the deadman's webhook — so if it stops arriving on cadence, a
  channel is broken;
- carries `severity: info` + `synthetic: "true"`, so it is clearly a self-test, filterable in
  dashboards, and **silenceable during maintenance** (silence on `alertname="PulseAlertPathCanary"`
  or `synthetic="true"`).

The canary **complements** the deadman — deadman proves eval + pipeline; canary proves end-to-end
delivery through the channels an operator actually reads. It is authored as a static rule
(`stack/compose/config/vmalert/rules/canary.yml`); adjust its cadence there.

## Where to go next

- **Activate routing / channels** → the [rollout-session runbook](/rollout-session/).
- **Wire credentials for the receivers** → [secret recipes](/secret-recipes/).
- **The overview that surfaces these alerts** → [web overview](/web-overview/).
