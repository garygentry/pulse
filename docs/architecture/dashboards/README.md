# dashboards

`dashboards` is the Pulse **Grafana dashboard library** and the guard suite that keeps it
honest. It ships five estate-agnostic Grafana boards, the file-provider that provisions them, an
additive Alertmanager datasource for alert-state panels, and a two-tier verification package
(`@pulse/dashboards`) that proves the committed artifacts are well-formed, portable, and
internally consistent.

Like the rest of Pulse, the boards encode **structure, not estate**: no host, domain, service, or
credential literal appears in any committed board. Every estate-specific value arrives at view
time through Grafana template variables and the metric labels the running stack actually holds.

## What ships here

The feature spans two trees:

| Path | What it holds |
|------|---------------|
| `stack/compose/config/grafana/provisioning/dashboards/pulse.yaml` | The single `file` dashboard provider |
| `stack/compose/config/grafana/provisioning/dashboards/json/**` | The board JSON files, one subdir per Grafana folder |
| `stack/compose/config/grafana/provisioning/datasources/alertmanager.yml` | The additive Alertmanager datasource |
| `stack/grafana/` | The `@pulse/dashboards` verification package (guard suite, provenance manifest, drilldown contract) |

The provisioning tree lives under stack-core's existing Grafana mount and is **additive** — it adds
this provider and datasource alongside stack-core's VictoriaMetrics datasource, which is left
byte-identical. Grafana consumes the provisioning files directly at boot; the config *is* the
runtime wiring, and `@pulse/dashboards` only verifies it (it ships no runtime code and exports no
importable surface).

## The boards

| UID | Folder | Target variable | Origin |
|-----|--------|-----------------|--------|
| `pulse-host` | Hosts | `instance` | Imported (Node Exporter Full), pruned + rewired |
| `pulse-hypervisor` | Infrastructure | `instance` | Imported (Proxmox via Prometheus), pruned + rewired |
| `pulse-nas` | Infrastructure | `instance` | Hand-authored |
| `pulse-deephealth` | Deep-Health | `service` | Hand-authored |
| `pulse-engine` | Engine | *(none — fixed link)* | Hand-authored |
| `pulse-gpu` | GPU | `instance` | Hand-authored (issue #1) |
| `pulse-dns` | DNS | `instance` | Hand-authored (issue #14) |
| `pulse-ingress` | Ingress | `instance` | Hand-authored (issue #14) |

Each board's `uid` is stable and frozen for v1 — it is the durable URL identity other features
(notably `web-app`) deep-link into. The Grafana folder for a board is simply the immediate
subdirectory it sits in under `json/`; there is no folder named anywhere in config.

## Quick start

The boards provision automatically whenever the Pulse stack comes up — no extra step. From a
running stack (see the `stack-core` docs for bring-up), every board resolves by uid:

```bash
# inside the stack network
curl -s -u admin:admin http://grafana:3000/api/dashboards/uid/pulse-host
```

Verify the committed artifacts without a running stack:

```bash
# Tier A — hermetic static guards (no Docker)
bun test stack/grafana/tests/static-guards.test.ts

# whole workspace, incl. typecheck
bun run typecheck && bun test
```

Verify end-to-end against a real Grafana (self-skips when no Docker daemon is present):

```bash
bun run smoke:dashboards
```

## Key concepts

**Boards reference datasources only through template variables.** Every metric panel points at
`${DS}` (the VictoriaMetrics datasource) and every alert-state panel at `${DS_ALERTS}` (the
Alertmanager datasource). No board hardcodes a datasource UID, so the same board JSON works against
any correctly-provisioned Grafana.

**Target scoping is a convention, enforced statically.** A board that declares a target variable
(`instance` or `service`) must scope its metric queries by that variable, and its drilldown
deep-link must embed it as `var-<name>=`. `pulse-engine` is the whole-engine board — it binds no
target variable and its deep-link is the bare `/d/pulse-engine`.

**The directory layout is the folder taxonomy.** The provider sets `foldersFromFilesStructure:
true`, so each immediate subdirectory of `json/` becomes a Grafana folder. Adding a board later is a
new file (and possibly a new subdir) — never a provider edit.

**Only board JSON may live under the scanned path.** The `file` provider treats every `.json` under
its path as a dashboard. The provenance manifest, drilldown contract, tests, and fixtures therefore
live in `stack/grafana/`, deliberately outside the scanned `json/` tree.

**Provisioning is config-as-code.** `disableDeletion: true` and `allowUiUpdates: false` mean the
committed JSON is authoritative: UI edits are transient and a board removed from disk is a
deliberate source change, not an accident.

## When to use

- Adding, pruning, or rewiring a Pulse Grafana board.
- Adding an alert-state panel (reference `${DS_ALERTS}`).
- Consuming a board's stable deep-link from another feature (see the drilldown contract in the
  [API Reference](./api-reference.md)).

## When NOT to use

- **Estate content.** Boards never name a host, service, or domain — those come from metric labels
  at view time. Do not add estate literals to satisfy a layout.
- **Datasource provisioning that isn't additive.** stack-core owns the VictoriaMetrics datasource
  and the compose tree; this feature only *adds* files. Do not edit stack-core's datasource or the
  compose file from here.
- **Runtime code.** `@pulse/dashboards` is verification-only. There is nothing to import from it.

## Configuration

The board library has no environment configuration of its own; it inherits the stack's Grafana
(admin credentials, network) from `stack-core`. The provisioning behavior is fixed in
`pulse.yaml` and `alertmanager.yml` — see the [API Reference](./api-reference.md#provisioning-configuration)
for every field and its rationale.

## Further reading

- [Architecture](./architecture.md) — The provisioning data flow, the two-tier guard suite, and the additive ownership boundary
- [API Reference](./api-reference.md) — Guard-suite exports, the guard checks and failure kinds, provisioning fields, and the drilldown deep-link contract
