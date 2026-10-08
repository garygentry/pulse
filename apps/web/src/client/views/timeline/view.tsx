// apps/web/src/client/views/timeline/view.tsx — the /timeline incident-reconstruction view (07 §3).
//
// Loaded by the frozen registry entry `load: () => import("./timeline/view.js").then((m) => m.default)`.
// The store is read ONLY through the model.ts readers (05 §3.1). The URL is the source of truth for
// range/end/zoom/sel (05 §4); every write goes through writeUrl and a 05 `with*` transition. Each
// region sits in its own RegionErrorBoundary (02 §9.1), the whole body in a PageErrorBoundary
// (02 §9.2) that keeps the timeline-page root and its h1. Kiosk is read from the URL only; the view owns no rotation (CON-08).

import type { ReactElement } from "react";
import { useEffect, useMemo, useRef } from "react";
import { batch, useComputed, useSignal, useSignalEffect } from "@preact/signals-react";
import { HISTORY_TTL_MS, type EndpointHistoryPayload, type OverviewSnapshotV2, type RangeId, type TimelineDomain, type TimelinePayload } from "@pulse/web-data/wire";

import { EmptyState, LoadingState, PageErrorBoundary, PageHeader, Callout, Section, StatusBadge, TARGET_STATUS, useDisposable } from "@/ui";
import { announce } from "../../a11y/index.js";
import { isKiosk } from "../../shell/kiosk.js";
import { createEstateClock } from "../../format.js";
import type { EstateClock } from "../../format.js";
import type { ViewProps } from "../../../shared/registry.js";

import { createLiveFollow, createTimeAxis } from "../_shared/timeseries/axis.js";
import type { TimeWindow } from "../_shared/timeseries/axis.js";
import { createRequestQueue, HISTORY_CONCURRENCY, LIVE_REFRESH_MS } from "../_shared/timeseries/history/client.js";
import type { HistoryRegionState, RequestQueue } from "../_shared/timeseries/history/client.js";
import { useHistory } from "../_shared/timeseries/history/use-history.js";
import { RegionErrorBoundary } from "../_shared/timeseries/history/boundary.js";
import { useNotCurrent } from "../_shared/timeseries/history/freshness.js";
import {
  buildLaneTree, createHostOrder, findLane, readTimeline, readTimelineConnectionPhase, readTimelineDelivery,
  readTimelineObservation, readTimelineSnapshot, targetKey,
} from "./model.js";
import type { LaneNode, LaneTree as LaneTreeModel, TargetKey } from "./model.js";
import {
  decodeTimelineUrl, encodeTimelineUrl, isCanonicalTimelineQuery, pausedWindowOutOfHistoryText,
  pausedWindowOutsideHistory, URL_CHANGE_MODE, validateSel, withPause, withRange, withResetZoom, withResume,
  withSel, withZoom,
} from "./url-state.js";
import type { TimelineUrlChange, TimelineUrlState, UrlFallbackNotice } from "./url-state.js";
import { COVERAGE_QUERY, RANGE_SECONDS, rangeExceedsMax, TIMELINE_RANGES } from "../_shared/timeseries/query-meta.js";
import { checkHistoryReachable, createLaneEvidenceCache, noDataSpans, problemHostKeys, requiredCheckEndpoints } from "./evidence.js";
import type { LaneEvidenceResult } from "./evidence.js";
import { createReadoutRegistry, CursorReadout } from "../_shared/timeseries/readout.js";
import { KioskStatusLine, TimelineControls, UrlNotices } from "./controls.js";
import { LaneEvidenceStatus, LaneTree } from "./lanes.js";
import { buildLaneBlocks, laneEvidence, regionData } from "./lanes-model.js";
import type { LaneEvidenceContext } from "./lanes-model.js";
import { AlertSwimlane } from "./swimlane.js";
import { TargetDetail } from "./detail.js";
import { installTimelineKeyboard, TimelineKeyboardHints } from "./keyboard.js";
import { useSignals } from "@preact/signals-react/runtime";

/** Route this view is mounted at; used for every timeline URL write. */
const TIMELINE_PATH = "/timeline";

/**
 * Placeholder effective step (seconds) until the first alerts payload reports
 * `effectiveStepSeconds`. Small on purpose, so the axis's "≥ MIN_ZOOM_STEPS steps" clamps are
 * permissive before real data arrives; replaced by the real step on first load (07 §3.6.1).
 */
