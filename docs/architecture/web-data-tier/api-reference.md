# API Reference

The web data tier has two public surfaces:

- the **HTTP routes** served by `@pulse/web` on port 8080;
- the **`@pulse/web-data` package** subpath exports.

Every package type below is exported with a JSDoc on each member. The source files under `packages/web-data/src/` are the authoritative definitions.

## HTTP Routes

Every route is `GET`. Any other method returns 405 `METHOD_NOT_ALLOWED`, and no body is read. An unknown `/api/*` path returns JSON 404 `API_NOT_FOUND`, never the SPA shell.

| Path | Body | Caching |
|---|---|---|
| `/api/overview` | `OverviewSnapshotV2` | cycle representation |
| `/api/alerts` | `AlertsPayload` | cycle representation |
| `/api/estate` | `EstatePayload` | cycle representation |
| `/api/engine` | `EnginePayload` | cycle representation |
| `/api/timeline` | `TimelinePayload` | cycle representation |
| `/api/session` | `SessionPayload` | `private, no-store` |
| `/api/events` | `text/event-stream` | `no-cache` |
| `/api/history/estate/:queryId` | `HistoryPayload` | `private, no-cache` |
| `/api/history/target/:drilldownId/:queryId` | `HistoryPayload` | `private, no-cache` |
| `/api/history/alerts` | `IntervalHistoryPayload` | `private, no-cache` |
| `/api/history/checks/:endpoint` | `EndpointHistoryPayload` | `private, no-cache` |
| `/healthz` | health body | none |
| `/metrics` | Prometheus text | none |

Every failure body is an `ErrorEnvelope`: `{ code, message, details? }`. `message` is the exact `ERROR_MESSAGES[code]` text.

### Path parameters

Each parameter is decoded exactly once. It must be non-empty, control-free, and at most 512 UTF-8 bytes. A `/` after decoding is rejected, **except** for these two parameters, which accept a percent-encoded slash (`%2F`):

| Parameter | Example raw path |
|---|---|
| `:drilldownId` on `/api/history/target/…` | `/api/history/target/svc%3Aweb%2Fapp/service.deep-health` |
| `:endpoint` on `/api/history/checks/…` | `/api/history/checks/web%2Fapp`, `/api/history/checks/dns%3Astatus.example.com` |

An opted-in value is still rejected (400 `INVALID_REQUEST`) if it starts or ends with `/`, contains `//`, has a `/`-separated piece equal to `.` or `..`, or contains `\`. Build these paths with `encodeURIComponent` on each segment.

### Current-view representations

`/api/overview`, `/api/alerts`, `/api/estate`, `/api/engine`, and `/api/timeline` serve the retained bytes of one published cycle:

- `ETag`: a strong tag. Plain and gzip representations have distinct tags.
- `If-None-Match`: a match returns a bodyless 304 with the same headers.
- `Content-Encoding: gzip` when the request accepts it.
- `x-pulse-observation`: base64url-encoded `CycleObservation`, at most 8 KiB.
- `x-pulse-payload-id`: the view's semantic `HashId`.
- 503 `NOT_READY` before the first cycle is published.
- In estate-bundle error mode, these routes return 503 with the bundle error code. No stale cycle is served.

These routes accept no query keys.

### History routes

History routes accept one optional query key, `range` (`1h`, `6h`, `24h`, `7d`). Any other key, a repeated key, or a query longer than 2 KiB is 400 `INVALID_REQUEST`. When `range` is absent, the default is the catalog default for the query, `alerts.firing`'s default for `/api/history/alerts`, and `24h` for checks.

| Code | Status | Meaning |
|---|---|---|
| `INVALID_REQUEST` | 400 | Malformed id, range, or query string |
| `QUERY_NOT_FOUND` | 404 | Unknown catalog id |
| `TARGET_NOT_FOUND` | 404 | Unknown drilldown id or unresolvable endpoint name |
| `QUERY_NOT_APPLICABLE` | 422 | The query does not apply to that target |
| `RANGE_UNSUPPORTED` | 422 | The range exceeds the query's `maxRange` |
| `HISTORY_OVERLOADED` | 503 | Queue full. Carries `Retry-After: 1`. |
| `MODEL_CHANGED` | 503 | The rendered estate changed mid-request |
| `HISTORY_CANCELLED` | 503 | The service was closed or the waiter was cancelled |
| `SOURCE_UNAVAILABLE` | 502 | Upstream failed, or no model is loaded |
| `HISTORY_LIMIT_EXCEEDED` | 502 | A size bound was crossed; nothing is truncated |
| `SOURCE_TIMEOUT` | 504 | The 5-second deadline passed |

`/api/history/checks/:endpoint` resolves `:endpoint` as a **pulse endpoint name**:

- a name declared by exactly one service (this rule wins, even for `dns:`-prefixed names); or
- `dns:<domain>` for a domain in the estate's `domains` list.

Anything else is `TARGET_NOT_FOUND`. The names that resolve are exactly those in `TimelinePayload.checkHistory.endpoints`.

### `/api/events`

Server-Sent Events. The stream sends `retry: 10000` on connect, a `: heartbeat` comment every 5 seconds, and one `tick` event per published cycle. Each event's `id` is `<generation>:<seq>`. Its `data` is a `LiveTick`. Send `Last-Event-ID` on reconnect to skip a redundant current tick.

## Wire Types (`@pulse/web-data/wire`)

### `TimelinePayload`

```ts
interface TimelineTarget {
  readonly target: TargetIdentity;          // exact drilldown id or endpoint name
  readonly name: string;                    // host name, "<host>/<service>", or endpoint name
  readonly queryIds: readonly QueryId[];    // applicable catalog ids, catalog order
  readonly ranges: readonly RangeId[];      // union of accepted ranges, ascending
  readonly parent: TargetIdentity | null;   // host → null; service → its host (or null); endpoint → its service
}

