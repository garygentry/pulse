# Integration Guide

The web app is delivered as a compose **service**, not a package you import. "Integrating" it means
wiring its container into the stack composition: giving it the three engine URLs, mounting the
rendered estate model read-only, and deciding where the authentication boundary sits. This guide
covers that.

## The compose slot

The service fills the `web` slot in the stack's `docker-compose.yml`. It is gated behind the `web`
compose profile, so it is **off by default** and only starts when that profile is selected:

```bash
# Bring the estate up with the web overview included
docker compose --profile web up -d --wait
```

The slot is built from the **repo root** as context (so the image can reach the sibling workspace
packages it bundles) and exposes port `8080` in-stack. It publishes **no `ports:`** of its own —
that is deliberate (see [Publishing & authentication](#publishing--authentication)).

### What the slot provides

| Concern | Slot wiring |
|---|---|
| Engine URLs | `PULSE_VM_URL`, `PULSE_ALERTMANAGER_URL`, `PULSE_GATUS_URL` point at the in-stack service names (`http://victoriametrics:8428`, `http://alertmanager:9093`, `http://gatus:8080`). |
| Estate model | `PULSE_WEB_ESTATE_MODEL: /rendered/web-estate-model.json`, delivered by a **read-only** mount: `${PULSE_RENDERED_DIR:-../rendered}:/rendered:ro`. The model is never baked into the image. |
| Timezone | `PULSE_ESTATE_TZ` from the stack's environment. |
| Healthcheck | `wget -qO- http://127.0.0.1:8080/healthz` — the runtime image installs `wget` for exactly this. |
| Scrape | The stack scrapes `web:8080/metrics` as its own Prometheus target. |

Operator-tunable variables live in the stack's `.env` (e.g. `PULSE_ESTATE_TZ`, `PULSE_GRAFANA_URL`,
`PULSE_GATUS_STALE_SECONDS`, and `PULSE_RENDERED_DIR`). The three engine URLs are fixed to the
in-stack service names and are not meant to be overridden per-deployment.

## Delivering the estate model

The app needs `web-estate-model.json` at the mounted path. That file is produced by the estate
renderer and lands in the rendered tree (`PULSE_RENDERED_DIR`, default `../rendered`). The typical
flow:

1. Render the estate → writes `rendered/web-estate-model.json`.
2. Start (or already-running) `web` service mounts `rendered/` read-only at `/rendered`.
3. On its next refresh cycle the app loads the model and leaves error-page mode.

You do **not** need to sequence these precisely. If the container starts before the model exists, it
comes up in [error-page mode](../architecture.md#estate-model--error-page-mode) — `/healthz` stays
live and reports `estateModel.loaded = false` — and recovers automatically once the file appears.
Re-rendering the model while the app runs is also fine: `estate/watch.ts` notices the content change
on the next cycle and reloads without a restart.

The mount is read-only (`:ro`) by design — the app only ever reads the model, and the read-only
mount is part of its security posture.

## Publishing & authentication

The container listens on `8080` in-stack but publishes no host port itself. **Where you publish it is
where your auth boundary must be**, because the app ships with **no built-in authentication** and
every route reveals estate structure, health, and active alerts.

Recommended patterns:

- **Trusted LAN** — publish `8080` only on a management network no untrusted client can reach.
- **Behind a reverse proxy** — front it with the same authenticating proxy that already guards
  Grafana and the estate's other UIs, and publish only the proxy.

Do not expose the raw `8080` port to the public internet. Non-`GET` requests are already rejected
(`405`), but that is a read-only guarantee, not an access-control one.

## Verifying an integration

Once the `web` profile is up:

```bash
# From inside the stack network (e.g. another service, or `docker compose exec`):
wget -qO- http://web:8080/healthz            # {"status":"ok"|"degraded", "estateModel":{"loaded":…}}
wget -qO- http://web:8080/api/overview       # the full OverviewSnapshot (503 if the model isn't loaded)
```

- `status: "ok"` with `estateModel.loaded: true` and all three `sources[*].ok: true` means a fully
  healthy integration.
- `status: "degraded"` with `estateModel.loaded: false` means the model mount is missing or invalid —
  check that `rendered/web-estate-model.json` exists and is readable at `/rendered`.
- `status: "degraded"` with a `sources[*].ok: false` means one engine is unreachable — check that
  engine's service and the URL wired into the slot.

## Grafana drill-down (optional)

Set `PULSE_GRAFANA_URL` to the **browser-facing** Grafana origin to enable per-host/-service
drill-down links from the overview into the relevant Grafana boards. Leave it unset (the default) and
the links are disabled with an explanatory tooltip — the overview is fully functional either way.
