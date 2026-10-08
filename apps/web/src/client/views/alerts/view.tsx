// src/client/views/alerts/view.tsx — the /alerts view.
//
// Same path, default export and `views/alerts/view` chunk key as the registry expects. The body reads
// ONE store payload (`readAlerts`, zero fan-out) and derives everything else from the URL: the active
// tab (`tab`, firing by omission), facet selection and `sel`. A PageErrorBoundary degrades any render
// fault in place so the shell keeps rendering.

import type { ReactElement } from "react";
import { useEffect, useRef } from "react";
import { useComputed, useSignal } from "@preact/signals-react";
import { useSignals } from "@preact/signals-react/runtime";

import {
  FragmentBoundary,
  Icon,
  LoadingState,
  PageErrorBoundary,
  PageHeader,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/ui";
import type { DataTableHandle, IconName } from "@/ui";
import type { ViewProps } from "../../../shared/registry.js";

import { facetValues, firingRows, readAlerts } from "./model.js";
import { FACET_DELIMITER, QUERY_KEYS, TARGET_ALIAS_KEY, decodeTriageRoute, encodeTriageState } from "./url-state.js";
import type { FacetSelection } from "./url-state.js";
import { matchesFacets } from "./facets.js";
import { TAB_QUERY_KEY, tabFromQuery } from "./view-model.js";
import type { TriageTabId } from "./view-model.js";
import { FacetBar } from "./facet-bar.js";
import { SourceStatusBanners } from "./degraded.js";
import { TriageTable } from "./table/TriageTable.js";
import { TriageKeyboardHints, installTriageKeyboard } from "./keyboard.js";
import { DetailPane } from "./detail/DetailPane.js";
import { CatalogTab } from "./catalog/CatalogTab.js";
import { SilencesTab } from "./silences/SilencesTab.js";
import { ExpireButton } from "../../mutations/ExpireButton.js";

/** Logs a view-level render fault; the boundary shows the fallback. No telemetry is emitted. */
function logViewFault(error: unknown): void {
  console.error("[alerts-view] render fault", error);
}

/** Tab definitions, in display order. */
const TABS: readonly { readonly id: TriageTabId; readonly label: string; readonly icon: IconName }[] = [
  { id: "firing", label: "Firing", icon: "triangle-alert" },
  { id: "catalog", label: "Catalog", icon: "list" },
  { id: "silences", label: "Silences", icon: "bell" },
];

/** The facet query keys (every QUERY_KEYS entry except `sel`) — replaced wholesale on a facet change. */
const FACET_QUERY_KEYS: readonly string[] = [
  QUERY_KEYS.severity,
  QUERY_KEYS.state,
  QUERY_KEYS.group,
  QUERY_KEYS.hostService,
  QUERY_KEYS.ruleFamily,
  QUERY_KEYS.ack,
];

/** Build a `?a=b` string (leading `?`, or "" when empty) from a flat query record. */
function toQueryString(query: Readonly<Record<string, string>>): string {
  const search = new URLSearchParams(query).toString();
  return search === "" ? "" : `?${search}`;
}

// ── the view ─────────────────────────────────────────────────────────────────────────────────────

/** Default export — the ComponentType<ViewProps> the registry loads. The boundary wraps the body so
 *  any render fault degrades in place. */
export default function AlertsView(props: ViewProps): ReactElement {
  return (
    <PageErrorBoundary
      pageSlot="alerts-page"
      title="The alerts view hit a rendering error"
      message="Reload to try again — other views are unaffected."
      onError={logViewFault}
    >
      <AlertsViewBody store={props.store} router={props.router} />
    </PageErrorBoundary>
  );
}

function AlertsViewBody({ store, router }: ViewProps): ReactElement {
  useSignals();
  // Route is a signal so back/forward + navigate re-render the view.
  const route = useSignal(router.current());
  useEffect(() => {
    const off = router.subscribe((m) => {
      route.value = m;
    });
    route.value = router.current(); // resync in case it changed between first render and effect
    return off;
  }, [router]);

  // Single store read — zero upstream fan-out. Signals auto-track.
  const payload = readAlerts(store);

  const activeTab = useComputed(() => tabFromQuery(route.value.query));
  // decodeTriageRoute also accepts the overview deep links (/alerts/:fingerprint, ?target=<id>).
  // `available` prunes the `target` alias to the kind the payload actually has (read inside the
  // computed so a new cycle re-derives it).
  const url = useComputed(() => {
    const p = readAlerts(store);
    return decodeTriageRoute(route.value, p === null ? null : facetValues(p).hostService);
  });
  // Read the store signal inside the computed so a new cycle re-derives the filtered rows.
  const filtered = useComputed(() => {
    const p = readAlerts(store);
    if (p === null) return [];
    const facets = url.value.facets;
    return firingRows(p).filter((a) => matchesFacets(p, a, facets));
  });

  const selectedIndex = useSignal(-1); // keyboard cursor into `filtered`
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<DataTableHandle>(null);

  /** Navigate to /alerts with `mutate` applied to a copy of the CURRENT query, so every other key
   *  (facets, tab, sel) survives; kiosk/rotate are carried by router.navigate (CARRIED_QUERY_KEYS).
   *  Always targets "/alerts", so a `/alerts/:fingerprint` path param never survives an interaction
   *  (closing the pane really closes it). A `target` alias is folded into canonical `hs` and dropped,
   *  so it can never re-apply after the operator edits the host/service facet. */
  const navigateQuery = (mutate: (query: Record<string, string>) => void): void => {
    const query: Record<string, string> = { ...router.current().query };
    // Fold a `/alerts/:fingerprint` selection into canonical `sel` first, so an unrelated interaction
    // (facet/tab change) keeps the pane open; a close still deletes `sel` inside `mutate`.
    const fingerprint = router.current().params["fingerprint"];
    if ((query[QUERY_KEYS.selected] ?? "") === "" && fingerprint !== undefined && fingerprint !== "") {
      query[QUERY_KEYS.selected] = fingerprint;
    }
    // Fold the `target` alias only once a payload exists; before that it stays in the URL so it can be
    // pruned to the matching kind when the payload lands.
    const p = readAlerts(store);
    if (query[TARGET_ALIAS_KEY] !== undefined && p !== null) {
      const hs = decodeTriageRoute(router.current(), facetValues(p).hostService).facets.hostService;
      delete query[TARGET_ALIAS_KEY];
      if (hs.length > 0) query[QUERY_KEYS.hostService] = [...hs].sort().join(FACET_DELIMITER);
    }
    mutate(query);
    router.navigate("/alerts" + toQueryString(query));
  };

  const setSelection = (fingerprint: string | null): void => {
    navigateQuery((query) => {
      if (fingerprint === null || fingerprint === "") delete query[QUERY_KEYS.selected];
      else query[QUERY_KEYS.selected] = fingerprint;
    });
  };
  const openAlert = (fingerprint: string): void => setSelection(fingerprint);
  const closePane = (): void => setSelection(null);

  const onTabChange = (id: string): void => {
    navigateQuery((query) => {
      if (id === "firing") delete query[TAB_QUERY_KEY];
      else query[TAB_QUERY_KEY] = id;
    });
  };

  const onFacetsChange = (facets: FacetSelection): void => {
    // encodeTriageState is the canonical (sorted, delimiter-joined) facet encoding; it is merged into
    // the current query so `tab`/`sel`/unrelated keys are preserved.
    const encoded = new URLSearchParams(encodeTriageState({ facets, selected: null }));
    navigateQuery((query) => {
      for (const key of FACET_QUERY_KEYS) delete query[key];
      for (const [key, value] of encoded) query[key] = value;
    });
    selectedIndex.value = -1; // the cursor indexes the filtered list, which just changed
  };

  // Install j/k/Enter/Esc once; getters read live signal values, so no re-install on data change.
  // The returned disposer fires on unmount.
  useEffect(
    () =>
      installTriageKeyboard({
        selectedIndex,
        rows: () => filtered.value,
        container: () => tableContainerRef.current,
        scrollToIndex: (index) => tableRef.current?.scrollToIndex(index),
        isFiringTabActive: () => activeTab.value === "firing",
        isPaneOpen: () => url.value.selected !== null,
        openAlert: (fp) => setSelection(fp),
        closePane: () => setSelection(null),
      }),
    [],
  );

  const tab = activeTab.value;
  const sourcesCurrent =
    payload !== null && payload.alertmanager.state === "current" && payload.vmalert.state === "current";

  // Only the active panel's content is built; Radix renders the inactive panels empty and hidden.
  let panel: ReactElement;
  if (payload === null) {
    // Pre-first-cycle: never a crash.
    panel = <LoadingState label="Loading alerts…" preset="table" />;
  } else if (tab === "catalog") {
    panel = <CatalogTab rules={payload.rules} />;
  } else if (tab === "silences") {
    panel = <SilencesTab silences={payload.silences} rowAction={(s) => <ExpireButton silence={s} store={store} />} />;
  } else {
    panel = (
      <>
        <SourceStatusBanners payload={payload} />
        <FacetBar
          values={facetValues(payload)}
          selection={url.value.facets}
          onChange={onFacetsChange}
          total={firingRows(payload).length}
          shown={filtered.value.length}
        />
        <TriageKeyboardHints />
        <TriageTable
          rows={filtered.value}
          selectedIndex={selectedIndex}
          onOpenAlert={openAlert}
          sourcesCurrent={sourcesCurrent}
          filtersExcludeAll={filtered.value.length === 0 && firingRows(payload).length > 0}
          containerRef={tableContainerRef}
          tableRef={tableRef}
        />
      </>
    );
  }

  return (
    <div data-slot="alerts-page" className="grid min-w-0 gap-4">
      <PageHeader title="Alerts" />
      {/* Controlled by the URL: a tab change navigates, and the route re-selects the tab. */}
      <Tabs value={tab} onValueChange={onTabChange} className="min-w-0 gap-4">
        <TabsList aria-label="Alert triage views">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} data-tab={t.id}>
              <Icon name={t.icon} />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((t) => (
          <TabsContent
            key={t.id}
            value={t.id}
            data-tab={t.id}
            // The firing panel holds focusable controls, so it is not a tab stop itself.
            {...(t.id === "firing" && payload !== null ? { tabIndex: -1 } : {})}
            {...(payload === null ? { "aria-busy": true } : {})}
            className="grid min-w-0 gap-3"
          >
            {t.id === tab ? panel : null}
          </TabsContent>
        ))}
      </Tabs>
      {/* Mounted once at view level; opens iff `sel` is set (unknown fingerprint → its own empty state). */}
      <FragmentBoundary label="Alert detail" resetKey={url.value.selected}>
        <DetailPane
          store={store}
          payload={payload}
          selected={url.value.selected}
          onClose={closePane}
          onSelect={openAlert}
        />
      </FragmentBoundary>
    </div>
  );
}