const INITIAL_STEP_SECONDS = 60;

/**
 * `CursorReadout`'s `summaryId` (the id of its aria-live summary element). Every PlotOverlay's
 * `describedBy` and every chart's `readout.summaryId` point here (REQ-A11Y-03).
 */
const READOUT_ID = "pulse-timeline-readout";

/** View-level render fault (REQ-OBS-01): logged, the page keeps its root and h1. */
function logViewFault(error: unknown): void {
  console.error("[timeline-view] render fault", error);
}

/**
 * The /timeline incident-reconstruction view (timeline-view contract; REQ-EXPOSE-02).
 * Fills the pre-registered `timeline` slot. A PageErrorBoundary wraps the whole body,
 * so a render fault shows the page heading and an error state and never crashes the shell (REQ-OBS-01).
 *
 * @param props - Shell-provided store, router and optional rotation context (not read: CON-08).
 * @returns The page.
 */
export default function TimelineView(props: ViewProps): ReactElement {
  return (
    <PageErrorBoundary
      pageSlot="timeline-page"
      title="The timeline view hit a rendering error"
      message="Reload to try again — other views are unaffected."
      onError={logViewFault}
    >
      <TimelineViewBody store={props.store} router={props.router} />
    </PageErrorBoundary>
  );
}

/** Current time in whole epoch seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Equality for nullable windows. */
function sameWindow(a: TimeWindow | null, b: TimeWindow | null): boolean {
  return a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end);
}

/** Fallback estate used when no snapshot is held (00 §3.3): UTC, with the fallback marker shown. */
const FALLBACK_ESTATE: OverviewSnapshotV2["estate"] = { name: "", timezone: "UTC", tzFallback: true };

/** The (always empty) expansion set used in kiosk, so block identity stays stable. */
const NO_EXPANSION: ReadonlySet<TargetKey> = new Set();
/** Stable empty domain list (before the tree exists). */
const NO_DOMAINS: readonly TimelineDomain[] = Object.freeze([]);

/** No URL notices. */
const NO_NOTICES: readonly UrlFallbackNotice[] = [];

type CheckStates = ReadonlyMap<string, HistoryRegionState<EndpointHistoryPayload>>;

