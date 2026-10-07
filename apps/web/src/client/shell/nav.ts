// shell/nav.ts — the sidebar's navigation model: order and grouping over the view registry. Pure: no
// DOM, no React. Kiosk rotation keeps its own order (`kiosk.ts`); this only shapes the sidebar.
import type { ViewDefinition } from "../../shared/registry.js";

/**
 * Nav order: `nav.order` ascending, `nav`-less views last, registry order as the tiebreak. Pure over
 * `views`; recomputed only when the registry identity changes (the registry is frozen at build time).
 */
export function orderedNavViews(views: readonly ViewDefinition[]): readonly ViewDefinition[] {
  return views
    .map((view, index) => ({ view, index }))
    .sort(
      (a, b) =>
        (a.view.nav?.order ?? Number.MAX_SAFE_INTEGER) -
          (b.view.nav?.order ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
    )
    .map((entry) => entry.view);
}

/** Sidebar group headings, in sidebar order. */
export const NAV_GROUP_ORDER = ["Overview", "Monitor", "Inventory", "System"] as const;
export type NavGroupLabel = (typeof NAV_GROUP_ORDER)[number];

/** The group each registered view sits under. A view missing here is listed last, ungrouped. */
export const VIEW_NAV_GROUP: Readonly<Record<string, NavGroupLabel>> = {
  overview: "Overview",
  alerts: "Monitor",
  timeline: "Monitor",
  estate: "Inventory",
  engine: "System",
};

export interface NavGroup {
  /** The group heading; `undefined` for views with no group. */
  label: NavGroupLabel | undefined;
  views: readonly ViewDefinition[];
}

/**
 * Group the views for the sidebar: known groups in `NAV_GROUP_ORDER`, then ungrouped views under no
 * heading. Within a group, views keep `orderedNavViews` order. Empty groups are dropped.
 */
export function groupNavViews(views: readonly ViewDefinition[]): NavGroup[] {
  const ordered = orderedNavViews(views);
  const groups: NavGroup[] = NAV_GROUP_ORDER.map((label) => ({
    label,
    views: ordered.filter((view) => VIEW_NAV_GROUP[view.id] === label),
  }));
  groups.push({ label: undefined, views: ordered.filter((view) => VIEW_NAV_GROUP[view.id] === undefined) });
  return groups.filter((group) => group.views.length > 0);
}
