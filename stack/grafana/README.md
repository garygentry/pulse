# @pulse/dashboards

Verification-only guard suite for the Pulse Grafana dashboard provisioning. This package ships
**no runtime code and exports no importable surface** — it imports no other `@pulse/*` package. Its
job is to prove that the committed Grafana provisioning artifacts (dashboard board JSON, the
dashboard file-provider, and the additive Alertmanager datasource) are well-formed, estate-agnostic,
and internally consistent.

The provisioning artifacts it guards live under
`stack/compose/config/grafana/provisioning/` (board JSON beneath `dashboards/json/**`, the provider
YAML, and the datasource YAML). Grafana consumes those files directly at boot — the provisioning
config *is* the runtime wiring; this package only verifies it.

## Layout

- `tests/guards.ts` — the single support module: shared constants, types, path constants, and the
  board-JSON loaders that both test tiers import.
- `tests/static-guards.test.ts` — **Tier A**, hermetic static guards (no Docker).
- `tests/provisioning.smoke.test.ts` — **Tier B**, provisioning smoke against a real Grafana.
- `tests/fixtures/estate/` — the seeded fixture metric series used by Tier B.
- `provenance.json` — per-board provenance manifest (origin + revision of each board).
- `drilldown-links.md` — the drilldown deep-link contract table that downstream consumers rely on.

## Running

- **Typecheck:** `bun run typecheck` (builds the whole workspace project graph, this package included).
- **Tier A (static guards):** `bun test stack/grafana/tests/static-guards.test.ts`, or the whole
  workspace via `bun test`. No Docker required.
- **Tier B (provisioning smoke):** `bun run smoke:dashboards`. Brings up the compose stack under a
  unique `pulse-test-dashboards-…` Compose project, waits for Grafana to become ready, seeds the
  fixture metric series into VictoriaMetrics, then probes that the datasources and boards provision
  and resolve. **Self-skips** when no Docker daemon is reachable, so it is safe to run in environments
  without Docker and on hosts that also run a live `pulse` project.

`bun run smoke` runs the whole-stack smoke gate (`smoke:cli && smoke:stack && smoke:dashboards`); use
`bun run smoke:dashboards` directly to exercise this feature's smoke in isolation.

## Tier B readiness

The Tier B suite brings the stack up detached (`docker compose -p <ephemeral-project> up -d`) and
uses that project's isolated network and named volumes. It gates on Grafana's `/api/health` returning
200 with its own polling budget, rather than `up --wait`. `up --wait` honors
the container healthcheck budget, which a slow first-run Grafana SQLite migration can exhaust before
Grafana finishes booting; polling readiness directly tolerates that slow-but-healthy startup.
Teardown (`docker compose -p <ephemeral-project> down -v --remove-orphans`) always runs and can
remove only the smoke run's throwaway resources.