interface TimelineDomain {
  readonly domain: string;                  // a model.estate.domains entry
  readonly endpoint: string;                // exactly `dns:<domain>`
}

interface TimelinePayload {
  readonly generatedAt: string;
  readonly targets: readonly TimelineTarget[];   // host < service < endpoint, then id
  readonly alertHistory: { readonly ranges: readonly RangeId[]; readonly provenance: "vmalert" };
  readonly checkHistory: {
    readonly endpoints: readonly string[];       // single-owner service endpoints + domain endpoints, ascending
    readonly provenance: "gatus";
  };
  readonly domains: readonly TimelineDomain[];   // model order, deduplicated, first wins
}
```

`parent` and `domains` are required fields. A hand-built fixture must set both.

```jsonc
{
  "targets": [
    { "target": { "kind": "service", "id": "svc:web/app" }, "name": "web/app",
      "queryIds": ["estate.liveness", "service.deep-health"], "ranges": ["1h", "6h", "24h"],
      "parent": { "kind": "host", "id": "host:web" } },
    { "target": { "kind": "endpoint", "id": "web/app" }, "name": "web/app",
      "queryIds": ["endpoint.check.latency"], "ranges": ["1h", "6h", "24h"],
      "parent": { "kind": "service", "id": "svc:web/app" } }
  ],
  "checkHistory": { "endpoints": ["dns:status.example.com", "web/app"], "provenance": "gatus" },
  "domains": [{ "domain": "status.example.com", "endpoint": "dns:status.example.com" }]
}
```

### History payloads

```ts
type TargetIdentity =
  | { kind: "host"; id: string }       // host drilldown id
  | { kind: "service"; id: string }    // service drilldown id, e.g. "svc:web/app"
  | { kind: "endpoint"; id: string };  // pulse Gatus endpoint name, e.g. "web/app"

interface HistoryPayload {
  queryId: QueryId; target: TargetIdentity | null; range: RangeId; fetchedAt: string;
  effectiveStepSeconds: number; unit: Unit; stale: boolean;
  series: readonly { labels: Record<string, string>; points: readonly [number, number | null][] }[];
}

interface IntervalHistoryPayload {
  operation: "alert-intervals"; target: TargetIdentity | null; range: RangeId; fetchedAt: string;
  effectiveStepSeconds: number; unit: "state"; stale: boolean;
  lanes: readonly AlertHistoryLane[];  // keyed by (alertname, severity, host, service, instance)
}

