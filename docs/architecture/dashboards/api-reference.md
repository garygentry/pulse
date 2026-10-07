# dashboards — API Reference

The dashboard library ships **no importable runtime API** — `@pulse/dashboards` is verification-only
and declares no package `exports`. This reference documents the *contracts* the feature enforces:
the guard-suite module surface, the guard checks and their failure kinds, the provisioning
configuration, and the drilldown deep-link contract other features consume.

## Guard-suite module (`stack/grafana/tests/guards.ts`)

The single support module both test tiers import from `./guards.js`. It imports only Node built-ins.
The symbols below are its exported surface (consumed by the tests, not by application code).

### Constants

| Symbol | Value | Meaning |
|--------|-------|---------|
| `BOARD_UIDS` | `["pulse-host", "pulse-deephealth", "pulse-hypervisor", "pulse-nas", "pulse-engine"]` | The frozen set of board UIDs. Every board's `uid` ∈ this set. |
| `FOLDERS` | `["Hosts", "Deep-Health", "Infrastructure", "Engine"]` | Grafana folder names, one per `json/` subdirectory. |
| `FOLDER_DIRS` | `{ Hosts: "hosts", "Deep-Health": "deep-health", Infrastructure: "infrastructure", Engine: "engine" }` | On-disk subdirectory name for each folder. |
| `TARGET_VARS` | `{ "pulse-host": "instance", "pulse-hypervisor": "instance", "pulse-nas": "instance", "pulse-deephealth": "service", "pulse-engine": null }` | The URL-bound target variable each board declares; `null` for the engine board. |
| `DATASOURCE_VARS` | `{ metrics: "DS", alerts: "DS_ALERTS" }` | The datasource template-variable names boards reference. |
| `ALERTMANAGER_DS_UID` | `"pulse-alertmanager"` | Stable uid of the additive Alertmanager datasource; referenced only via `${DS_ALERTS}`. |
| `PULSE_BOARD_TAG` | `"pulse"` | Tag every board carries, so a taxonomy scan can find Pulse boards. |

### Path constants

| Symbol | Points at |
|--------|-----------|
| `PROVISIONING_DIR` | `stack/compose/config/grafana/provisioning/` |
| `BOARDS_JSON_DIR` | `…/dashboards/json/` — the scanned board path (board JSON only) |
| `PROVIDER_YAML` | `…/dashboards/pulse.yaml` |
| `ALERTMANAGER_YAML` | `…/datasources/alertmanager.yml` |
| `PROVENANCE_JSON` | `stack/grafana/provenance.json` (outside the scanned path) |
| `DRILLDOWN_DOC` | `stack/grafana/drilldown-links.md` (outside the scanned path) |

### Loaders

```ts
function listBoardJsonFiles(): string[]
```
Every `.json` under `BOARDS_JSON_DIR`, recursively and sorted — matching Grafana's own recursive
scan.

```ts
function loadArtifacts(): LoadedArtifact[]
```
Every committed artifact under verification, each tagged by `ArtifactKind` (`board` | `provider` |
`datasource` | `provenance` | `drilldown-doc`). Fixtures are excluded — they are seed data, not
shipped artifacts.

### Key types

- `DashboardModel` — the validated subset of a Grafana board: `uid` (∈ `BOARD_UIDS`), `title`,
  `schemaVersion` (integer), `tags` (includes `pulse`), `templating.list`, `panels`.
- `TemplateVariable` — a Grafana variable: `datasource` type for `DS`/`DS_ALERTS`, `query` type for
  target selectors. Target selectors must not be `required`.
- `Panel` / `PanelTarget` — a panel references a datasource via a `${DS}`/`${DS_ALERTS}` template ref
  (never a literal uid); each metric target's `expr` must be target-scoped when the board declares a
  target variable.
- `ProvenanceEntry` / `ProvenanceManifest` — one record per board uid: either `{ source:
  "grafana.com", sourceId, revision, notes }` or `{ source: "hand-authored" }`.
- `DrilldownEntry` — one drilldown row: `category`, `uid`, `boundVar` (= `TARGET_VARS[uid]`),
  `deepLink`, `variableQuery`.
- `GuardCheck` / `GuardFailureKind` / `GuardFinding` — the check identifiers, the enumerated failure
  kinds, and a single finding (check, kind, path, detail).

## Guard checks and failure kinds

The four hermetic checks (Tier A) plus the Docker-tier provisioning smoke (Tier B):

