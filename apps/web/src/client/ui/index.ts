/**
 * `@/ui` — deck's component library.
 *
 * Primitives are vendored shadcn/ui source (`components.json`): owned here and
 * editable. Record any local edit in a header comment on the primitive so a later
 * `shadcn diff` stays readable. Feature code imports from this barrel, not from
 * the individual files.
 */

export { cn } from "./lib/utils";
export { useIsMobile } from "./hooks/use-mobile";
export { FALLBACK_ICON, ICONS, isIconName, type IconName } from "./lib/icons";
export { Icon, type IconProps } from "./patterns/icon";
export { formatAge, formatRelative, formatTimestamp } from "./lib/format";
export {
  TONES,
  defineStatusMap,
  type StatusMap,
  type StatusPresentation,
  type Tone,
} from "./lib/status";

export * from "./primitives/alert-dialog";
export * from "./primitives/alert";
export * from "./primitives/badge";
export * from "./primitives/breadcrumb";
export * from "./primitives/button";
export * from "./primitives/card";
export * from "./primitives/checkbox";
export * from "./primitives/collapsible";
export * from "./primitives/command";
export * from "./primitives/dialog";
export * from "./primitives/dropdown-menu";
export * from "./primitives/input";
export * from "./primitives/kbd";
export * from "./primitives/label";
export * from "./primitives/popover";
export * from "./primitives/radio-group";
export * from "./primitives/scroll-area";
export * from "./primitives/select";
export * from "./primitives/separator";
export * from "./primitives/sheet";
export * from "./primitives/sidebar";
export * from "./primitives/skeleton";
export * from "./primitives/table";
export * from "./primitives/tabs";
export * from "./primitives/textarea";
export * from "./primitives/toggle-group";
export * from "./primitives/toggle";
export * from "./primitives/tooltip";

// §C Page scaffolding & feedback
export { slugify, pageHeadingId } from "./lib/dom-id";
export { usePageHeadingId } from "./hooks/use-page-heading-id";
export { PageHeader, type PageHeaderProps, type BreadcrumbEntry } from "./patterns/page-header";
export { Section, type SectionProps } from "./patterns/section";
export { EmptyState, type EmptyStateProps } from "./patterns/empty-state";
export { ErrorState, type ErrorStateProps } from "./patterns/error-state";
export { LoadingState, type LoadingPreset, type LoadingStateProps } from "./patterns/loading-state";
export { Callout, calloutRole, type CalloutProps, type CalloutRole } from "./patterns/callout";
export { PageErrorBoundary, type PageErrorBoundaryProps } from "./patterns/page-error-boundary";
export { FragmentBoundary, type FragmentBoundaryProps } from "./patterns/fragment-boundary";

// §G Interaction hooks
export {
  isHandledIntent,
  nearestSurvivor,
  nextGPending,
  nextListIndex,
  resolveListIntent,
  type ListNavConfig,
  type ListNavContext,
  type ListNavIntent,
  type ListNavKeyEvent,
  type ListNavOrigin,
  type ListNavPreset,
} from "./lib/list-navigation";
export { cssEscape, focusIsLost, isEditableTarget, isTextEntryTarget } from "./lib/dom";
export { APP_TITLE, formatDocumentTitle } from "./lib/document-title";
export { useListNavigation, type UseListNavigationOptions } from "./hooks/use-list-navigation";
export { hashTargetId, useScrollToHash, type UseScrollToHashOptions } from "./hooks/use-scroll-to-hash";
export { useDocumentTitle } from "./hooks/use-document-title";

// §D Content & data display
export {
  EmptyValue,
  KeyValue,
  KeyValueList,
  NotDeclared,
  NotObserved,
  NotSupplied,
  type KeyValueItem,
  type KeyValueLayout,
  type KeyValueListProps,
  type KeyValueProps,
} from "./patterns/key-value-list";
export { ComparisonGrid, type ComparisonGridProps, type ComparisonRow } from "./patterns/comparison-grid";
export { StatGrid, StatTile, type StatTileProps } from "./patterns/stat-tile";
export { Meter, type MeterProps } from "./patterns/meter";
export { CodeBlock, type CodeBlockProps } from "./patterns/code-block";
export { useCopyToClipboard, type CopyState } from "./hooks/use-copy-to-clipboard";
export { LogOutput, type LogOutputProps } from "./patterns/log-output";
export { useStickToBottom } from "./hooks/use-stick-to-bottom";
export { Prose, type ProseProps } from "./patterns/prose";
export { Disclosure, type DisclosureProps } from "./patterns/disclosure";
export {
  ShowMore,
  ShowMoreControls,
  type ShowMoreControlsProps,
  type ShowMoreProps,
} from "./patterns/show-more";
export { useShowMore, type ShowMoreState, type UseShowMoreOptions } from "./hooks/use-show-more";

