# API Reference

stack-core has no runtime code API — it is a Docker Compose tree. Its "API" is the set of
stable **contracts** a deploy and downstream features build against: the service registry and
in-stack addresses, the environment-variable surface, the rendered-mount map, the profiles, the
health probes, and the TypeScript constants the verification harness exports.

Every value below is exported from `stack/tests/harness.ts` (the harness is the single source of
truth realizing these contracts) unless noted otherwise.

## Service registry

### `COMPOSE_PROJECT` / `COMPOSE_NETWORK`

```typescript
export const COMPOSE_PROJECT = "pulse";   // fixed compose project name
export const COMPOSE_NETWORK = "pulse";   // the one user-defined bridge every service joins
```

Both are fixed for production. Docker smoke tests never use that project identity: they create a
unique `SmokeProjectName` with `createSmokeProjectName(scope)`, build guarded `-p` invocations via
`smokeComposeArgs(...)`, and derive the sidecar network with `composeNetworkName(project)`. Thus a
production network is `pulse_pulse`, while each smoke network is `<ephemeral-project>_pulse`.

### `DEFAULT_PROFILE_SERVICES`

The seven always-on services. A default `docker compose up` must bring all of them to healthy;
this is the green bar.

```typescript
export const DEFAULT_PROFILE_SERVICES = [
  "victoriametrics", "vmalert", "alertmanager",
  "gatus", "grafana", "cadvisor", "pve-exporter",
];
export type DefaultProfileService = (typeof DEFAULT_PROFILE_SERVICES)[number];
```

## `engine-apis` — in-stack addresses

