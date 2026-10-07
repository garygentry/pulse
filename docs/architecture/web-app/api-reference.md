# API Reference

`@pulse/web` is a compose service, not a library — it exposes no importable TypeScript API. Its
public contract is its **HTTP surface**, the **JSON shapes** it serves, the **Prometheus metrics** it
publishes, and the **environment variables** it reads. All of those are documented here.

## HTTP routes

The service listens on a fixed port **8080**. Every route is `GET`-only; any other method returns
`405 Method Not Allowed`.

| Method | Path | Response | Notes |
|---|---|---|---|
| `GET` | `/` | `text/html` | The SPA shell (`index.html`). Any unmatched non-asset path also returns the shell (client hash-routing). |
| `GET` | `/assets/*` | asset bytes | Content-hashed client bundle. Served with `Cache-Control: public, max-age=31536000, immutable`. `404` if the asset name is unknown. |
| `GET` | `/api/overview` | `application/json` — [`OverviewSnapshot`](#overviewsnapshot) | The current estate snapshot. Returns `503` with an error body in [error-page mode](./architecture.md#estate-model--error-page-mode). |
| `GET` | `/api/history/alerts?range=<range>` | `application/json` — `IntervalHistoryPayload | ErrorEnvelope` | Alert firing-history lanes. `range` is `1h`, `6h`, `24h`, or `7d` and defaults to `24h`. Responses use `Cache-Control: private, no-cache`. |
| `GET` | `/healthz` | `application/json` — [`HealthBody`](#healthbody) | Always `200` when the process can respond. |
| `GET` | `/metrics` | `text/plain` | Prometheus exposition — see [Metrics](#metrics). |

In error-page mode, `/healthz` and `/metrics` stay live and `/assets/*` is still served, while `/`
returns the diagnostic error page and `/api/overview` returns `503`.

## JSON shapes

These are the shapes served on the wire. Field-level intent is summarized; the authoritative
definitions live in `src/shared/snapshot.ts`.

### `OverviewSnapshot`

Served by `GET /api/overview`. One immutable description of the whole estate at an instant.

```jsonc
{
  "appVersion": "1.4.0",                 // build version; a change triggers one client reload
  "generatedAt": "2026-08-22T12:00:00Z", // ISO-8601 UTC; drives the staleness indicator
  "estate": {
    "name": "acme-prod",
    "timezone": "America/New_York",
    "tzFallback": false                  // true ⇒ TZ unconfigured, UTC shown with a marker
  },
  "sources": {                           // per-engine health (see SourceHealth)
    "metrics": { "ok": true,  "lastSuccess": "…", "error": null },
    "alerts":  { "ok": true,  "lastSuccess": "…", "error": null },
    "checks":  { "ok": false, "lastSuccess": "…", "error": "gatus unreachable" }
  },
  "hosts": [ /* HostStatus[] in declared model order */ ],
  "alerts": [ /* ActiveAlert[]: matched + unattributed, severity-then-recency ordered */ ]
}
```

Key nested types:

- **`SourceHealth`** — `{ ok: boolean; lastSuccess: string | null; error: string | null }`. `ok:false`
  marks that engine's slice stale while the rest of the snapshot stays live.
- **`HostStatus`** — a declared host with its rolled-up `status`, its `services` (`ServiceStatus[]`),
  matched `alerts`, and `checks` (`CheckResult[]`).
- **`ServiceStatus`** — a declared service with its resolved `status`, matched `alerts`, and `checks`.
- **`ActiveAlert`** — `{ name, severity, target, startsAt, … }` where `severity ∈ {critical, warning,
  info}` (an unrecognized severity coerces to `info`), and `target` is the matched host/service
  identity or `null` (unattributed).
- **`CheckResult`** — `{ endpoint, success, lastEvaluatedAt, responseTimeMs? }`; a Gatus endpoint
  status attached to its declared host/service.
- **`TargetStatus`** — the status enum: `"ok" | "warning" | "critical" | "unknown" | "suppressed"`.

### `HealthBody`

Served by `GET /healthz`. Always `200` when the process can respond.

```jsonc
{
  "status": "ok",                        // "ok" | "degraded" (any source down or model not loaded)
  "version": "1.4.0",
  "estateModel": {
    "loaded": true,
    "formatVersion": 1,                  // null when not loaded
    "error": null                        // a short message when the model failed to load
  },
  "sources": { "metrics": {…}, "alerts": {…}, "checks": {…} }  // SourceHealth each
}
```

`status` is `"degraded"` when any engine source is unreachable **or** the estate model is not loaded.
In error-page mode, `/healthz` returns `200` with `estateModel.loaded = false`.

## Metrics

`GET /metrics` publishes six Prometheus metric families:

| Metric | Meaning |
|---|---|
| `pulse_web_build_info` | Build/version info (labelled). |
| `pulse_web_source_up` | Per-engine reachability (`1`/`0`), labelled by source. |
| `pulse_web_estate_model_loaded` | `1` when the estate model is loaded, `0` in error-page mode. |
| `pulse_web_snapshot_age_seconds` | Age of the current snapshot. |
| `pulse_web_refresh_total` | Refresh-cycle counter. |
| `pulse_web_http_requests_total` | HTTP request counter. |

## Environment variables

Parsed once at startup into the runtime config. The listen port is **not** configurable — it is fixed
at `8080` so the slot's `expose`, the healthcheck, and the scrape target all agree.

| Env var | Required | Default / on absence |
|---|---|---|
| `PULSE_VM_URL` | **yes** | none — a missing/empty value is a hard startup failure (`ConfigError` → red healthcheck) |
| `PULSE_ALERTMANAGER_URL` | **yes** | none — hard startup failure |
| `PULSE_GATUS_URL` | **yes** | none — hard startup failure |
| `PULSE_WEB_ESTATE_MODEL` | no | unset/empty → error-page mode (servable), the same state as an unreadable mount — **not** a startup failure |
| `PULSE_ESTATE_TZ` | no | UTC, with an explicit "TZ not configured" marker; an invalid zone logs a warning and falls back to UTC |
| `PULSE_GRAFANA_URL` | no | Grafana deep links disabled, with an actionable tooltip |
| `PULSE_GATUS_STALE_SECONDS` | no | `300`; a non-numeric value logs a warning and uses the default |

Only the three engine URLs are hard-required. An unset `PULSE_WEB_ESTATE_MODEL` deliberately yields a
`null` model path and servable error-page mode rather than refusing to boot, so the container can
start before its estate model is rendered.

## Alerts view URL state

The `/alerts` view is shareable and browser-history aware. It reads these query keys:

| Key | Meaning |
|---|---|
| `sev` | Selected severities |
| `state` | Selected firing, silenced, or inhibited states |
| `group` | Selected alert groups |
| `hs` | Selected host/service identities |
| `family` | Selected rule families |
| `sel` | Fingerprint of the alert open in the detail drawer |
| `tab` | Active tab (`catalog` or `silences`); omission means `firing` |

Multi-value facets use `,` as their delimiter. Values are sorted when encoded so equivalent
selections produce the same canonical URL. On the firing tab, `j` and `k` move the keyboard cursor,
`Enter` opens the selected alert, and `Esc` closes the detail drawer.

## Timing constants

Fixed cadences that define the app's freshness guarantees:

| Constant | Value | Role |
|---|---|---|
| Server refresh interval | 10s | How often the server rebuilds the snapshot from the engines. |
| Source fetch timeout | 5s | Per-engine request timeout inside a refresh cycle. |
| Client poll interval | 10s | How often the browser re-fetches `/api/overview`. |
| Client stale threshold | 30s | Failed-poll window before the "app server stale" banner is raised. |
| Gatus staleness default | 300s | Default freshness window for a Gatus check (`PULSE_GATUS_STALE_SECONDS`). |
