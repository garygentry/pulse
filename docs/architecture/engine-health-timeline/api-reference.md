# API Reference

Engine Health and Timeline is internal to the private `@pulse/web` application. These exports are source-module contracts for nearby client modules and tests, not public package APIs. Import them only from repository source paths. Examples are written as if from a sibling view directory, `apps/web/src/client/views/<your-view>/`.

## View Entries

### `default EngineView(props: ViewProps): ReactElement`

Source: `views/engine/view.tsx`. This is the lazy `/engine` view registered in `views/registry.ts` (id `engine`, nav order 3, `kiosk: true`). Kiosk mode is on when `isKiosk(route.query)` is true or `props.rotation` is non-null. The view reads rotation but never writes it.

```tsx
import EngineView from "../engine/view.js";

const node = <EngineView store={store} router={router} rotation={null} />;
```

`view.tsx` also exports two helpers. `estateClockFor(snapshot: OverviewSnapshotV2 | null): EstateClock` falls back to UTC with `tzFallback: true` when no snapshot is held. `EngineGrafanaLink({ href }: EngineGrafanaLinkProps): ReactElement | null` renders nothing when `href` is `null`.

### `default TimelineView(props: ViewProps): ReactElement`

Source: `views/timeline/view.tsx`. This is the lazy `/timeline` view (id `timeline`, nav order 4, `kiosk: true`). Kiosk mode comes from the URL only.

```tsx
import TimelineView from "../timeline/view.js";

const node = <TimelineView store={store} router={router} />;
```

## History Plumbing

Sources: `views/_shared/timeseries/history/*`. Both views consume these modules.

### Types

```typescript
type HistoryFailureKind =
  | "overloaded" | "timeout" | "unavailable" | "too-many" | "not-applicable"
  | "superseded" | "not-ready" | "unexpected";

interface ClassifiedFailure {
  readonly kind: HistoryFailureKind;
  readonly code: string;               // wire code, or "NETWORK"
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
}

type HistoryRegionState<T> =
  | { readonly phase: "idle" }
  | { readonly phase: "not-applicable"; readonly reason: string }
  | { readonly phase: "loading"; readonly previous: T | null }
  | { readonly phase: "ready"; readonly data: T }
  | { readonly phase: "error"; readonly failure: ClassifiedFailure; readonly previous: T | null };

type HistoryRequest =
  | { readonly op: "alerts"; readonly range: RangeId }
  | { readonly op: "estate"; readonly queryId: QueryId; readonly range: RangeId }
  | { readonly op: "target"; readonly target: TargetIdentity; readonly queryId: QueryId; readonly range: RangeId }
  | { readonly op: "checks"; readonly endpoint: string; readonly range: RangeId };

type HistoryResponse<R extends HistoryRequest> =
  R extends { op: "alerts" } ? IntervalHistoryPayload
  : R extends { op: "checks" } ? EndpointHistoryPayload
  : HistoryPayload;

type FetchOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly failure: ClassifiedFailure };

type RequestPriority = 0 | 1 | 2;
```

### Constants

```typescript
const HISTORY_CONCURRENCY = 4;
const LIVE_REFRESH_MS = 60_000;
```

### `historyUrl(request: HistoryRequest): string`

Builds the same-origin path plus `?range=`. Every path segment and the range value are percent-encoded, so a slash-bearing id such as `web01/nginx` stays one segment (`web01%2Fnginx`), which the history routes accept. For `op: "target"`, only `target.id` is sent. The function does not check reachability: callers gate endpoint keys with `checkHistoryReachable(key, index)` and send nothing when it is false.

```typescript
import { historyUrl } from "../_shared/timeseries/history/client.js";

historyUrl({ op: "estate", queryId: "engine.active-series", range: "6h" });
// "/api/history/estate/engine.active-series?range=6h"
```

### `fetchHistory<R extends HistoryRequest>(request: R, signal: AbortSignal): Promise<FetchOutcome<HistoryResponse<R>>>`

Issues one GET through `globalThis.fetch`, which is read at call time so tests can stub it. A response is a success when its body matches the operation's discriminator (`operation`, or `queryId`), whatever the HTTP status. Otherwise the result is a classified failure. `Retry-After` is parsed only for `HISTORY_OVERLOADED`.

