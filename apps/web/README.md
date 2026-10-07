# @pulse/web — Pulse operator UI

The Pulse web overview app: a single container — a zero-dependency `Bun.serve` **server tier** plus
a **React SPA** — that fills the profile-gated `web` slot in the stack composition. It reads the
rendered `web-estate-model.json` via a read-only mount, acquires from four engine origins on a fixed
10-second cycle, folds each cycle into coherent per-view payloads, and serves them over read-only
(`GET`-only) HTTP with conditional caching and a live event stream. It is estate-agnostic and
strictly read-only.

The app has no TypeScript export surface — it is a compose **service**, not an importable module.
The process entry is the built `dist/server/index.js`, run by the image `CMD`.

## Architecture

```
                rendered/web-estate-model.json (:ro mount)
                              │
   VictoriaMetrics ┐          ▼
   Alertmanager    ├─► cycle scheduler ─► folds ─► materialized per-view payloads
   Gatus           │   (every 10s,         (pure)    (canonical JSON + gzip, strong ETags)
   vmalert         ┘    fixed cardinality)              │
   Grafana (optional, health only)                      ▼
                              atomic publish ─► GET /api/* routes + SSE ticks
```

- **Four fixed engine origins** — VictoriaMetrics, Alertmanager, Gatus, and vmalert are required.
  Grafana is optional (health + deep links only) and is never a startup dependency.
- **Coherent cycles** — each 10-second cycle acquires a fixed set of upstream calls (independent of
  estate size or viewer count), folds them into five current views (overview, alerts, estate,
  engine, timeline), materializes each into retained plain/gzip bytes with distinct strong ETags,
  and publishes them in one atomic swap. A construction failure retains the prior cycle as aging
  authority (or stays `NOT_READY` before the first success) and retries on the next deadline.
- **On-demand history** — the four `/api/history/*` routes serve bounded, per-request time series
  (curated server-authored queries only; the client never supplies a query expression).
- **Live updates** — `/api/events` is a Server-Sent Events stream: a `retry` hint, ~5-second
  heartbeats, and one tick per published cycle. Clients converge to the latest state on reconnect.

## Deployment

**Security stance (REQ-SEC-01): the app ships with _no built-in authentication_.** In the default
auth mode `none` every route is read-only (`GET`-only, enforced by the `RouteDefinition.method: "GET"`
seam type — a mutating route cannot be registered). In `proxy-header` mode the write path adds
`POST /api/mutations/*` and `GET /api/proposals`, gated per capability; see
[docs/operator/write-path.md](../../docs/operator/write-path.md). Either way the overview exposes
estate structure, host/service health, and active alerts to anyone who can reach the listen port. Do
**not** expose it directly to an untrusted network.

Deploy it on a **trusted LAN**, or place it **behind the estate's existing reverse-proxy
authentication** (the same auth tier that fronts Grafana / the other estate UIs). The container:

- listens on a fixed `8080` (`LISTEN_PORT`, deliberately not env-configurable — the slot's `expose`,
  the healthcheck, and the `web` scrape target are all keyed to it);
- has **no `ports:` publication** of its own in the slot — host publication (and therefore where the
  auth boundary sits) is the deploy-toolkit's responsibility, not this image's;
- bakes **no estate name/host/domain/credential** — everything arrives via slot env and the
  read-only rendered-tree mount;
- in auth mode `none`, issues **only `GET`** requests to its upstreams and never mutates estate or
  engine state. The mutation and audit seams ship dark (disabled) in that mode:
  `POST`/`PUT`/`PATCH`/`DELETE` return `405` without reading a body, and `/api/session` reports all
  capabilities as `false`. In `proxy-header` mode a trusted identity can create and expire
  Alertmanager silences, acknowledge alerts, and file estate-edit proposals; it never edits the
  estate directly (proposals are applied offline with `pulse proposals apply`).

