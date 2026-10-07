# Architecture

Engine Health and Timeline consists of two lazy React views layered on the web foundation's path router, signal store, and the shared `@/ui` component library and its `ui/viz/` charts (see [Web UI](../ui.md)). Current state comes from store signals that the shell's live-state machine fills. Bounded history comes from same-origin `/api/history/*` routes, through one shared plumbing layer under `views/_shared/timeseries/history/`.

## System Overview

```mermaid
graph LR
  LS[live-state machine] --> ENG[store.engine]
  LS --> TL[store.timeline]
  LS --> SNAP[store.snapshot]
  LS --> CONN[store.connection]
  ENG --> EM[engine/model.ts]
  SNAP --> EM
  CONN --> EM
  EM --> EV[EngineView regions]
  TL --> TM[timeline/model.ts]
  SNAP --> TM
  CONN --> TM
  TM --> TV[TimelineView lanes + swimlane + detail]
  EV --> UH[useHistory]
  TV --> UH
  UH --> Q[RequestQueue, 4 in flight]
  Q --> API[/api/history/*]
  UH --> HR[HistoryRegion]
```

The views never fetch `/api/engine` or `/api/timeline` themselves, and they never contact VictoriaMetrics, vmalert, Alertmanager, or Gatus. The server owns source access, validation, bounding, caching, and error envelopes.

## Module Layout

| Area | Location | Responsibility |
|---|---|---|
| Engine composition | `views/engine/view.tsx` | Route/kiosk read, region order, per-region boundaries |
| Engine model | `engine/model.ts` | Store readers; scrape, rule, notification, capacity sections; Grafana base |
| Verdict | `engine/verdict.ts`, `verdict-banner.tsx` | Pure roll-up and banner text |
| Engine presentation | `labels.ts`, `components.tsx`, `scrape.tsx`, `rules.tsx`, `pipeline.tsx` | Copy, formatters, cards, tables, tiles |
| Engine trends | `engine/trends.tsx` | Five trend charts and the view's request queue |
| Timeline composition | `views/timeline/view.tsx` | URL sync, live follow, requests, region layout |
| Timeline model | `timeline/model.ts`, `evidence.ts`, `swimlane-pack.ts` | Lane tree, host order, lane segments, severity rows |
| URL and axis | `timeline/url-state.ts`, `_shared/timeseries/axis.ts` | Codec and transitions; zoom/cursor/pin signals; live-follow timer |
| Timeline rendering | `timeline/lanes.tsx`, `swimlane.tsx`, `detail.tsx`, `controls.tsx`; `_shared/timeseries/chart.tsx`, `overlay.tsx`, `readout.tsx` | Tree, swimlane, detail charts, pointer overlay, readout, header |
| Query mirror | `_shared/timeseries/query-meta.ts` | Client copy of catalog defaults and max ranges (drift-tested) |
| History plumbing | `_shared/timeseries/history/` | Client, queue, hook, region, boundary, freshness |

`engine/model.ts` and `timeline/model.ts` are the roots of their module graphs. They import no local runtime modules, and they are the only modules that read `store.*.value`. Both views import the history plumbing and the chart/axis modules from `views/_shared/timeseries/`. The timeline view may not import from `views/engine/`, and a structural test enforces it.

## Engine View Data Flow

`EngineView` wraps `EngineViewBody` in the `@/ui` `PageErrorBoundary`. On each render the body:

1. reads `engine`, the engine delivery state, the snapshot, the cycle observation, `lastGoodAt`, and the connection phase through `model.ts`;
2. computes `notCurrent` with `useNotCurrent(connectionPhase, delivery.phase)`;
3. memoizes the scrape, rule, canary, notification, and capacity sections on `(engine, observation)` identity;
4. calls `rollUpVerdict()` and `presentVerdict()`.

Regions render in a fixed order in desk and kiosk mode: verdict banner, components, deadman, scrape jobs, rule groups, notifications, capacity, trends, and the Grafana link. Each region sits in its own `RegionErrorBoundary`.

### Verdict roll-up

`rollUpVerdict` is pure and total:

- no payload, delivery `initial`, and not stale → `loading` (a skeleton layout with "Loading engine state…");
- no payload, or `notCurrent` → `unknown` since `lastGoodAt`;
- otherwise it collects contributors in a fixed order: cycle build failure, degraded cycle, unreachable/stale components, deadman, scrape targets down, target discovery not current, failing rule groups, failing notification integrations, and unavailable notification metrics.

If that list is empty, a guard checks the seven governing sources in the cycle observation. It also checks the overview snapshot's engine summary, but only when the snapshot has the same `generatedAt` as the engine payload. Any failure adds "engine source {id} not current". So the engine view can never say OK while the overview's same-cycle engine summary says it is not OK, and an older snapshot can never hold a recovered engine in Degraded. Capacity never contributes.