interface EndpointHistoryPayload {
  operation: "endpoint-history";
  endpoint: string;                     // the pulse endpoint name, never the Gatus key
  target: TargetIdentity | null;        // { kind: "endpoint", id: endpoint }
  range: RangeId; fetchedAt: string;
  effectiveStepSeconds: number | null;  // median observed gap, or null
  unit: "milliseconds"; stale: boolean; provenance: "gatus";
  results: readonly { timestamp: string; success: boolean; durationMs: number | null }[];
  incidents: readonly StatusInterval[]; // coalesced failures, state "failed"
}
```

A `null` point value is an explicit gap. It is never zero. `results` holds every result Gatus retains (at most 100) whatever `range` is requested.

### Other payloads

| Type | Route | Summary |
|---|---|---|
| `OverviewSnapshotV2` | `/api/overview` | Hosts with nested services, alerts, signals, checks, engine summary, coverage. `grafana` is `{ boardUid, url } \| null`, and `url` is `""` when no Grafana origin is configured. |
| `AlertsPayload` | `/api/alerts` | `ActiveAlert[]`, `RuleState[]`, `ActiveSilence[]`, each group with its own `AvailabilitySection` |
| `EstatePayload` | `/api/estate` | Rendered model, `EstateTargetState[]`, coverage and findings, declared-versus-scraped |
| `EnginePayload` | `/api/engine` | Six `EngineComponent`s, scrape jobs, rule groups, notifications, capacity, cycle health, deadman |
| `SessionPayload` | `/api/session` | `identity: Identity \| null`, `authMode: "none" \| "proxy-header"`, `capabilities: { silence: false; ack: false; proposeEstateEdit: false }` |
| `LiveTick` | `/api/events` | `{ observation: CycleObservation; identities: Record<ViewId, HashId> }` |

### Runtime validators

Each validator takes `unknown` and returns a fresh typed value (or a result object). It never throws and never echoes input:

| Function | Returns |
|---|---|
| `validateLiveTick(input)` | `LiveTick \| null` |
| `validateCycleObservation(input)` | `CycleObservation \| null` |
| `validateSourceObservation(input)` | `SourceObservation \| null` |
| `validateHashId(input)` | `HashId \| null` |
| `validateOverviewSnapshotV2(input)` | `{ ok: true; value } \| { ok: false; message }`. Accepts a Grafana link whose `url` is `""`. |

### Error catalogs

- `ERROR_MESSAGES: Record<ApiErrorCode, string>`: exact text for every API error.
- `SOURCE_ERROR_MESSAGES: Record<SourceErrorKind, string>`: exact text for `timeout`, `transport`, `upstream-status`, `malformed-json`, `invalid-shape`, `incompatible`, `overflow`, and `disabled`.

## Sources (`@pulse/web-data/sources`)

Every factory validates its base URL: it must be an absolute HTTP(S) URL with no credentials, or the factory throws. Every method resolves a `SourceResult<T>` (`{ ok: true, data } | { ok: false, error: { kind, message, status } }`) and never rejects. `options` accepts `fetchImpl`, `timeoutMs`, and `now` for tests.

| Factory | Operations |
|---|---|
| `createVmClient(baseUrl, options?)` | `statusSignals()`, `targets()`, `buildInfo()`, `queryRange(request, { signal })` |
| `createAlertmanagerClient(baseUrl, options?)` | `alerts()`, `silences()`, `status()`, `receivers()` |
| `createAlertmanagerWriteClient(baseUrl, options?)` | `createSilence(request)`, `expireSilence(id)`. Dark in M1. |
| `createVmalertClient(baseUrl, options?)` | `rules()` |
| `createGatusClient(baseUrl, options?)` | `endpointStatuses(expected)`, `endpointHistory(key, { signal })` |
| `createGrafanaClient(baseUrl, options?)` | `health()` |
| `resolveGrafanaClient(url \| null, options?)` | `GrafanaClient \| null`. Returns `null` when the URL is unset or blank. |

### `gatusEndpointKey(group: string, name: string): string`

Derives the composite key Gatus 5.13.1 uses in `/api/v1/endpoints/{key}/statuses` and in its `key` metric label. It computes `sanitize(group) + "_" + sanitize(name)`, where `sanitize` lowercases and trims, then replaces each of `/ _ . , # + &` and space with `-`.

```ts
gatusEndpointKey("web", "web/app");              // "web_web-app"
gatusEndpointKey("", "dns:status.example.com");     // "_dns:status-example-com"
```

A service endpoint's group is its service's `host`. A domain endpoint's group is `""`.

### `GatusClient.endpointHistory(key, options?)`

Pass the **composite key**, not the pulse name. The client issues one cancellable `GET /api/v1/endpoints/<key>/statuses?page=1&pageSize=100` (`GATUS_HISTORY_PAGE_SIZE = 100`). The key is path-encoded with `encodeURIComponent`, but `:` is kept literal because Gatus 5.13.1 does not decode `%3A`. An empty, over-512-byte, or control-bearing key resolves as `invalid-shape` without a request.

