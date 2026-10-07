# API Reference

Alert Triage is internal to the private `@pulse/web` application. These exports are source-module contracts for nearby client modules and tests, not public package APIs. Import them only from repository source paths.

## View Entry

Source: `apps/web/src/client/views/alerts/view.tsx`.

### `default AlertsView(props: ViewProps): ReactElement`

The lazy `/alerts` view registered by `views/registry.ts`. It expects the standard `{ store, router }` view props.

```tsx
import AlertsView from "./src/client/views/alerts/view.js";

const node = <AlertsView store={store} router={router} />;
```

### Tab helpers

Source: `view-model.ts`.

```typescript
type TriageTabId = "firing" | "catalog" | "silences";
const TAB_QUERY_KEY = "tab";
function tabFromQuery(query: Readonly<Record<string, string>>): TriageTabId;
```

Unknown or absent tab values resolve to `"firing"`.

```typescript
tabFromQuery({ tab: "catalog" }); // "catalog"
tabFromQuery({ tab: "unknown" }); // "firing"
```

## URL-State Codec

Source: `url-state.ts`.

```typescript
type FacetKey = "severity" | "state" | "group" | "hostService" | "ruleFamily";

interface FacetSelection {
  severity: readonly string[];
  state: readonly ("firing" | "silenced" | "inhibited")[];
  group: readonly string[];
  hostService: readonly string[];
  ruleFamily: readonly string[];
}

interface TriageUrlState {
  facets: FacetSelection;
  selected: string | null;
}
```

`FACET_KEYS`, `QUERY_KEYS`, and `FACET_DELIMITER` define the stable codec vocabulary.

### `encodeTriageState(state): string`

Returns a canonical query string without a leading `?`. Empty facets and null selection are omitted; each facet’s values are sorted.

```typescript
encodeTriageState({
  facets: {
    severity: ["warning", "critical"],
    state: ["firing"],
    group: [],
    hostService: [],
    ruleFamily: [],
  },
  selected: "fp-123",
});
// "sev=critical%2Cwarning&state=firing&sel=fp-123"
```

### `decodeTriageState(query): TriageUrlState`

Decodes the router’s flat query record. Unknown values are retained; empty values become empty arrays or null selection. `hs` values written before the target-reference fix (`host:host:web01`, `service:svc:web01/nginx`) are mapped to the canonical reference (`host:web01`, `svc:web01/nginx`) by `normalizeTargetRef`, so older shared links keep filtering.

```typescript
const state = decodeTriageState({ sev: "critical,warning", sel: "fp-123" });
```

### `decodeTriageRoute(match, available?): TriageUrlState`

Decodes a full `RouteMatch`. It builds on `decodeTriageState(match.query)` and adds the inbound deep-link forms:

- `match.params.fingerprint`, from the `/alerts/:fingerprint` route, becomes the selection when `sel` is absent or empty;
- a non-empty `target` query value `T` (a `TargetIdentity.id`, such as `host:web01` or `svc:web01/nginx`) adds its host/service facet value(s), merged with `hs` and de-duplicated. The candidates are `targetAliasValues(T)`: `T` itself (host and service ids already carry their kind) and `endpoint:T`. With `available` (`facetValues(payload).hostService`), only the matching candidate is kept. With no payload, or no match, both are added.

```typescript
const state = decodeTriageRoute({ path: "/alerts/fp-1", view: "alerts", params: { fingerprint: "fp-1" }, query: { target: "host:web01" } });
// state.selected === "fp-1"; state.facets.hostService is ["host:web01", "endpoint:host:web01"]
```

`TARGET_ALIAS_KEY` (`"target"`), `TARGET_ALIAS_KINDS` (`["host", "service", "endpoint"]`) and `targetAliasValues(id)` are exported alongside it.

### `resolveSelected(payload, selected): ActiveAlert | null`

Finds the selected fingerprint among current firing rows. It returns null for a closed pane, an unavailable payload, or a stale/resolved fingerprint.

