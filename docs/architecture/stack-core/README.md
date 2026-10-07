# stack-core

`stack-core` is the deployable monitoring **engine** — the Docker Compose tree that runs
Pulse. It composes VictoriaMetrics, vmalert, Alertmanager, Gatus, Grafana, cAdvisor, and the
agentless API exporters into one `pulse`-named stack on a single bridge network, and ships the
estate-agnostic base configuration each service boots from.

The engine ships **no** host, domain, or credential literal. Every estate-specific fact enters
at deploy time through two seams and only those two: read-only bind mounts of a rendered
directory (`${PULSE_RENDERED_DIR}`) produced by `pulse-cli`, and `${VAR}` secret references
resolved from a git-ignored `.env`. A clean checkout brings the whole default profile up
**green** against a seeded fixture, with no real estate, no secrets, and nothing to fill in
first.

## Quick Start

Everything resolves from `stack/compose/`. Create your environment file from the committed
template:

```bash
cd stack/compose
cp .env.example .env          # .env is git-ignored — never commit it
```

Point `PULSE_RENDERED_DIR` at a rendered tree. To try the engine immediately, use the seeded
verification fixture that ships with the repo:

```bash
# from stack/compose/
PULSE_RENDERED_DIR=../tests/fixtures/rendered \
  docker compose up --wait --wait-timeout 180
```

`--wait` blocks until every default-profile service reports **healthy**. When it returns 0 the
engine is live:

| Service | In-stack address | What it serves |
|---------|------------------|----------------|
| VictoriaMetrics | `victoriametrics:8428` | Metrics TSDB, query API, built-in scraper |
| Grafana | `grafana:3000` | Dashboards UI (VictoriaMetrics datasource pre-provisioned) |
| Alertmanager | `alertmanager:9093` | The one routing / silence / deadman brain |
| Gatus | `gatus:8080` | Synthetic-check engine |

Tear it down, removing the named volumes:

```bash
docker compose down -v --remove-orphans
```

To bring up a profile-gated slot (once its owning feature has landed an image), add
`--profile`:

```bash
docker compose --profile web up --wait      # also starts the web UI
```

## Key Concepts

**The engine is estate-agnostic by construction.** The committed tree encodes *structure* —
which services run, how they wire together, what each checks — never *whose* estate it
monitors. A single deploy-time input (`${PULSE_RENDERED_DIR}`) plus a handful of `${VAR}`
references specialize it. This is what lets the same compose file boot green from a fictional
fixture and run a real estate unchanged.

**Rendered data arrives read-only.** `pulse-cli` renders an estate description into a
directory tree — scrape targets, Gatus endpoints, abstract Alertmanager routing. stack-core
mounts subtrees of it into the services that consume them, always `:ro`. The engine never
writes to the rendered tree and never re-parses raw estate YAML; it consumes exactly the files
`pulse-cli` emits.

**Secrets are references, never values.** Credentials appear only as `${VAR}` tokens in the
compose file and are resolved from `.env` at deploy time. No secret material lives in the
committed tree. A repo-side guard fails the build if an enumerated credential pattern ever
appears in a shipped file.

**The default profile is the green bar.** Seven services run under a plain `compose up` — the
`DEFAULT_PROFILE_SERVICES`. Two more (`web`, `prober`) are gated behind Compose profiles and
stay inert until their owning feature supplies an image. (A `nas-api` host needs no gated
service — it is a direct `node_exporter` scrape, issue #4.) "Healthy" means: every
default-profile service passes its healthcheck.

**stack-core owns the engine, not the estate content.** It provides the running services and
the base config that boots them green. It deliberately leaves **slots** — empty mount points
and inert config paths — for downstream features (`alerting`, `dashboards`, `web-app`) to fill.
Those slots are wired now; their content lands later without touching the compose tree.

## Package Contents

stack-core is a config tree, not a code package. Its surface is the directory layout under
`stack/`:

| Path | What it holds |
|------|---------------|
| `stack/compose/docker-compose.yml` | The full engine: 9 service definitions, networks, volumes |
| `stack/compose/.env.example` | Every `${VAR}` the tree references, with non-secret placeholders |
| `stack/compose/config/victoriametrics/scrape.yml` | VictoriaMetrics scrape config (estate targets + self-observability) |
| `stack/compose/config/alertmanager/alertmanager.bootstrap.yml` | Native Alertmanager bootstrap (boots green, silent) |
| `stack/compose/config/grafana/provisioning/datasources/` | The VictoriaMetrics datasource provisioning |
| `stack/gatus/alerting-provider.yaml` | Static Gatus config: `metrics: true` (no alerting provider — Gatus checks page via vmalert, issue #1) |
| `stack/tests/` | The two-tier verification harness + the seeded rendered fixture |
| `stack/alerting/`, `stack/grafana/` | **Reserved** mount points owned by downstream features |

## Configuration

All configuration is environment variables read from `stack/compose/.env` (copied from
`.env.example`). The engine-owned keys:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PULSE_RENDERED_DIR` | `../rendered` | Path to the rendered estate tree, mounted read-only |
| `PULSE_VM_RETENTION` | `6` | VictoriaMetrics retention, in months |
| `PVE_TOKEN` | *(none)* | Read-only Proxmox API token value (secret) |
| `GF_ADMIN_USER` / `GF_ADMIN_PASSWORD` | `admin` / `admin` | Grafana admin bootstrap — override for any non-local deploy |

See [API Reference](./api-reference.md#environment-variables) for the complete list, including
the exporter-identity and estate-channel keys.

## Further Reading

- [Architecture](./architecture.md) — The composition, the rendered-tree data flow, and the ownership boundaries
- [API Reference](./api-reference.md) — Service registry, environment variables, mount map, profiles, and the test harness exports
- [Integration Guide](./guides/integration.md) — How downstream features plug into stack-core's slots
