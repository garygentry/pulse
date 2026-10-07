# Web App — Estate Overview

`@pulse/web` is the Pulse estate-overview web application: a single container that renders a live,
read-only dashboard of every managed host and service in the estate. It runs a zero-dependency
`Bun.serve` **server tier** alongside a **React 19 single-page app**, and fills the profile-gated
`web` slot in the stack composition.

The server reads the rendered `web-estate-model.json` (the estate's declared shape) from a read-only
mount, aggregates three engine sources — VictoriaMetrics, Alertmanager, and Gatus — every 10
seconds into one pure `OverviewSnapshot`, and serves it as JSON. The browser SPA polls that snapshot
and paints an estate grid with per-host/-service status, an active-alerts strip, staleness and
liveness indicators, per-source degradation, and Grafana drill-down links.

It is **estate-agnostic** (no estate name, host, or credential is baked into the image) and
**strictly read-only** (`GET`-only, enforced by the route type system).

## Quick Start

The app is a compose **service**, not an importable library — it has no TypeScript export surface.
Run it from the workspace root:

```bash
# Build the client bundle + server entry into dist/
bun run --filter @pulse/web build

# Run directly (env supplies the engine URLs and the estate-model mount)
PULSE_VM_URL=http://victoriametrics:8428 \
PULSE_ALERTMANAGER_URL=http://alertmanager:9093 \
PULSE_GATUS_URL=http://gatus:8080 \
PULSE_WEB_ESTATE_MODEL=/rendered/web-estate-model.json \
bun apps/web/dist/server/index.js
# → listening on :8080
```

The container image runs `dist/server/index.js` as its `CMD`. In production it is launched by the
stack's `web` compose slot; see [Integration](./guides/integration.md).

Verify it is up:

```bash
curl -s localhost:8080/healthz | jq .status      # "ok" or "degraded"
curl -s localhost:8080/api/overview | jq .estate # estate identity + hosts
```

## Key Concepts

- **Estate model** — the declared inventory of hosts and services, rendered upstream into
  `web-estate-model.json` and mounted read-only. It is the sole source of estate *structure*; the
  app never invents a host or service that is not declared.
- **Snapshot** — one immutable `OverviewSnapshot` describing the whole estate at an instant:
  per-source health, every host with its roll-up status and services, and the active-alerts strip.
  The server rebuilds it every 10s; the client polls it every 10s.
- **Status resolution** — each host/service resolves to `ok | warning | critical | unknown |
  suppressed` by folding liveness signals, matched alerts, and check results. `info` alerts never
  colour a cell; suppressed targets contribute nothing to a roll-up; the Alertmanager
  `DeadMansSwitch` is dropped entirely.
- **Error-page mode** — when the estate model cannot be loaded, the app does **not** crash. It
  serves a diagnostic error page and keeps `/healthz` and `/metrics` live, recovering automatically
  once a valid model appears.
- **Degradation, not failure** — if one engine source is unreachable, its slice of the snapshot goes
  stale (`SourceHealth.ok = false`) while the others stay live. The refresh loop never throws across
  its boundary.

## Service & Module Map

The package is one process split into three internal tiers:

| Area | Location | Responsibility |
|---|---|---|
| Server entry | `src/server/index.ts` | Parse env → config, build the runtime, start the refresh loop, `Bun.serve` on `:8080`. |
| Refresh loop | `src/server/refresh.ts` | Every 10s, fetch all sources, fold a fresh snapshot, swap it in atomically. |
| Engine sources | `src/server/sources/` | VictoriaMetrics (`vm.ts`), Alertmanager (`alertmanager.ts`), Gatus (`gatus.ts`) clients — each never throws. |
| Snapshot fold | `src/server/snapshot/` | Pure `build.ts` + `match.ts`/`liveness.ts`/`links.ts` that turn raw source data into an `OverviewSnapshot`. |
| Estate model | `src/server/estate/` | `load.ts` (read + validate), `watch.ts` (reload on change), `error-page.ts` (diagnostic HTML). |
| HTTP routing | `src/server/router.ts`, `src/server/routes/` | Route table for `/`, `/assets/*`, `/api/overview`, `/healthz`, `/metrics`. |
| Client SPA | `src/client/` | React 19 app (Tailwind v4 + the `@/ui` library, see [Web UI](../ui.md)): live-state transport, History-API routing, `views/overview/` estate grid, and `views/alerts/` triage, detail, catalog, and silences surfaces. |
| Shared | `src/shared/` | Snapshot/type contracts, constants, error classes, the route/view registry. |

## Configuration

Everything is configured through environment variables; the listen port is the sole exception (fixed
at `8080`). Three engine URLs are hard-required; an unset estate-model path is a servable state (it
yields error-page mode, not a crash).

| Env var | Required | On absence |
|---|---|---|
| `PULSE_VM_URL` | yes | startup failure (`ConfigError`) |
| `PULSE_ALERTMANAGER_URL` | yes | startup failure |
| `PULSE_GATUS_URL` | yes | startup failure |
| `PULSE_WEB_ESTATE_MODEL` | no | error-page mode (servable) |
| `PULSE_ESTATE_TZ` | no | UTC, with a "TZ not configured" marker |
| `PULSE_GRAFANA_URL` | no | Grafana deep links disabled |
| `PULSE_GATUS_STALE_SECONDS` | no | `300` |

Full details, defaults, and the exact on-absence behavior are in the
[API Reference](./api-reference.md#environment-variables).

## When to Use / When Not To

**Use it** as the single at-a-glance operational view of a Pulse estate — host and service health,
active alerts, and one-click drill-down into Grafana — served on a trusted network or behind the
estate's existing reverse-proxy authentication.

**Do not** expose it directly to an untrusted network: it ships with **no built-in authentication**
and every route reveals estate structure and health. It is also not a metrics store, an alerting
engine, or a configuration surface — it only *reads* the engines and the rendered model. To change
what the estate contains, edit the estate definition and re-render the model; the app picks the new
model up on its next reload.

## Further Reading

- [Architecture](./architecture.md) — the two-tier design, the refresh loop, status resolution, and error-page mode.
- [API Reference](./api-reference.md) — HTTP routes, JSON shapes, `/metrics` families, and the environment contract.
- [Integration Guide](./guides/integration.md) — deploying the service into the stack composition.