### Sections and degraded sources

Every list section returns `rows`, `empty`, or `unavailable`, together with its governing `DataAvailability`. Rows are ordered problem-first by a stable partition over wire order, never by sorting. Problem rows start expanded. In kiosk mode, problem rows are expanded and healthy rows are non-interactive.

Scrape discovery is not current when the observation's `victoriametrics-targets` source is not current. It is also not current when a job reads unknown while the `victoriametrics` component is not current. In either case every job's effective state becomes `unknown`. This rule can only make jobs look worse, never healthier.

Values go through the `TileValue` union `value | not-reported | unavailable`. Zero is shown only when the payload says zero.

## Timeline View Data Flow

```mermaid
sequenceDiagram
  participant URL as PathRouter
  participant View as TimelineView
  participant Axis as TimeAxis
  participant Hook as useHistory
  participant Queue as RequestQueue
  participant API as /api/history

  URL->>View: query (range, end, zoom, sel)
  View->>View: decodeTimelineUrl + validateSel
  View->>Axis: domain = [end − range, end], zoom
  View->>Hook: alerts, coverage (priority 0)
  View->>Hook: selected target charts (priority 1)
  Hook->>Queue: run(priority, signal, fetchHistory)
  Queue->>API: GET ?range=
  API-->>Hook: payload or ErrorEnvelope
  Hook-->>View: HistoryRegionState
  View->>View: noDataSpans + deriveLaneSegments (cached)
  Axis->>URL: zoom / pin → replace; range / sel / pause → push
```

### Lane tree and evidence

`buildLaneTree(snapshot, index)` produces one host lane per declared host in model order, with service lanes nested under it. Identity is always `TargetIdentity` `{ kind, id: drilldownId }`, the same identity used by history lanes and the alert-triage `hs=` facet. Display names never drive identity. Hosts, services, labels, Grafana URLs, and `/estate` link names come from the snapshot. A service's check endpoints come from the timeline index's parent links: the endpoint targets whose `parent` is that service and that are listed in `checkHistory.endpoints`, deduplicated and sorted. `LaneTree.domains` is `index.domains` deduplicated by endpoint. Before the first index delivery every service has no endpoints and there are no domains.

`deriveLaneSegments` sweeps three evidence channels over the axis domain. The channels are attributed alert intervals (critical and warning change status; info is listed only), check failures and gaps (a gap longer than three times the median result spacing is no data), and no-data spans from the coverage probe (`engine.active-series`). Precedence per instant is: coverage no-data first, then critical (an alert or a failed check), then warning, then a check gap ("no data"), then OK. A collapsed host counts its own alerts and its services' alerts. An expanded host counts only its own. Unmatched history lanes are never attributed to a lane. They appear in the swimlane as "unmatched target". Domain alerts are among them: they are not attributed to domain lanes.

A lane is marked partial with one reason. In precedence order the reasons are `evidence-unavailable`, `loading`, `not-loaded`, and `coverage-limited`. The row label shows the worst status in the visible window, where "no data" ranks above OK. While the page follows live, `worstInView` leaves out a trailing no-data segment at the live edge when it is no longer than `max(2 × step, HISTORY_TTL_MS / 1000)` and is not the whole view. History payloads can be up to one server cache TTL older than the live window end, so without this every lane would summarise as "no data". The lane still draws the tail. Paused or zoomed, the tail allowance is 0.

### Check-history reachability

`checkHistoryReachable(key, index)` is the single gate for check history and the service latency chart. It is true only when the key is non-empty and listed in `index.checkHistory.endpoints`. The key's shape does not matter: `historyUrl` encodes a `/` as `%2F`, which the history routes accept. With a `null` index it is false, so nothing is requested before the first delivery. The view passes `(key) => checkHistoryReachable(key, index)` to evidence assembly, `requiredCheckEndpoints`, the lane tree, and the detail region. A service lane, domain lane, or Domains header whose endpoints are all unlisted reads "check history not available", and a service's latency slot reads "Check latency history not available".

### Domains group

The Domains header appears only when `LaneTree.domains` is non-empty. Expanded, it is followed by one level-2 row per domain, named by the domain, with the accessible name "`<domain>` DNS check". A domain lane's evidence is that endpoint's check history plus the coverage no-data spans. It has no alert evidence, so each endpoint's span before its first retained result (or the whole window, with no results) is a check gap, never OK. It ranks like any check gap, so another domain's failure still reads critical in the header. The header merges every domain endpoint into one input, which gives the worst of its domain lanes, and it shows "partial evidence" while any domain endpoint is loading or failed.

