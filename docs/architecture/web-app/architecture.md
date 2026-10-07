# Architecture

The web app is one container running two cooperating tiers in a single Bun process:

- a **server tier** that owns state — it reads the estate model, polls the engines, and folds a
  snapshot; and
- a **React SPA** that owns nothing — it polls the server's snapshot and renders it.

All estate truth flows one way: rendered model + live engines → server snapshot → client view. The
client never talks to an engine directly and never mutates anything.

## Server tier

```
                        ┌─────────────────────────── refresh loop (every 10s) ───────────────────────────┐
  PULSE_WEB_ESTATE_MODEL │                                                                                 │
  (read-only mount) ─────┼──▶ estate/load + watch ──▶ WebEstateModel ──┐                                   │
                         │                                             │                                   │
  VictoriaMetrics ───────┼──▶ sources/vm ────────────▶ liveness ──┐    ▼                                   │
  Alertmanager ──────────┼──▶ sources/alertmanager ─▶ alerts ─────┼─▶ snapshot/build ─▶ OverviewSnapshot ──┼─▶ atomic swap
  Gatus ─────────────────┼──▶ sources/gatus ────────▶ checks ─────┘                                        │      │
                         └─────────────────────────────────────────────────────────────────────────────────┘      │
                                                                                                                    ▼
                                       Bun.serve :8080  ──▶  GET /api/overview  (serves the current snapshot as JSON)
```

### The refresh loop

`refresh.ts` runs a cycle every `REFRESH_INTERVAL_MS` (10s):

1. Fetch all three engine sources concurrently. Each client (`sources/vm`, `sources/alertmanager`,
   `sources/gatus`) applies a `SOURCE_TIMEOUT_MS` (5s) timeout and **never throws** — every timeout,
   non-2xx, or malformed response is captured as `{ ok: false, error }`.
2. Fold the raw source data plus the current estate model into a fresh `OverviewSnapshot` (pure, in
   `snapshot/build.ts`).
3. Swap the new snapshot in as the current one. Readers always see a complete, consistent snapshot —
   there is no half-updated state.

The loop is crash-proof by construction: a source failure is *data* (that source's slice goes stale),
not an exception. A per-source failure sets `SourceHealth.ok = false` for that source while the other
two stay live, so a single dead engine degrades the view rather than blanking it.

### Fold and status resolution

`snapshot/build.ts` is a pure function `(model, sourceData, now, config) → OverviewSnapshot`. It:

- **matches** raw alerts and checks to declared targets by **exact identity** (`match.ts`). An alert
  labelled `host=web01, service=grafana` attaches to that service; a Gatus endpoint `web01/grafana`
  attaches to the same service, `host:edge01` to that host. Matching is exact string equality — a
  near-miss (`web01/grafan`) attaches to nothing and colours nothing. An unmatched alert is still
  listed in the strip as unattributed (`target: null`).
- **resolves status** for every host and service to `ok | warning | critical | unknown |
  suppressed`, then rolls services up into their host. Ordering rules: severity is
  critical > warning > ok; `info` alerts appear in the strip and panel but never colour a cell;
  a `suppressed` target contributes nothing to a roll-up; the Alertmanager `DeadMansSwitch` is
  dropped entirely (it neither colours nor appears).
- **builds Grafana drill-down links** (`links.ts`) when `PULSE_GRAFANA_URL` is set, using a fixed
  set of board UIDs; when it is unset, links are disabled with an explanatory tooltip.

Because the fold is pure and injects `now` and all source data explicitly, it is exhaustively unit
tested without a clock, network, or filesystem.

## Estate model & error-page mode

The estate model is the declared shape of the estate, rendered upstream into `web-estate-model.json`
and mounted read-only. `estate/load.ts` reads and validates it in order — JSON well-formedness →
root shape → format-version compatibility → structural fields — and **never throws**: every failure
is captured as an `EstateModelError` with a kind (`missing`, `unparseable`, `version`, `structure`)
and an operator-actionable message.

`estate/watch.ts` re-checks the file once per refresh cycle, guarded by a cheap `mtime`+`size` stat
and then a content hash, so a touched-but-unchanged file is a no-op and only a real content change
triggers a reload.

When the model is not loaded — the env var is unset (a `null` path), the file is missing/unreadable,
or it fails validation — the app enters **error-page mode** instead of crashing:

| Request | Behavior in error-page mode |
|---|---|
| `GET /` and other SPA paths | Diagnostic error page (HTTP 200) explaining the model fault |
| `GET /api/overview` | HTTP 503 with a machine-readable error body |
| `GET /healthz` | Stays live: HTTP 200 with `estateModel.loaded = false`, `status: "degraded"` |
| `GET /metrics` | Stays live |
| `GET /assets/*` | Served normally (the shell's JS/CSS still load) |

Recovery is automatic: the next refresh cycle that reads a valid model transitions the app back to
normal, with no restart. An unset env var and an unreadable file are the *same* servable state — the
app is designed to be brought up before its model is ready.

## Client tier

The SPA is a React 19 app styled with Tailwind CSS v4 and composed from the in-repo `@/ui` component library (see [Web UI](../ui.md)); it is bundled with `Bun.build`, with no build-time framework beyond the bundler.

- **`poll.ts`** fetches `/api/overview` every `POLL_INTERVAL_MS` (10s) and holds exactly one
  snapshot, replacing it each poll (never accumulating history). It is stateless across polls, so it
  **self-heals**: after a run of failed fetches, the next success resumes rendering with the fresh
  snapshot and clears the stale state.
- **Staleness** is surfaced to the operator: if polling fails for longer than `POLL_STALE_MS` (30s),
  the app raises an "app server stale" banner while retaining the last good snapshot (never blanking
  it). Combined with the server's own 10s refresh, worst-case data age stays well under the banner
  threshold.
- **Reload-on-deploy**: the snapshot carries the build's `appVersion`; when it changes, the client
  triggers exactly one reload to pick up the new bundle.
- **`router.ts`** maps History-API paths to lazy views. **`views/overview/`** renders the estate grid,
  while **`views/alerts/`** renders the firing triage table, catalog and active-silences tabs. The
  alerts view derives facets and its detail sheet from URL state and contains a view-local error
  boundary so a rendering fault does not take down the shell. A `kiosk` query flag hides chrome
  except the staleness indicator.

## Security posture

The app has **no built-in authentication**. Every route is `GET`-only (enforced by the
`RouteDefinition.method: "GET"` type, and a non-GET request returns 405), but the overview still
exposes estate structure, health, and active alerts to anyone who can reach the port. The container
publishes no `ports:` of its own — where the auth boundary sits is the deployment's responsibility.
Run it on a trusted LAN or behind the estate's existing reverse-proxy authentication.

## Design rationale

- **One-way data flow** keeps the client trivial and the server the single owner of truth; the whole
  UI is a pure function of one JSON document.
- **Never-throw sources and a never-crash loop** mean a flaky engine or a mid-render model swap
  degrades the view instead of taking the service down — the dashboard you look at when things are
  broken must itself stay up.
- **Error-page mode over crash-fast** lets the container start before its estate model is rendered
  and recover on its own, which matters in a compose bring-up where ordering is not guaranteed.
- **A pure, clock-injected fold** makes status resolution — the part most likely to regress subtly —
  fully unit-testable.
