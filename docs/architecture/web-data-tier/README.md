# Web Data Tier

The web data tier turns the rendered estate bundle and the live monitoring engine into coherent, read-only, view-ready data for the Pulse web application. It acquires VictoriaMetrics, Alertmanager, vmalert, Gatus, and (optionally) Grafana on fixed cadences, folds each acquisition into five per-view payloads, publishes each cycle atomically, notifies browsers over Server-Sent Events when a payload materially changes, and answers a closed catalog of bounded history questions. A failed source is always reported as stale or unavailable. It is never presented as healthy.

The tier has two halves:

- **`@pulse/web-data`** (`packages/web-data/`) is a runtime-neutral workspace package. It holds the wire contracts, source clients, pure folds, curated query catalog, history service, trusted-identity resolution, and the audit writer.
- **The `@pulse/web` server** (`apps/web/src/server/`) owns the cycle scheduler, the HTTP routes, the SSE stream registry, configuration, and metrics. It composes the package.

Browser code imports only `@pulse/web-data/wire`, which has no runtime dependencies.

## Quick Start

Run the web application against the in-process mock engine:

```bash
bun install
bun run dev:web --mock
```

Or against a real engine. The four origins are VictoriaMetrics, Alertmanager, Gatus, and vmalert, in that order:

```bash
bun run dev:web --engine \
  http://localhost:8428,http://localhost:9093,http://localhost:8081,http://localhost:8880
```

Then read the data tier directly:

```bash
curl -s localhost:8080/api/timeline | jq '.domains, .checkHistory'
curl -s localhost:8080/api/history/estate/engine.active-series?range=6h | jq '.series | length'
# Ids containing "/" must be percent-encoded as %2F:
curl -s 'localhost:8080/api/history/checks/web%2Fapp?range=24h' | jq '.results | length'
curl -s 'localhost:8080/api/history/target/svc%3Aweb%2Fapp/service.deep-health' | jq .unit
curl -N localhost:8080/api/events          # SSE: retry, heartbeats, ticks
```

The mock engine serves only instant queries and the statuses page. Under `--mock`, history routes answer `SOURCE_UNAVAILABLE`.

In server code, use the package through its subpath exports:

```ts
import { createGatusClient, createVmClient } from "@pulse/web-data/sources";
import { createHistoryService } from "@pulse/web-data/history";

const history = createHistoryService({
  vm: createVmClient(process.env.PULSE_VM_URL!),
  gatus: createGatusClient(process.env.PULSE_GATUS_URL!),
  model: () => currentModel, // WebEstateModelV2 | null
});

const result = await history.endpointHistory({ endpoint: "web/app", range: "24h" });
if (result.ok) console.log(result.data.results.length, result.data.incidents);
else console.log(result.error.code); // e.g. TARGET_NOT_FOUND
```

## Key Concepts

### One cycle, five views

Every 10 seconds the server runs six core acquisitions. Every 60 seconds it also runs four slow ones (VM build info, Alertmanager status and receivers, Grafana health). It folds the captured records into five payloads: `overview`, `alerts`, `estate`, `engine`, and `timeline`. The folds are pure. A cycle is published with a single assignment, so a request never sees views from two different moments. Each view has a semantic identity (`sha256:…`) that ignores observation-only timestamps. If only timestamps changed, the prior bytes and ETags are reused.

### Never silently green

Each source record follows one truth table. A current success is `current`. A failure with a last-good value keeps that value but marks it `stale`. A failure with no last-good value is `unavailable`. A missing, NaN, or non-finite metric is `null`, never zero. Grafana, when unconfigured, is `not-configured` and makes no calls, which is distinct from a configured failure.

### Change notification, not push

`GET /api/events` streams `tick` events. Each tick carries only the cycle observation and the five view identities. A browser refetches a view only when that view's identity changed, and uses `If-None-Match` for a bodyless 304.

### Closed, curated history

History is a closed catalog of 14 query ids plus two non-curated operations (vmalert alert intervals and Gatus check history). A client sends a route and an optional `range` (`1h`, `6h`, `24h`, `7d`). It never sends PromQL, a window, or a step. The history service validates and binds a request before admitting it, serves from a 60-second cache, coalesces identical requests, runs at most 4 operations with 32 queued, and enforces a 5-second deadline. Any limit overflow fails the whole operation. It never truncates.

### Exact identities

Every target is addressed by its exact rendered identity: a host or service `drilldownId` (for example `svc:web/app`) or a pulse Gatus endpoint name (`web/app`, or `dns:<domain>` for an estate domain check). Service ids and endpoint names contain `/`. On the two history routes that take them (`/api/history/target/:drilldownId/…` and `/api/history/checks/:endpoint`) that slash must arrive percent-encoded as `%2F`. Every other route parameter rejects a slash.

### The pulse name is the wire identity; the Gatus key stays internal

Gatus 5.13.1 addresses per-endpoint history by a composite key, `sanitize(group) + "_" + sanitize(name)`, for example `web_web-app` or `_dns:status-example-com`. The data tier derives that key on the server with `gatusEndpointKey`. The wire, the cache, and error mapping all use the pulse name. The Gatus key never reaches the browser.

### Timeline index

