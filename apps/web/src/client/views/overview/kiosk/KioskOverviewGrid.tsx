// apps/web/src/client/views/overview/kiosk/KioskOverviewGrid.tsx — the kiosk tile wall.
//
// One flat, worst-first list of read-only KioskTiles (no group sections: each tile carries its class
// label). The list is a labelled `role="list"`, not a grid: kiosk is unattended, so no tile is
// focusable and nothing selects. The tile grid uses fixed-height rows and auto-fill column tracks;
// useKioskPaging reads both from the rendered list and pages the hosts columns × rows at a time. The
// "i / P" indicator sits in a fixed footer row under the tile region, beside the estate time zone. This never drives shell rotation.

import type { ReactElement, ReactNode, RefObject } from "react";
import { useEffect, useMemo, useRef } from "react";

import type { HostStatus } from "@pulse/web-data/wire";
import type { ViewRotationContext } from "../../../../shared/registry.js";
import { cn } from "@/ui";
import { NoHosts } from "../grid/OverviewGrid.js";
import type { ChangeTracker, KioskPage, OverviewModel } from "../model.js";
import { deriveKioskHosts } from "../selectors.js";
import { KioskTile } from "./KioskTile.js";
import { useKioskPaging } from "./useKioskPaging.js";
import type { KioskPagingClock } from "./useKioskPaging.js";

/** Inputs for the kiosk tile wall. */
export interface KioskOverviewGridProps {
  /** Coherent model derived from one accepted snapshot. */
  readonly model: OverviewModel;
  /** Shared target-status transition tracker scoped to the mounted view. */
  readonly changeTracker: ChangeTracker;
  /** Current media-query result for `prefers-reduced-motion: reduce`. */
  readonly reducedMotion: boolean;
  /** Current shell rotation context (`ViewProps.rotation ?? null`). */
  readonly rotation: ViewRotationContext | null;
  /** The estate time-zone note (the kiosk page header that shows it on the desk is hidden). */
  readonly zone?: ReactNode;
  /** The page root's offset below the shell chrome: a change re-measures before paint. */
  readonly layoutKey?: unknown;
  /** Optional deterministic paging clock; omitted in production. */
  readonly clock?: KioskPagingClock;
}

/**
 * The tile list: fixed-height rows (two lines of wallboard text) and auto-fill tracks at least 56
 * spacing units wide, so a short last page keeps full-size tiles. Paging reads the computed tracks.
 */
const TILE_LIST_CLASS = cn(
  "m-0 grid min-w-0 list-none content-start gap-2 p-0",
  "grid-cols-[repeat(auto-fill,minmax(min(100%,calc(var(--spacing)*56)),1fr))] auto-rows-[calc(var(--spacing)*15)]",
);

function KioskPageView(props: {
  readonly page: KioskPage;
  readonly total: number;
  readonly listRef: RefObject<HTMLUListElement | null>;
  readonly changeTracker: ChangeTracker;
  readonly reducedMotion: boolean;
}): ReactElement {
  const { page, total, listRef, changeTracker, reducedMotion } = props;
  return (
    <div
      className={cn(
        "min-w-0",
        !reducedMotion && "animate-in fade-in duration-(--motion-base) ease-(--motion-ease) motion-reduce:animate-none",
      )}
      data-slot="overview-kiosk-page"
      data-page-index={page.index}
      data-fade={reducedMotion ? "false" : "true"}
    >
      <ul
        ref={listRef}
        role="list"
        className={TILE_LIST_CLASS}
        data-slot="overview-grid"
        data-layout="kiosk"
        aria-label={total > 1 ? `Overview hosts, page ${page.index + 1} of ${total}` : "Overview hosts"}
      >
        {page.hosts.map((host) => (
          <KioskTile key={host.drilldownId} host={host} changeTracker={changeTracker} reducedMotion={reducedMotion} />
        ))}
      </ul>
    </div>
  );
}

/** Render the paged, read-only kiosk tile wall or the shared empty state. */
export function KioskOverviewGrid(props: KioskOverviewGridProps): ReactElement {
  const { model, changeTracker, reducedMotion } = props;
  const previousHosts = useRef<readonly HostStatus[] | undefined>(undefined);
  const hosts = useMemo(() => deriveKioskHosts(model.groups, previousHosts.current), [model.groups]);
  previousHosts.current = hosts;

  const regionRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const paging = useKioskPaging({
    hosts,
    rotation: props.rotation,
    regionRef,
    gridRef: listRef,
    layoutKey: props.layoutKey,
    ...(props.clock !== undefined ? { clock: props.clock } : {}),
  });

  // Forget tracker state for ids no longer in the accepted model.
  useEffect(() => {
    changeTracker.retain(new Set(model.targetById.keys()));
  }, [changeTracker, model.targetById]);

  const page = paging.pages[paging.activePageIndex] ?? paging.pages[0];
  if (page === undefined) return <NoHosts />;
  const total = paging.pages.length;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-1" data-slot="overview-kiosk">
      <div ref={regionRef} className="min-h-0 flex-1 overflow-hidden" data-slot="overview-kiosk-region">
        <KioskPageView
          key={page.index}
          page={page}
          total={total}
          listRef={listRef}
          changeTracker={changeTracker}
          reducedMotion={reducedMotion}
        />
      </div>
      {/* The footer row is always there, so the region's height (and with it the capacity) never
          depends on whether the indicator shows. */}
      <div className="flex h-6 shrink-0 items-center justify-between gap-4 overflow-hidden whitespace-nowrap" data-slot="overview-kiosk-footer">
        <div className="min-w-0 truncate">{props.zone}</div>
        {paging.indicatorLabel !== null ? (
          <span
            className="shrink-0 text-sm text-muted-foreground tabular-nums"
            data-slot="overview-kiosk-indicator"
            role="note"
            aria-label={paging.indicatorLabel}
          >
            {`${page.index + 1} / ${total}`}
          </span>
        ) : null}
      </div>
    </div>
  );
}
