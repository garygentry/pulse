# Engine Health and Timeline

Engine Health and Timeline adds two read-only views to the Pulse web application. `/engine` is the monitoring engine's self-health page: an overall verdict, the six engine components, scrape jobs, rule groups, the deadman canary, notification and capacity tiles, and five trend charts. `/timeline` is an incident-reconstruction page: a lane tree of hosts and services, an alert-history swimlane, and synced detail charts for one selected target, all on one shared time axis with zoom, cursor pinning, and live follow. Both views share one history plumbing layer (`views/_shared/timeseries/history/`) that fetches bounded history, queues requests, classifies failures, and renders every region state. Neither view ever shows missing data as healthy.

This feature is part of the private `@pulse/web` application. It is not a published package and has no public package export map.

## Quick Start

Run the web application against the in-process mock engine:

```bash
bun install
bun run dev:web --mock
```

Open `http://127.0.0.1:8080/engine` and `http://127.0.0.1:8080/timeline`.

The mock engine serves only instant queries. The history routes therefore answer `SOURCE_UNAVAILABLE`, so under `--mock` the engine trends, timeline lanes, and swimlane show the "Metrics source unavailable." failure state with a Retry button. This is the intended degraded rendering, not a bug. To see real charts, run against an engine:

```bash
bun run dev:web --engine \
  http://localhost:8428,http://localhost:9093,http://localhost:8081,http://localhost:8880
```

The four origins are VictoriaMetrics, Alertmanager, Gatus, and vmalert, in that order. To exercise degraded engine states, use `bun run dev:web --mock degraded-mix` or `--mock source-outage`.

Useful URL examples:

```text
/engine
/engine?kiosk=1                                   # wallboard: every contributor inline, no disclosures
/timeline                                         # 24h, live
/timeline?range=6h
/timeline?range=24h&end=1790200000                # paused at an epoch-seconds anchor
/timeline?range=24h&end=1790200000&zoom=1790190000-1790196000
/timeline?sel=host%3Aweb01                        # detail region for host drilldown id "host:web01"
/timeline?kiosk=1&range=6h                        # kiosk: range honoured, end/zoom/sel ignored
```

## Key Concepts

### Store snapshot in, pure model out

Neither view fetches its current-state payload. The shell's live-state machine writes `store.engine`, `store.timeline`, and `store.snapshot`. In each view, `model.ts` is the only module that reads `store.*.value`. The view then derives render-ready sections, verdicts, and lane trees through pure, total functions that never throw on any wire value.

### Bounded history through one queue

Trend charts, lane evidence, the swimlane, and detail charts all load through `useHistory`. Each mounted view owns one request queue with at most four requests in flight (`HISTORY_CONCURRENCY`). The client sends only curated ids and a `range`. It never sends PromQL, a window, or a step.

### Every region renders something

`HistoryRegion` maps each region state (idle, not-applicable, loading, ready, error) to visible text. Failures are classified per cause, such as "History service is busy." or "Too many lanes/series for this range — try a shorter range.". Data from an earlier load stays on screen, marked stale, while a refresh loads or after one fails.

### Not current is persistent, never transient

A view is "not current" only when the control channel is stale, or when its delivery phase has stayed `stale` for longer than one refresh interval. The normal refetch gap between a tick and its payload keeps the last rendered state. When not current, `/engine` reads "Unknown", and healthy components read "Stale". `/timeline` shows a banner above the last lane tree.

### Never falsely green

The engine verdict is `OK` only when no contributor is present and every governing source is current. Missing values read "not reported". Examples are uptime for web and Grafana, and version for vmalert and Gatus. Unavailable sources read "unavailable" with the last good time. Rule-group evaluation duration is not provided by the data tier, so the rule table has no duration column. On the timeline, "no data" ranks above OK, and lanes with incomplete evidence carry a "partial evidence" marker. A domain lane has only check evidence, so the time before its first retained check result is a check gap ("no data"), never OK.

### Check evidence and Domains

Service and domain lanes draw Gatus check evidence from `/api/history/checks/<endpoint>`. The timeline index decides which endpoints can be requested: an endpoint key is reachable only when it is listed in `TimelinePayload.checkHistory.endpoints`, whatever its shape. A service lane's endpoints come from the index's parent links (endpoint targets whose parent is that service). The Domains group lists one DNS-check lane per `TimelinePayload.domains[]` entry, and its header shows the worst of its domain lanes. The group is hidden when the index declares no domains. Gatus 5.13.1 keeps at most 100 results per endpoint, so check history covers about the last 100 minutes at the estate's one-minute check interval.

### URL-owned timeline state

`range`, `end`, `zoom`, and `sel` live in the query string. Invalid values fall back to defaults with one visible notice per key, and the URL is then rewritten to canonical form. Zooming or pinning the cursor pauses live follow by writing `end`.