Domain endpoints are always in the checks-loading set, expanded or not, so the collapsed header and kiosk mode show a real status. Domain rows join the lane-grid keyboard model (Up/Down move through them, Left focuses the header) but are not selectable: they have no `sel`, no detail panel, no latency chart, and no `/estate` link. Kiosk mode keeps the group collapsed.

Gatus 5.13.1 retains at most 100 results per endpoint, and the data tier requests exactly that page. Check history therefore covers about the last 100 minutes at a one-minute check interval. At longer ranges a healthy domain lane reads "no data" before that point, and a service lane is marked `coverage-limited`.

Segments are derived over the domain, not the zoom window, and are memoized per lane by `createLaneEvidenceCache`. Zooming and cursor moves therefore never recompute evidence.

### Host order

Hosts with status-changing alert evidence in the domain sort first, with model order kept within each group. `createHostOrder` computes the order on the first ready alerts payload after a `(range, end)` change and freezes it across live refreshes, so lanes do not jump while an operator reads them.

### Too-many handling

`HISTORY_LIMIT_EXCEEDED` classifies as `too-many`. It is never retryable, and it discards retained data. With no alert lanes, every host lane reads "no data" instead of showing a partial set. The swimlane and the evidence status line offer "Try a shorter range" when a shorter range exists. At `1h` they say "Too many lanes/series for this range." with no suggestion.

## Time Axis, Zoom, and Live Follow

`createTimeAxis` owns the page-wide `zoom`, `cursor`, `pinned`, and `stepSeconds` signals. `view` is computed as `zoom ?? domain`. An internal effect clamps or clears the zoom when the domain or step changes. Zoom only magnifies data that is already loaded: no request is keyed on zoom, and the narrowest zoom is two effective data steps.

Two effects keep the URL and the axis in sync without looping:

- URL → axis: a reload, Back/Forward, or a shared link sets `axis.zoom`, and a live URL clears the pin;
- axis → URL: a brush, keyboard zoom, reset, or cursor pin writes `zoom` and, while live, `end` with the current domain end.

A write for a range change, selection, pause, or resume pushes a history entry. A write for zoom, zoom reset, or cursor pin replaces the current entry.

`createLiveFollow` ticks every `LIVE_REFRESH_MS` while `end === null`, the view is not zoomed, and the cursor is not pinned. Each tick advances `liveEnd`. That changes the `end` component of every history key, so the alerts, coverage, and detail requests re-run. The first tick fires one interval after mount. Resuming fires one tick immediately. This is a data-refresh timer. Kiosk rotation belongs to the shell.

The server always serves the latest window. `end` is a key component, never a request parameter. When a paused window lies entirely before the served window, the page shows "History is only available for the latest {range}; the paused window is older".

## History Plumbing

### Request queue and priorities

Each view creates one `createRequestQueue(HISTORY_CONCURRENCY)`. Lower priorities run first, and requests at the same priority run in submission order:

| Priority | Requests |
|---|---|
| 0 | engine trends; timeline alert history; timeline coverage probe |
| 1 | selected-target detail charts |
| 2 | check history for services under expanded hosts, and for every domain endpoint |

An aborted queued entry leaves the queue without using a slot. An aborted running entry releases its slot when its fetch rejects.

### Keys, supersession, and retained data

`useHistory` keys each region by the primitive string `op|target|queryId|range|end|generation`. A store update that rebuilds an equal request object never refetches. When the key changes, the hook aborts the previous attempt and discards late results. Data from an earlier load is kept as `previous` only for the same data identity (`op|target|queryId|range`) and never after `too-many`. A `superseded` failure (`MODEL_CHANGED`, `HISTORY_CANCELLED`) is retried automatically once. An `AbortError` never becomes a state.

### Failure classification and region copy

`fetchHistory` counts a response as success whenever the body matches the operation's discriminator, whatever the HTTP status. Otherwise it reads the `ErrorEnvelope.code`:

| Codes | Kind | Copy | Retry |
|---|---|---|---|
| `HISTORY_OVERLOADED` | overloaded | History service is busy. | yes, after `Retry-After` countdown |
| `SOURCE_TIMEOUT` | timeout | History query timed out. | yes |
| `SOURCE_UNAVAILABLE` | unavailable | Metrics source unavailable. | yes |
| `HISTORY_LIMIT_EXCEEDED` | too-many | Too many lanes/series for this range — try a shorter range. | no |
| `QUERY_NOT_APPLICABLE`, `RANGE_UNSUPPORTED`, `TARGET_NOT_FOUND` | not-applicable | Not applicable to this target/range. | no |
| `MODEL_CHANGED`, `HISTORY_CANCELLED` | superseded | Estate model changed — history could not be reloaded. | auto once, then yes |
| `NOT_READY` | not-ready | Engine starting — history not ready yet. | yes |
| network, non-JSON, anything else | unexpected | Unexpected error loading history. | yes |