**Throws:** `DOMException` named `"AbortError"` when `signal` aborts. This is the only way it rejects.

```typescript
import { fetchHistory } from "../_shared/timeseries/history/client.js";

const ctrl = new AbortController();
const outcome = await fetchHistory({ op: "alerts", range: "24h" }, ctrl.signal);
if (outcome.ok) console.log(outcome.data.lanes.length);
else console.log(outcome.failure.kind);
```

### `classifyFailure(code: string, retryAfterSeconds: number | null): ClassifiedFailure`

Pure and total. Unknown codes map to `"unexpected"`. `too-many` and `not-applicable` are not retryable. `retryAfterSeconds` is kept only for `overloaded`.

```typescript
import { classifyFailure } from "../_shared/timeseries/history/client.js";

classifyFailure("HISTORY_LIMIT_EXCEEDED", null); // { kind: "too-many", retryable: false, ... }
classifyFailure("HISTORY_OVERLOADED", 1);        // { kind: "overloaded", retryAfterSeconds: 1, ... }
```

### `createRequestQueue(limit?: number): RequestQueue`

```typescript
interface RequestQueue {
  run<T>(priority: RequestPriority, signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  readonly active: number;
  readonly queued: number;
}
```

`limit` defaults to `HISTORY_CONCURRENCY`. Lower priorities run first, with FIFO order inside a priority. An aborted signal rejects with `AbortError` without consuming a slot.

**Throws:** `RangeError` when `limit` is not a positive integer. The `useHistory` example below shows the queue in use.

### `useHistory<R extends HistoryRequest>(request: R | null, options: UseHistoryOptions): UseHistoryResult<HistoryResponse<R>>`

Source: `use-history.ts`.

```typescript
interface UseHistoryOptions {
  readonly queue: RequestQueue;
  readonly priority: RequestPriority;
  readonly end?: number | null;            // key component only; never sent
  readonly generation?: string | null;     // server restart re-keys the region
  readonly refreshMs?: number | null;      // interval re-request while the key is stable
  readonly enabled?: boolean;              // false → idle, no request (default true)
  readonly notApplicable?: string | null;  // non-null → "not-applicable", no request
}

interface UseHistoryResult<T> {
  readonly state: HistoryRegionState<T>;
  retry(): void;
  readonly key: string | null;
}
```

Only the primitive key triggers a request. A `null` request, or `enabled: false`, gives `idle`. `notApplicable` takes precedence over both. A key change aborts the previous attempt. Data from an earlier load is retained only for the same data identity, and never after `too-many`. `superseded` is retried once automatically.

```tsx
import { useMemo } from "react";
import { createRequestQueue, HISTORY_CONCURRENCY, LIVE_REFRESH_MS } from "../_shared/timeseries/history/client.js";
import { useHistory } from "../_shared/timeseries/history/use-history.js";

function ActiveSeriesProbe() {
  const queue = useMemo(() => createRequestQueue(HISTORY_CONCURRENCY), []);
  const { state, retry } = useHistory(
    { op: "estate", queryId: "engine.active-series", range: "6h" },
    { queue, priority: 0, refreshMs: LIVE_REFRESH_MS },
  );
  return <p data-phase={state.phase} onClick={retry}>{state.phase}</p>;
}
```

### `historyKey(request: HistoryRequest, end: number | null, generation: string | null): string`

Returns `op|target|queryId|range|end|generation`, with each field percent-encoded. It is pure.

```typescript
import { historyKey } from "../_shared/timeseries/history/use-history.js";

historyKey({ op: "alerts", range: "24h" }, null, "g1"); // "alerts|||24h||g1"
```

### `HistoryRegion<T extends { readonly stale: boolean }>(props: HistoryRegionProps<T>): ReactElement`

Source: `region.tsx`.

