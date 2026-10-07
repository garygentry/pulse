# Integration Guide

This guide covers consuming the web data tier from a view, extending it on the server, and testing and troubleshooting it. The data tier lives in `packages/web-data/` (the `@pulse/web-data` package) and `apps/web/src/server/`.

## Run It Locally

```bash
bun run dev:web --mock                       # in-process mock engine; history → SOURCE_UNAVAILABLE
bun run dev:web --mock degraded-mix          # degraded source scenarios
bun run dev:web --engine <vm>,<am>,<gatus>,<vmalert>
```

The dev loop rebuilds `@pulse/web-data` in watch mode. Outside the dev loop, run `bun run --cwd packages/web-data build` after changing the package, because consumers resolve its built `dist/`.

## Consuming Current Views

Views do not fetch current payloads themselves. The shell's live-state machine subscribes to `/api/events`, compares each tick's `identities` with the identity it last accepted, refetches only the changed views with `If-None-Match`, and writes them into the store. Read `store.<view>` in a view.

To consume the routes directly (a script, a test, or another client):

1. Open `GET /api/events`, then parse each `tick` with `validateLiveTick`.
2. For each view whose identity changed, `GET /api/<view>` with the prior `ETag` in `If-None-Match`.
3. A 304 means your copy is current. On a 200, check that `x-pulse-payload-id` equals the tick identity before accepting the body.
4. A 503 `NOT_READY` means no cycle has been published yet, so retry on the next tick.

## Requesting History

Build every path segment with `encodeURIComponent`. That is what makes slash-bearing ids work:

```ts
const url = (...segments: string[]) =>
  "/api/history/" + segments.map(encodeURIComponent).join("/");

url("estate", "engine.active-series");                 // /api/history/estate/engine.active-series
url("target", "svc:web/app", "service.deep-health");  // /api/history/target/svc%3Aweb%2Fapp/service.deep-health
url("checks", "web/app");                             // /api/history/checks/web%2Fapp
url("checks", "dns:status.example.com");                 // /api/history/checks/dns%3Astatus.example.com
```

Take ids from the timeline index, never from display text:

- **Target history:** use `TimelineTarget.target.id` with an id from its `queryIds`, and a range from its `ranges`.
- **Check history:** request only names in `TimelinePayload.checkHistory.endpoints`. A service's endpoints are the endpoint targets whose `parent` is that service. Domain checks are `TimelinePayload.domains[].endpoint`.
- **Alert history:** `/api/history/alerts?range=…` returns every lane, including `unmatched` ones.

Always send the pulse endpoint name (`web/app`). Never send the Gatus composite key (`web_web-app`). The server derives the key.

Handle failures by `code`, not by status alone. `HISTORY_OVERLOADED` carries `Retry-After: 1`. `MODEL_CHANGED` means the estate was re-rendered, so refetch the timeline index before retrying.

## Server-Side Use of the Package

```ts
import { createGatusClient, gatusEndpointKey } from "@pulse/web-data/sources";

const gatus = createGatusClient("http://gatus:8080");
const r = await gatus.endpointHistory(gatusEndpointKey("web", "web/app"));
if (!r.ok) log(r.error.kind); // never throws
```

Prefer `HistoryService.endpointHistory({ endpoint: "web/app", range })` over calling the client directly. The service resolves the group from the model, bounds and caches the result, and coalesces identical requests.

## Adding a Route

1. Add a `defineRoute({ method: "GET", path, handler })` in `apps/web/src/server/routes/` and list it in `ROUTES` in `routes/registry.ts`.
2. Take a `/`-bearing identifier as a path parameter only if it is an exact model lookup key. If so, list it in `slashParams`. `assertRegistry` rejects a name that is not a parameter of the path. Never use an opted-in value as a filesystem path or pass it through to an upstream URL.
3. Validate the query string with `validateQuery(search, allowedKeys)`.
4. Return failures through `errorFor(code, status)` so the body uses the catalog message.
5. The route inherits the GET-only guard, the decode-once parameter bounds, and template-labelled metrics automatically.

## Adding a Curated Query

