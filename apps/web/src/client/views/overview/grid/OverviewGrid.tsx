// apps/web/src/client/views/overview/grid/OverviewGrid.tsx — the grouped, keyboard-operable desk
// host grid. (The kiosk renders its own read-only tile wall: ../kiosk/KioskOverviewGrid.tsx.)
//
// One labelled `role="grid"`; each OverviewGroup is a `rowgroup` whose header row holds a real
// heading and a native collapse button, and each visible host is a `row` of gridcell buttons. The
// spatial controller (navigation.ts) owns tab stops, arrow movement and the single click activation
// path; wallboard composition suppresses selection there. Groups arrive already ordered — this
// module never re-sorts, re-groups or reads status beyond what HostCell/ServiceChip render.

import type { RefObject, ReactElement } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef } from "react";

import { Button, EmptyState, cn } from "@/ui";
import type { ChangeTracker, OverviewGroup, OverviewModel, SpatialGridController } from "../model.js";
import { HostCell } from "./HostCell.js";
import { createSpatialGridController } from "./navigation.js";

/** Props for the complete grouped host/service composite grid. */
export interface OverviewGridProps {
  /** Coherent ordered model derived from one accepted snapshot. */
  readonly model: OverviewModel;
  /** Estate display name used in the grid's accessible name. */
  readonly estateName: string;
  /** Persisted ids of groups currently collapsed. */
  readonly collapsedGroupIds: ReadonlySet<string>;
  /** Canonical selected target id, or null. */
  readonly selectedTargetId: string | null;
  /** True when the shell has selected wallboard density. */
  readonly wallboard: boolean;
  /** Shared target-status transition tracker scoped to the mounted view. */
  readonly changeTracker: ChangeTracker;
  /** Current media-query result for `prefers-reduced-motion: reduce`. */
  readonly reducedMotion: boolean;
  /** Toggles one persisted group id. */
  readonly onToggleGroup: (groupId: string) => void;
  /** Selects a canonical host or service target. */
  readonly onSelect: (drilldownId: string) => void;
}

/** Selector matching every roving target trigger. */
export const OVERVIEW_TARGET_SELECTOR = "[data-overview-target]" as const;

/** Copy for the zero-host estate. */
export const NO_HOSTS_TITLE = "No hosts in this estate" as const;
export const NO_HOSTS_DESCRIPTION = "The rendered estate declares no hosts." as const;

function hostCount(groups: readonly OverviewGroup[]): number {
  return groups.reduce((n, group) => n + group.hosts.length, 0);
}

function hostCountText(count: number): string {
  return count === 1 ? "1 host" : `${count} hosts`;
}

/** The shared empty state for a zero-host estate (desk and kiosk). */
export function NoHosts(): ReactElement {
  return (
    <div data-slot="overview-grid-empty">
      <EmptyState title={NO_HOSTS_TITLE} description={NO_HOSTS_DESCRIPTION} />
    </div>
  );
}

/** The grid root: groups stacked with a gap. */
const GRID_CLASS = "grid min-w-0 gap-3";
/** One group: header row above its hosts. */
const GROUP_CLASS = "grid min-w-0 gap-2";
/** The group heading (h2). */
const GROUP_HEADING_CLASS = "m-0 min-w-0 text-base font-semibold";

/**
 * A group's hosts: auto-fit tracks of at least 13.75rem (18rem and a wider gap at wallboard
 * density), one column below 480px.
 */
function hostsClass(wallboard: boolean): string {
  return cn(
    "group/hosts grid min-w-0 content-stretch max-[480px]:grid-cols-1 [&[hidden]]:hidden",
    wallboard ? "gap-3" : "gap-2",
    wallboard
      ? "grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))]"
      : "grid-cols-[repeat(auto-fit,minmax(min(100%,13.75rem),1fr))]",
  );
}

/**
 * Mount one spatial controller on `gridRef` while `mounted`, release it exactly once, and refresh it
 * after every commit that may change target membership.
 */