`/api/timeline` is an index, not history. It lists each host, service, and endpoint target that has at least one applicable curated query, with a `parent` link (service → host, endpoint → service). It lists the estate's per-domain DNS checks in `domains[]`. It also lists every endpoint that check history can serve in `checkHistory.endpoints`.

### Dark mutation seams

`/api/session` reports the resolved identity and three capabilities (`silence`, `ack`, `proposeEstateEdit`), all literally `false` in M1. The trusted-proxy identity resolver, the JSONL audit writer, and the Alertmanager write client exist so M2 can add mutations. No M1 route calls them.

## Package Exports

| Export | Runtime | Contents |
|---|---|---|
| `@pulse/web-data` | any | Re-export of `wire/common` (ids, limits, error catalogs) |
| `@pulse/web-data/wire` | browser-safe | All wire payload types, error catalogs, and runtime validators (`validateLiveTick`, `validateCycleObservation`, `validateOverviewSnapshotV2`, …) |
| `@pulse/web-data/cycle` | server | Fold input records, the five folds, `buildCycleCandidate`, canonical JSON, SHA-256 identity, deterministic gzip |
| `@pulse/web-data/sources` | server | `createVmClient`, `createAlertmanagerClient`, `createAlertmanagerWriteClient`, `createVmalertClient`, `createGatusClient`, `gatusEndpointKey`, `createGrafanaClient`, `resolveGrafanaClient` |
| `@pulse/web-data/queries` | server | `QUERY_CATALOG`, range and step planning, `bindCuratedQuery` |
| `@pulse/web-data/history` | server | `createHistoryService` and its request/result contracts, normalizers |
| `@pulse/web-data/identity` | server | `parseIdentityConfig`, `resolveIdentity` |
| `@pulse/web-data/audit` | server | `createJsonlAuditWriter` |

The package builds to `dist/` with `tsc -b`, and consumers resolve the built output. `bun run dev:web` keeps it rebuilt in watch mode.

## Configuration

The server reads these environment variables:

| Variable | Required | Meaning |
|---|---|---|
| `PULSE_VM_URL` | yes | VictoriaMetrics origin |
| `PULSE_ALERTMANAGER_URL` | yes | Alertmanager origin |
| `PULSE_GATUS_URL` | yes | Gatus origin (pinned to 5.13.1 behavior) |
| `PULSE_VMALERT_URL` | yes | vmalert origin |
| `PULSE_WEB_ESTATE_MODEL` | yes | Path to the rendered `web-estate-model.json` |
| `PULSE_GRAFANA_URL` | no | Grafana origin. When absent, Grafana is `not-configured` and deep links are `""`. |
| `PULSE_ESTATE_TZ` | no | Display timezone |
| `PULSE_GATUS_STALE_SECONDS` | no | Gatus check freshness window (default 300) |
| `PULSE_WEB_AUTH_MODE` | no | `none` (default: identity is always null) or `proxy-header` |
| `PULSE_WEB_AUTH_HEADER` | no | Identity header name in proxy-header mode |
| `PULSE_WEB_TRUSTED_PROXIES` | no | CIDRs of peers allowed to assert the identity header |

The fixed limits are exported constants in `@pulse/web-data/wire`, for example `CORE_CADENCE_MS` (10 s), `SLOW_CADENCE_MS` (60 s), `SOURCE_TIMEOUT_MS` (5 s), `HISTORY_TTL_MS` (60 s), `HISTORY_MAX_ACTIVE` (4), `HISTORY_MAX_QUEUED` (32), `HISTORY_MAX_POINTS` (600), `GATUS_STATUS_PAGE_SIZE` (512), and `GATUS_MAX_ENDPOINTS` (511). The [API Reference](./api-reference.md#limits) lists them all.

A reverse proxy in front of the web app must forward `%2F` in request paths unchanged. Caddy does this by default. Otherwise service and endpoint history return 400.

## When to Use

- A view needs current estate, alert, engine, or timeline data: read it from the store the live-state machine fills from these routes.
- A view needs bounded history: call an `/api/history/*` route with a catalog id or an endpoint listed in the timeline index.
- Server code needs to talk to an engine component: use the typed `@pulse/web-data/sources` clients, which bound, validate, and never throw.
- Browser code needs a wire type or a runtime validator: import `@pulse/web-data/wire`.

## When Not to Use

- Arbitrary queries. There is no PromQL passthrough. Add a curated catalog entry instead.
- Gatus check results older than the retained window. Gatus 5.13.1 keeps at most 100 results per endpoint, about 100 minutes at a one-minute interval, whatever `range` is requested.
- Mutations. The write, identity, and audit seams are dark in M1, and `/api/session` capabilities are all `false`.
- Importing `@pulse/web-data` (root or server subpaths) from browser code. Use `/wire` only.
- Addressing Gatus by its composite key from a client. Clients always use the pulse endpoint name.

## Further Reading

- [Architecture](./architecture.md): cycle scheduler, folds, representations, SSE, history service, and design rationale
- [API Reference](./api-reference.md): HTTP routes, wire types, package functions, error codes, and limits
- [Integration Guide](./guides/integration.md): consuming the routes, adding a query or view, testing, and troubleshooting
- [Engine Health and Timeline](../engine-health-timeline/README.md): the main consumer of the timeline index and history routes
- [Web Foundation](../web-foundation/README.md): router, store, and live-state machine on the client
- [Web App](../web-app/README.md): the service container and its legacy overview surface