1. Add the id to the `QueryId` union in `wire/history.ts`.
2. Add its definition to `QUERY_CATALOG` in `queries/catalog.ts`. The record is exhaustive, so typecheck fails until both match.
3. Add a builder in `queries/binding.ts`. Build PromQL only from pinned templates. Use `labelSelector` for label values and validate metric names against the pattern. Select Gatus metrics by the `name` label.
4. The timeline index advertises the query automatically for every target where the binder succeeds.
5. Update the client's query-metadata mirror (`views/_shared/timeseries/query-meta.ts`). A drift test compares it to the catalog.

## Adding a Fold Field

Folds must stay pure and total:

- Read only `FoldInputs`. Make no source or history call.
- Represent missing evidence as `null` with an availability. Never use zero or an empty current set.
- If a new wire field is required, update every hand-built fixture of that type in the same change (`apps/web/tests/timeline-fixtures.ts`, `apps/web/tests/browser/fixtures/timeline-render.tsx`, `packages/web-data/tests/**`). Otherwise typecheck fails in consumers.
- Every exported interface member needs a non-empty JSDoc. `public-api-docs.test.ts` enforces this.

## Testing

```bash
bun test                                  # everything, one process
bun test packages/web-data                # package only
bun run typecheck && bun run smoke
```

| Concern | Test |
|---|---|
| Slash-bearing params, structural rejections, unknown `slashParams` | `apps/web/tests/router-patterns.test.ts` |
| History routes end to end through `createFetchHandler`, including a fake Gatus that answers only composite keys | `apps/web/tests/history-routes.test.ts` |
| Composite-key derivation against live-observed pairs | `packages/web-data/tests/history/endpoint-key.test.ts`, `tests/sources/gatus.test.ts` |
| Endpoint resolution (service, domain, precedence, ambiguous) | `packages/web-data/tests/history/service.test.ts` |
| Latency query label | `packages/web-data/tests/queries/catalog-binding.test.ts` |
| Parents, domains, and check endpoints in the index | `packages/web-data/tests/cycle/fold-timeline.test.ts` |
| Overview validator, including `grafana.url === ""` | `packages/web-data/tests/overview-validator.test.ts` |
| Never-silent-green truth table | `packages/web-data/tests/cycle/never-silent-green.test.ts` |
| History cancellation, limits, intervals | `packages/web-data/tests/history/*.test.ts` |
| `/wire` stays browser-safe | `packages/web-data/tests/wire-browser-safe.test.ts` |
| Mutation seams stay dark | `apps/web/tests/mutation-darkness.test.ts` |

Source clients take `fetchImpl`, and the history service takes `now`, `setTimer`, and `clearTimer`. Tests inject these for determinism, and none needs a network.

## Troubleshooting

### Every service or endpoint history request returns 400

A reverse proxy is decoding or rejecting `%2F`. The proxy must forward the encoded slash unchanged. Caddy's `reverse_proxy` does this by default. Traefik's encoded-character filtering and nginx `proxy_pass` with a URI part do not. Confirm by calling `web:8080` directly.

### Check history returns 404 `TARGET_NOT_FOUND`

The name is not in `TimelinePayload.checkHistory.endpoints`. Either no service declares it, several services declare it (ambiguous), or it is a `dns:` name for a domain not listed in the estate's `domains`. Re-render the estate after fixing the declaration.

### Check history returns 502 `SOURCE_UNAVAILABLE` for one endpoint only

Gatus returned 404 for the derived key. Compare `gatusEndpointKey(group, name)` with the `key` label on `gatus_results_duration_seconds` for that `name`. If they differ, Gatus's key algorithm has changed. The helper is pinned to 5.13.1, so update it and its fixtures together.

### Check history shows only about 20 results

Something is calling Gatus without `pageSize`. Gatus defaults to 20 results. The client always sends `page=1&pageSize=100`.

### Endpoint latency chart is empty

`endpoint.check.latency` selects by `name`. Check that `gatus_results_duration_seconds{name="<endpoint>"}` returns series in VictoriaMetrics. Domain endpoints never get this chart, because they are not endpoint targets.

### A current route keeps returning 503 `NOT_READY`

No cycle has been published yet. Check the `cycle_degraded` logs and `/metrics` publication outcomes. A fold or materialization failure keeps the previous authority, or `NOT_READY` before the first success. It retries every 10 seconds.

### The overview is rejected by the client validator

Run the body through `validateOverviewSnapshotV2` to see its message. A Grafana link with `url: ""` is valid, meaning no Grafana origin is configured. Any other malformed field rejects the whole body.
