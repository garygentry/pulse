# Host Agent

The host agent supplies per-host infrastructure metrics and central deep-health probing for Pulse.
It consists of:

- `node_exporter` on port 9100 for host metrics.
- Optional cAdvisor on port 8080 for container metrics.
- A heartbeat exporter on port 9110 for agent liveness and build information.
- One central prober on port 9120 for JSON deep-health endpoints.

All images and component versions are pinned in `agent/contract/constants.ts`. The public metric
contract is recorded in `agent/contract/metrics.json` and `agent/contract/metrics-contract.md`.

## Rendered configuration

The renderer writes one `rendered/agent/<host>.yaml` file for each managed Linux host. Its shape is
validated by `agent/contract/config.schema.json` and contains:

- `host`: the estate host name.
- `deliveryForm`: `compose` or `systemd`.
- `cadvisor`: whether the optional container exporter is installed.
- `scrapePorts`: node and heartbeat ports, plus cAdvisor only when enabled.

The central prober reads `rendered/prober/config.yaml`. The stack mounts the containing `prober/`
directory read-only at `/rendered/prober`; a missing file is valid and leaves the prober healthy but
idle. An unreadable, malformed, or structurally invalid file is a fatal startup error.

## Delivery forms

### Compose

`agent/compose/agent.fragment.yml` defines the per-host bundle. Set:

- `PULSE_RENDERED_DIR` to the rendered tree root.
- `PULSE_AGENT_HOST` to the host whose rendered config is mounted.
- `COMPOSE_PROFILES=cadvisor` only when that host's rendered config enables cAdvisor.

node_exporter and heartbeat are always present. Host-introspection mounts are read-only; cAdvisor is
the only privileged service.

### systemd

`agent/systemd/` contains three Podman-backed units. Install node_exporter and heartbeat on every
managed Linux host. Install cAdvisor only when the rendered host config enables it. Every host bind
is read-only, images are pinned, and each unit restarts on failure.

## Prober runtime

The central prober serves `GET /metrics` and `GET /healthz`; it exposes no write or control route.
It loads configuration once at startup and executes deep-health probes under bounded timeout and
worker-pool limits. These environment variables accept positive integer values:

| Variable | Unit | Default | Purpose |
|---|---:|---:|---|
| `PULSE_PROBE_TIMEOUT_MS` | milliseconds | 5000 | Timeout for one HTTP probe |
| `PULSE_PROBE_CADENCE_MS` | milliseconds | 30000 | Delay between probe cycles |
| `PULSE_PROBE_CONCURRENCY` | workers | 8 | Maximum simultaneous probes |

Unset values use their defaults. Zero, negative, fractional, or non-numeric values are fatal startup
configuration errors. Probe credentials use `${ENV_NAME}` references and are resolved only inside
the prober process; resolved values never enter rendered configuration or metric output.

## Image builds

Build the heartbeat image from the `agent/` context and provide a label-safe version token:

```sh
docker build agent -f agent/heartbeat/Dockerfile \
  --build-arg AGENT_VERSION=1.0.0 \
  -t pulse/agent-heartbeat:1.0.0
```

Build the central prober from the same context:

```sh
docker build agent -f agent/prober/Dockerfile -t pulse/prober:1.0.0
```

## Verification

Run the repository gates:

```sh
bun run typecheck
bun test
bun run smoke
```

`agent/tests/compose.config.test.ts` validates delivery structure without starting containers.
Docker-backed tests self-skip only when no Docker daemon is reachable; when available, they build
local development images and verify exporter and prober runtime behavior.