Because there is no authentication layer inside the container, the reverse-proxy / network boundary
in front of it **is** the access-control boundary. Treat it accordingly.

### Optional trusted-proxy identity

When the app runs behind a reverse proxy that performs authentication, it can resolve the
authenticated principal. This is **off by default**. In `proxy-header` mode a trusted identity also
enables the write capabilities (`silence`, `ack`, `proposeEstateEdit`) whose stores are healthy; see
[docs/operator/write-path.md](../../docs/operator/write-path.md) before turning it on.

- `PULSE_WEB_AUTH_MODE=proxy-header` enables it; the default `none` disables it entirely.
- Identity is resolved **deny-by-default**: only when the direct peer IP matches a configured
  `PULSE_WEB_TRUSTED_PROXIES` CIDR **and** the configured header carries a single bounded,
  control-free value. A direct, untrusted, or header-less request always resolves to `null`.
- Forwarding headers are never trusted; raw peer/header/CIDR values are never logged.

## Configuration

The container is configured entirely through environment variables (the listen port is the sole
exception — it is fixed at `8080`, not env-configurable). The slot injects the four engine URLs; the
estate-model mount and the optional vars arrive via slot reconciliation. Cadences, timeouts, and all
page/stream/history/payload limits are constants — they are **not** env-configurable.

### Required

| Env var | On absence |
|---|---|
| `PULSE_VM_URL` | hard startup failure (`ConfigError`, red healthcheck) |
| `PULSE_ALERTMANAGER_URL` | hard startup failure |
| `PULSE_GATUS_URL` | hard startup failure |
| `PULSE_VMALERT_URL` | hard startup failure |

Each required URL must be an absolute `http(s)` URL with **no embedded credentials**; a malformed or
credential-bearing value throws a safe `ConfigError` (naming the env key, never the value) before the
server binds.

### Optional

| Env var | Default / on absence |
|---|---|
| `PULSE_WEB_ESTATE_MODEL` | unset/empty → error-page mode (servable), the same state as an unreadable mount — not a startup failure |
| `PULSE_ESTATE_TZ` | UTC, with an explicit "TZ not configured" marker |
| `PULSE_GRAFANA_URL` | deep links disabled + optional server health check off; a Grafana outage degrades only Grafana |
| `PULSE_GATUS_STALE_SECONDS` | `300` |
| `PULSE_WEB_AUTH_MODE` | `none` (exact `none` \| `proxy-header`) |
| `PULSE_WEB_AUTH_HEADER` | `Remote-User` (an RFC token) |
| `PULSE_WEB_TRUSTED_PROXIES` | empty (comma-separated IPv4/IPv6 CIDRs) |

The write path (audit log, acks and proposals under `PULSE_WEB_DATA_DIR`) is inert in auth mode
`none`; see [docs/operator/write-path.md](../../docs/operator/write-path.md). No estate YAML or
source path is read beyond the rendered bundle model path.

## Client views

The SPA shell (side nav, theme and density toggles, command palette on Ctrl+K / ⌘K) hosts five
lazy-loaded views, in nav order. Every view is read-only and degrades explicitly: a missing or stale
source shows as "not current", "not reported" or "not available", never as healthy.

The client is React 19 with Tailwind CSS v4, built from the `@/ui` component library (shadcn/ui
primitives and patterns vendored from deck). See [docs/architecture/ui.md](../../docs/architecture/ui.md)
for the library, theme tokens, status maps, build and test conventions.