```typescript
interface HistoryRegionProps<T extends { readonly stale: boolean }> {
  readonly state: HistoryRegionState<T>;
  readonly label: string;                                   // loading text and aria-label
  readonly children: (data: T, stale: boolean) => ReactNode;
  readonly onRetry?: () => void;                            // absent → no Retry button
  readonly onShorterRange?: (() => void) | null;            // absent/null → no suggestion on too-many
  readonly idle?: ReactNode;
  readonly loadingHeight?: string;                          // Skeleton height class, default "h-12"
  readonly className?: string;
}

const FAILURE_COPY: Readonly<Record<HistoryFailureKind, string>>;
const REGION_TEXT: {
  stalePrevious: string; staleCache: string; retry: string;
  retryIn: (seconds: number) => string; shorterRange: string;
  tooManyNoShorter: string; loading: (label: string) => string;
};
```

Each phase renders `data-history-phase`. Errors also render `data-history-kind` and `data-history-code`. The component imports no CSS.

```tsx
import { HistoryRegion } from "../_shared/timeseries/history/region.js";

<HistoryRegion state={state} label="active series" onRetry={retry}>
  {(data, stale) => <p>{data.series.length} series{stale ? " (stale)" : ""}</p>}
</HistoryRegion>;
```

### `class RegionErrorBoundary extends Component<RegionErrorBoundaryProps, RegionBoundaryState>`

Source: `boundary.tsx`.

```typescript
interface RegionErrorBoundaryProps {
  readonly label: string;
  readonly resetKey?: string | number | null;   // a change clears a caught fault
  readonly children?: ReactNode;
}
```

When a descendant throws, the boundary renders "This panel failed to render" and logs one `console.error`. It never re-throws. Place it outside `HistoryRegion`, one per chart or region, as the [integration guide](./guides/integration.md#reusing-the-history-plumbing) shows.

### Freshness

Source: `freshness.ts`.

```typescript
interface FreshnessInput {
  readonly connectionPhase: ConnectionPhase; readonly viewPhase: ViewDeliveryState["phase"];
  readonly viewStaleSinceMs: number | null; readonly nowMs: number;
}
function isNotCurrent(input: FreshnessInput): boolean;
function useNotCurrent(
  connectionPhase: ConnectionPhase,
  viewPhase: ViewDeliveryState["phase"],
  now?: () => number,
): boolean;
```

The view is not current when `connectionPhase === "stale"`, or when the view phase has stayed `stale` for longer than `REFRESH_INTERVAL_MS`. The hook takes plain values, never the store.

```typescript
import { isNotCurrent } from "../_shared/timeseries/history/freshness.js";

isNotCurrent({ connectionPhase: "live", viewPhase: "stale", viewStaleSinceMs: 0, nowMs: 5_000 });  // false
isNotCurrent({ connectionPhase: "live", viewPhase: "stale", viewStaleSinceMs: 0, nowMs: 10_001 }); // true
```

## Query Metadata

Source: `views/_shared/timeseries/query-meta.ts`. This is a client mirror of catalog fields, drift-tested against the server catalog.

```typescript
interface ClientQueryMeta {
  readonly defaultRange: RangeId;
  readonly maxRange: RangeId;
  readonly unit: "count" | "bytes" | "seconds" | "percent" | "scalar" | "milliseconds" | "state";
}

const CLIENT_QUERY_META: Readonly<Partial<Record<QueryId, ClientQueryMeta>>>;
const RANGE_SECONDS: Readonly<Record<RangeId, number>>;
const TIMELINE_RANGES: readonly RangeId[];          // ["1h", "6h", "24h", "7d"]
const DEFAULT_RANGE: RangeId;                       // "24h"
const ENGINE_TREND_QUERIES: readonly [...5 engine.* ids];
const HOST_CHART_QUERIES: readonly [...4 host.* ids];
const SERVICE_CHART_QUERY: "endpoint.check.latency";
const COVERAGE_QUERY: "engine.active-series";

function timelineStepSeconds(range: RangeId): number;
function rangeExceedsMax(queryId: QueryId, range: RangeId): boolean;
```

`rangeExceedsMax` returns `true` for an id that is not in the mirror, so the client never sends a request it cannot prove valid.

```typescript
import { rangeExceedsMax, timelineStepSeconds } from "../_shared/timeseries/query-meta.js";

rangeExceedsMax("host.load.1m", "7d"); // true (max 24h)
timelineStepSeconds("24h");            // 145
```

## Timeline URL State

Source: `views/timeline/url-state.ts`. Everything in this module is pure and total, and it never navigates.

```typescript
interface TimelineUrlState {
  readonly range: RangeId;
  readonly end: number | null;
  readonly zoom: { readonly start: number; readonly end: number } | null;
  readonly sel: (TargetIdentity & { readonly kind: "host" | "service" }) | null;
}
interface UrlFallbackNotice { readonly key: "range" | "end" | "zoom" | "sel"; readonly message: string }
interface DecodedTimelineUrl { readonly state: TimelineUrlState; readonly notices: readonly UrlFallbackNotice[] }
type TimelineUrlChange = "range" | "select" | "pause" | "resume" | "zoom" | "reset-zoom" | "cursor-pin";

const TIMELINE_QUERY_KEYS: { range: "range"; end: "end"; zoom: "zoom"; sel: "sel" };
const END_FUTURE_TOLERANCE_S = 60;
const URL_CHANGE_MODE: Readonly<Record<TimelineUrlChange, "push" | "replace">>;

function decodeTimelineUrl(query: RouteMatch["query"], nowSec: number): DecodedTimelineUrl;
function validateSel(state: TimelineUrlState, tree: LaneTree): { readonly state: TimelineUrlState; readonly notice: UrlFallbackNotice | null };
function encodeTimelineUrl(state: TimelineUrlState, current: RouteMatch["query"]): string;
function isCanonicalTimelineQuery(query: RouteMatch["query"], state: TimelineUrlState): boolean;
function pausedWindowOutsideHistory(state: TimelineUrlState, nowSec: number): boolean;
function pausedWindowOutOfHistoryText(range: RangeId): string;

// Transitions, applied before navigating:
function withRange(state: TimelineUrlState, range: RangeId): TimelineUrlState;           // clears zoom
function withPause(state: TimelineUrlState, domainEnd: number): TimelineUrlState;
function withResume(state: TimelineUrlState): TimelineUrlState;                          // clears end + zoom
function withZoom(state: TimelineUrlState, window: TimeWindow, domainEnd: number): TimelineUrlState;
// also withResetZoom(state) and withSel(state, node | null)
```

Decoding rules:

- `kiosk=1` keeps `range` and drops `end`, `zoom`, and `sel` without notices;
- a `zoom` without `end` pins `end` to now;
- `sel` is shape-checked here and tree-checked later by `validateSel`. Its value is the target's
  canonical reference (`targetRef`: `host:web01`, `svc:web01/nginx`), whose prefix names the lane
  kind; links written before #17 in the internal `targetKey` form (`host:host:web01`,
  `service:svc:web01/nginx`) still decode to the same lane.