```typescript
const alert = resolveSelected(payload, route.query.sel ?? null);
```

## Payload Selectors

Source: `model.ts`.

### Core selectors

```typescript
function readAlerts(store: AppStore): AlertsPayload | null;
function firingRows(payload: AlertsPayload): readonly ActiveAlert[];
function rules(payload: AlertsPayload): readonly RuleState[];
function silences(payload: AlertsPayload): readonly ActiveSilence[];
```

These functions do not validate, copy, or sort the data.

```typescript
const payload = readAlerts(store);
if (payload !== null) {
  console.log(firingRows(payload).length);
}
```

### Rule-family and facet selectors

```typescript
const UNGROUPED_FAMILY = "ungrouped";

interface FacetValues {
  severity: readonly string[];
  state: readonly string[];
  group: readonly string[];
  hostService: readonly string[];
  ruleFamily: readonly string[];
}

function ruleFamily(payload: AlertsPayload, alert: ActiveAlert): string;
function buildRuleFamilyIndex(payload: AlertsPayload): ReadonlyMap<string, string>;
function facetValues(payload: AlertsPayload): FacetValues;
function hostServiceValue(alert: ActiveAlert): string | null;
```

`hostServiceValue` is `targetRef(alert.target)` from `src/client/target-ref.ts`: the canonical wire id, whose kind prefix appears once (`host:web01`, `svc:web01/nginx`; endpoint names become `endpoint:<name>`). Never compose `${kind}:${id}` for display or for `hs`: host and service ids already start with `host:` / `svc:`.

The first matching rule name wins. Unmatched alerts use `UNGROUPED_FAMILY`.

```typescript
const values = facetValues(payload);
const family = ruleFamily(payload, payload.alerts[0]!);
```

### Target helpers

```typescript
function targetEquals(a: TargetIdentity | null, b: TargetIdentity | null): boolean;
function relatedByTarget(
  payload: AlertsPayload,
  target: TargetIdentity | null,
): readonly ActiveAlert[];
```

Two null targets are not equal. Related alerts require exact kind and ID equality.

```typescript
const related = relatedByTarget(payload, { kind: "host", id: "web01" });
```

## Facet Filtering

Source: `facets.ts`.

```typescript
interface FacetDef {
  key: FacetKey;
  label: string;
  valueOf: (payload: AlertsPayload, alert: ActiveAlert) => string | null;
}

const FACET_DEFS: readonly FacetDef[];
function matchesFacets(
  payload: AlertsPayload,
  alert: ActiveAlert,
  selection: FacetSelection,
): boolean;
```

`matchesFacets` applies OR within each facet and AND across active facets.

```typescript
const visible = payload.alerts.filter((alert) =>
  matchesFacets(payload, alert, selection),
);
```

`FacetBar(props: FacetBarProps): ReactElement` renders the controls. `FacetBarProps` contains `values`, `selection`, `onChange`, and the `total`/`shown` counts.

## Triage Table

Sources: `table/TriageTable.tsx` and `table/columns.tsx`.

```typescript
const TRIAGE_ROW_HEIGHT: number = DATA_TABLE_VIRTUALIZE_DEFAULTS.rowHeight.compact;
type TriageColumn = ColumnDef<ActiveAlert> & { readonly id: string };
const triageColumns: TriageColumn[];

interface TriageTableProps {
  rows: readonly ActiveAlert[];
  selectedIndex: Signal<number>;
  onOpenAlert: (fingerprint: string) => void;
  sourcesCurrent: boolean;
  filtersExcludeAll?: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  tableRef?: RefObject<DataTableHandle | null>;
}

function TriageTable(props: TriageTableProps): ReactElement;
```

```tsx
<TriageTable
  rows={visible}
  selectedIndex={selectedIndex}
  onOpenAlert={(fingerprint) => open(fingerprint)}
  sourcesCurrent={true}
  containerRef={containerRef}
  tableRef={tableRef}
/>
```