## Entry Points

| Entry | Location | Purpose |
|---|---|---|
| `/engine` view | `apps/web/src/client/views/engine/view.tsx` (default export) | Engine self-health page |
| `/timeline` view | `apps/web/src/client/views/timeline/view.tsx` (default export) | Incident reconstruction page |
| History client | `apps/web/src/client/views/_shared/timeseries/history/client.ts` | `fetchHistory`, `classifyFailure`, `createRequestQueue`, constants |
| History hook | `apps/web/src/client/views/_shared/timeseries/history/use-history.ts` | `useHistory`, `historyKey` |
| Region renderer | `apps/web/src/client/views/_shared/timeseries/history/region.tsx` | `HistoryRegion`, `FAILURE_COPY`, `REGION_TEXT` |
| Fault containment | `apps/web/src/client/views/_shared/timeseries/history/boundary.tsx` | `RegionErrorBoundary` |
| Freshness | `apps/web/src/client/views/_shared/timeseries/history/freshness.ts` | `isNotCurrent`, `useNotCurrent` |
| Registry entries | `apps/web/src/client/views/registry.ts` | `engine` (nav order 3), `timeline` (nav order 4) |

There is no package export. Import these modules only from repository source paths.

## Configuration

Neither view has runtime configuration or environment variables. Grafana links appear only when the web app is configured with `PULSE_GRAFANA_URL`. The named tunable constants are:

| Constant | Value | Module | Meaning |
|---|---|---|---|
| `HISTORY_CONCURRENCY` | `4` | `history/client.ts` | Max in-flight history requests per view |
| `LIVE_REFRESH_MS` | `60_000` | `history/client.ts` | Live-follow tick and engine trend refresh |
| `REFRESH_INTERVAL_MS` | `10_000` | `shared/constants.ts` | Staleness threshold for "not current" |
| `DEFAULT_RANGE` | `"24h"` | `_shared/timeseries/query-meta.ts` | Default and kiosk timeline range |
| `TIMELINE_RANGES` | `1h, 6h, 24h, 7d` | `_shared/timeseries/query-meta.ts` | Range selector order |
| `CLIENT_QUERY_META` | per query | `_shared/timeseries/query-meta.ts` | Default range, max range, unit (drift-tested) |
| `MIN_ZOOM_STEPS` | `2` | `_shared/timeseries/axis.ts` | Narrowest zoom, in effective data steps |
| `KEY_ZOOM_FACTOR` | `2` | `_shared/timeseries/axis.ts` | `+`/`-` zoom factor |
| `END_FUTURE_TOLERANCE_S` | `60` | `timeline/url-state.ts` | Clock-skew allowance for `end` |
| `MAX_SUBLANES` | `4` | `timeline/swimlane-pack.ts` | Visible sub-lanes per severity row |
| `VERDICT_INLINE_CONTRIBUTORS` | `3` | `engine/labels.ts` | Contributors shown before "and N more" |
| `ENGINE_BOARD_UID` | `"pulse-engine"` | `engine/labels.ts` | Grafana board for the engine link |
| `READOUT_ANNOUNCE_DEBOUNCE_MS` | `250` | `_shared/timeseries/readout-model.ts` | Screen-reader readout debounce |

## When to Use

Use these views to:

- decide at a glance whether the monitoring engine itself is healthy, and name what is not;
- find failing scrape targets, failing rule groups, notification failures, or a silent deadman canary;
- reconstruct what happened across hosts and services over a range of up to 7 days;
- correlate firing alert intervals with host capacity charts at one cursor time;
- share an exact investigation window through the URL.

Reuse the history plumbing when a new view needs bounded history with the same failure and staleness semantics.

## When Not to Use

Do not use these views to:

- run arbitrary queries, custom windows, or custom steps. Only curated query ids and closed ranges exist;
- read history older than the latest served window. A paused `end` shows the latest history plus a notice;
- compare several targets at once. The detail region shows one selected target;
- read Gatus check results older than about 100 minutes. Gatus 5.13.1 retains at most 100 results per endpoint, so at longer ranges a service lane is marked "check history covers only since {t}" and a healthy domain lane reads "no data" before that point. Deeper check history needs a Gatus upgrade;
- import view modules as a public library API.

## Further Reading

- [Architecture](./architecture.md) — data flow, history plumbing, lazy chart chunk, and design rationale
- [API Reference](./api-reference.md) — exported TypeScript contracts
- [Integration Guide](./guides/integration.md) — linking in, reusing history plumbing, testing, and troubleshooting
- [Alert Triage](../alert-triage/README.md) — the `/alerts` view that swimlane and rule links open
- [Web Foundation](../web-foundation/README.md) — router, store, lazy views, and browser test infrastructure