| Path | View | What it shows | URL state |
|---|---|---|---|
| `/` → `/overview` | Overview | Estate status grid, firing-alert ribbon, target drawer with liveness history and checks | — |
| `/alerts`, `/alerts/:fingerprint` | Alerts | Triage table with facets, detail pane, alert history strip, rule catalog and silences tabs | `sev`, `state`, `group`, `hs` (`<kind>:<id>`), `family`, `sel`, `tab`; `?target=<id>` alias |
| `/estate`, `/estate/host/:name`, `/estate/service/:host/:name` | Estate | Inventory, coverage and findings from the rendered model; host and service entity pages | `tab`, `q` |
| `/engine` | Engine | Monitoring-engine verdict, component cards, scrape jobs, rule groups, capacity trends | — |
| `/timeline` | Timeline | Host/service/domain status lanes (alerts plus Gatus checks), alert swimlane, per-target charts | `range` (`1h`/`6h`/`24h`/`7d`), `end` (pause), `zoom`, `sel` |

**Kiosk / wallboard.** `?kiosk=1` hides the chrome. `?rotate=overview,alerts:30s,timeline` cycles
views (`viewId` or `viewId:Ns` for a per-view dwell; unknown ids are dropped), and the next view's
payload is prefetched before its turn. Legacy `#/<view>` hash links redirect to the path form.

**Check history through a reverse proxy.** Timeline check history requests ids containing `/`
percent-encoded (`/api/history/checks/web%2Fapp`). The proxy must forward `%2F` unchanged — see
`docs/operator/exposure.md`.

## HTTP routes (all `GET` in auth mode `none`)

**Operational**

| Route | Purpose |
|---|---|
| `/healthz` | liveness + per-source reachability (`status: "ok"` body) |
| `/metrics` | Prometheus exposition (see **Telemetry**) |

**Current views** (cycle-backed; conditional caching)

| Route | Payload |
|---|---|
| `/api/overview` | estate grid, live signals, alert counts, coverage |
| `/api/alerts` | firing/silenced/inhibited alerts, rules, active silences |
| `/api/estate` | rendered vocabulary joined with live target state |
| `/api/engine` | the six engine components, scrape/rule/capacity health |
| `/api/timeline` | per-target applicable history query ids + ranges, parent links (service→host, endpoint→service), estate DNS domains |

**Session / live**

| Route | Behavior |
|---|---|
| `/api/session` | resolved identity (or `null`), auth mode, three capabilities — `false` unless `proxy-header` mode with a trusted identity; `Cache-Control: private, no-store` |
| `/api/events` | SSE stream: `retry: 10000`, ~5s heartbeats, one tick per published cycle |

**On-demand history** (bounded, per-request; the only query key honored is `range`)

| Route | Series |
|---|---|
| `/api/history/estate/:queryId` | estate-wide curated series |
| `/api/history/target/:drilldownId/:queryId` | target-scoped curated series |
| `/api/history/alerts` | firing-alert intervals |
| `/api/history/checks/:endpoint` | exact-endpoint check history |

`:drilldownId` and `:endpoint` accept a percent-encoded `/` (`svc%3Ahost%2Fname`, `host%2Fservice`); no
other route parameter does. `checks` also accepts estate DNS endpoints (`dns%3A<domain>`).

History routes accept **only** the optional `range` key (one of `1h`, `6h`, `24h`, `7d`); `start`,
`end`, `step`, and any query expression are rejected with `400 INVALID_REQUEST`. **Clients never send
PromQL** — the server builds every query from its own curated catalog. Unknown `/api/*` paths return
a JSON `404`; a non-`GET` request returns a JSON `405` (no body is read), except for the write-path
routes below in `proxy-header` mode.

**Write path** (`proxy-header` mode only; see
[docs/operator/write-path.md](../../docs/operator/write-path.md))

| Route | Purpose |
|---|---|
| `POST /api/mutations/silences`, `POST /api/mutations/silences/expire` | create / expire an Alertmanager silence (`silence`) |
| `POST /api/mutations/acks`, `POST /api/mutations/acks/remove` | acknowledge / un-acknowledge a firing alert (`ack`) |
| `POST /api/mutations/proposals` | record a signed estate-edit proposal (`proposeEstateEdit`) |
| `GET /api/proposals?kind=&id=` | proposals for one host or service |