| Check | Kind(s) | Asserts |
|-------|---------|---------|
| `json-validity` | `invalid-json`, `non-board-json` | Each scanned `.json` parses to a dashboard model with an integer `schemaVersion` and the `pulse` tag. |
| `uid-convention` | `duplicate-uid`, `unknown-uid`, `provenance-mismatch` | UIDs unique and ∈ `BOARD_UIDS`; board set === provenance keys === drilldown rows; each drilldown row's `boundVar` and deep-link match the board's target variable. |
| `no-estate-literals` | `estate-literal`, `credential-literal` | No host/domain/credential literal in any committed artifact. |
| `no-external-datasource` | `external-reference`, `hardcoded-datasource`, `unscoped-query` | No live external reference; every datasource ref templated; every metric query target-scoped when a target variable exists. |
| provisioning smoke (Tier B) | — | Artifacts provision into a real Grafana: datasource resolves + is reachable; every board uid resolves; target vars populate from seeded labels. |

The `GuardFailureKind` enum has exactly 10 members; a compile-time meta-guard asserts the suite's
protection set equals the enum, so coverage cannot silently shrink.

## Provisioning configuration

### Dashboard provider — `dashboards/pulse.yaml`

A single `file` provider named `pulse`:

| Field | Value | Why |
|-------|-------|-----|
| `type` | `file` | Load board JSON from disk (config-as-code) — no HTTP API, no live grafana.com reference. |
| `disableDeletion` | `true` | A board removed from disk is not auto-deleted from Grafana; removals are deliberate source edits. |
| `allowUiUpdates` | `false` | UI edits are transient; committed JSON is authoritative and reprovisions on restart. |
| `updateIntervalSeconds` | `30` | Prompt pickup after a restart/redeploy without hammering disk. |
| `options.path` | `/etc/grafana/provisioning/dashboards/json` | In-container scan path. **Only board JSON may live here** — the provider treats every `.json` as a dashboard. |
| `options.foldersFromFilesStructure` | `true` | Each immediate subdirectory of `json/` becomes a Grafana folder; no folder is named in config. |

### Alertmanager datasource — `datasources/alertmanager.yml`

Additive — a new file alongside stack-core's `victoriametrics.yml` (left untouched):

| Field | Value | Why |
|-------|-------|-----|
| `name` | `Alertmanager` | Display name. |
| `type` | `alertmanager` | Grafana's Alertmanager datasource plugin (reads live alert state). |
| `uid` | `pulse-alertmanager` | Stable handle the `${DS_ALERTS}` variable resolves to; boards never hardcode it. |
| `access` | `proxy` | Grafana proxies server-side (browser never contacts Alertmanager directly). |
| `url` | `http://alertmanager:9093` | In-stack address on the `pulse` network — no estate literal. |
| `editable` | `false` | Provisioned, not UI-editable. |
| `jsonData.implementation` | `prometheus` | Standalone Prometheus-style Alertmanager (not Grafana-managed alerting). |

## Drilldown deep-link contract

`web-app` (and any consumer) links into these boards using stable deep-links. The contract is the
table in `stack/grafana/drilldown-links.md`, enforced by check 2:

| UID | Bound variable | Deep-link | View-time variable query |
|-----|----------------|-----------|--------------------------|
| `pulse-host` | `instance` | `/d/pulse-host?var-instance=<host>` | `label_values(node_uname_info, instance)` |
| `pulse-deephealth` | `service` | `/d/pulse-deephealth?var-service=<service>` | `label_values(<probe metric>, service)` |
| `pulse-hypervisor` | `instance` | `/d/pulse-hypervisor?var-instance=<pvehost>` | `label_values(pve_up, instance)` |
| `pulse-nas` | `instance` | `/d/pulse-nas?var-instance=<nashost>` | `label_values(<nas metric>, instance)` |
| `pulse-engine` | *(none)* | `/d/pulse-engine` | n/a |

Convention: a board with a target variable is deep-linked as `/d/<uid>?var-<boundVar>=<value>`; the
engine board (no target variable) is the bare `/d/pulse-engine`. Check 2 asserts both halves
statically, so a drifted deep-link is caught at build time.

## Commands

| Command | What it does |
|---------|--------------|
| `bun run typecheck` | Type-checks the workspace, including `@pulse/dashboards`. |
| `bun test stack/grafana/tests/static-guards.test.ts` | Tier A static guards (no Docker). |
| `bun run smoke:dashboards` | Tier B provisioning smoke against a real Grafana (self-skips without Docker). |
| `bun run smoke` | Whole-stack smoke gate (`smoke:cli && smoke:stack && smoke:dashboards`). |
