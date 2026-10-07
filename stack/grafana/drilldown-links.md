# Drilldown-Links Contract

> **Feature:** `dashboards` (epic `stack`)
> This is the committed `(category, target) → Grafana deep-link` convention that `web-app`
> deep-links against. The board **UID** is the only durable URL handle; title-slug URLs are
> rejected as brittle. The UIDs and bound variable names below are **frozen for v1** — any change
> to a UID or a bound variable name is a **breaking change** to this contract (REQ-LINK-03).

## Contract table

Each row maps a category to its board UID, the URL-bound template variable that scopes it, the
deep-link template, and the view-time `label_values(...)` query that populates the variable's
option list. The **Bound variable** column equals `TARGET_VARS[uid]` (`00-core-definitions.md` §1)
for every row.

| Category | UID | Bound variable | Deep-link | Variable query (view-time) |
|---|---|---|---|---|
| per-host | `pulse-host` | `instance` | `/d/pulse-host?var-instance=<host>` | `label_values(node_uname_info, instance)` |
| deep-health | `pulse-deephealth` | `service` | `/d/pulse-deephealth?var-service=<service>` | `label_values(<probe metric>, service)` |
| hypervisor | `pulse-hypervisor` | `instance` | `/d/pulse-hypervisor?var-instance=<pvehost>` | `label_values(pve_up, instance)` |
| NAS | `pulse-nas` | `instance` | `/d/pulse-nas?var-instance=<nashost>` | `label_values(<nas metric>, instance)` |
| GPU contention | `pulse-gpu` | `instance` | `/d/pulse-gpu?var-instance=<host>` | `label_values(pulse_command_signal_up{signal="gpu"}, instance)` |
| DNS | `pulse-dns` | `instance` | `/d/pulse-dns?var-instance=<host>` | `label_values(coredns_build_info, instance)` |
| ingress | `pulse-ingress` | `instance` | `/d/pulse-ingress?var-instance=<host>` | `label_values(nginx_ingress_controller_build_info, instance)` |
| engine self-health | `pulse-engine` | *(none — fixed link)* | `/d/pulse-engine` | n/a |

### The `pulse-engine` fixed link

`pulse-engine` is a **whole-engine** board — it scopes nothing by target, so it binds **no** URL
variable (`TARGET_VARS["pulse-engine"] === null`). Its deep-link is the fixed `/d/pulse-engine`
with no `var-...` query string, and its variable query is `n/a`. `web-app` links to it directly
without a target argument.

## Non-URL-bound datasource variables (not deep-link bindings)

Beyond the URL-bound target variables above, every board carries **datasource** template variables
that are **not** part of the deep-link. They resolve at view time and never appear in the URL, so
`web-app` never sets them — they are portability plumbing, not target selectors:

- **`DS`** — type `datasource`, query `prometheus`. Present on **every** board; resolves to
  stack-core's default VictoriaMetrics datasource (no pinned UID). Every metric panel and every
  `label_values(...)` query references `${DS}`, never a hardcoded datasource UID.
- **`DS_ALERTS`** — type `datasource`, query `alertmanager`. Present **only on boards carrying an
  Alert-list panel**; resolves to the additive Alertmanager datasource
  (`uid: pulse-alertmanager`). Referenced only via `${DS_ALERTS}`.

These are deliberately **omitted** from the deep-link column above: they are the board's full
variable set for reader context, but they are **not** deep-link bindings.

## Placeholder metric names (`<probe metric>` / `<nas metric>`)

The variable-query column for `pulse-deephealth` and `pulse-nas` uses the placeholders
`<probe metric>` and `<nas metric>`. These are **intentionally unresolved** in v1: the deep-health
probe series depends on a prober mechanism not yet frozen in stack-core, and the NAS series depends
on a TrueNAS-class exporter image not yet chosen.

> `WARNING — confirm at implementation:` the exact `<probe metric>` and `<nas metric>` names in the
> `pulse-deephealth` / `pulse-nas` variable queries are confirmed against live scraped exporter
> output before implementation. The **contract-visible** parts — the UIDs (`pulse-deephealth`,
> `pulse-nas`) and the bound variable names (`service`, `instance`) — are **frozen now** and are
> NOT affected by resolving the metric name; only the internal `label_values(...)` argument changes.

The deep-link (`/d/pulse-nas?var-instance=<nashost>`) and its bound variable name (`instance`) do
not change when `<nas metric>` is later pinned.

## Caller-supplied placeholders

`<host>`, `<pvehost>`, `<nashost>`, and `<service>` in the deep-link column are **caller-supplied
placeholders** — the target value `web-app` substitutes at link-construction time (e.g. an
`instance` label value). They are documentation placeholders, **not** estate literals, and MUST NOT
be replaced with any real host/service name in this committed doc (REQ-SEC-02).