### Not-ready and degradation

- **Before the first cycle** the cycle-backed routes return `503 NOT_READY` (`{ code: "NOT_READY" }`).
  `/healthz`, `/metrics`, `/api/session`, and `/api/events` stay live.
- **Bundle error** (missing/unreadable/unparseable/incompatible rendered model): cycle-backed APIs
  return a `503` with a safe `ESTATE_BUNDLE_*` code and an actionable message; no stale cycle is
  served. `/healthz`, `/metrics`, assets, session, and events continue. Recovery needs no restart.
- **Source degradation** (one upstream unreachable/timing out): the cycle still publishes as
  **degraded** — unaffected data stays current, the failing source is marked stale/unavailable, and
  no missing evidence is ever shown as healthy/green ("never-silent-green"). Sources recover
  automatically on a later cycle. Optional artifacts (coverage/findings/Grafana) that are absent are
  reported as **unavailable**, never as empty-but-healthy.

### Conditional caching (ETag / gzip)

Current-view routes serve retained bytes with:

- a strong `ETag` over the exact selected representation (plain and gzip carry **distinct** strong
  validators);
- `gzip` content negotiation honoring `Accept-Encoding` q-values (`gzip;q=0` disables it);
- a bodyless `304 Not Modified` on a matching strong `If-None-Match`;
- `Cache-Control: private, no-cache`, `Vary: Accept-Encoding`, a base64url `X-Pulse-Observation`
  header, and a semantic `X-Pulse-Payload-Id` — on both `200` and `304`.

History responses are per-request values, not cycle representations: `Cache-Control: private,
no-cache` and no ETag/observation protocol.

### Limits (fixed constants)

| Limit | Value |
|---|---|
| Cycle cadence / slow-tier cadence | 10 s / 60 s |
| Source request timeout / max body | 5 s / 32 MiB |
| Current body budget (plain / gzip) | 5 MiB / 1 MiB |
| Observation header | 8 KiB |
| SSE retry / heartbeat / max streams | 10 s / 5 s / 64 |
| History deadline / cache TTL | 5 s / 60 s |
| History concurrency (active / queued) | 4 / 32 |
| History points / series per response | 600 / 1024 |
| History cache entries / bytes | 64 / 64 MiB |
| Gatus page size / max endpoints | 512 / 511 |

## Telemetry

`/metrics` is handwritten Prometheus exposition with bounded, closed labels. Labels are **never**
host/service/endpoint/fingerprint/raw-path/query/peer/identity/error values. Cycle-tier families:

```
pulse_web_cycle_sequence
pulse_web_cycle_duration_seconds
pulse_web_cycle_publications_total{outcome}
pulse_web_source_up{source}
pulse_web_upstream_calls_total{source,outcome}
pulse_web_sse_streams
pulse_web_sse_events_total{event,outcome}
pulse_web_history_requests_total{query,outcome}
pulse_web_history_cache_hits_total{query}
pulse_web_history_active
pulse_web_history_queued
```

The write path adds `pulse_web_mutations_total`, `pulse_web_mutation_refusals_total`,
`pulse_web_audit_write_failures_total`, `pulse_web_ack_auto_clears_total` and
`pulse_web_write_path_status`; see [docs/operator/write-path.md](../../docs/operator/write-path.md).

`source` labels are exactly the closed `SourceId` set; `history` `query` labels are exact catalog
query ids plus fixed operation names; route labels use declared templates or the fixed
`static`/`spa`/`api-notfound` categories. The existing build/bundle/HTTP/refresh families and a
cycle-observation-age gauge are retained. Structured JSON logs cover cycle publication/degradation/
recovery, source failure/recovery (edge-triggered), SSE connect/displace/write-failure, and history
timeout/overload/model-invalidation — all with categorical fields only (no bodies, credentials,
PromQL, entity ids, peer IPs, or identity/header values).

## Build