Encoding keeps unrelated keys in their original order, omits defaults, and percent-encodes every key and value.

```typescript
import { decodeTimelineUrl, encodeTimelineUrl, withRange } from "../timeline/url-state.js";

const { state, notices } = decodeTimelineUrl({ range: "2d", sel: "host:web01" }, 1790200000);
// state.range === "24h"; notices[0].message === "Unknown range '2d' — showing 24h"
encodeTimelineUrl(withRange(state, "6h"), { kiosk: "1" });
// "?kiosk=1&range=6h&sel=host%3Aweb01"
```

## Time Axis

Source: `views/_shared/timeseries/axis.ts`.

```typescript
interface TimeWindow { readonly start: number; readonly end: number }   // epoch seconds, half-open

interface TimeAxis {
  readonly domain: ReadonlySignal<TimeWindow>;
  readonly zoom: Signal<TimeWindow | null>;
  readonly view: ReadonlySignal<TimeWindow>;
  readonly cursor: Signal<number | null>;
  readonly pinned: Signal<boolean>;
  readonly stepSeconds: Signal<number>;
  toFraction(t: number): number;
  fromFraction(f: number): number;
  zoomAround(centre: number, factor: number): void;
  brush(f0: number, f1: number): void;
  reset(): void;
}
interface TimeAxisController extends TimeAxis { dispose(): void }
interface TimeAxisOptions {
  readonly domain: ReadonlySignal<TimeWindow>;
  readonly initialZoom: TimeWindow | null;
  readonly initialStepSeconds: number;
}

const MIN_ZOOM_STEPS = 2;
const KEY_ZOOM_FACTOR = 2;
const CURSOR_BIG_STEP = 10;

function createTimeAxis(opts: TimeAxisOptions): TimeAxisController;
function createLiveFollow(opts: {
  readonly intervalMs: number; readonly isLive: ReadonlySignal<boolean>; readonly onTick: () => void;
}): { readonly lastTickAt: ReadonlySignal<number | null>; dispose(): void };
```

