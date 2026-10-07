# Integration Guide

This guide covers integrating or extending Alert Triage inside the private Pulse web application. The view is already registered at `/alerts`; most work should happen inside `apps/web/src/client/views/alerts/` or in the upstream web-data contract that populates `store.alerts`.

## Run the View Locally

From the repository root:

```bash
bun install
bun run dev:web --mock
```

Open `/alerts`. Use a committed mock scenario that includes alert, rule, silence, and availability data when developing degraded states or detail content.

For production-shaped source integration:

```bash
bun run dev:web --engine \
  http://localhost:8428,http://localhost:9093,http://localhost:8081
```

The browser must continue to use same-origin Pulse APIs. Do not add direct browser requests to the three engine origins.

## Route Integration

The compile-time view registry already contains:

```typescript
{
  id: "alerts",
  label: "Alerts",
  icon: "alert-triangle",
  load: () => import("./alerts/view.js").then((module) => module.default),
  routes: ["/alerts/:fingerprint"],
  nav: { order: 1, kiosk: true },
}
```

The primary route is derived as `/alerts`. The single extra route, `/alerts/:fingerprint`, exists so that inbound links from other views (the overview firing ribbon, and command-palette alert results via `entityPath("alert", fingerprint)`) open an alert directly. Inside the view, selection still belongs in `?sel=<fingerprint>`, and the current tab belongs in `?tab=…`. Do not add further routes to represent view state.

To link *into* triage from another view, prefer `/alerts/<encodeURIComponent(fingerprint)>` for one alert and `/alerts?target=<TargetIdentity id>` (or the canonical `?hs=<targetRef(target)>`, e.g. `?hs=host:web01`) for a target's alerts. Pass the raw wire id as `?target=<target.id>`, and build `?hs=` with `targetRef(target)` (`src/client/target-ref.ts`); never prefix a `TargetIdentity.id` with its kind again.

When changing query state:

1. begin with `router.current().query`;
2. replace only keys owned by the feature;
3. navigate to `/alerts` with the resulting query;
4. let the router carry `kiosk` and `rotate` where appropriate.

Use `encodeTriageState()` for canonical facet/selection encoding and `decodeTriageRoute()` at the route boundary (it covers the path param and the `target` alias as well as the query). Do not maintain duplicate component-local facet or drawer-open state.

## Store and Data-Tier Integration

The required client signal is `store.alerts`. Its non-null value must satisfy the frozen `AlertsPayload` wire contract and include:

- ordered firing alerts;
- ordered rule catalog;
- ordered active silences;
- independent Alertmanager and vmalert `DataAvailability` values.

The view assumes the data tier has already parsed and normalized the payload. Keep schema validation, engine access, ordering, and last-good behavior upstream. The view may derive presentation values, but it must not:

- refetch the alerts payload per row or per component;
- hide silenced or inhibited firing alerts by default;
- resort upstream arrays;
- infer source health from an empty array;
- guess target identity from loose labels.

If the alerts signal has not published its first payload, the active panel shows a skeleton.

## History Integration

The detail strip calls:

```http
GET /api/history/alerts?range=24h
Accept: application/json
```

Supported ranges are `1h`, `6h`, `24h`, and `7d`. The route returns either an `IntervalHistoryPayload` or an `ErrorEnvelope`. In particular, a bounded-query overflow must preserve its error body so the client can recognize `HISTORY_LIMIT_EXCEEDED` and avoid rendering partial lanes.

An `ActiveAlert` without `historyRef` renders a no-reference state and makes no request. For alerts with a reference, preserve the stable `queryId` and optional target identity across normal store refreshes; changing those primitives intentionally triggers a fresh request.

Historical attribution must use the canonical alert tuple and exact target identity. Never join history by the current Alertmanager fingerprint.

## Add or Change a Facet

A new facet crosses several coordinated contracts:

1. add its key and value type to `FacetKey`, `FacetSelection`, `FACET_KEYS`, and `QUERY_KEYS`;
2. add a `FacetDef` with a total value accessor;
3. add its available-value collection to `FacetValues` and `facetValues()`;
4. include the key in the view’s replace-on-change list;
5. add URL round-trip, predicate, no-refetch, and browser-history tests;
6. document delimiter or value-encoding constraints.

Preserve the filtering law: OR within one facet, AND across active facets, and empty selection means no constraint. Keep filtering client-side over the current payload.

## Extend the Detail Sheet