function useSpatialGrid(
  gridRef: RefObject<HTMLElement | null>,
  mounted: boolean,
  onActivate: (drilldownId: string) => void,
  membership: readonly unknown[],
): void {
  const activateRef = useRef(onActivate);
  activateRef.current = onActivate;
  const controllerRef = useRef<SpatialGridController | null>(null);

  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!mounted || element === null) return undefined;
    const controller = createSpatialGridController(element, {
      itemSelector: OVERVIEW_TARGET_SELECTOR,
      onActivate: (id) => activateRef.current(id),
    });
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.release();
    };
  }, [gridRef, mounted]);

  useLayoutEffect(() => {
    controllerRef.current?.refresh();
    // `membership` is the caller-supplied dependency list.
  }, membership);
}

/** Forget tracker state for ids no longer in the accepted model. */
function useRetainTargets(tracker: ChangeTracker, model: OverviewModel): void {
  useEffect(() => {
    tracker.retain(new Set(model.targetById.keys()));
  }, [tracker, model.targetById]);
}

interface GroupSectionProps {
  readonly group: OverviewGroup;
  readonly idPrefix: string;
  readonly collapsed: boolean;
  readonly wallboard: boolean;
  readonly selectedTargetId: string | null;
  readonly changeTracker: ChangeTracker;
  readonly reducedMotion: boolean;
  readonly onToggleGroup: (groupId: string) => void;
  readonly onSelect: (drilldownId: string) => void;
}

function GroupSection(props: GroupSectionProps): ReactElement {
  const { group, idPrefix, collapsed, wallboard, onToggleGroup } = props;
  const headingId = `${idPrefix}-heading`;
  const hostsId = `${idPrefix}-hosts`;
  return (
    <div role="rowgroup" className={GROUP_CLASS} data-group-id={group.id} aria-labelledby={headingId}>
      <div role="row" className="min-w-0">
        <div role="columnheader" className="min-w-0">
          <h2 id={headingId} className={GROUP_HEADING_CLASS}>
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-h-11 min-w-11 max-w-full items-baseline justify-start gap-2 px-2 text-start text-[length:inherit] font-semibold whitespace-normal [overflow-wrap:anywhere]"
              data-group-toggle=""
              aria-expanded={!collapsed}
              aria-controls={hostsId}
              onClick={() => onToggleGroup(group.id)}
            >
              <span>{group.label}</span>
              <span className="text-sm font-normal text-muted-foreground" data-slot="overview-group-count">
                {hostCountText(group.hosts.length)}
              </span>
            </Button>
          </h2>
        </div>
      </div>
      <div
        id={hostsId}
        className={hostsClass(wallboard)}
        data-layout="desk"
        hidden={collapsed}
      >
        {collapsed
          ? null
          : group.hosts.map((host) => (
              <HostCell
                key={host.drilldownId}
                host={host}
                selectedTargetId={props.selectedTargetId}
                changeTracker={props.changeTracker}
                reducedMotion={props.reducedMotion}
                onSelect={props.onSelect}
              />
            ))}
      </div>
    </div>
  );
}

/** Render the grouped, keyboard-operable overview grid or shared empty state. */
export function OverviewGrid(props: OverviewGridProps): ReactElement {
  const { model, estateName, collapsedGroupIds, selectedTargetId, changeTracker, reducedMotion, onToggleGroup } = props;
  const gridRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const hasHosts = hostCount(model.groups) > 0;

  // One stable selection callback for the whole mount: memoized cells never rerender because the
  // parent passed a fresh closure, and wallboard/kiosk suppression reads the latest props.
  const latest = useRef(props);
  latest.current = props;
  const select = useCallback((drilldownId: string) => {
    const current = latest.current;
    if (!current.wallboard) current.onSelect(drilldownId);
  }, []);

  useSpatialGrid(gridRef, hasHosts, select, [model.groups, collapsedGroupIds]);
  useRetainTargets(changeTracker, model);

  if (!hasHosts) return <NoHosts />;

  return (
    <div
      ref={gridRef}
      role="grid"
      className={GRID_CLASS}
      data-slot="overview-grid"
      data-layout="desk"
      aria-label={`${estateName} hosts`}
    >
      {model.groups.map((group, index) => (
        <GroupSection
          key={group.id}
          group={group}
          idPrefix={`${uid}-g${index}`}
          collapsed={collapsedGroupIds.has(group.id)}
          wallboard={props.wallboard}
          selectedTargetId={selectedTargetId}
          changeTracker={changeTracker}
          reducedMotion={reducedMotion}
          onToggleGroup={onToggleGroup}
          onSelect={select}
        />
      ))}
    </div>
  );
}