`createLiveFollow` also accepts an injectable `scheduler` for tests. Always call `dispose()` on both objects on unmount.

```typescript
import { signal } from "@preact/signals-core";
import { createTimeAxis } from "../_shared/timeseries/axis.js";

const domain = signal({ start: 1790196400, end: 1790200000 });
const axis = createTimeAxis({ domain, initialZoom: null, initialStepSeconds: 60 });
axis.brush(0.25, 0.75);
console.log(axis.view.value);
axis.dispose();
```

## Timeline Model and Evidence

Source: `views/timeline/model.ts`.

```typescript
interface LaneNode {
  readonly target: TargetIdentity;
  readonly label: string;
  readonly hostName: string | null;
  readonly name: string;
  readonly endpoints: readonly string[];   // services: endpoint targets whose index parent is this service, ∩ checkHistory.endpoints, sorted
  readonly queryIds: readonly QueryId[];
  readonly grafanaUrl: string | null;
  readonly children: readonly LaneNode[];
}
interface LaneTree {
  readonly hosts: readonly LaneNode[];
  readonly domains: readonly TimelineDomain[];   // index.domains, deduplicated by endpoint; [] hides the group
}
type TargetKey = `${TargetIdentity["kind"]}:${string}`;

// Store readers: readTimeline, readTimelineDelivery, readTimelineSnapshot,
// readTimelineObservation, readTimelineConnectionPhase — the only store access in the view.
function targetKey(target: TargetIdentity): TargetKey;
function buildLaneTree(snapshot: OverviewSnapshotV2, index: TimelinePayload | null): LaneTree;
function findLane(tree: LaneTree, target: TargetIdentity): LaneNode | null;
function createHostOrder(): HostOrder;   // problem-first order, frozen across live refreshes
```

```typescript
import { buildLaneTree, findLane, targetKey } from "../timeline/model.js";

const tree = buildLaneTree(snapshot, index);
const node = findLane(tree, { kind: "host", id: "host:web01" });
if (node !== null) console.log(targetKey(node.target)); // "host:host:web01" (internal key, never in the URL)
```

Key exports from `evidence.ts`:

```typescript
type PartialReason = "not-loaded" | "loading" | "evidence-unavailable" | "coverage-limited";
interface LaneEvidenceResult {
  readonly segments: readonly LaneSegment[];
  readonly partial: PartialReason | null;
  readonly coverageSince: number | null;
}

function checkHistoryReachable(endpointKey: string, index: TimelinePayload | null): boolean; // listed in index.checkHistory.endpoints
function requiredCheckEndpoints(tree: LaneTree, expanded: ReadonlySet<TargetKey>, reachable: (key: string) => boolean): readonly string[];
function domainEvidenceInput(args: {
  endpoints: readonly string[]; lookup: (endpoint: string) => HistoryRegionState<EndpointHistoryPayload> | undefined;
  noData: readonly TimeWindow[] | null; window: TimeWindow; reachable: (key: string) => boolean;
}): LaneEvidenceInput;
function deriveLaneSegments(input: LaneEvidenceInput): LaneEvidenceResult;
function noDataSpans(probe: HistoryPayload, window: TimeWindow, alertsFetchedAt: string | null): readonly TimeWindow[];
function problemHostKeys(tree: LaneTree, lanes: readonly AlertHistoryLane[], window: TimeWindow): ReadonlySet<TargetKey>;
function createLaneEvidenceCache(derive?: (input: LaneEvidenceInput) => LaneEvidenceResult): LaneEvidenceCache;
```

