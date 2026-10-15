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

It does bake the **Pulse version**, which `/healthz` and `pulse_web_build_info` report. By default
that is the `version` in `apps/web/package.json` of the checkout you build from (`0.2.0` on the
`v0.2.0` tag). To bake another value, pass `--build-arg PULSE_BUILD_VERSION=<version>` to
`docker build`, or set `PULSE_BUILD_VERSION` in the environment of `docker compose build`. Open
browser tabs reload themselves once when they see a new image: the server's `appVersion` combines
the version with the client bundle's build id, so a rebuild at the same version also counts.

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

## Wallboard (kiosk) mode

For an unattended screen, open the overview with `?kiosk=1`, for example
`https://pulse.example/overview?kiosk=1`. Kiosk mode hides the navigation and the controls, uses the
larger wallboard type, and replaces the host grid with a read-only wall of compact tiles:

- One line with coverage and engine state, then the status counts. Each badge reads
  hosts · services, for example "Critical 2 · 3", and counts of 1,000 or more are shortened to
  "5K". Then one line of firing-alert counts and names. On a narrow screen, or with many statuses,
  the counts may take more than one line.
- One two-line tile per host, worst status first: the host name, its class and status, its firing
  alert count, its worst failing service, and how many services are OK.
- Tiles are not interactive. Use the desk view to open a host's details.

The bottom line shows the time zone that every time on the wall uses. When the hosts do not fit one
screen, the wall pages through them, showing "i / P" at the bottom right. Each page stays up for at
least 10 seconds. Up to three pages share a 30-second cycle, and more pages lengthen the cycle. To
rotate between views, add `rotate`, for example `?kiosk=1&rotate=overview:60s,alerts:30s`. Each
overview visit then shows the pages that fit its dwell at 10 seconds or more each, and the next visit
continues from where the last one stopped. A rotation dwell under 10 seconds shows one page per
visit. When a host newly turns critical and is not on screen, the wall jumps back to page 1, where
the worst hosts are (the new host is there unless more critical hosts than one page holds sort
ahead of it). This happens at most once per cycle, however many hosts flap. With reduced motion
set on the device, pages change without the fade.

## Where to go next

- **Expose it safely** → the [exposure recipe](/exposure/).
- **The posture it inherits** → [runtime posture](/runtime-posture/).
- **What the alerts it surfaces mean** → [alerting](/alerting/).