`HistoryRegion` renders every phase. Idle renders optional content. Not-applicable renders its reason. Loading renders a skeleton, or the previous data with `aria-busy`. Ready renders the data, marked "Stale — history served from cache." when `payload.stale` is true. Error renders the failure copy, and with previous data adds "Stale — showing previously loaded data.".

When the client can tell that a request would be rejected, it sends none. A range above the query's `maxRange` renders "Not available at this range (max {maxRange})". An endpoint key that the timeline index does not list renders "Check latency history not available".

### Stale and not-current handling

`isNotCurrent` is true when the connection phase is `stale`, or when the view phase has stayed `stale` for longer than `REFRESH_INTERVAL_MS`. `useNotCurrent` records when the phase entered `stale` and schedules one timer to re-render at the threshold. In `/engine`, not current gives the Unknown verdict, a "Not current" notice above the last payload, and "Stale" for healthy components. In `/timeline`, it gives the banner "Timeline index not current since {t}", and the last lane tree stays rendered.

## Lazy Chart Chunk

uPlot is heavy, so it never ships on the initial route. The only runtime path to it is the `@/ui` `TimeSeriesChart` (`ui/viz/time-series-chart.tsx`), a `<Suspense>` wrapper whose uPlot implementation (`ui/viz/uplot-chart.tsx`) loads through `React.lazy`, with a skeleton fallback. `SyncedChart` renders it. `ChartChunkPrefetch` mounts a hidden, empty instance as soon as the detail region opens, so the chunk downloads while the first history request is in flight.

Tests enforce this invariant:

- `build-budget.test.ts` asserts that no initial-route entry contains uPlot and keeps total JS within its gzip ceiling (`TOTAL_JS_BUDGET_BYTES`);
- `timeline-view-chunk.test.ts` asserts that uPlot is present in at least one lazy chunk;
- structural tests in `engine-view-model.test.ts` and `timeline-view-model.test.ts` reject any use of the generic `TimeSeriesChart` (or an import of `ui/viz/time-series-chart`) outside the shared `SyncedChart` wrapper in `views/_shared/timeseries/`, and charts are imported only from the `@/ui` barrel.

`SyncedChart` places a `PlotOverlay` over uPlot's `.u-over` plot area, measured after each data identity change and on resize. The overlay captures all pointer input, so uPlot's own hover and drag-select never fire. Cursor moves translate one line element and never rebuild a chart. Chart data is shifted into the estate zone for uPlot's tick labels. The axis and readouts always use true times.

## Styling

Neither view ships a stylesheet. Components style themselves with Tailwind token classes and compose `@/ui` patterns (`PageHeader`, `Section`, `Callout`, `EmptyState`, `StatusBadge`, …); status colours come from the `@/ui` status maps. Structural tests in `engine-view-model.test.ts` and `timeline-view-model.test.ts` fail on any `.css` import or file under `views/engine/`, `views/timeline/`, or `views/_shared/timeseries/`. uPlot's own stylesheet is the one exception: `ui/viz/uplot-chart.tsx` imports it, and the build folds it into the entry sheet.

## Failure Containment

- A render fault in one chart is contained by `RegionErrorBoundary`, which shows a "This panel failed to render" `Callout`; the engine page's regions are each wrapped in the library's `FragmentBoundary`. Other regions keep rendering.
- A fault that escapes to the view is caught by the view's own boundary: `PageErrorBoundary` on the engine page, the private `ViewErrorBoundary` in `views/timeline/view.tsx`. The shell keeps working.
- History failures stay inside their region or evidence status line.
- Engine trends reset their boundaries when the server generation changes. Detail chart slots reset on a range or target change.

## Design Rationale

- **Store-only current state** keeps one fetch cadence and one freshness model for every view.
- **Pure, total model modules** let the verdict, sections, and evidence be tested exhaustively without a DOM.
- **Persistent-only staleness** prevents flicker to Unknown during the normal refetch gap after every cycle.
- **Magnify-only zoom** makes zoom instant and free of requests. The resolution label always reports the real data step.
- **Frozen host order** stops lanes from moving under the operator's cursor during live refreshes.
- **Explicit too-many and not-applicable states** make sure a truncated or rejected query is never shown as a complete picture.
- **Unsynced engine charts** keep the curated default ranges (1h and 6h) of the five trends independent. Timeline charts share one axis because they answer a single "what happened at this time" question.
- **One queue per view with priorities** keeps lanes and the swimlane responsive when a target selection adds four chart requests.