`checkHistoryReachable` is false for an empty key or a `null` index. `requiredCheckEndpoints` returns the endpoints of services under expanded hosts, then every domain endpoint whether or not the Domains group is expanded, each passing `reachable`, deduplicated, in tree order. `domainEvidenceInput` builds the input for one domain lane (one endpoint) or for the Domains header (all of them). It sets `preCoverageIsNoData: true` on `LaneEvidenceInput`, so each endpoint's span before its first retained result is a check gap rather than OK.

```typescript
import { checkHistoryReachable, requiredCheckEndpoints } from "../timeline/evidence.js";

const reachable = (key: string) => checkHistoryReachable(key, index);
reachable("web01/nginx");                                  // true only if index.checkHistory.endpoints lists it
const endpoints = requiredCheckEndpoints(tree, expanded, reachable);
```

Key exports from `lanes.tsx`:

```typescript
function buildLaneBlocks(
  hosts: readonly LaneNode[], expanded: ReadonlySet<TargetKey>,
  domains: readonly TimelineDomain[], domainsExpanded: boolean,
): readonly LaneBlock[];
function worstInView(
  segments: readonly LaneSegment[], view: TimeWindow, liveTailSeconds?: number,
): { readonly status: TargetStatus; readonly text: string };
```

`buildLaneBlocks` emits the Domains header (`kind: "domains"`) only when `domains` is non-empty, followed by one `kind: "domain"` row (`key: "endpoint:<endpoint>"`, level 2) per domain when expanded. `worstInView` ranks critical > warning > no data > OK over the segments that intersect `view`. With `liveTailSeconds > 0` (the view passes `max(2 × step, HISTORY_TTL_MS / 1000)` while following live), a trailing no-data segment no longer than the tail is left out unless it is the whole view.

## Links

```typescript
// views/timeline/swimlane.tsx
function swimIntervalHref(interval: SwimInterval): string;   // /alerts?hs=<targetRef(target)> or /alerts?sev=<severity>
// views/timeline/detail.tsx
function estateHref(node: LaneNode): string;                 // /estate/host/<name> or /estate/service/<host>/<name>
function safeGrafanaHref(url: string | null): string | null; // http(s) only
// views/engine/scrape-match.ts
function matchScrapeInstanceToHost(instance: string, hosts: readonly HostStatus[]): string | null;
function estateHostPath(hostName: string): string;
// views/engine/rules.tsx
const RULE_CATALOG_HREF = "/alerts?tab=catalog";
```

`matchScrapeInstanceToHost` returns a host name only for an exact, case-sensitive single match on name or address. Zero or several matches give no link.

## Charts and Readout

Source: `views/_shared/timeseries/chart.tsx`.

```typescript
type ChartReadoutMode =
  | { readonly mode: "page"; readonly registry: ReadoutRegistry; readonly summaryId: string; readonly order?: number }
  | { readonly mode: "local" };

interface SyncedChartProps {
  chartId: string; title: string; unit: ClientQueryMeta["unit"];
  range: RangeId; payload: HistoryPayload | null; axis: TimeAxis; clock: EstateClock;
  height?: number; interactive: boolean; readout: ChartReadoutMode;
}

const UOVER_GRACE_MS = 1_000;
function SyncedChart(props: SyncedChartProps): ReactElement;
function ChartChunkPrefetch(): ReactElement;
```

`SyncedChart` never fetches. It renders the `@/ui` `TimeSeriesChart`, which loads uPlot through `React.lazy` behind its own `<Suspense>` skeleton. `"local"` mode creates a private readout registry, disables keyboard zoom, and renders an inline `CursorReadout`. The engine trends use this mode.

```tsx
import { SyncedChart } from "../_shared/timeseries/chart.js";

<SyncedChart
  chartId="engine.active-series" title="Active series" unit="count"
  range="6h" payload={data} axis={axis} clock={clock} interactive readout={{ mode: "local" }}
/>;
```

`views/_shared/timeseries/readout.tsx` exports `createReadoutRegistry(): ReadoutRegistry` and `CursorReadout`. A page creates one registry. Lanes, the swimlane, and charts register sources on it, sorted by `order`: lanes at 0, the swimlane at 500, and detail charts from 1000.