Place a new read-only section under `detail/` and compose it in `DetailPane.tsx`. Prefer a pure component with narrow props. Failures that can be represented as data should stay local to the section.

For links derived from alert annotations, pass candidate URLs through `safeHref()` and render rejected schemes as text. For target relations, use exact `TargetIdentity`; do not introduce fuzzy label joins.

The sheet’s open state belongs to the URL, and its focus lifecycle to the `@/ui` `Sheet` (Radix Dialog) plus `DetailPane`'s return-focus handling. Do not add a second modal-open signal or a second focus trap.

## Implement Future Actions

The M1 view exposes stable action regions:

```html
<div data-action-slot="silence">…</div>
<div data-action-slot="ack">…</div>
```

To implement a mutation action:

1. complete session-to-store wiring so `store.session` contains the minimized identity and explicit capabilities;
2. implement the body of `actions/silence.tsx` or `actions/ack.tsx` without changing `ActionProps`;
3. gate with `canAct()` (`mutations/gating.ts`), which is strict and deny-by-default;
4. obtain identity from the session seam, not forwarded request headers or action props;
5. add mutation lifecycle, error, replay, and authorization tests;
6. leave the existing slot names and DOM regions intact.

Do not render a disabled or suggestive affordance when capability is absent; the current contract renders nothing inside the stable region.

## Preserve Accessibility

When changing the view:

- keep reciprocal `aria-controls` and `aria-labelledby` relationships between tabs and panels;
- keep every panel’s `role="tabpanel"`;
- represent row opening with a real button or link;
- preserve icon and text labels in addition to status color (render status with `StatusBadge` and a status map such as `TARGET_STATUS`);
- retain the single `aria-current` keyboard marker;
- avoid intercepting native Enter behavior on interactive controls;
- announce history failures politely;
- test at 320 CSS pixels, 200% zoom, dark/light themes, and grayscale.

The `@/ui` components own their own semantics. Prefer composing them (`Tabs`, `Sheet`, `StatusBadge`, `DataTable`, `Skeleton`, `EmptyState`) over recreating them locally. See [Web UI](../../ui.md).

## Testing

Run focused alert suites while developing:

```bash
bun test apps/web/tests/alerts-*.test.ts
bun test apps/web/tests/browser/alerts-axe.test.ts
bun test apps/web/tests/browser/alerts-grayscale.test.ts
bun test apps/web/tests/browser/alerts-reflow.test.ts
```

Then run repository gates:

```bash
bun test
bun run typecheck
bun run smoke
```

Browser suites share fixture builds and Chromium within the test process but create suite-local contexts. Keep contexts isolated and always close them; do not return to per-fixture browser launches.

Important regression categories include:

- URL codec round trips and Back/Forward restoration;
- filtering laws and no-refetch behavior;
- stale selection handling;
- virtualized keyboard scroll/focus;
- source-specific degradation and healthy-empty distinction;
- taxonomy and history-range drift;
- lazy registry loader execution;
- history cancellation, overflow, unmatched lanes, and attribution;
- accessibility, reflow, theme, and grayscale behavior.

## Troubleshooting

### Empty table says “unavailable”

At least one source is not `current`. Inspect the named source banner and data-tier availability fields. This is intentional even when the current alerts array is empty.

### Shared URL opens “no longer firing”

The `sel` fingerprint is not present in the latest firing payload. The alert likely resolved or changed fingerprint. Close the detail sheet; do not silently select a different alert.

### History repeatedly reloads

Check whether the data tier is changing `historyRef.queryId` or its target identity on every cycle. Object identity may change, but those stable primitives should not.

### Keyboard focus does not reach an off-screen row

Keep `TRIAGE_ROW_HEIGHT` derived from `DATA_TABLE_VIRTUALIZE_DEFAULTS` and pass it as the table's `virtualize.rowHeight`. The keyboard controller reaches virtualized-out rows through the `DataTable` handle's `scrollToIndex`, so wire `tableRef` through to it rather than scrolling by hand.

### Alert chunk unexpectedly includes uPlot

Import viz components from the `@/ui` barrel, never `ui/viz/uplot-chart.tsx` or `uplot` directly. The barrel tree-shakes, and `TimeSeriesChart` loads uPlot only through `React.lazy`. `tests/build-budget.test.ts` fails if uPlot reaches the initial route.

### Action capability is true but no button appears

The M1 action components intentionally return null. Capability gating and slot placement are ready, but mutation behavior must be implemented by the mutation layer.