The stable `service:port` addresses on the `pulse` network. These are the contract downstream
features query; they are **not** host-published ports (host publishing is `deploy-toolkit`'s).

```typescript
export const ENGINE_APIS = {
  victoriametrics: "victoriametrics:8428",  // TSDB + query API + scraper
  vmalert:         "vmalert:8880",          // rule evaluator
  alertmanager:    "alertmanager:9093",     // routing / silence / deadman brain
  gatus:           "gatus:8080",            // synthetic-check engine
  grafana:         "grafana:3000",          // dashboards UI
};
```

The URL form injected into the `web` slot's environment:

```typescript
export const ENGINE_API_URLS = {
  PULSE_VM_URL:           "http://victoriametrics:8428",
  PULSE_ALERTMANAGER_URL: "http://alertmanager:9093",
  PULSE_GATUS_URL:        "http://gatus:8080",
};
```

## Environment variables

Read from `stack/compose/.env` (copy `.env.example`; `.env` is git-ignored). Values are
resolved by Compose at deploy time; the tree carries only the reference tokens.

### stack-core-owned

| Variable | Default | Secret | Purpose |
|----------|---------|--------|---------|
| `PULSE_RENDERED_DIR` | `../rendered` | no | Path to the rendered estate tree, mounted read-only |
| `PULSE_VM_RETENTION` | `6` | no | VictoriaMetrics retention, in months |
| `PVE_TOKEN` | *(none)* | **yes** | Proxmox read-only API token value |
| `GF_ADMIN_USER` | `admin` | no | Grafana admin username — override for any non-local deploy |
| `GF_ADMIN_PASSWORD` | `admin` | **yes** | Grafana admin password — override for any non-local deploy |
| `PVE_USER` | `pulse@pve` | no | Proxmox auth identity (non-secret) |
| `PVE_TOKEN_NAME` | `pulse` | no | Proxmox token id (non-secret) |
| `PVE_VERIFY_SSL` | `false` | no | Whether pve-exporter verifies the PVE TLS cert |

`PVE_TOKEN` may appear **only** as a `${VAR}` reference — a guard test fails the build if it is
literal-assigned anywhere in the shipped tree. (There is no `NAS_TOKEN`/`NAS_EXPORTER_PORT`: a
`nas-api` host is a direct `node_exporter` scrape now — issue #4 — so the shipped tree carries no
NAS exporter or credential.)

### Estate-channel references (not read by any stack-core config)

Listed in `.env.example` only so the operator resolves them; they are consumed inside *rendered*
estate routing, not by the engine:

| Variable | Purpose |
|----------|---------|
| `OPSGENIE_WEBHOOK` | Opsgenie destination for rendered Alertmanager routing |
| `SLACK_TOKEN` | Slack destination for rendered Alertmanager routing |

## Rendered-mount map

### `RENDERED_MOUNTS`

Each entry is one read-only bind of a rendered subtree into a service. `source` is relative to
the rendered root (`${PULSE_RENDERED_DIR}`).

```typescript
export interface RenderedMount {
  source: string;         // e.g. "scrape/file_sd"
  containerPath: string;  // e.g. "/rendered/scrape/file_sd"
  consumer: DefaultProfileService | "prober";
  readOnly: true;         // always
}

export const RENDERED_MOUNTS: RenderedMount[] = [
  { source: "scrape/file_sd",           containerPath: "/rendered/scrape/file_sd",           consumer: "victoriametrics", readOnly: true },
  { source: "gatus/config.yaml",        containerPath: "/config/10-endpoints.yaml",          consumer: "gatus",           readOnly: true },
  { source: "alertmanager/routing.yaml", containerPath: "/rendered/alertmanager/routing.yaml", consumer: "alertmanager",  readOnly: true }, // slot only — AM does not read it
  { source: "prober/config.yaml",       containerPath: "/rendered/prober/config.yaml",       consumer: "prober",          readOnly: true }, // slot only — deferred
];
```

The Tier-1 test asserts every one of these container paths is a `:ro` bind on its consumer.

## Profiles

### `StackProfile` / `PROFILE`

The Compose profiles that gate optional services out of the default `compose up`.

```typescript
export type StackProfile = "web" | "deep-health";

export const PROFILE = {
  web:        "web",          // gates the web-app UI slot
  deepHealth: "deep-health",  // gates the deferred prober slot
};
```

| Profile | Gated service | Enabled with |
|---------|---------------|--------------|
| `web` | `web` | `docker compose --profile web up` |
| `deep-health` | `prober` | `docker compose --profile deep-health up` |

There is no `nas` profile: a `nas-api` host is scraped as a direct `node_exporter` target
(issue #4), so it needs no gated exporter service.

## Health probes and budget

### `HEALTHCHECK_BUDGET`

The uniform budget every default-profile healthcheck uses:

```typescript
export const HEALTHCHECK_BUDGET = {
  interval:    "10s",
  timeout:     "5s",
  retries:     6,
  startPeriod: "30s",
};
```

### `HEALTH_PROBES`

The health endpoint each default-profile service exposes (200-expecting HTTP GET):

```typescript
export const HEALTH_PROBES = {
  victoriametrics: "GET /health on :8428",
  vmalert:         "GET /health on :8880",
  alertmanager:    "GET /-/healthy on :9093",
  gatus:           "GET /health on :8080",      // asserted out-of-band; see below
  grafana:         "GET /api/health on :3000",
  cadvisor:        "GET /healthz on :8080",
  "pve-exporter":  "GET /metrics reachable on :9221",
};
```

Gatus has no *container* healthcheck (its image ships no shell/wget/curl); its readiness is
asserted by the smoke tier's in-stack HTTP probe instead.

## Secret-reference conventions

```typescript
export type SecretRef = `${string}`;                    // a "${VARNAME}" token
export const CREDENTIAL_LABEL = "__pulse_credential__"; // meta-label carrying the credential ref
export const EXPORTER_TOKEN_ENV = {
  "pve-exporter": "PVE_TOKEN",
  // no nas-exporter: nas-api is a direct node_exporter scrape (issue #4)
};
```

`__`-prefixed meta-labels (including `__pulse_credential__`) are dropped by VictoriaMetrics
post-relabel — the real token reaches the exporter via its environment, never the scrape config.

## Rendered-tree input contracts

Mirror types of the on-disk shapes `pulse-cli` emits, which stack-core consumes. These are
*mirror* definitions (the harness imports no `@pulse/*` package); the renderer is the source of
truth.

### `RenderedManifest`

```typescript
export interface RenderedManifest {
  formatVersion: number;  // MUST equal EXPECTED_RENDER_FORMAT_VERSION
  files: string[];        // code-point-sorted relative paths of every rendered file
}

export const EXPECTED_RENDER_FORMAT_VERSION = 1;
```

The smoke tier preflights `formatVersion === EXPECTED_RENDER_FORMAT_VERSION` **before** starting
any container — a format drift fails loud and cheap.

### `FileSdEntry` / `CollectionClass`

```typescript
export interface FileSdEntry {
  targets: string[];               // "host:port" or "scheme://host:port"
  labels: Record<string, string>;  // "__"-prefixed labels are meta, dropped post-relabel
}

export type CollectionClass =
  | "managed-linux"   // direct node_exporter scrape; auxiliary exporters use split jobs
  | "hypervisor-api"  // relabel-through pve-exporter
  | "nas-api"         // direct node_exporter scrape (issue #4; opt-in API-exporter override)
  | "probe-only";     // NOT wired to a VM job in v1 — Gatus/prober cover it
```

### `AmReceiver` / `AmRoutingRendered`

The abstract routing shape `pulse-cli` emits — the one native Alertmanager rejects, mounted as a
slot for `alerting` to transform:

```typescript
export interface AmReceiver {
  name: string;
  config: Record<string, unknown>;  // opaque provider config — NOT native AM top-level
}
export interface AmRoutingRendered {
  receivers: AmReceiver[];
  route: Record<string, unknown>;
}
```

## Test-harness helpers

### Path constants

```typescript
export const REPO_ROOT;            // resolved from stack/tests → up two
export const COMPOSE_FILE;         // stack/compose/docker-compose.yml
export const FIXTURE_RENDERED_DIR; // stack/tests/fixtures/rendered
```

### `run(argv, env?): Ran`

Runs a command to completion, capturing streams. **Never throws** on a non-zero exit — the
caller inspects `exitCode`.

```typescript
export interface Ran { exitCode: number; stdout: string; stderr: string }

export function run(argv: string[], env?: Record<string, string>): Ran;
```

**Parameters:**
- `argv` (`string[]`) — Command and arguments (e.g. `["docker", "compose", "config"]`).
- `env` (`Record<string, string>`, optional) — Extra env, merged over `process.env`.

**Returns:** `Ran` — `{ exitCode, stdout, stderr }` with streams decoded to strings.

**Example:**

```typescript
import { run, COMPOSE_FILE, FIXTURE_ENV } from "./harness";

const parsed = run(
  ["docker", "compose", "-f", COMPOSE_FILE, "config", "--format", "json"],
  FIXTURE_ENV,
);
if (parsed.exitCode !== 0) throw new Error(parsed.stderr);
```

### `FIXTURE_ENV`

Placeholder environment so `docker compose config`/`up` can interpolate `${VAR}`s against the
seeded fixture. Never real secrets:

```typescript
export const FIXTURE_ENV = {
  PULSE_RENDERED_DIR: FIXTURE_RENDERED_DIR,
  PVE_TOKEN:          "placeholder-not-a-secret",
  PULSE_VM_RETENTION: "6",
};
```

## Verification commands

| Command | What it runs |
|---------|--------------|
| `bun run typecheck` | `tsc -b` — type-checks the harness and both test suites |
| `bun test` | Both tiers; the smoke tier self-skips with no Docker daemon |
| `bun run smoke` | Aggregate: `smoke:cli` then `smoke:stack` |
| `bun run smoke:stack` | The Docker bring-up smoke tier (`stack/tests/bringup.smoke.test.ts`) |
