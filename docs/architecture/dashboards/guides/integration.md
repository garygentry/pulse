# Integration Guide

This guide is for two audiences: authors adding or changing a Pulse Grafana board, and downstream
features (notably `web-app`) that deep-link into the boards. The dashboard library is delivered as
**config-as-code** — Grafana reads it at boot — so you add a board by dropping a file into the
right place, never by editing a provider or the compose tree. The guard suite (`@pulse/dashboards`)
then proves the artifact is well-formed, portable, and internally consistent.

## The drop-in convention

A new board is **a new file under `json/<subdir>/`, plus a provenance row** — and nothing else. In
particular you never touch the provider (`pulse.yaml`), the compose file, or stack-core's
VictoriaMetrics datasource.

Steps to add a board:

1. **Write the board JSON** into `stack/compose/config/grafana/provisioning/dashboards/json/<subdir>/<name>.json`,
   where `<subdir>` is the Grafana folder it belongs in (see the taxonomy below). Create the subdir
   if the folder is new.
2. **Give it a stable `uid`** and add that uid to `BOARD_UIDS` in `stack/grafana/tests/guards.ts` —
   the frozen set every board's `uid` must belong to.
3. **Record its provenance** in `stack/grafana/provenance.json`: `{ "source": "hand-authored" }`,
   or `{ "source": "grafana.com", "sourceId": "...", "revision": "...", "notes": "..." }` for an
   imported-and-pruned board. Check 2 requires the provenance key set to equal the board set.
4. **If the board declares a target variable**, add its row to `stack/grafana/drilldown-links.md`
   and its `TARGET_VARS` entry — bound variable and deep-link both.

Because the provider's `updateIntervalSeconds` is 30 and `disableDeletion`/`allowUiUpdates` make
the committed JSON authoritative, the board appears after a restart with no further wiring. A board
removed from disk is a deliberate source edit, not an accident.

## The folder taxonomy is the on-disk layout

The single `file` provider sets `foldersFromFilesStructure: true`, so **each immediate
subdirectory of `json/` becomes a Grafana folder** — there is no folder named anywhere in config.
The current mapping (`FOLDER_DIRS` in the guard suite):

| On-disk `json/<subdir>/` | Grafana folder |
|--------------------------|----------------|
| `hosts` | Hosts |
| `deep-health` | Deep-Health |
| `infrastructure` | Infrastructure |
| `engine` | Engine |
| `gpu` | GPU |
| `dns` | DNS |
| `ingress` | Ingress |

Adding a board to an existing folder is just a new file in that subdir; introducing a new folder is
a new subdir. Either way the provider needs no edit — that is the whole point of driving folders
from the directory structure.

**Only board JSON may live under the scanned path.** The provider treats every `.json` under
`json/` as a dashboard, so the provenance manifest, the drilldown contract, tests, and fixtures
live in `stack/grafana/`, deliberately outside the scanned tree.

## The datasource-variable convention

Boards never hardcode a datasource UID. Every panel references one of two Grafana template
variables of type `datasource`, so the same JSON binds to whatever datasource the target Grafana
provisions:

| Variable | Resolves to | Use for |
|----------|-------------|---------|
| `${DS}` | VictoriaMetrics (stack-core's datasource) | every metric query |
| `${DS_ALERTS}` | Alertmanager (`uid: pulse-alertmanager`, this feature's additive datasource) | alert-state panels |

`${DS}` is the default datasource, so a metric panel with no explicit datasource still resolves to
it; `${DS_ALERTS}` must be named explicitly on an alert-state panel. Both are checked statically —
a literal datasource UID or a live external reference fails the `no-external-datasource` guard.

## Target scoping and deep-links

A board that specializes to one subject declares a **target variable** (a `query` template
variable populated at view time via `label_values(...)`), scopes its metric queries by it, and is
deep-linked as `/d/<uid>?var-<boundVar>=<value>`. The whole-engine board (`pulse-engine`) binds no
target variable and is the bare `/d/pulse-engine`. `TARGET_VARS` records each board's binding:

| UID | Bound variable |
|-----|----------------|
| `pulse-host`, `pulse-hypervisor`, `pulse-nas`, `pulse-gpu`, `pulse-dns`, `pulse-ingress` | `instance` |
| `pulse-deephealth` | `service` |
| `pulse-engine` | *(none — fixed link)* |

Check 2 asserts both halves statically — a target board's deep-link must embed `var-<boundVar>=`,
and the engine board must not — so a drifted deep-link is caught at build time even when the bound
variable still reads correctly. `web-app` consumes these links from
`stack/grafana/drilldown-links.md`.

## The DNS and Ingress boards (issue #14)

Two boards shipped in this branch, following the drop-in convention exactly:

| UID | File | Folder | Target variable |
|-----|------|--------|-----------------|
| `pulse-dns` | `json/dns/pulse-dns.json` | DNS | `instance` |
| `pulse-ingress` | `json/ingress/pulse-ingress.json` | Ingress | `instance` |

Each was added as a **new `json/<subdir>/` plus a hand-authored `provenance.json` row and its
`BOARD_UIDS`/`TARGET_VARS`/`FOLDER_DIRS` entries** — no provider edit, no compose change. They are
the reference example of the convention this guide describes: a new folder and a new board landing
cleanly into a Grafana that was provisioned before either existed.

## What you can rely on

- **The boards carry no estate** — host/service/domain values come from metric labels at view time,
  never a literal in committed JSON (the `no-estate-literals` guard enforces it).
- **Board UIDs are stable** — a `uid` is the durable URL identity `web-app` deep-links into; it is
  frozen for v1.
- **Provisioning is additive** — this feature only adds files under stack-core's Grafana mount; it
  never edits the VictoriaMetrics datasource or the compose file.

## What not to do

- **Don't edit `pulse.yaml` to add a board** — a new file in a `json/` subdir is picked up by the
  directory-driven provider automatically.
- **Don't hardcode a datasource UID** — reference `${DS}` / `${DS_ALERTS}`; a literal fails the
  guard.
- **Don't put a non-board `.json` under `json/`** — the provider would treat it as a dashboard;
  manifests, contracts, and fixtures live in `stack/grafana/`.
- **Don't add a board without its provenance row and (if targeted) drilldown row** — check 2
  requires the board set, the provenance keys, and the drilldown rows to be the same set.

## Verifying your change

```bash
# Tier A — hermetic static guards (no Docker)
bun test stack/grafana/tests/static-guards.test.ts

# Tier B — provisioning smoke against a real Grafana (self-skips without Docker)
bun run smoke:dashboards
```

Tier A proves the JSON is a valid board, the uid is unique and in the frozen set, the board /
provenance / drilldown sets match, no estate or credential literal appears, and every datasource
reference is a templated, target-scoped query. Tier B brings the stack up and proves the board
actually provisions and resolves by uid.

## Further Reading

- [README](../README.md) — What the dashboard library ships and its key concepts
- [Architecture](../architecture.md) — The provisioning data flow, the two-tier guard suite, and the ownership boundary
- [API Reference](../api-reference.md) — Guard-suite exports, provisioning fields, and the drilldown deep-link contract