### `GatusClient.endpointStatuses(expected)`

Issues one `page=1&pageSize=512` request. It returns every endpoint's `name`, `group`, `key`, `expected` flag, and results. The whole call fails as `overflow` on a saturated page, more than 511 expected names, a missing expected name, or a duplicate name or key.

## Queries (`@pulse/web-data/queries`)

| Export | Description |
|---|---|
| `QUERY_CATALOG` | `Record<QueryId, CuratedQueryDefinition>`: `targetKind`, `unit`, `defaultRange`, `maxRange`, `preferredStepSeconds` |
| `QUERY_IDS`, `isQueryId(value)` | Catalog ids in frozen order, and a narrowing guard |
| `queryIdsForTargetKind(kind)` | Ids for a target kind. `estate.liveness` also applies to hosts and services. |
| `RANGE_SECONDS`, `RANGE_IDS` | `1h`=3600, `6h`=21600, `24h`=86400, `7d`=604800 |
| `effectiveStepSeconds(rangeSeconds, preferred)` | `max(preferred, ceil(rangeSeconds / 598))` |
| `acceptedRangesForQuery(definition)` | Ranges no longer than `maxRange`, ascending |
| `parseRange(value, definition)` | Resolves a range and its step, or `INVALID_REQUEST` / `RANGE_UNSUPPORTED` |
| `bindCuratedQuery(queryId, target, range, model)` | `QueryBindResult`: a `BoundQuery` with server-authored `promql`, or a closed failure |
| `escapePrometheusLabelValue(value)` | Escapes backslash, newline, and double quote only |

| Query id | Target | Unit | Default / max range |
|---|---|---|---|
| `estate.liveness` | estate, host, service | state | 1h / 24h |
| `alerts.firing` | estate | state | 6h / 7d |
| `host.cpu.utilization` | host | percent | 1h / 7d |
| `host.memory.utilization` | host | percent | 1h / 7d |
| `host.disk.utilization` | host | percent | 6h / 7d |
| `host.load.1m` | host | scalar | 1h / 24h |
| `endpoint.check.latency` | endpoint | milliseconds | 1h / 24h |
| `service.deep-health` | service | scalar | 1h / 24h |
| `service.backup-age` | service | seconds | 6h / 7d |
| `engine.ingestion-rate` | estate | count | 1h / 24h |
| `engine.active-series` | estate | count | 6h / 7d |
| `engine.disk-usage` | estate | bytes | 6h / 7d |
| `engine.notification-failures` | estate | count | 6h / 7d |
| `engine.notification-latency` | estate | seconds | 6h / 7d |

`endpoint.check.latency` binds to `1000 * avg(gatus_results_duration_seconds{name="<endpoint name>"})`. It selects by Gatus's `name` label, which holds the pulse name, not by `key`. It applies only to service endpoint targets.

## History (`@pulse/web-data/history`)

### `createHistoryService(options: HistoryServiceOptions): HistoryService`

```ts
interface HistoryServiceOptions {
  vm: VmClient;
  gatus: GatusClient;
  model: () => WebEstateModelV2 | null;   // null → SOURCE_UNAVAILABLE
  now?: () => number;                     // test clock
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

interface HistoryService {
  query(r: { queryId: QueryId; target: TargetIdentity | null; range: RangeId; signal?: AbortSignal }):
    Promise<HistoryResult<HistoryPayload>>;
  alertIntervals(r: { range: RangeId; target: TargetIdentity | null; signal?: AbortSignal }):
    Promise<HistoryResult<IntervalHistoryPayload>>;
  endpointHistory(r: { endpoint: string; range: RangeId; signal?: AbortSignal }):
    Promise<HistoryResult<EndpointHistoryPayload>>;
  stats(): HistoryStats;       // active, queued, inFlightKeys, cachedKeys, cachedBytes, waiters
  invalidateModel(): void;     // new model generation; clears cache; outstanding → MODEL_CHANGED
  close(): void;               // idempotent; later calls → HISTORY_CANCELLED
}

type HistoryResult<T> =
  | { ok: true; data: T; delivery: "hit" | "miss" | "coalesced" }
  | { ok: false; error: { code; message; retryAfterSeconds: number | null } };
```