function TimelineViewBody({ store, router }: ViewProps): ReactElement {
  useSignals();
  // --- route (07 §3.2) ---
  const route = useSignal(router.current());
  useEffect(() => {
    const off = router.subscribe((m) => {
      route.value = m;
    });
    route.value = router.current(); // resync between first render and effect
    return off;
  }, [router]);

  const kiosk = useComputed(() => isKiosk(route.value.query));
  const decoded = useComputed(() => decodeTimelineUrl(route.value.query, nowSeconds())); // kiosk-aware (05)

  // --- store reads (model.ts only) and the lane tree (07 §3.7) ---
  const index = readTimeline(store);
  const snapshot = readTimelineSnapshot(store);
  const delivery = readTimelineDelivery(store);
  const generation = readTimelineObservation(store)?.generation ?? null;
  const notCurrent = useNotCurrent(readTimelineConnectionPhase(store), delivery.phase);

  const lastTree = useRef<LaneTreeModel | null>(null);
  const tree = useMemo(
    () => (snapshot !== null && index !== null ? buildLaneTree(snapshot, index) : null),
    [snapshot, index],
  );
  if (tree !== null) lastTree.current = tree;
  const shownTree = tree ?? lastTree.current; // keep the last lane tree when the index goes away

  // shownTree mirrored into a signal so the sel check can be computed (07 §3.12).
  const shownTreeSig = useSignal<LaneTreeModel | null>(null);
  useEffect(() => {
    shownTreeSig.value = shownTree;
  }, [shownTree]);
  const checked = useComputed(() => {
    const t = shownTreeSig.value;
    return t === null ? { state: decoded.value.state, notice: null } : validateSel(decoded.value.state, t);
  });
  const url = useComputed<TimelineUrlState>(() => checked.value.state);

  // --- per-mount objects (07 §3.3) ---
  const liveEnd = useSignal(nowSeconds());
  const domain = useComputed<TimeWindow>(() => {
    const end = url.value.end ?? liveEnd.value;
    return { start: end - RANGE_SECONDS[url.value.range], end };
  });
  const axis = useDisposable(
    () => createTimeAxis({ domain, initialZoom: url.peek().zoom, initialStepSeconds: INITIAL_STEP_SECONDS }),
    (a) => a.dispose(),
  );
  const readouts = useMemo(() => createReadoutRegistry(), []);
  const queue = useMemo(() => createRequestQueue(HISTORY_CONCURRENCY), []);
  const hostOrder = useMemo(createHostOrder, []);
  const evidenceCache = useMemo(() => createLaneEvidenceCache(), []);

  // --- canonical URL rewrite (07 §3.2, 05 §4.7); decode notices outlive the rewrite ---
  const stickyNotices = useSignal<readonly UrlFallbackNotice[]>(NO_NOTICES);
  useSignalEffect(() => {
    const query = route.value.query;
    const d = decoded.value;
    if (kiosk.value) return;
    if (d.notices.length > 0) stickyNotices.value = d.notices;
    if (!isCanonicalTimelineQuery(query, d.state)) {
      router.navigate(TIMELINE_PATH + encodeTimelineUrl(d.state, query), { replace: true });
    }
  });

  // --- URL writes (07 §3.4) ---
  const writeUrl = (next: TimelineUrlState, change: TimelineUrlChange): void => {
    if (kiosk.peek()) return;
    stickyNotices.value = NO_NOTICES; // a user-initiated write retires the fallback notices (07 §4.7)
    router.navigate(TIMELINE_PATH + encodeTimelineUrl(next, router.current().query), {
      replace: URL_CHANGE_MODE[change] === "replace",
    });
  };

  // URL → axis: reload, back/forward, shared link.
  useSignalEffect(() => {
    const u = url.value;
    batch(() => {
      if (!sameWindow(u.zoom, axis.zoom.peek())) axis.zoom.value = u.zoom;
      if (u.end === null && axis.pinned.peek()) axis.pinned.value = false; // a live URL has no pin
    });
  });

  // axis → URL: brush, keyboard zoom, reset, pin.
  useSignalEffect(() => {
    const z = axis.zoom.value;
    const pinned = axis.pinned.value;
    if (kiosk.peek()) return;
    const u = url.peek();
    const domainEnd = domain.peek().end;
    let next = u;
    let change: TimelineUrlChange | null = null;
    if (!sameWindow(z, u.zoom)) {
      next = z === null ? withResetZoom(u) : withZoom(u, z, domainEnd);
      change = z === null ? "reset-zoom" : "zoom";
    }
    if (pinned && next.end === null) {
      next = withPause(next, domainEnd);
      change ??= "cursor-pin";
    }
    if (change === null || (sameWindow(next.zoom, u.zoom) && next.end === u.end)) return; // no loop
    writeUrl(next, change);
  });

  /** Pause live follow at the current anchor (REQ-FOLLOW-02). No request is issued. */
  const pause = (): void => {
    const u = url.peek();
    if (kiosk.peek() || u.end !== null) return;
    writeUrl(withPause(u, domain.peek().end), "pause");
    announce("Live updates paused");
  };

  /** Resume live: clear pin, zoom and anchor; createLiveFollow's immediate tick refetches once. */
  const resume = (): void => {
    const u = url.peek();
    if (kiosk.peek() || (u.end === null && u.zoom === null)) return;
    axis.pinned.value = false; // first, so the axis→URL effect cannot re-pause
    writeUrl(withResume(u), "resume");
    axis.cursor.value = null;
    announce("Following live");
  };

  const toggleLive = (): void => (url.peek().end === null ? pause() : resume());

  /** Select a range; clears zoom and the cursor pin, keeps `end`. */
  const setRange = (range: RangeId): void => {
    const u = url.peek();
    if (range === u.range) return;
    writeUrl(withRange(u, range), "range");
    batch(() => {
      axis.pinned.value = false;
      axis.cursor.value = null;
    });
  };

  /** `[` / `]`: previous / next entry of TIMELINE_RANGES; clamps at the ends (no wrap). */
  const stepRange = (delta: -1 | 1): void => {
    const next = TIMELINE_RANGES[TIMELINE_RANGES.indexOf(url.peek().range) + delta];
    if (next !== undefined) setRange(next);
  };

  /** The next shorter range, or null at 1h (feeds "Try a shorter range", REQ-HISTERR-03). */
  const shorterRange = (): RangeId | null => TIMELINE_RANGES[TIMELINE_RANGES.indexOf(url.peek().range) - 1] ?? null;

  /** Select a host or service lane (REQ-CHART-01). Selecting the current selection is a no-op. */
  const select = (node: LaneNode): void => {
    const t = node.target;
    if (t.kind === "endpoint") return;
    const u = url.peek();
    if (u.sel !== null && u.sel.kind === t.kind && u.sel.id === t.id) return;
    writeUrl(withSel(u, node), "select");
  };

  /** Close the detail region. */
  const clearSelection = (): void => writeUrl(withSel(url.peek(), null), "select");

  // --- live follow (07 §3.5) ---
  const isLive = useComputed(() => url.value.end === null && axis.zoom.value === null && !axis.pinned.value);
  useEffect(() => {
    const follow = createLiveFollow({
      isLive,
      intervalMs: LIVE_REFRESH_MS,
      onTick: () => {
        liveEnd.value = nowSeconds();
      },
    });
    return () => follow.dispose();
  }, []);

  // --- requests (07 §3.6) ---
  const range = url.value.range;
  const end = domain.value.end;

  const alerts = useHistory(index === null ? null : ({ op: "alerts", range } as const), {
    queue,
    priority: 0,
    end,
    generation,
    notApplicable: index !== null && !index.alertHistory.ranges.includes(range)
      ? "Alert history is not available at this range."
      : null,
  });
  const coverage = useHistory({ op: "estate", queryId: COVERAGE_QUERY, range } as const, {
    queue,
    priority: 0,
    end,
    generation,
    notApplicable: rangeExceedsMax(COVERAGE_QUERY, range) ? "Coverage is not available at this range." : null,
  });

  const alertsData = regionData(alerts.state);
  const coverageData = regionData(coverage.state);

  // The resolution label and zoom clamps follow the lane data's real step (REQ-ZOOM-03).
  useEffect(() => {
    if (alertsData !== null) axis.stepSeconds.value = alertsData.effectiveStepSeconds;
  }, [alertsData]);

  // --- frozen order, expansion, blocks (07 §3.7) ---
  const orderedHosts = shownTree === null ? [] : hostOrder.order({
    tree: shownTree,
    range,
    end: url.value.end,
    alertsFetchedAt: alerts.state.phase === "ready" ? alerts.state.data.fetchedAt : null,
    problems: () => (alertsData === null ? new Set<TargetKey>() : problemHostKeys(shownTree, alertsData.lanes, domain.value)),
  });

  const expanded = useSignal<ReadonlySet<TargetKey>>(new Set());
  const domainsExpanded = useSignal(false);
  const toggle = (key: TargetKey | "domains"): void => {
    if (kiosk.peek()) return;
    if (key === "domains") {
      domainsExpanded.value = !domainsExpanded.value;
      return;
    }
    const next = new Set(expanded.value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded.value = next;
  };

  const isKioskNow = kiosk.value;
  const expandedNow = isKioskNow ? NO_EXPANSION : expanded.value;
  const domainsExpandedNow = !isKioskNow && domainsExpanded.value;
  const domainsPresent = shownTree?.domains ?? NO_DOMAINS;
  const blocks = useMemo(
    () => (shownTree === null ? [] : buildLaneBlocks(orderedHosts, expandedNow, domainsPresent, domainsExpandedNow)),
    [orderedHosts, expandedNow, domainsPresent, domainsExpandedNow],
  );

  // --- check evidence loaders (07 §3.6.3; gated by index membership, 09 §1) ---
  const reachable = useMemo(() => (key: string) => checkHistoryReachable(key, index), [index]);
  const checkStates = useSignal<CheckStates>(new Map());
  const checkEndpoints = shownTree === null ? [] : requiredCheckEndpoints(shownTree, expandedNow, reachable);
  const reportCheck = (endpoint: string, state: HistoryRegionState<EndpointHistoryPayload> | null): void => {
    const next = new Map(checkStates.peek());
    if (state === null) next.delete(endpoint);
    else next.set(endpoint, state);
    checkStates.value = next;
  };

  // --- evidence (07 §5.3) ---
  const domainNow = domain.value;
  const alertsFetchedAt = alertsData?.fetchedAt ?? null;
  const noData = useMemo(
    () => (coverageData === null ? null : noDataSpans(coverageData, domainNow, alertsFetchedAt)),
    [coverageData, alertsFetchedAt, domainNow.start, domainNow.end],
  );
  const checkStatesNow = checkStates.value;
  const evidence = useMemo(() => {
    const ctx: LaneEvidenceContext = {
      alertLanes: alertsData?.lanes ?? null,
      noData,
      lookup: (e) => checkStatesNow.get(e),
      expanded: expandedNow,
      window: domainNow,
      cache: evidenceCache,
      reachable,
    };
    return new Map<string, LaneEvidenceResult>(
      blocks.flatMap((b) => b.rows).map((row) => [row.key, laneEvidence(row, ctx)] as const),
    );
  }, [blocks, alertsData, noData, checkStatesNow, expandedNow, reachable, domainNow.start, domainNow.end]);

  // Drop cached segments for lanes that are no longer shown (05 §5.12).
  useEffect(() => {
    const live = new Set<string>();
    for (const b of blocks) {
      for (const row of b.rows) live.add(row.key);
    }
    evidenceCache.prune(live);
  }, [blocks]);

  // --- clock (07 §3.8) ---
  const clock = useMemo(
    () => createEstateClock(snapshot?.estate ?? FALLBACK_ESTATE),
    [snapshot?.estate.timezone, snapshot?.estate.tzFallback],
  );

  // --- view shortcuts (07 §9; desk only) ---
  useEffect(() => {
    if (isKioskNow) return undefined; // no shortcuts in kiosk (REQ-KIOSK-03)
    return installTimelineKeyboard({
      resetZoom: () => axis.reset(),
      toggleLive,
      previousRange: () => stepRange(-1),
      nextRange: () => stepRange(1),
    });
  }, [isKioskNow]);

  // --- render ---
  const u = url.value;
  const selNotice = checked.value.notice;
  const decodeNotices = decoded.value.notices;
  const baseNotices = isKioskNow || decodeNotices.length > 0 ? decodeNotices : stickyNotices.value;
  const notices = selNotice !== null ? [...baseNotices, selNotice] : baseNotices;
  const historyNotice = pausedWindowOutsideHistory(u, nowSeconds()) ? pausedWindowOutOfHistoryText(u.range) : null;
  const stepSeconds = alertsData === null ? null : axis.stepSeconds.value;
  const shorter = shorterRange();
  const onShorterRange = shorter === null ? null : () => setRange(shorter);
  const selNode = u.sel !== null && shownTree !== null ? findLane(shownTree, u.sel) : null;
  const selKey = selNode === null ? null : targetKey(selNode.target);

  let lanesRegion: ReactElement;
  if (shownTree === null) {
    lanesRegion =
      !notCurrent && (snapshot === null || delivery.phase === "initial") ? (
        <LoadingState label="Loading timeline…" preset="lines" rows={8} />
      ) : (
        <EmptyState
          icon="wifi-off"
          title="Timeline index unavailable"
          description="The timeline index has not been received from the Pulse web tier. Lanes appear when it arrives."
        />
      );
  } else {
    const status = (
      <LaneEvidenceStatus
        sources={[
          { source: "Alert history (vmalert)", state: alerts.state, onRetry: alerts.retry },
          { source: "Coverage (VictoriaMetrics)", state: coverage.state, onRetry: coverage.retry },
        ]}
        clock={clock}
        onShorterRange={onShorterRange}
      />
    );
    lanesRegion =
      shownTree.hosts.length === 0 && shownTree.domains.length === 0 ? (
        <Section title="Status lanes" headingId="timeline-lanes-title" data-slot="timeline-lanes">
          {status}
          <EmptyState
            icon="info"
            title="No hosts declared"
            description="The rendered estate declares no hosts, so there are no status lanes."
          />
        </Section>
      ) : (
        <LaneTree
          blocks={blocks}
          evidence={evidence}
          selected={isKioskNow ? null : selKey}
          axis={axis}
          readouts={readouts}
          clock={clock}
          interactive={!isKioskNow}
          readoutId={READOUT_ID}
          status={status}
          onToggle={toggle}
          onSelect={select}
          reachable={reachable}
          liveTailSeconds={isLive.value ? Math.max(2 * (stepSeconds ?? 0), HISTORY_TTL_MS / 1000) : 0}
        />
      );
  }

  return (
    <div
      data-slot="timeline-page"
      data-kiosk={isKioskNow ? "true" : undefined}
      className="flex min-w-0 flex-col gap-4 p-4 [@media(max-width:30rem)]:gap-2 [@media(max-width:30rem)]:p-2"
    >
      {isKioskNow ? (
        <PageHeader
          title="Timeline"
          meta={
            <RegionErrorBoundary label="Timeline controls">
              <KioskStatusLine range={u.range} clock={clock} stepSeconds={stepSeconds} />
            </RegionErrorBoundary>
          }
        />
      ) : (
        <PageHeader
          title="Timeline"
          actions={
            <RegionErrorBoundary label="Timeline controls">
              <TimelineControls
                range={u.range}
                pausedAt={u.end}
                zoomed={axis.zoom.value !== null}
                stepSeconds={stepSeconds}
                clock={clock}
                onRange={setRange}
                onPause={pause}
                onResume={resume}
                onResetZoom={() => axis.reset()}
              />
            </RegionErrorBoundary>
          }
        />
      )}
      <UrlNotices notices={notices} historyNotice={historyNotice} />
      {notCurrent ? <NotCurrentBanner index={index} clock={clock} /> : null}
      {!isKioskNow ? (
        <RegionErrorBoundary label="Cursor readout">
          <div data-slot="timeline-readout-slot" className="sticky top-14 z-10 bg-background">
            <CursorReadout summaryId={READOUT_ID} axis={axis} registry={readouts} clock={clock} variant="panel" />
          </div>
        </RegionErrorBoundary>
      ) : null}
      <RegionErrorBoundary label="Status lanes">{lanesRegion}</RegionErrorBoundary>
      {shownTree !== null ? (
        <RegionErrorBoundary label="Alert history" resetKey={range}>
          <AlertSwimlane
            state={alerts.state}
            onRetry={alerts.retry}
            onShorterRange={onShorterRange}
            tree={shownTree}
            axis={axis}
            readouts={readouts}
            clock={clock}
            interactive={!isKioskNow}
            readoutId={READOUT_ID}
            onNavigate={(href) => router.navigate(href)}
          />
        </RegionErrorBoundary>
      ) : null}
      {!isKioskNow && selNode !== null && selKey !== null ? (
        <RegionErrorBoundary label="Selected target" resetKey={selKey}>
          <TargetDetail
            node={selNode}
            range={range}
            end={end}
            generation={generation}
            queue={queue}
            axis={axis}
            readouts={readouts}
            clock={clock}
            readoutId={READOUT_ID}
            onClose={clearSelection}
            reachable={reachable}
          />
        </RegionErrorBoundary>
      ) : null}
      {!isKioskNow ? <TimelineKeyboardHints /> : null}
      {checkEndpoints.map((endpoint) => (
        <EndpointCheckLoader
          key={endpoint}
          endpoint={endpoint}
          range={range}
          end={end}
          generation={generation}
          queue={queue}
          report={reportCheck}
        />
      ))}
    </div>
  );
}

/** Persistent not-current banner (07 §3.8). The last lane tree stays rendered beneath it. */
function NotCurrentBanner(props: { readonly index: TimelinePayload | null; readonly clock: EstateClock }): ReactElement {
  const since = props.index === null ? "—" : props.clock.format(props.index.generatedAt);
  return (
    <Callout tone="neutral" role="status" compact>
      <span className="inline-flex flex-wrap items-center gap-2">
        {StatusBadge.fromMap(TARGET_STATUS, "unknown", { label: "Not current" })}
        <span>Timeline index not current since {since}</span>
      </span>
    </Callout>
  );
}

/** Render-nothing loader: owns one endpoint's checks request and reports its region state (07 §3.6.3). */
function EndpointCheckLoader(props: {
  /** Gatus endpoint key (listed in the index: requiredCheckEndpoints applies the gate). */ readonly endpoint: string;
  /** Selected range. */ readonly range: RangeId;
  /** Current window end (key component). */ readonly end: number;
  /** Server generation (key component). */ readonly generation: string | null;
  /** Page queue. */ readonly queue: RequestQueue;
  /** Receives this endpoint's region state on every change, and null on unmount. */
  readonly report: (endpoint: string, state: HistoryRegionState<EndpointHistoryPayload> | null) => void;
}): null {
  const { state } = useHistory(
    { op: "checks", endpoint: props.endpoint, range: props.range } as const,
    { queue: props.queue, priority: 2, end: props.end, generation: props.generation },
  );
  useEffect(() => {
    props.report(props.endpoint, state);
  }, [state]);
  useEffect(() => () => props.report(props.endpoint, null), []);
  return null;
}