`TriageTable` is the `@/ui` `DataTable` with `virtualize` on (300-row default threshold). Column-formatting helpers are pure and live in `table/columns-model.ts`:

```typescript
function formatAge(startsAt: string, now?: number): string;
function formatTarget(target: TargetIdentity | null): string;
function summaryText(alert: ActiveAlert): string;
```

```typescript
formatAge("2026-09-23T02:00:00Z", Date.parse("2026-09-23T03:00:00Z")); // "1h"
formatTarget({ kind: "service", id: "svc:web01/api" }); // "svc:web01/api"
```

## Keyboard Controller

Source: `keyboard.ts`.

```typescript
interface TriageKeyboardOptions {
  selectedIndex: Signal<number>;
  rows: () => readonly ActiveAlert[];
  container: () => HTMLElement | null;
  scrollToIndex: (index: number) => void;
  isFiringTabActive: () => boolean;
  isPaneOpen: () => boolean;
  openAlert: (fingerprint: string) => void;
  closePane: () => void;
}

function installTriageKeyboard(options: TriageKeyboardOptions): () => void;
function TriageKeyboardHints(): ReactElement;
```

Always invoke the returned disposer on unmount.

```typescript
useEffect(() => installTriageKeyboard(options), []);
```

## Detail and History

### `DetailPane(props): ReactElement`

Source: `detail/DetailPane.tsx`.

```typescript
interface DetailPaneProps {
  store: AppStore;
  payload: AlertsPayload | null;
  selected: string | null;
  onClose: () => void;
  onSelect?: (fingerprint: string) => void;
}
```

```tsx
<DetailPane
  store={store}
  payload={payload}
  selected={selected}
  onClose={() => clearSelection()}
/>
```

### History contracts

Sources: `detail/History.tsx` and `detail/history-model.ts`.

```typescript
type HistoryViewState =
  | { kind: "loading" }
  | { kind: "ready"; payload: IntervalHistoryPayload }
  | { kind: "error"; code: string }
  | { kind: "no-ref" };

interface HistoryProps {
  alert: ActiveAlert;
  range?: RangeId;
}

const RANGE_MS: Readonly<Record<RangeId, number>>;
function isAlertOwnLane(alert: ActiveAlert, lane: AlertHistoryLane): boolean;
function deriveDomain(payload: IntervalHistoryPayload): {
  domainStart: number;
  domainEnd: number;
};
function buildLanes(
  payload: IntervalHistoryPayload,
  alert: ActiveAlert,
): readonly TimelineLane[];
function History(props: HistoryProps): ReactElement;
```

```tsx
<History alert={alert} range="6h" />
```

`buildLanes` retains every lane and orders own, matched, then unmatched lanes.

### Detail helpers

```typescript
function safeHref(url: string): string | null;
function matcherExpression(matcher: SilenceMatcher): string;
function Related(props: {
  payload: AlertsPayload | null;
  alert: ActiveAlert;
  onSelect?: (fingerprint: string) => void;
}): ReactElement;
function Routing(props: { alert: ActiveAlert }): ReactElement;
function Silences(props: { alert: ActiveAlert; payload: AlertsPayload | null; store?: AppStore }): ReactElement | null;
```

```typescript
safeHref("https://runbook.example/alert"); // same URL
safeHref("javascript:alert(1)"); // null
matcherExpression({ name: "host", value: "web.*", isRegex: true, isEqual: true });
```

## Taxonomy and Routing

Sources: `taxonomy.ts` and `routing-explain.ts`.

