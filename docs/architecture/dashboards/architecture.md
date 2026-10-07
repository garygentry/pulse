# dashboards — Architecture

This document explains how the Pulse dashboard library is provisioned, how its guard suite proves
the committed artifacts are correct, and where its ownership boundary with `stack-core` sits.

## The provisioning data flow

The library is delivered entirely as **config-as-code** that Grafana reads at boot. There is no
service, no build step, and no API call in the delivery path.

```
committed board JSON  ──┐
(json/<folder>/*.json)  │
                        ├─►  Grafana file-provider (pulse.yaml)  ──►  Grafana folders + dashboards
Alertmanager datasource ┘         scans json/ recursively,            (resolved by stable uid)
(alertmanager.yml)                folders = subdirectory names
```

1. **stack-core mounts the provisioning tree.** `stack/compose/config/grafana/provisioning/` is
   bind-mounted into Grafana. stack-core provisions the VictoriaMetrics datasource there; this
   feature adds `dashboards/pulse.yaml`, the `dashboards/json/**` board tree, and
   `datasources/alertmanager.yml` alongside it.
2. **The file-provider loads boards from disk.** `pulse.yaml` declares one `file` provider scanning
   `/etc/grafana/provisioning/dashboards/json` (in-container). `foldersFromFilesStructure: true`
   turns each immediate subdirectory into a Grafana folder — `hosts` → **Hosts**, `deep-health` →
   **Deep-Health**, `infrastructure` → **Infrastructure**, `engine` → **Engine**.
3. **Boards resolve datasources at view time.** Each board's panels reference `${DS}` (metrics) and
   `${DS_ALERTS}` (alerts) — Grafana template variables of type `datasource`. `${DS}` resolves to
   stack-core's VictoriaMetrics datasource; `${DS_ALERTS}` resolves to this feature's Alertmanager
   datasource by its stable uid `pulse-alertmanager`.
4. **Target variables specialize a board to one subject.** A board that declares a `query` variable
   (`instance` or `service`) populates it at view time via `label_values(...)` against the live
   metrics, and scopes its panel queries by that variable. This is how one estate-agnostic board
   renders for any host/service without naming one.

## Why the boards carry no estate

The whole library is portable by construction:

- **Datasource references are always templated** (`${DS}` / `${DS_ALERTS}`), never a literal UID.
  A board therefore binds to whatever datasource the target Grafana provisions.
- **Subject selection is a template variable**, populated from metric labels the running stack
  actually holds. The board ships the *query* (`label_values(node_uname_info, instance)`), never a
  *value*.
- **The Alertmanager datasource is reached over the trusted in-stack network** (`http://alertmanager:9093`),
  so it needs no credential literal.

The result: the same committed JSON boots green against a seeded fixture and runs a real estate
unchanged — the same portability contract stack-core establishes for the engine.

## The two-tier guard suite

`@pulse/dashboards` (`stack/grafana/`) is a verification-only package. It exports no runtime
surface; its job is to fail the build if a committed artifact drifts from the contract. It runs in
two tiers.

### Tier A — hermetic static guards (`static-guards.test.ts`)

Pure file reads, no Docker, milliseconds to run. Four checks over every committed artifact, plus a
meta-guard:

| Check | Failure kinds it raises | What it proves |
|-------|------------------------|----------------|
| **check 1** `json-validity` | `invalid-json`, `non-board-json` | Every `.json` under the scanned path parses to a dashboard model with an integer `schemaVersion` and the `pulse` tag. |
| **check 2** `uid-convention` | `duplicate-uid`, `unknown-uid`, `provenance-mismatch` | Board UIDs are unique and ∈ the frozen set; the board set, the provenance manifest keys, and the drilldown rows are the same set; each drilldown row's bound variable and **deep-link** match the board's target variable. |
| **check 3** `no-estate-literals` | `estate-literal`, `credential-literal` | No host/domain/credential literal appears in any committed artifact. |
| **check 4** `no-external-datasource` | `external-reference`, `hardcoded-datasource`, `unscoped-query` | No live external reference; every datasource ref is a `${DS}`/`${DS_ALERTS}` template; every metric query is target-scoped when the board declares a target variable. |
| **meta-guard** | — | The suite's protection set is *exactly* the `GuardFailureKind` enum (10 kinds), enforced at compile time — the guard cannot silently stop covering a failure mode. |

The deep-link half of check 2 is what proves the drilldown *convention* statically: a target board's
deep-link must be `/d/<uid>` embedding `var-<boundVar>=`, and the engine's must be the bare
`/d/pulse-engine` with no `var-` query. A drifted Deep-link cell is caught here even when the bound
variable still reads correctly.

### Tier B — provisioning smoke (`provisioning.smoke.test.ts`)

Brings the real Compose stack up and proves the artifacts actually provision. It **self-skips** when
no Docker daemon is reachable, so it is safe everywhere.

Bring-up is **readiness-gated, not healthcheck-gated**: the suite creates a unique
`pulse-test-dashboards-…` project, runs `docker compose -p <project> up -d` (detached), and then
polls Grafana's `/api/health` over the project-derived network on its own budget (30 attempts × 5s).
It deliberately does **not** use `docker compose up --wait`, because `up --wait` honors the
container's healthcheck retry budget, which a slow first-run Grafana SQLite migration can exhaust
before Grafana finishes booting — aborting a bring-up that would otherwise have become healthy.
Polling readiness directly tolerates that slow-but-healthy startup. Checked teardown
(`docker compose -p <project> down -v --remove-orphans`) always runs, even if a probe throws, and
can remove only that smoke run's throwaway resources.

Once Grafana is ready, the smoke seeds a fixture metric series into VictoriaMetrics and probes that:
the Alertmanager datasource is provisioned (resolves by uid) and reachable through the datasource
proxy; every board uid resolves via `GET /api/dashboards/uid/<uid>`; and target variables would
populate from the seeded labels.

## Provenance and the drilldown contract

Two artifacts live in `stack/grafana/`, outside the scanned board path, and are checked by Tier A:

- **`provenance.json`** — exactly one record per board uid. Imported boards record their grafana.com
  source id and revision plus the pruning/rewiring notes; hand-authored boards record only that.
  Check 2 requires its key set to equal the board set.
- **`drilldown-links.md`** — the `(category, target) → deep-link` table that `web-app` consumes to
  build links into these boards. Check 2 requires its rows to match the board set, and each row's
  bound variable and deep-link to match the board's target variable.

## Ownership boundary with stack-core

The feature is strictly **additive** to a completed stack-core:

- It **adds** files under stack-core's existing Grafana provisioning mount. It does not edit
  stack-core's VictoriaMetrics datasource, which stays byte-identical.
- It does not touch the compose file or Grafana's healthcheck. When the Tier B smoke needed to
  tolerate a slow Grafana boot, the fix went into *this feature's test* (the readiness poll), not
  into stack-core's compose — the healthcheck is stack-core's to own.

This boundary is why the board tree slots cleanly into a stack that was built and verified before
the boards existed: stack-core reserved the mount, and this feature fills it without a single
change to the engine.
