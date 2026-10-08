# Integration Guide

This guide covers linking into, reusing, and testing Engine Health and Timeline inside the private Pulse web application. Both views are already registered at `/engine` and `/timeline`. Most work belongs inside `apps/web/src/client/views/engine/` or `apps/web/src/client/views/timeline/`, or in the upstream web-data contracts that fill the store and serve history.

## Run the Views Locally

From the repository root:

```bash
bun install
bun run dev:web --mock                 # all-green estate; history routes answer SOURCE_UNAVAILABLE
bun run dev:web --mock degraded-mix    # engine verdict Degraded, failing rules and targets
bun run dev:web --mock source-outage   # per-source degraded badges and staleness
```

The mock engine does not serve `query_range`. Under `--mock`, every history region shows its "Metrics source unavailable." state. For working charts, use `--engine <vm>,<alertmanager>,<gatus>,<vmalert>`. For deterministic chart rendering during development, open the browser fixture pages instead (see [Testing](#testing)).

## Route Integration

The registry entries have no extra routes, so all state lives in the query string:

```typescript
{ id: "engine", label: "Engine", icon: "network",
  load: () => import("./engine/view.js").then((m) => m.default),
  nav: { order: 3, kiosk: true } },
{ id: "timeline", label: "Timeline", icon: "clock",
  load: () => import("./timeline/view.js").then((m) => m.default),
  nav: { order: 4, kiosk: true } },
```

Keep the entry filename `view.tsx`. The shell attaches lazy-chunk CSS by the key `views/<id>/view`.

## Linking Into the Views

### `/engine`

`/engine` takes no view-owned query keys. `?kiosk=1`, or an active shell rotation, switches it to wallboard mode. In that mode every contributor is inline, problem groups are expanded, healthy rows are non-interactive, and the trend charts are shown but not interactive.

### `/timeline`

| Key | Values | Default when absent |
|---|---|---|
| `range` | `1h`, `6h`, `24h`, `7d` | `24h` |
| `end` | integer epoch seconds, at most 60 s in the future | live |
| `zoom` | `<start>-<end>` epoch seconds, inside `[end − range, end]`, at least 2 data steps wide | full range |
| `sel` | `host:<drilldownId>` or `service:<drilldownId>` | no detail region |

Build links with the codec rather than by hand:

```typescript
import { encodeTimelineUrl } from "../timeline/url-state.js";

const href = "/timeline" + encodeTimelineUrl(
  { range: "6h", end: 1790200000, zoom: null, sel: { kind: "host", id: "host:web01" } },
  {},
);
// "/timeline?range=6h&end=1790200000&sel=host%3Aweb01"
```

Rules for inbound links:

- `sel` uses the snapshot's `drilldownId`, not the display name. An unknown target falls back to no selection and shows a notice.
- `zoom` without `end` pins `end` to the current time, and the URL is rewritten to canonical form with `replace`.
- An `end` older than one range shows the latest served history with an explanatory notice. The server cannot serve older windows.
- `kiosk=1` honours only `range`.
- Unrelated keys, including the shell's `kiosk` and `rotate`, are preserved on every write.

## Outbound Links

| Source | Link |
|---|---|
| Swimlane interval with a target | `/alerts?hs=<encodeURIComponent(kind + ":" + id)>` |
| Swimlane interval without a target | `/alerts?sev=<encodeURIComponent(severity)>` |
| Engine rule row | `/alerts?tab=catalog` |
| Engine scrape target | `/estate/host/<name>`, only when the instance matches exactly one declared host by name or address |
| Timeline detail, host | `/estate/host/<name>` |
| Timeline detail, service | `/estate/service/<host>/<name>` |
| Timeline detail, Grafana | the snapshot's server-resolved `grafana.url`, `http:`/`https:` only |
| Engine Grafana board | `<grafanaBase>/d/pulse-engine`, hidden when Grafana is not configured |

The `hs` value uses the same `TargetIdentity` as alert triage's host/service facet, so the link opens alert triage filtered to that target. When changing either side, keep the identity spaces aligned. Never join by display name or Alertmanager fingerprint.

## Reusing the History Plumbing

A new view that needs bounded history should compose the same four pieces:

```tsx
import { useMemo, type ReactElement } from "react";
import type { HistoryPayload } from "@pulse/web-data/wire";
import { createRequestQueue, HISTORY_CONCURRENCY } from "../_shared/timeseries/history/client.js";
import { useHistory } from "../_shared/timeseries/history/use-history.js";
import { HistoryRegion } from "../_shared/timeseries/history/region.js";
import { RegionErrorBoundary } from "../_shared/timeseries/history/boundary.js";
import { rangeExceedsMax } from "../_shared/timeseries/query-meta.js";

export function DiskHistory(props: { readonly hostId: string; readonly generation: string | null }): ReactElement {
  const queue = useMemo(() => createRequestQueue(HISTORY_CONCURRENCY), []); // one per view
  const range = "24h" as const;
  const { state, retry } = useHistory(
    { op: "target", target: { kind: "host", id: props.hostId }, queryId: "host.disk.utilization", range },
    {
      queue,
      priority: 1,
      generation: props.generation,
      notApplicable: rangeExceedsMax("host.disk.utilization", range) ? "Not available at this range" : null,
    },
  );
  return (
    <RegionErrorBoundary label="Disk history" resetKey={props.generation}>
      <HistoryRegion state={state} label="disk history" onRetry={retry}>
        {(data: HistoryPayload, stale) => <p>{data.series.length} series{stale ? " (stale)" : ""}</p>}
      </HistoryRegion>
    </RegionErrorBoundary>
  );
}
```

Guidelines:

1. Create one queue per mounted view with `useMemo`, and share it across every history region in that view.
2. Use priority 0 for what the page needs first (overview lanes, trends), 1 for selection-driven detail, and 2 for optional expansions.
3. Pass `generation` from `store.connection.value.observation?.generation`, read through your view's `model.ts`, so a server restart re-keys every region.
4. Pass `end` only as a key component when your view has a pause anchor. It is never sent.
5. Gate requests that the server would reject with `notApplicable` instead of sending them. Examples are `rangeExceedsMax`, and `checkHistoryReachable(key, index)` for endpoint keys, which is true only for keys the timeline index lists in `checkHistory.endpoints`.
6. Place `RegionErrorBoundary` outside `HistoryRegion`, one per chart or region.
7. Do not add a stylesheet. The shared modules render `@/ui` components (`Skeleton`, `Callout`, …) styled with Tailwind token classes; style your own markup the same way (see [Web UI](../../ui.md)).
8. If your view reads `store.connection` for staleness, pass plain values into `useNotCurrent`. Keep your view's `model.ts` the only store reader.

To add a curated query id, add it to `CLIENT_QUERY_META` with the catalog's `defaultRange`, `maxRange`, and `unit`. The drift test (`timeline-view-query-meta-drift.test.ts`) fails until the mirror matches the server catalog.

## Adding a Chart

Render charts only through `SyncedChart`, which uses the `@/ui` `TimeSeriesChart` (uPlot behind `React.lazy`). Do not deep-import `ui/viz/` modules and do not import `uplot`. Either import pulls uPlot into the eager graph, and the build-budget and structural tests fail. When a region will show charts, render `ChartChunkPrefetch` next to the loading region, so the chunk downloads in parallel with the data.

Use `readout: { mode: "local" }` for a stand-alone chart with its own axis, like the engine trends. Use `{ mode: "page", registry, summaryId, order }` to join a page-wide cursor, like the timeline detail.

## Testing

Run the focused suites while developing:

```bash
bun test apps/web/tests/engine-*.test.ts
bun test apps/web/tests/timeline-*.test.ts
bun test apps/web/tests/browser/engine-*.test.ts apps/web/tests/browser/timeline-*.test.ts
bun test apps/web/tests/build-budget.test.ts
```

Then run the repository gates:

```bash
bun test
bun run typecheck
bun run smoke
```

Unit suites run under happy-dom. `timeline-view-history.test.ts` and `timeline-view-history-dom.test.ts` cover the history client, queue, hook, and region. `timeline-view-url.test.ts` covers the codec. `engine-view-verdict.test.ts` covers the roll-up table. `timeline-view-chunk.test.ts` builds the client and asserts that uPlot is in a lazy chunk.

The browser suites (`*-axe`, `*-grayscale`, `*-reflow`, `*-perf`) open fixture pages from `tests/browser/fixtures/engine-*.tsx` and `timeline-*.tsx` through `engine-browser.ts` and `timeline-browser.ts`. Rules for these suites:

- Gate each file with `browserDescribe()` from `tests/browser/_harness.ts`. Without Chromium the suite self-skips, and with `PULSE_REQUIRE_BROWSER=1` it fails instead. Install Chromium with `bunx playwright-core install chromium`.
- Always obtain Chromium from the shared `sharedBrowser()` in `_harness.ts`, and never close it. Suites create and close their own contexts. Several launches in one `bun test` process can wedge later browser files.
- `engine-perf.test.ts` and `timeline-perf.test.ts` run whenever Chromium is provisioned. They are not behind `PULSE_REQUIRE_PERF`. Their budgets are 1000 ms for the engine envelope paint, 3000 ms for timeline lanes, 2000 ms for detail charts, and a 100 ms median for readout updates.

Important regression categories include:

- verdict contributor order and the same-cycle overview guard;
- "not reported" versus zero versus "unavailable";
- persistent-only staleness;
- URL decode fallbacks, canonical rewrite, and push/replace behavior;
- queue priority and abort behavior, key supersession, retained data, and too-many clearing;
- the check-history gate (index membership only), service endpoints from parent links, and Domains rows (worst-of header, pre-coverage no data, keyboard-reachable but not selectable);
- the live-edge no-data tail left out of "worst in view";
- lazy uPlot placement and the single CSS import.

## Troubleshooting

### Every chart says "Metrics source unavailable."

You are running `--mock`, which serves no range queries, or VictoriaMetrics is unreachable. Check `/healthz` and the VictoriaMetrics origin.

### Charts never render, and the plot shows `data-overlay-state="missing-u-over"`

uPlot's DOM no longer contains `.u-over`, and one console error names it. The overlay stays disabled rather than guessing geometry. Check the uPlot version and `ui/viz/uplot-chart.tsx`.

### A history region reloads on every store cycle

The key must be stable. Check that you pass primitive `end` and `generation` values and do not rebuild them per render. The request object's identity alone never triggers a fetch.

### Engine reads "Unknown" briefly after every cycle

This should not happen. Only persistent staleness sets `notCurrent`. Check that the view passes `delivery.phase` into `useNotCurrent`, not the raw `connection.views` object, and that `REFRESH_INTERVAL_MS` has not been lowered below the cycle cadence.

### A shared timeline link opens with a notice and a different window

The link's value was invalid, or its `zoom` fell outside `[end − range, end]` or was narrower than two data steps. The page falls back per key, shows the reason, and rewrites the URL to canonical form.

### Host lanes all read "no data" while the swimlane says too many

The alert history exceeded the server's bound. The page deliberately shows no partial lane set. Choose a shorter range.

### Service detail shows "Check latency history not available"

The timeline index does not list that endpoint in `checkHistory.endpoints`, so `checkHistoryReachable` blocks the request. This happens before the first index delivery, or when the data tier could not resolve the service's Gatus endpoint (for example an ambiguous key). Check the `/api/timeline` payload: the endpoint target should carry a `parent` link to the service and appear in `checkHistory.endpoints`.

### A domain lane reads "no data" although the domain is healthy

A domain lane has only check evidence, and time before its first retained Gatus result is a check gap. Gatus 5.13.1 retains at most 100 results per endpoint, about 100 minutes at a one-minute interval, so at longer ranges the earlier part of the window reads "no data". Use a shorter range to judge a domain. Deeper history needs a Gatus upgrade.
