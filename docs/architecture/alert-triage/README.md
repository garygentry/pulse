# Alert Triage

Alert Triage is the read-only `/alerts` workspace in the Pulse web application. It gives operators one place to filter active alerts, inspect routing and suppression context, review bounded firing history, browse the rule catalog and active silences, and move through large alert sets with the keyboard. It deliberately preserves degraded and stale source states instead of turning missing data into a false all-clear.

This feature is part of the private `@pulse/web` application. It is not a published package and has no public package export map.

## Quick Start

Run the web application with committed engine fixtures:

```bash
bun install
bun run dev:web --mock
```

Open `http://127.0.0.1:8080/alerts`.

Useful URL examples:

```text
/alerts
/alerts?sev=critical,warning&state=firing
/alerts?group=database&hs=host:web01
/alerts?family=capacity&sel=<alert-fingerprint>
/alerts?tab=catalog
/alerts?tab=silences
/alerts/<alert-fingerprint>           # inbound deep link; canonicalizes to ?sel=
/alerts?target=<target-id>            # inbound target filter; canonicalizes to ?hs=
```

Query values are URL encoded normally. Multi-select facet values are comma-separated and canonicalized in sorted order.

## Operator Workflow

1. Start on the **Firing** tab. Alertmanager and vmalert availability banners appear when either source is not current.
2. Narrow the list with severity, delivery state, group, host/service, or rule-family facets.
3. Open an alert from its name button, press `Enter` on the keyboard-selected row, or follow a shared URL containing `sel`.
4. Inspect labels, annotations, intended versus actual routing, matching silences, firing history, and alerts on the same rendered target.
5. Press `Escape` or close the detail sheet to return to the list. The URL remains the source of truth, so browser Back and Forward restore tabs, filters, and selection.

Keyboard shortcuts on the Firing tab:

| Key | Action |
|---|---|
| `J` | Move to the next firing row |
| `K` | Move to the previous firing row |
| `Enter` | Open the selected row |
| `Escape` | Close the detail sheet |

The shortcuts do not override native input or interactive-control behavior.

## Key Concepts

### One payload, client-side derivation

The view reads `store.alerts` once per render cycle as an `AlertsPayload`. Sorting and source normalization belong to the web data tier. Facets, rule-family joins, selected-alert resolution, and related-alert lookup are pure client-side derivations and do not refetch upstream data.

### URL-owned triage state

The active tab, five facet selections, and selected alert fingerprint live in the route query. This makes triage links shareable and gives browser history deterministic behavior. The router continues to carry shell-owned `kiosk` and `rotate` parameters.

### Never silent green

Alertmanager and vmalert availability are evaluated independently. Stale, unavailable, and unconfigured states render named status banners with last-good context. An empty list is called “No firing alerts” only when both sources are current; otherwise the view says firing alerts are unavailable.

### Read-only detail with a mutation seam

The detail sheet is read-only in this release. Stable `silence` and `ack` action-slot regions already exist, but affordances render only when `store.session` explicitly grants the matching capability. The current placeholder actions render nothing.

### Bounded on-demand history

Opening an alert with a history reference issues one `GET /api/history/alerts?range=…` request. The request is aborted when the selection changes or closes. Every returned lane is shown, including unmatched lanes; an overflow response renders an explicit unavailable state rather than partial history.

## Module Map

| Area | Location | Responsibility |
|---|---|---|
| Composition | `apps/web/src/client/views/alerts/view.tsx` | Tabs, route synchronization, store read, filtering, keyboard lifecycle, detail sheet |
| URL codec | `apps/web/src/client/views/alerts/url-state.ts` | Canonical facet and selection query encoding/decoding |
| Model selectors | `apps/web/src/client/views/alerts/model.ts` | Payload narrowing and ordered pure selectors |
| Facets | `facets.ts`, `facet-bar.tsx` | OR-within/AND-across filtering and controls |
| Triage table | `table/` | Virtualized rows, status columns, delegated row opening |
| Detail sheet | `detail/` | Metadata, routing, silences, history, related alerts, action slots |
| Secondary tabs | `catalog/`, `silences/` | Rule catalog and active-silence tables |
| Source degradation | `degraded.tsx` | Named availability banners and last-good display |
| Taxonomy | `taxonomy.ts`, `routing-explain.ts` | Severity presentation and read-only routing intent |
| Styling | Tailwind token classes in each component | No view stylesheet; status colours come from `@/ui` status maps (see [Web UI](../ui.md)) |

## Configuration

Alert Triage has no feature-specific environment variables. It depends on the web application’s alerts payload and same-origin history route. The history range defaults to `24h`; the closed supported range set is `1h`, `6h`, `24h`, and `7d`.

## When to Use

Use Alert Triage to:

- investigate currently firing Alertmanager alerts;
- preserve and share a filtered investigation state;
- understand suppression, routing intent, and actual receivers;
- correlate an alert with bounded interval history and exact target identity;
- browse the current vmalert rule catalog and active silences.

## When Not to Use

Do not use this view to:

- create silences or acknowledge alerts until mutation capabilities are implemented;
- infer that an empty table is healthy while either source is degraded;
- query arbitrary history or perform analytics beyond the bounded alert-history contract;
- import alert-view modules as a public library API;
- contact Alertmanager or vmalert directly from the browser.

## Further Reading

- [Architecture](./architecture.md) — component boundaries, data flow, degradation, and design rationale
- [API Reference](./api-reference.md) — internal TypeScript contracts and extension seams
- [Integration Guide](./guides/integration.md) — route, store, history, action-slot, and test integration
- [Web App](../web-app/README.md) — service runtime and HTTP APIs
- [Web Foundation](../web-foundation/README.md) — router, store, lazy views, and browser test infrastructure
