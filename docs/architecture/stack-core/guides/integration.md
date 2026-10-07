# Integration Guide

This guide is for two audiences: operators bringing the engine up against a real estate, and
authors of the downstream Pulse features that plug into it (`pulse-cli`, `alerting`,
`dashboards`, `web-app`, `host-agent`). stack-core is the engine everything else runs on or
extends — it defines the slots, and you fill them without editing the compose tree.

## Running the engine against an estate

The engine takes one estate input: a rendered directory produced by `pulse-cli`. Render your
estate, point `PULSE_RENDERED_DIR` at the result, and bring the default profile up.

```bash
# 1. render your estate config into a directory (owned by pulse-cli)
pulse render ./estate --out ./rendered

# 2. configure the engine
cd stack/compose
cp .env.example .env            # .env is git-ignored
$EDITOR .env                    # fill PVE_TOKEN, Grafana admin, retention, etc.

# 3. bring it up
PULSE_RENDERED_DIR=../../rendered docker compose up --wait --wait-timeout 180
```

`--wait` returns 0 only once every default-profile service is healthy. To include an optional
slot whose feature has landed, add its profile:

```bash
docker compose --profile web --profile deep-health up --wait
```

Tear down, removing volumes:

```bash
docker compose down -v --remove-orphans
```

## The rendered-tree contract (`pulse-cli`)

stack-core mounts subtrees of `${PULSE_RENDERED_DIR}` read-only into the services that consume
them. As the renderer, you own the *content* of these files; stack-core owns *where they mount*:

| You render | Mounted into | As |
|------------|--------------|----|
| `scrape/file_sd/*.json` | `victoriametrics` | `/rendered/scrape/file_sd` (Prometheus `file_sd`) |
| `gatus/config.yaml` | `gatus` | `/config/10-endpoints.yaml` (merged with stack-core's Gatus config) |
| `alertmanager/routing.yaml` | `alertmanager` | `/rendered/alertmanager/routing.yaml` (slot only) |
| `prober/config.yaml` | `prober` | `/rendered/prober/config.yaml` (slot only, deferred) |

Two contract points to hold:

- **The rendered root carries a `.rendered-manifest.json`** with `formatVersion` and a sorted
  `files[]` list. stack-core preflights `formatVersion === 1` before starting any container — a
  bump fails loud. Keep it in step with `EXPECTED_RENDER_FORMAT_VERSION`.
- **Scrape targets for API classes are the estate's API endpoints**, not the exporter. The
  engine's relabel-through rewrites the scrape to hit the exporter and passes your target as
  `?target=`. Render the real endpoint; do not pre-point it at `pve-exporter`.

### Gatus `alerts:` bindings (issue #15)

The Gatus→Alertmanager provider is defined in `stack/gatus/alerting-provider.yaml`, and Gatus
fires it for endpoints that declare an `alerts:` block. A service declares that binding in the
estate (`services[].alerts: [{ type: custom, ... }]`), and the renderer emits it onto the
service's ingress endpoint as `endpoints[].alerts[]` — so paging is on for any service that binds
it. The binding is inert (and warns, `inert_alert_binding`) on a service that renders no endpoint
(no `ingress_url` / suppressed). No stack-core edit is needed.

## Filling a reserved slot

stack-core leaves mount points and inert config paths for downstream features. Each is wired in
the compose tree today; you add content into a reserved directory, and the engine picks it up
with no compose edit.

### `alerting` — the vmalert rule library and real routing

- Drop rule files (`*.yml`) into the vmalert rules mount so vmalert evaluates them. An empty rules
  directory means zero rules, which is healthy — the bootstrap boots green with no library.
- Transform the rendered abstract `alertmanager/routing.yaml` (the `{name, config}` receiver
  shape) into a **native** Alertmanager config that supersedes `alertmanager.bootstrap.yml`.
  Native AM rejects the abstract `config:` wrapper, which is exactly why the bootstrap exists.
- Own the `DeadMansSwitch` expression (the bootstrap provides only the routing *slot* and a
  placeholder receiver) and the severity framework.

### `dashboards` — Grafana content

- stack-core provisions **only** the VictoriaMetrics datasource. Add your folder taxonomy and
  dashboard JSON into the same `/etc/grafana/provisioning` tree stack-core mounts (via the
  reserved `stack/grafana/` mount point). Build panels against the `VictoriaMetrics` datasource,
  which is the default — panels with no explicit datasource resolve to it.

### `web-app` — the web UI slot

- The `web` service is a `build: ../../apps/web` slot gated behind the `web` profile. Provide the
  build context; the engine injects `PULSE_VM_URL`, `PULSE_ALERTMANAGER_URL`, and
  `PULSE_GATUS_URL` (the `ENGINE_API_URLS`) and expects an HTTP `GET /` health endpoint on the
  service's listen port.

### `host-agent` — the deferred prober slot

- The `prober` service (`deep-health` profile) is wired with a rendered-config mount but has no
  image yet; its mechanism is settled jointly with `host-agent`. Pin an image and add a
  healthcheck when the mechanism lands.

## Querying the engine from a sidecar

To reach the engine from a one-shot container (a probe, a migration, a test), join the network
`${COMPOSE_PROJECT}_${COMPOSE_NETWORK}` (`pulse_pulse`) and address services by their
`engine-apis` name:

```bash
docker run --rm --network pulse_pulse curlimages/curl:8.11.1 \
  -sf 'http://victoriametrics:8428/api/v1/query?query=up'
```

This is the pattern the smoke tier itself uses for its functional probes (`vm-self-scrape`,
`grafana-datasource`, `gatus-config-loaded`, `alertmanager-booted`).

## What you can rely on

Because the engine boots green from a fixture with no estate and no secrets, these invariants
hold and you build against them:

- **The default profile is always the green bar** — seven services, all healthy, no optional
  image required.
- **Every rendered mount is read-only** — the engine never writes your rendered tree.
- **Every image is pinned to a concrete tag** — bring-ups are reproducible; no `:latest`.
- **No secret or estate literal ships in the committed tree** — a guard test enforces it.
- **In-stack addresses are stable** — `service:port` on the `pulse` network is the contract, not
  host-published ports (those are `deploy-toolkit`'s).

## What not to do

- **Don't point Alertmanager at the rendered `routing.yaml`.** It is the abstract shape AM
  rejects. AM boots off the native bootstrap; the rendered file is a slot for `alerting` to
  transform.
- **Don't put estate content in the committed tree.** Hosts, domains, credentials, and endpoints
  enter only through `${PULSE_RENDERED_DIR}` and `${VAR}` references. A literal in a shipped file
  fails the Tier-1 guard.
- **Don't edit the compose file to add downstream content.** The slots are wired; add content
  into the reserved directories and rendered tree instead.
- **Don't rely on the profile-gated slots under a default `up`.** `web` and `prober` are inert
  until you pass their profile *and* their owning feature has supplied an image. (A `nas-api`
  host needs no profile — it is a direct `node_exporter` scrape, issue #4.)
