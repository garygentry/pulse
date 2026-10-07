---
title: Web overview profile
description: The build + run contract for the web overview profile — how the web:8080 image is built, what it needs at run time, the estate model it renders from, and how to expose it safely.
slug: web-overview
---

# Web overview profile

The **web overview** (`web:8080`, Compose profile `web`) is Pulse's top-level, at-a-glance
"durable window": a read-only status grid over the estate, with Grafana as the drill-down
underneath. It is **profile-gated OFF** — a plain `docker compose up` runs only the seven always-on
services; the overview comes up under `--profile web`. This page is the deterministic build + run
contract so a consumer can stand it up to Pulse's shipped shape, not a bespoke one.

## What renders it: `web-estate-model.json`

The overview reads its structure from **`web-estate-model.json`** — an **existing engine render
output**, not a separate input. `pulse render` emits it (renderer render-kind `web`,
`packages/renderer/src/render/web-model.ts`) into the rendered tree, alongside `gatus/`,
`alertmanager/`, `scrape/`, etc. It carries the estate name + domains, the hosts (each with
`collectionClass`, addresses, `drilldownId`, `suppressed`) and services — the **sole** source of the
grid's membership. The app never reads inventory files or live metrics to decide what to show.

Lifecycle:

- Delivered by the **read-only rendered-tree mount** (`${PULSE_RENDERED_DIR:-../rendered}:/rendered:ro`),
  never baked into the image.
- **Hot-reloaded** — re-render the estate and the grid picks up the new model without a restart.
- If `PULSE_WEB_ESTATE_MODEL` is unset or the file is unreadable, the app serves a graceful
  error-page mode (it does **not** crash on boot).

## Build: the D10 build-on-host pattern

Pulse ships **only a `build:` recipe** for `web` — there is no published registry image (tracked
upstream as pulse#5). The image is built **on the Docker host from a pinned Pulse checkout**, then
its tag is pinned in the vendored Compose file:

```bash
# From the root of a pinned pulse checkout (the build context is the REPO ROOT, so the image
# can reach the sibling workspace packages @pulse/core + @pulse/renderer):
docker build -t pulse/web:<pulse-sha> -f apps/web/Dockerfile .
```

Then reference the built tag in your vendored compose (replacing Pulse's `build:` block):

```yaml
services:
  web:
    image: pulse/web:<pulse-sha>
    profiles: ["web"]      # still OFF by default
```

The image is a multi-stage Bun build and bakes **no estate value** — everything arrives via env and
the read-only mount.

## Run-time configuration

The service listens on a fixed port **8080** (deliberately not env-configurable) and publishes **no
host port** by default (`expose: ["8080"]` only — host publication is the exposure step below).

| Env var | Required | Notes |
|---|---|---|
| `PULSE_VM_URL` | **yes** | e.g. `http://victoriametrics:8428`. Missing → hard startup failure. |
| `PULSE_ALERTMANAGER_URL` | **yes** | e.g. `http://alertmanager:9093`. Hard failure if absent. |
| `PULSE_GATUS_URL` | **yes** | e.g. `http://gatus:8080`. Hard failure if absent. |
| `PULSE_WEB_ESTATE_MODEL` | no | In-container model path (default `/rendered/web-estate-model.json`). Unset/unreadable → graceful error-page mode, not a boot failure. |
| `PULSE_ESTATE_TZ` | no | Display timezone; defaults to UTC. |
| `PULSE_GRAFANA_URL` | no | Absent → drill-down deep links to Grafana are disabled. |
| `PULSE_GATUS_STALE_SECONDS` | no | Freshness cutoff for Gatus results; default 300. |

The service `depends_on` VictoriaMetrics + Alertmanager (`service_healthy`) and Gatus
(`service_started` — the pinned Gatus image is shell-less and carries no healthcheck).

## Exposure posture

The overview ships **no built-in auth** — in the default auth mode `none` every route is GET-only
and exposes only estate structure, health, and alerts (no secrets); `proxy-header` mode adds the
write path (silences, acks, estate-edit proposals — see [write path](/write-path/)). Either way the reverse-proxy / network boundary **is** the access-control
boundary. It is one of the two services blessed as proxy-safe (alongside Grafana); everything else
stays internal. The blessed posture is a TLS-terminating reverse proxy that **joins the `pulse`
network** and proxies to `web:8080` by in-stack DNS name — see the [exposure recipe](/exposure/)
(Recipe A, Caddy or Traefik). Add it via a git-ignored `docker-compose.override.yml`; never edit the
committed tree.

## Stand it up

```bash
# 1. Render the estate (emits web-estate-model.json into the rendered tree):
pulse render --config <estate-dir> --out <rendered-dir>

# 2. Bring up the stack WITH the web profile:
cd stack/compose && docker compose --profile web up --wait

# 3. Content-verify the overview answers (in-stack or via your proxy):
docker compose exec web wget -qO- http://127.0.0.1:8080/healthz
```

## Where to go next

- **Expose it safely** → the [exposure recipe](/exposure/).
- **The posture it inherits** → [runtime posture](/runtime-posture/).
- **What the alerts it surfaces mean** → [alerting](/alerting/).