## Engine Model and Verdict

Source: `views/engine/model.ts`.

```typescript
// Store readers (the only store access in the view):
function readEngine(store: AppStore): EnginePayload | null;
function readEngineDelivery(store: AppStore): ViewDeliveryState;
// also readSnapshot, readObservation, readLastGoodAt, readConnectionPhase

type TileValue =
  | { readonly kind: "value"; readonly value: number }
  | { readonly kind: "not-reported" }
  | { readonly kind: "unavailable" };
type EngineSectionState = "rows" | "empty" | "unavailable";
interface EngineSection<Row> {
  readonly state: EngineSectionState;
  readonly rows: readonly Row[];
  readonly availability: DataAvailability;
}

function scrapeDiscovery(engine: EnginePayload, observation: CycleObservation | null): ScrapeDiscovery;
function scrapeSection(engine: EnginePayload, observation: CycleObservation | null): EngineSection<ScrapeJobRow>;
function ruleSection(engine: EnginePayload): EngineSection<RuleGroupRow>;
function canaryRule(engine: EnginePayload): RuleState | null;
function notificationSection(notifications: EngineNotificationState): NotificationSection;
function capacityTiles(capacity: EngineCapacityState): readonly CapacityTile[];
function deriveGrafanaBase(snapshot: OverviewSnapshotV2 | null): string | null;
```

Source: `views/engine/verdict.ts`.

```typescript
const GOVERNING_SOURCES: readonly SourceId[];
type Verdict =
  | { readonly kind: "loading" }
  | { readonly kind: "unknown"; readonly since: number | null }
  | { readonly kind: "ok" }
  | { readonly kind: "degraded"; readonly contributors: readonly string[] };

function rollUpVerdict(input: VerdictInput): Verdict;
function presentVerdict(verdict: Verdict, formatIso: (isoUtc: string) => string): VerdictPresentation;
```

```typescript
import { readEngine, readEngineDelivery, readLastGoodAt, readObservation } from "../engine/model.js";
import { presentVerdict, rollUpVerdict } from "../engine/verdict.js";

const verdict = rollUpVerdict({
  engine: readEngine(store), delivery: readEngineDelivery(store), notCurrent: false,
  observation: readObservation(store), overviewEngine: null, lastGoodAt: readLastGoodAt(store),
});
console.log(presentVerdict(verdict, (iso) => iso).headline); // e.g. "Degraded — vmalert unreachable"
```

`views/engine/labels.ts` holds the copy and formatters (`formatVersion`, `formatUptime`, `formatBytes`, `formatRate`, `formatSeconds`, `degradedText`, `engineBoardUrl`). Each formatter returns `NOT_REPORTED` (`"not reported"`) for null, non-finite, or negative input, and never for zero.

## Engine Trends

Sources: `views/engine/trends.tsx` and `views/engine/trends-model.ts` (`trendWindow`).

```typescript
type EngineTrendQueryId = (typeof ENGINE_TREND_QUERIES)[number];
const TREND_LABEL: Readonly<Record<EngineTrendQueryId, { title: string; region: string; unit: string }>>;
const RANGE_LABEL: Readonly<Record<RangeId, string>>;
function trendWindow(endSec: number, range: RangeId): TimeWindow;
function EngineTrends({ clock, kiosk, generation }: EngineTrendsProps): ReactElement;
function EngineTrendChart(props: EngineTrendChartProps): ReactElement;
```

`EngineTrends` owns the engine view's request queue. Each chart has its own axis, which is not synced with the page, and requests its curated default range at priority 0, refreshing every `LIVE_REFRESH_MS`.

## Keyboard

Source: `views/timeline/keyboard.ts`. `installTimelineKeyboard({ resetZoom, toggleLive, previousRange, nextRange })` registers `0`, `l`, `[`, and `]` on the shared shortcut registry, which is inactive inside text inputs, and returns a disposer. The view installs it in desk mode only. Plot, swimlane, and lane-tree keys are handled by their own components. `TIMELINE_KEY_BINDINGS` is the full table, and `TimelineKeyboardHints` renders it.