```typescript
interface SeverityRouting {
  channels: string;
  repeatInterval: string | null;
  groupWindow: string | null;
  bypassesQuietHours: boolean;
  sendsResolved: boolean;
}

interface SeverityEntry {
  name: string;
  response: string;
  routing: SeverityRouting;
}

interface SeverityTaxonomy {
  contractVersion: number;
  severities: readonly SeverityEntry[];
  webhookMirror: Readonly<Record<"critical" | "warning" | "info", string>>;
}

const SEVERITY_TAXONOMY: SeverityTaxonomy;
const SEVERITY_STATUS: Readonly<Record<string, TargetStatus>>;
const INTERVAL_STATUS: Readonly<Record<StatusInterval["state"], TargetStatus>>;
const DEFAULT_HISTORY_RANGE: RangeId;
function severityToStatus(severity: string): TargetStatus;
function stateToStatus(state: ActiveAlert["state"], severity: string): TargetStatus;
```

```typescript
severityToStatus("critical"); // "critical"
severityToStatus("custom"); // "unknown"
stateToStatus("silenced", "critical"); // "suppressed"
```

Routing explanation is total over free-form severity strings:

```typescript
type WebhookMirrorPolicy = "always" | "if-selected" | "never";

interface RoutingIntent {
  severity: string;
  matched: boolean;
  response: string | null;
  routing: SeverityRouting | null;
  webhookMirror: WebhookMirrorPolicy | null;
  contractVersion: number;
}

function explainRouting(severity: string): RoutingIntent;
```

```typescript
const intent = explainRouting(alert.severity);
if (!intent.matched) console.log("No routing policy for this severity");
```

## Source Availability

Sources: `degraded.tsx` and `degraded-model.ts`.

```typescript
interface SourceStatusView {
  label: string;
  availability: DataAvailability;
}

function formatLastGood(lastGoodAt: string | null): string;
function sourceStatusHeadline(source: SourceStatusView): string;
function sourceStatusViews(payload: AlertsPayload): readonly SourceStatusView[];
function SourceStatus(props: { source: SourceStatusView }): ReactElement | null;
function SourceStatusBanners(props: { payload: AlertsPayload }): ReactElement;
```

```typescript
for (const source of sourceStatusViews(payload)) {
  console.log(sourceStatusHeadline(source));
}
```

A current source renders no banner.

## Secondary Tabs

Sources: `catalog/CatalogTab.tsx`, `catalog/catalog-model.ts`, `silences/SilencesTab.tsx`, and `apps/web/src/client/status/target-status.ts` (`RULE_HEALTH_STATUS`). Both tabs render the `@/ui` `DataTable`.

```typescript
function CatalogTab(props: { rules: readonly RuleState[] }): ReactElement;
const CATALOG_COLUMNS: (ColumnDef<RuleState> & { readonly id: string })[];
const RULE_HEALTH_STATUS: Readonly<Record<RuleState["health"], TargetStatus>>;
function ruleHealthStatus(health: RuleState["health"]): TargetStatus;

function SilencesTab(props: {
  silences: readonly ActiveSilence[];
  rowAction?: (silence: ActiveSilence) => ReactElement | null;
}): ReactElement;
const SILENCE_COLUMNS: readonly (ColumnDef<ActiveSilence> & { readonly id: string })[];
```

```tsx
<CatalogTab rules={payload.rules} />
<SilencesTab silences={payload.silences} />
```

## Action-Slot Seam

Sources: `constants.ts` and `detail/ActionSlots.tsx`.

```typescript
const ACTION_SLOTS = ["silence", "ack"] as const;
type ActionSlotName = "silence" | "ack";
interface ActionProps { alert: ActiveAlert }
function ActionSlots(props: { store: AppStore; alert: ActiveAlert }): ReactElement;
```

```typescript
// Slots are gated by canAct (mutations/gating.ts): an explicit `true` capability,
// never on wallboard density or under ?kiosk=1.
if (canAct(store, "silence")) {
  // The corresponding slot may render its affordance.
}
```

`SilenceAction` and `AckAction` currently implement `(props: ActionProps) => null`. Replace their bodies in place when the mutation layer is available; keep the slot names and prop shape stable.