Expected failures never reject. `endpointHistory` takes the **pulse endpoint name**. It resolves the Gatus group from the model, derives the composite key internally, and returns `TARGET_NOT_FOUND` for an unknown or ambiguous name.

Also exported: `normalizeHistorySeries`, `buildAlertIntervals`, `buildEndpointHistory`, the pure normalizers the service composes.

## Cycle (`@pulse/web-data/cycle`)

| Export | Description |
|---|---|
| `foldOverview`, `foldAlerts`, `foldEstate`, `foldEngine`, `foldTimeline` | Pure folds: `(inputs: FoldInputs) => payload` |
| `foldCurrentViews(inputs)` | Runs all five folds and returns `CurrentViewValues` |
| `materializeCycle(previous, observation, records, values)` | Reuse-or-rebuild per view, assembling `CycleState` |
| `buildCycleCandidate(prior, observation, inputs)` | `CycleBuildResult`. The only expected outcome at the app seam; fold exceptions become `kind: "fold"`. |
| `materializeView(...)` | Per-view identity decision |
| `canonicalJson(value)`, `sha256Id(bytes)`, `deterministicGzip(bytes)` | Deterministic encoding and identity. `canonicalJson` throws `CanonicalJsonError` on non-round-trippable input. |
| `CycleSourceRecords`, `FoldInputs`, `SourceRecord`, record helpers | Keyed fold inputs and the current / stale / unavailable truth table |

## Identity and Audit

| Export | Description |
|---|---|
| `parseIdentityConfig(input)` (`/identity`) | Validates mode, header name, and trusted CIDRs. Deny-by-default. |
| `resolveIdentity(request, peerIp, config)` (`/identity`) | `Identity \| null` (`{ subject, displayName, source: "proxy-header" }`) |
| `createJsonlAuditWriter(options)` (`/audit`) | Append-only JSONL writer that requires an absolute path. Each `append` is fsync'd before `{ ok: true }`. |

## Limits

All limits are exported from `@pulse/web-data/wire`:

| Constant | Value |
|---|---|
| `CORE_CADENCE_MS` / `SLOW_CADENCE_MS` | 10,000 / 60,000 |
| `SOURCE_TIMEOUT_MS` | 5,000 |
| `SOURCE_MAX_BODY_BYTES` | 32 MiB |
| `SOURCE_MAX_NAME_BYTES` | 512 |
| `GATUS_STATUS_PAGE_SIZE` / `GATUS_MAX_ENDPOINTS` | 512 / 511 |
| `SSE_HEARTBEAT_MS` / `SSE_MAX_STREAMS` | 5,000 / 64 |
| `HISTORY_TTL_MS` / `HISTORY_DEADLINE_MS` | 60,000 / 5,000 |
| `HISTORY_MAX_ACTIVE` / `HISTORY_MAX_QUEUED` | 4 / 32 |
| `HISTORY_MAX_POINTS` / `HISTORY_MAX_SERIES` | 600 / 1,024 |
| `HISTORY_MAX_BODY_BYTES` | 32 MiB |
| `HISTORY_MAX_CACHE_ENTRIES` / `HISTORY_MAX_CACHE_BYTES` | 64 / 64 MiB |
| `HISTORY_MAX_LABELS` / `…_LABEL_KEY_BYTES` / `…_LABEL_VALUE_BYTES` | 32 / 128 / 256 |
| `HISTORY_MAX_WAITERS_PER_KEY` / `…_GLOBAL` | 64 / 256 |
| `CURRENT_MAX_PLAIN_BYTES` / `CURRENT_MAX_GZIP_BYTES` | 5 MiB / 1 MiB |
| `OBSERVATION_HEADER_MAX_BYTES` | 8 KiB |

`GATUS_HISTORY_PAGE_SIZE` (100) is exported from `@pulse/web-data/sources`.

## Server Seam (`apps/web/src/shared/registry.ts`)

This is app-private, not a package export:

```ts
interface RouteDefinition {
  method: "GET";
  path: string;                              // "/api/x/:a/:b"
  slashParams?: readonly string[];           // params that may carry a decoded "/"; each must be a :param of path
  handler(request: RouteRequest, ctx: ServerContext): Response | Promise<Response>;
}
```

Use `defineRoute({...})` to get typed `request.params`. `assertRegistry(routes)` throws `RouteCompileError` at startup for a malformed pattern, an ambiguous pair, or an unknown `slashParams` name.
