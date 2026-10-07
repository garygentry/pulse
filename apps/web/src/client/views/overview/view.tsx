// src/client/views/overview/view.tsx — the overview view component.
//
// Top-level composition only: reads `store.snapshot` / `store.connection` / `store.route` /
// `store.density` (never fetches the overview endpoint or subscribes to SSE — live-state owns it),
// derives ONE OverviewSurfaceState and ONE OverviewModel per render, and hands that same model to
// StatHeader, FiringRibbon, the grid and the drawer. Presentation preferences are read, reconciled
// and written through preferences.ts with a guarded browser-storage adapter. Selection is canonical
// (`TargetIdentity.id`); the store's name-based `selection` is only a compatibility mirror.
// `?kiosk=1` implies wallboard, suppresses the drawer and the grouping controls, fits the page to the
// viewport below the shell chrome and pages the grid. Feed freshness is the shell's top-bar indicator.
// The page sits in a PageErrorBoundary; the stat header, ribbon and drawer each in a
// FragmentBoundary. The grid is not wrapped, so its render-count contract is untouched.

import type { CSSProperties, ReactElement } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ViewProps } from "../../../shared/registry.js";
import { cn, FragmentBoundary, PageErrorBoundary, PageHeader, SegmentedControl, useDisposable } from "@/ui";
import { announce } from "../../a11y/index.js";
import { createEstateClock, TZ_FALLBACK_MARKER } from "../../format.js";
import type { EstateClock } from "../../format.js";
import { TargetDrawer, toStoreSelection } from "./drawer/TargetDrawer.js";
import { OVERVIEW_LOADING_MESSAGE, deriveOverviewSurfaceState } from "./freshness.js";
import { createChangeTracker } from "./grid/change-marker.js";
import { memoWithEquality, shallowEqualProps } from "./grid/memo.js";
import { KioskOverviewGrid, OVERVIEW_TARGET_SELECTOR, OverviewGrid } from "./grid/OverviewGrid.js";
import { apiHistoryFetch, createHistoryController } from "./history.js";
import type { KioskPagingClock } from "./kiosk/useKioskPaging.js";
import { useViewportTop } from "./kiosk/useViewportTop.js";
import { MAX_COLLAPSED_GROUP_IDS } from "./model.js";
import type {
  GroupMode,
  HistoryFetch,
  OverviewModel,
  OverviewPreferenceStorage,
  OverviewPreferencesV1,
  SortMode,
} from "./model.js";
import { browserPreferenceStorage } from "./preference-storage.js";
import { readOverviewPreferences, reconcileOverviewPreferences, writeOverviewPreferences } from "./preferences.js";
import { FiringRibbon } from "./ribbon/FiringRibbon.js";
import { deriveOverviewModel, deriveTargetDrawerModel } from "./selectors.js";
import { StatHeader } from "./stats/StatHeader.js";
import type { StatHeaderProps } from "./stats/StatHeader.js";
import { OverviewSurfaceNotice } from "./stats/SurfaceNotice.js";
import { useSignals } from "@preact/signals-react/runtime";

/** Announced when a refresh removes the target whose drawer was open. */
export const SELECTED_TARGET_GONE_MESSAGE = "Selected target is no longer in the estate.";

/** Visible labels of the grouping/sorting controls and their closed option sets. */
export const GROUP_BY_LABEL = "Group by";
export const SORT_BY_LABEL = "Sort by";
const MODE_OPTIONS: readonly { readonly value: GroupMode & SortMode; readonly label: string }[] = [
  { value: "class", label: "Class" },
  { value: "status", label: "Status" },
  { value: "name", label: "Name" },
];

/**
 * Injection seams for tests and browser fixtures. Production passes none of these: storage wraps
 * `window.localStorage`, history uses the shared API client, reload reloads the page.
 */
