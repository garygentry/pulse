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

Gatus blackbox checks page **only for services that declare an `alerts:` binding**. Declare it on a
service in the estate and the alerting transform renders a critical **`GatusCheckFailed`** vmalert
rule for that service's ingress check into `rendered/vmalert/rules/synthetic.yml`:

```yaml
services:
  - name: portal-web
    host: harbor-web-01
    kind: http
    managed: true
    ingress_url: https://portal.aurora.example   # the check target
    alerts:
      - type: custom                # retained for compatibility; selects nothing
        failure_threshold: 3        # failed checks before firing (default 3, max 60)
        success_threshold: 2        # passing checks before resolving (default 2, max 60)
        description: "Portal ingress synthetic check failing"
```

The rule reads Gatus's own `gatus_results_total` series (the stack enables Gatus's `/metrics` and
scrapes it every 30s). Gatus checks nominally run every 60s. With F = `failure_threshold` and
S = `success_threshold`:

- **Fires** once there were **at least F failed checks in the last 4·F minutes and no passing check
  in the last F minutes**. At the nominal cadence that is F consecutive failures, so with the
  defaults the alert fires about 3–4 minutes after the last good check. After a Gatus restart the
  rule still needs F fresh failures.
- **Resolves** once there were **at least S passing checks and no failed check in the last S+1
  minutes**. With the defaults that is about 3 minutes after the last failure. A pass between
  failures does not resolve it.
- **Gatus down never resolves it.** While the alert fires, the rule reads its own state back from
  the `ALERTS` series vmalert writes to VictoriaMetrics, and with no fresh check results nothing
  can clear it. (A Gatus outage raises `AncillaryDown`; see the [engine runbook](/engine/).)
- **Slow checks delay firing, they don't flap.** Gatus runs checks one at a time and waits 60s
  after each finishes, so a broad outage (many endpoints timing out) stretches the real cadence.
  The 4·F failure window still fits F failures at up to about 4× the nominal interval; slower than
  that, the alert fires late. Once it fires, it holds until the resolve condition is met.

vmalert re-sends the alert on every evaluation while it fires, so a long outage stays firing in
Alertmanager and the "resolved" notification arrives only when the check recovers. The alert carries
`severity: critical`, `source: gatus`, `endpoint: <host>/<service>`, `group: <host>`, plus `name`
(same value as `endpoint`), vmalert's `alertgroup: synthetic-checks` and the `estate` label, with
`summary`, `description`, `url` (the ingress URL) and `runbook_url` (the
[synthetic checks runbook](/synthetic/)).

Field notes:

- Optional: **`enabled`** (`false` renders no rule), **`description`**, **`failure_threshold`**,
  **`success_threshold`**.
- **`type`** and **`send_on_resolved`** are kept for compatibility and **have no effect**. Whether
  you get resolve notifications is decided by each Alertmanager receiver (`send_resolved`). Setting
  `send_on_resolved: false` raises an advisory `IGNORED_ALERT_FIELD` finding from the transform.
- One rule per check: if a service declares several enabled bindings, the first is used (advisory
  `IGNORED_ALERT_FIELD` finding).
- A binding only fires on a service that **renders a Gatus endpoint**, meaning one with an
  `ingress_url` that is not suppressed. On any other service it is inert and raises an
  `inert_alert_binding` **warning** at validation.
- The rule file is a rendered artifact like `deep-health.yml` and `backup.yml`: mount it into
  vmalert as the [rollout session](/rollout-session/) shows, or no synthetic check pages.

> **BREAKING for existing deployments: upgrading from the Gatus push provider.** Earlier revisions
> paged Gatus checks through a Gatus `custom` alerting provider posting straight to Alertmanager.
> That provider never resolved alerts correctly (issue #1) and has been removed. After upgrading you
> **must** re-run the alerting transform and add the `synthetic.yml` mount to vmalert. If you
> don't, Gatus checks **silently stop paging**: nothing errors, and the checks stay green in the
> Gatus UI. No estate change is needed, since the same `alerts:` bindings drive the rules. Alerts
> also change identity at cutover (new labels such as `estate`, `name` and `alertgroup`), so
> existing silences matching on the full old label set need updating.

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