// §A Foundations (remainder) + §B Status
export { useNow } from "./hooks/use-now";
export { useDisposable } from "./hooks/use-disposable";
export { VisuallyHidden, type VisuallyHiddenProps } from "./patterns/visually-hidden";
export { SafeRouteLink, type SafeRouteLinkProps } from "./patterns/safe-route-link";
export { ExternalLink, type ExternalLinkProps } from "./patterns/external-link";
export {
  StatusBadge,
  type StatusBadgeMapProps,
  type StatusBadgeProps,
  type StatusBadgeSize,
  type StatusBadgeVariant,
} from "./patterns/status-badge";
export { RelativeTime, type RelativeTimeProps } from "./patterns/relative-time";
export {
  FRESHNESS_STATUS,
  FreshnessBadge,
  freshnessTitle,
  type FreshnessBadgeProps,
} from "./patterns/freshness-badge";
export type { FreshnessStamp, FreshnessState } from "./lib/freshness";
export { HealthPill, type HealthPillProps } from "./patterns/health-pill";

// §E Collections
export {
  DataTable,
  DATA_TABLE_VIRTUALIZE_DEFAULTS,
  ROW_LINK_ATTRIBUTE,
  ROW_LINK_SELECTOR,
  type DataTableHandle,
  type DataTableProps,
  type DataTableScrollAlign,
  type DataTableVirtualizeOptions,
} from "./patterns/data-table";
export type { ColumnDef } from "@tanstack/react-table";
export {
  List,
  ListGroup,
  ListItem,
  type ListGroupProps,
  type ListItemProps,
  type ListProps,
  type ListVariant,
} from "./patterns/list";
export { LinkTile, type LinkTileProps } from "./patterns/link-tile";
export { CardGrid, type CardGridProps } from "./patterns/card-grid";
export { columnsFromOffsets } from "./lib/grid";
export {
  TREE_VIEW_VIRTUALIZE_DEFAULTS,
  TreeView,
  type TreeNodeState,
  type TreeViewProps,
  type TreeViewVirtualizeOptions,
} from "./patterns/tree-view";
export {
  ancestorIds,
  filterTreeNodes,
  isLeafNode,
  textPredicate,
  visibleTreeRows,
  type FilteredTree,
  type TreeAccessors,
  type TreeEntry,
  type VisibleTreeRow,
} from "./lib/tree";

// §F Filtering & search
export {
  applyFilters,
  countActiveCriteria,
  describeActiveFilters,
  emptyCriteria,
  facetCounts,
  hasActiveCriteria,
  matchesCriteria,
  normalizeQuery,
  removeActiveFilter,
  toggleValue,
  type ActiveFilter,
  type DescribeOptions,
  type FacetValue,
  type FilterAccessors,
  type FilterCriteria,
  type FilterResult,
} from "./lib/filters";
export {
  useFacetFilters,
  type FacetFiltersState,
  type UseFacetFiltersOptions,
} from "./hooks/use-facet-filters";
export { SearchInput, type SearchInputProps } from "./patterns/search-input";
export { FacetFilter, type FacetFilterProps, type FacetOption } from "./patterns/facet-filter";
export { ActiveFilters, type ActiveFiltersProps } from "./patterns/active-filters";
export { ResultCount, type ResultCountProps } from "./patterns/result-count";
export { FilterBar, type FilterBarProps } from "./patterns/filter-bar";
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from "./patterns/segmented-control";
export {
  CommandPalette,
  commandGroupsFromIndex,
  type CommandGroupsOptions,
  type CommandIndexEntry,
  type CommandPaletteGroup,
  type CommandPaletteItem,
  type CommandPaletteProps,
} from "./patterns/command-palette";
export * from "./status";

// Viz (pulse)
export * from "./viz";