export interface OverviewCompositionProps extends ViewProps {
  /** Preference storage; `undefined` → guarded `window.localStorage`, `null` → no persistence. */
  readonly storage?: OverviewPreferenceStorage | null;
  /** History transport for the drawer's liveness sparkline. */
  readonly historyFetch?: HistoryFetch;
  /** Page-level recovery action for the unavailable state. */
  readonly onReload?: () => void;
  /** Deterministic kiosk paging clock. */
  readonly kioskClock?: KioskPagingClock;
}

function reloadPage(): void {
  (globalThis as { location?: { reload?: () => void } }).location?.reload?.();
}

// Selection, collapse and control changes re-render the composition; the header and ribbon skip
// those renders unless their own inputs changed. The surface is compared
// field-wise because deriveOverviewSurfaceState builds a fresh object every render.
const StableStatHeader = memoWithEquality(
  StatHeader,
  (a: Readonly<StatHeaderProps>, b: Readonly<StatHeaderProps>) =>
    a.stats === b.stats && a.clock === b.clock && shallowEqualProps(a.surface, b.surface),
);
const StableFiringRibbon = memoWithEquality(FiringRibbon, shallowEqualProps);

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Live `prefers-reduced-motion: reduce` result; false when `matchMedia` is unavailable. */
function useReducedMotion(): boolean {
  const read = (): MediaQueryList | null => {
    const matchMedia = (globalThis as { matchMedia?: (query: string) => MediaQueryList }).matchMedia;
    if (typeof matchMedia !== "function") return null;
    try {
      return matchMedia(REDUCED_MOTION_QUERY);
    } catch {
      return null;
    }
  };
  const [reduced, setReduced] = useState(() => read()?.matches === true);
  useEffect(() => {
    const list = read();
    if (list === null || typeof list.addEventListener !== "function") return undefined;
    const onChange = (): void => setReduced(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** Whether keyboard focus has been lost (body/null/detached), e.g. after its trigger unmounted. */
function focusLost(): boolean {
  const doc = (globalThis as { document?: Document }).document;
  if (doc === undefined) return false;
  const active = doc.activeElement;
  return active === null || active === doc.body || !active.isConnected;
}

/** Move lost focus to the grid's roving tab stop, else its first target, else the grid region. */
function rescueFocus(region: HTMLElement | null): void {
  if (region === null || !focusLost()) return;
  const stop =
    region.querySelector<HTMLElement>(`${OVERVIEW_TARGET_SELECTOR}[tabindex="0"]`) ??
    region.querySelector<HTMLElement>(OVERVIEW_TARGET_SELECTOR);
  (stop ?? region).focus();
}

function toggleCollapsed(ids: readonly string[], groupId: string): readonly string[] | null {
  if (ids.includes(groupId)) return ids.filter((id) => id !== groupId);
  // The persisted list is capped; past the cap a collapse stays expanded rather than
  // producing a record the validator would reject.
  return ids.length >= MAX_COLLAPSED_GROUP_IDS ? null : [...ids, groupId];
}

/** One labelled single-choice layout control; `data-control` names it for tests. */
function LayoutChoice(props: {
  readonly control: "group-by" | "sort-by";
  readonly label: string;
  readonly value: GroupMode;
  readonly onChange: (mode: GroupMode) => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2" data-control={props.control}>
      <span className="text-sm font-medium" aria-hidden="true">
        {props.label}
      </span>
      <SegmentedControl
        label={props.label}
        options={MODE_OPTIONS}
        value={props.value}
        onValueChange={props.onChange}
        className="[&>button]:min-h-11 [&>button]:min-w-11"
      />
    </div>
  );
}

/** Grouping/sorting controls (desk/mobile only; hidden in kiosk). */
function OverviewControls(props: {
  readonly groupBy: GroupMode;
  readonly sortBy: SortMode;
  readonly onGroupBy: (mode: GroupMode) => void;
  readonly onSortBy: (mode: SortMode) => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2" role="group" aria-label="Overview layout" data-controls="">
      <LayoutChoice control="group-by" label={GROUP_BY_LABEL} value={props.groupBy} onChange={props.onGroupBy} />
      <LayoutChoice control="sort-by" label={SORT_BY_LABEL} value={props.sortBy} onChange={props.onSortBy} />
    </div>
  );
}

/** The page heading id; the loading/unavailable page is labelled by it. */
const PAGE_TITLE_ID = "overview-page-title";
export const OVERVIEW_PAGE_TITLE = "Overview";
export const OVERVIEW_PAGE_ERROR_TITLE = "The overview hit a rendering error";

/** Page header meta: the estate zone every absolute time is shown in, plus the UTC fallback marker. */
function ZoneMeta({ clock }: { readonly clock: EstateClock }): ReactElement {
  return (
    <span className="text-sm text-muted-foreground" data-zone="">
      Times in {clock.timezone}
      {clock.tzFallback ? (
        <>
          {" · "}
          <span data-tz-fallback="">{TZ_FALLBACK_MARKER}</span>
        </>
      ) : null}
    </span>
  );
}

/**
 * The drawer's modal Sheet sets `pointer-events: none` on `<body>`. The property inherits, so it
 * would restyle every grid element on open (tens of ms at 100 hosts). An explicit value on the page
 * root stops the cascade there; behaviour is unchanged because the modal overlay covers the page.
 * (The scroll lock's custom property is registered non-inherited in styles/app.css.)
 */
const MODAL_LOCK_ISOLATION = "pointer-events-auto";

/** Root layout: a single column; kiosk is a fixed-height grid whose last row (the pages) takes the rest. */
function rootClass(kiosk: boolean, wallboard: boolean): string {
  return cn(
    "grid min-w-0 content-start gap-4",
    MODAL_LOCK_ISOLATION,
    wallboard && "gap-6",
    kiosk && "h-[calc(100dvh-var(--overview-kiosk-top,0px))] grid-rows-[auto_auto_auto_minmax(0,1fr)] content-stretch p-4",
  );
}

const GRID_REGION_CLASS =
  "min-w-0 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 group-data-[kiosk=true]/page:min-h-0";

/** The overview composition with explicit test/fixture seams (see {@link OverviewCompositionProps}). */
export function OverviewComposition(props: OverviewCompositionProps): ReactElement {
  return (
    <PageErrorBoundary title={OVERVIEW_PAGE_ERROR_TITLE} message="Reload to try again — other views are unaffected.">
      <OverviewPage {...props} />
    </PageErrorBoundary>
  );
}

function OverviewPage(props: OverviewCompositionProps): ReactElement {
  useSignals();
  const { store, router } = props;

  // Signals are read directly during render — never copied into state.
  const snapshot = store.snapshot.value;
  const surface = deriveOverviewSurfaceState(store);
  const kiosk = store.route.value.query.kiosk === "1";
  const wallboard = kiosk || store.density.value === "wallboard";

  // Per-mount resources: storage adapter, change tracker, lazy history controller.
  const [storage] = useState(() => (props.storage !== undefined ? props.storage : browserPreferenceStorage()));
  const [changeTracker] = useState(createChangeTracker);
  const history = useDisposable(
    () => createHistoryController({ fetch: props.historyFetch ?? apiHistoryFetch }),
    (h) => h.dispose(),
  );
  const reducedMotion = useReducedMotion();

  // Preferences: read and validated once on mount; restored selection activates only once a model
  // exists and survives reconciliation.
  const [preferences, setPreferences] = useState<OverviewPreferencesV1>(() => readOverviewPreferences(storage).value);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const commitPreferences = useCallback(
    (next: OverviewPreferencesV1): void => {
      if (next === preferencesRef.current) return;
      preferencesRef.current = next;
      setPreferences(next);
      writeOverviewPreferences(storage, next);
    },
    [storage],
  );

  // One model per accepted snapshot + grouping/sort; the previous model feeds structural sharing and
  // is only replaced after a successful derivation. Collapse/selection never regroup.
  const previousModel = useRef<OverviewModel | undefined>(undefined);
  const model = useMemo(
    () => (snapshot === null ? null : deriveOverviewModel(snapshot, preferences, previousModel.current)),
    [snapshot, preferences.groupBy, preferences.sortBy],
  );
  if (model !== null) previousModel.current = model;
  const modelRef = useRef(model);
  modelRef.current = model;

  const clock = useMemo(
    () => (snapshot === null ? null : createEstateClock(snapshot.estate)),
    [snapshot?.estate.timezone, snapshot?.estate.tzFallback],
  );

  // The canonical selected target as rendered this commit: absent from the model → none (the
  // reconciliation effect below then clears it everywhere); kiosk → never rendered.
  const selectedTarget =
    model !== null && preferences.selectedTargetId !== null
      ? (model.targetById.get(preferences.selectedTargetId) ?? null)
      : null;
  const drawerTarget = kiosk ? null : selectedTarget;
  const drawerModel = useMemo(
    () => (snapshot !== null && drawerTarget !== null ? deriveTargetDrawerModel(snapshot, drawerTarget) : null),
    [snapshot, drawerTarget],
  );

  const gridRegionRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const kioskTop = useViewportTop(rootRef, kiosk);

  // Reconcile persisted group/selection ids against every accepted model.
  useLayoutEffect(() => {
    if (model === null) return;
    const current = preferencesRef.current;
    const reconciled = reconcileOverviewPreferences(current, model);
    if (reconciled === current) return;
    const lostSelection = current.selectedTargetId !== null && reconciled.selectedTargetId === null;
    commitPreferences(reconciled);
    if (lostSelection) {
      history.cancel();
      if (!kiosk) announce(SELECTED_TARGET_GONE_MESSAGE);
    }
  }, [model, preferences, commitPreferences, history, kiosk]);

  // Mirror the rendered drawer target into the store's compatibility selection; kiosk clears it and
  // cancels in-flight history. Writes only once a model exists.
  const drawerTargetId = drawerTarget?.drilldownId ?? null;
  const hasModel = model !== null;
  useEffect(() => {
    if (!hasModel) return;
    if (drawerTarget === null) {
      if (store.selection.value !== null) store.selection.value = null;
      history.cancel();
      return;
    }
    store.selection.value = toStoreSelection(drawerTarget);
  }, [hasModel, drawerTargetId, store, history]);

  // After the drawer closes (Escape, close button, disappearance) the drawer returns focus to its
  // trigger (a tick later, once Radix releases the trap) when that node is still connected; when
  // focus is lost now, land on the roving tab stop, a surviving grid target or the grid region.
  const hadDrawer = useRef(false);
  useEffect(() => {
    const open = drawerModel !== null;
    if (hadDrawer.current && !open) rescueFocus(gridRegionRef.current);
    hadDrawer.current = open;
  }, [drawerModel]);

  const onSelect = useCallback(
    (drilldownId: string): void => {
      if (store.route.value.query.kiosk === "1") return;
      const target = modelRef.current?.targetById.get(drilldownId);
      if (target === undefined) return;
      commitPreferences({ ...preferencesRef.current, selectedTargetId: target.drilldownId });
    },
    [store, commitPreferences],
  );
  const onClose = useCallback((): void => {
    commitPreferences({ ...preferencesRef.current, selectedTargetId: null });
  }, [commitPreferences]);
  const onToggleGroup = useCallback(
    (groupId: string): void => {
      const current = preferencesRef.current;
      const collapsedGroupIds = toggleCollapsed(current.collapsedGroupIds, groupId);
      if (collapsedGroupIds !== null) commitPreferences({ ...current, collapsedGroupIds });
    },
    [commitPreferences],
  );
  const onGroupBy = useCallback(
    (groupBy: GroupMode): void => {
      if (groupBy !== preferencesRef.current.groupBy) commitPreferences({ ...preferencesRef.current, groupBy });
    },
    [commitPreferences],
  );
  const onSortBy = useCallback(
    (sortBy: SortMode): void => {
      if (sortBy !== preferencesRef.current.sortBy) commitPreferences({ ...preferencesRef.current, sortBy });
    },
    [commitPreferences],
  );

  const collapsedGroupIds = useMemo(() => new Set(preferences.collapsedGroupIds), [preferences.collapsedGroupIds]);

  const ready =
    surface.status !== "loading" && surface.status !== "unavailable" && model !== null && clock !== null && snapshot !== null;

  let body: ReactElement;
  if (!ready) {
    // No accepted snapshot: explicit loading/not-ready or unavailable state — never a blank or
    // synthesized-healthy grid.
    const notice =
      surface.status === "loading" || surface.status === "unavailable"
        ? surface
        : ({ status: "loading", message: OVERVIEW_LOADING_MESSAGE } as const);
    body = <OverviewSurfaceNotice surface={notice} onReload={props.onReload ?? reloadPage} />;
  } else {
    const gridProps = {
      model,
      estateName: snapshot.estate.name,
      collapsedGroupIds,
      selectedTargetId: drawerTarget?.drilldownId ?? null,
      wallboard,
      changeTracker,
      reducedMotion,
      onToggleGroup,
      onSelect,
    };
    body = (
      <>
        <FragmentBoundary label="Estate statistics">
          <StableStatHeader stats={model.stats} surface={surface} clock={clock} />
        </FragmentBoundary>
        <FragmentBoundary label="Firing alerts">
          <StableFiringRibbon
            alerts={model.firing}
            router={router}
            clock={clock}
            kiosk={kiosk}
            alertsCurrent={surface.status === "ready" && snapshot.sources.alerts.ok}
            alertsLastGoodAt={snapshot.sources.alerts.lastSuccess}
          />
        </FragmentBoundary>
        {kiosk ? null : (
          <OverviewControls
            groupBy={preferences.groupBy}
            sortBy={preferences.sortBy}
            onGroupBy={onGroupBy}
            onSortBy={onSortBy}
          />
        )}
        <div ref={gridRegionRef} className={GRID_REGION_CLASS} data-slot="overview-grid-region" tabIndex={-1}>
          {kiosk ? (
            <KioskOverviewGrid
              {...gridProps}
              rotation={props.rotation ?? null}
              {...(props.kioskClock !== undefined ? { clock: props.kioskClock } : {})}
            />
          ) : (
            <OverviewGrid {...gridProps} />
          )}
        </div>
        {drawerModel !== null ? (
          <FragmentBoundary label="Target details">
            <TargetDrawer open={true} model={drawerModel} history={history} clock={clock} onClose={onClose} />
          </FragmentBoundary>
        ) : null}
      </>
    );
  }

  // One root element in every state, so the kiosk offset measurement always tracks the live node.
  const kioskStyle = kiosk ? ({ "--overview-kiosk-top": `${kioskTop}px` } as CSSProperties) : undefined;
  return (
    <section
      ref={rootRef}
      data-slot="overview-page"
      className={cn("group/page", rootClass(kiosk, wallboard))}
      style={kioskStyle}
      {...(ready ? { "aria-label": `${snapshot.estate.name} overview` } : { "aria-labelledby": PAGE_TITLE_ID })}
      data-surface={ready ? surface.status : surface.status === "unavailable" ? "unavailable" : "loading"}
      data-kiosk={kiosk ? "true" : "false"}
    >
      <PageHeader id={PAGE_TITLE_ID} title={OVERVIEW_PAGE_TITLE} meta={ready ? <ZoneMeta clock={clock} /> : null} />
      {body}
    </section>
  );
}

/** The overview screen: stats, firing ribbon, grouped grid and the selected-target drawer. */
export function OverviewView(props: ViewProps): ReactElement {
  return <OverviewComposition {...props} />;
}