`bun run build` (⇒ `bun run scripts/build.ts`) compiles the workspace package graph first
(`@pulse/web-data` and its `@pulse/core` / `@pulse/renderer` dependencies), then generates
`src/version.ts`, bundles the client into `dist/client/` (`Bun.build` with `bun-plugin-tailwind`;
content-hashed, minified) and the server
into `dist/server/index.js` (`target: bun`), and copies the static shell. A package compile failure
publishes no new client manifest or server bundle. The image (`Dockerfile`) is multi-stage and is
built with the **repo root** as context so the build can reach the sibling workspace packages. Bases
are pinned (`oven/bun:1.3.9` build, `oven/bun:1.3.9-slim` runtime); the runtime stage installs
`wget` for the in-container healthcheck (CON-08).

## Testing

Unit/component tests run under `bun test` (happy-dom and React Testing Library). An in-process **normal-composition smoke**
(`tests/smoke.test.ts`) boots the real server runtime against sanitized mock sources and exercises
every M1 route in not-ready, ready, and degraded/error modes — it needs no Docker. The same file also
carries the `--profile web` **Docker** compose smoke, which boots the real container and self-skips
without a Docker daemon (so a plain `bun test` stays green); it runs under `bun run smoke`. The
browser criteria suite (`tests/browser/*.test.ts` — grayscale / reflow / axe) needs headless
Chromium, provisioned as a tool via `bunx playwright-core install chromium`; those tests self-skip
cleanly when Chromium is absent, unless `PULSE_REQUIRE_BROWSER=1` is set, which turns a missing
Chromium into a hard failure.

The write-path **dev-loop e2e** (`tests/mutations-dev-loop.test.ts`) self-skips unless
`PULSE_DEV_LOOP=1`; it then needs `PULSE_ALERTMANAGER_URL` pointing at the dev loop's real
Alertmanager (`--mock` is read-only). Run it once before merging write-path changes.

The production overview **performance suite** (`tests/browser/overview-performance.test.ts`) is
opt-in. It registers only when `PULSE_REQUIRE_PERF=1` is set, which `bun run perf` does, and
`bun run ci` includes `bun run perf`. It asserts p95 limits of 1000 ms for the initial grid paint and
100 ms for the refreshed status paint and for keyboard and pointer input response. Those limits are
meant for a quiet or dedicated runner. On a shared, loaded host, `bun run perf` (and so a local
`bun run ci`) can miss them. The per-change local gate is `bun test && bun run smoke && bun run typecheck`.

## Troubleshooting

- **`ConfigError` on startup / red healthcheck** — a required URL (`PULSE_VM_URL`,
  `PULSE_ALERTMANAGER_URL`, `PULSE_GATUS_URL`, `PULSE_VMALERT_URL`) is missing, malformed, or carries
  embedded credentials. The message names the env key.
- **Error-page / `ESTATE_BUNDLE_*` 503** — the rendered `web-estate-model.json` mount is missing,
  unreadable, unparseable, or an incompatible version. Re-render the estate; recovery needs no
  restart.
- **Routes return `503 NOT_READY`** — the first cycle has not published yet (upstreams just came up).
  It clears within a cycle once sources respond.
- **A single source shows stale/degraded** — check that origin's URL and reachability; the rest of
  the estate keeps serving. `/healthz` and `pulse_web_source_up{source}` report per-source state.
- **Grafana deep links missing** — `PULSE_GRAFANA_URL` is unset (optional). Set it to enable deep
  links; leaving it unset is supported and never blocks startup.
- **SSE not updating behind a proxy** — ensure the proxy forwards `X-Accel-Buffering: no`, does not
  buffer the response, and does not impose a short idle timeout (heartbeats arrive every ~5 s).

For local development against a mock or real engine (four-origin syntax, package rebuild watching,
build-failure recovery, fixtures), see [`DEVELOPING.md`](./DEVELOPING.md).
