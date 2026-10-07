// model.ts — the single implementation home of every overview-owned type and constant.
// Pure module: no React component imports, no I/O. Wire types stay authoritative in
// `@pulse/web-data/wire` and are imported type-only, never restated or re-exported.
// Function contracts over these types live in selectors.ts, preferences.ts, freshness.ts,
// history.ts, grid/navigation.ts, grid/change-marker.ts and kiosk/paging.ts. Component props
// and kiosk-hook interfaces are declared in their own component/hook modules.
import type {
  CheckSummary,
  DataAvailability,
  HistoryPayload,
  HostStatus,
  OverviewAlertSummary,
  OverviewSnapshotV2,
  ServiceStatus,
  TargetIdentity,
  TargetStatus,
} from "@pulse/web-data/wire";
import type { TimelineLane } from "@/ui";
import type { ApiFetchResult } from "../../api/client.js";

// ---------------------------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------------------------

/** Worst-first status order used by grouping, sorting, and deterministic ties. */
export const OVERVIEW_STATUS_ORDER = [
  "critical",
  "warning",
  "unknown",
  "suppressed",
  "ok",
] as const satisfies readonly TargetStatus[];

/** Locale-aware, numeric display-name comparator shared by every overview ordering operation. */
export const OVERVIEW_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

// ---------------------------------------------------------------------------------------------
// Canonical overview targets
// ---------------------------------------------------------------------------------------------

/** Target kind selectable in the overview grid. */
export type OverviewTargetKind = "host" | "service";

/** A canonical target with enough context to render its drawer. */
export interface OverviewTarget {
  /** Canonical wire identity. `identity.id` is the rendered drilldown identifier. */
  readonly identity: Extract<TargetIdentity, { readonly kind: OverviewTargetKind }>;
  /** Alias of `identity.id`, retained for map keys and DOM data attributes. */
  readonly drilldownId: string;
  /** Closed target kind. */
  readonly kind: OverviewTargetKind;
  /** Owning host object from the accepted snapshot. */
  readonly host: HostStatus;
  /** Service object for service targets; null for a host target. */
  readonly service: ServiceStatus | null;
}

// ---------------------------------------------------------------------------------------------
// Derived model
// ---------------------------------------------------------------------------------------------

/** User-selectable grouping dimensions. */
export type GroupMode = "class" | "status" | "name";

/** User-selectable host ordering dimensions. */
export type SortMode = "class" | "status" | "name";

/** One visible host group in deterministic order. */
export interface OverviewGroup {
  /** Stable group identity suitable for persistence and DOM ids. */
  readonly id: string;
  /** Human-readable section heading. */
  readonly label: string;
  /** Hosts in deterministic sort order. */
  readonly hosts: readonly HostStatus[];
}

/** Complete pure presentation model derived from one snapshot and one preference record. */
export interface OverviewModel {
  /** Ordered groups, including collapsed groups; rendering decides whether hosts are visible. */
  readonly groups: readonly OverviewGroup[];
  /** Canonical target lookup keyed by `TargetIdentity.id`. */
  readonly targetById: ReadonlyMap<string, OverviewTarget>;
  /** Statistics derived from the same snapshot. */
  readonly stats: OverviewStats;
  /** Already-filtered firing alert summaries from `snapshot.alerts`. */
  readonly firing: readonly OverviewAlertSummary[];
}

// ---------------------------------------------------------------------------------------------
// Preferences and persistence
// ---------------------------------------------------------------------------------------------

export const OVERVIEW_PREFERENCES_KEY = "pulse.web.overview.v1" as const;
/** Schema version written with every persisted preferences record. */
export const OVERVIEW_PREFERENCES_VERSION = 1 as const;
/** Most collapsed group ids a stored record may hold; a longer list is rejected, not truncated. */
export const MAX_COLLAPSED_GROUP_IDS = 256 as const;
/** Longest id a stored record may hold; a longer id is rejected, not truncated. */
export const MAX_PREFERENCE_ID_LENGTH = 512 as const;

/** The only overview-owned persistent state. */
export interface OverviewPreferencesV1 {
  /** Closed schema version. */
  readonly version: 1;
  /** Default `class`. */
  readonly groupBy: GroupMode;
  /** Default `status`; ties always resolve by name then drilldown id. */
  readonly sortBy: SortMode;
  /** Stable ids of collapsed groups. Groups are expanded when absent. */
  readonly collapsedGroupIds: readonly string[];
  /** Canonical selected target id, or null. */
  readonly selectedTargetId: string | null;
}

/** Preferences used when nothing valid is stored. */
export const DEFAULT_OVERVIEW_PREFERENCES: OverviewPreferencesV1 = {
  version: 1,
  groupBy: "class",
  sortBy: "status",
  collapsedGroupIds: [],
  selectedTargetId: null,
};

/** Guarded key/value storage adapter; every method absorbs expected storage failures. */
export interface OverviewPreferenceStorage {
  /** Return the stored string for `key`, or null when absent or unreadable. */
  get(key: string): string | null;
  /** Store `value` under `key`; an expected write failure is absorbed. */
  set(key: string, value: string): void;
  /** Remove `key`; used to clear invalid or future-version records. */
  remove(key: string): void;
}

/** Outcome of reading the persisted preference record. */
export type PreferenceReadResult =
  | {
      /** A valid stored record was read. */
      readonly status: "ok";
      /** The validated stored preferences. */
      readonly value: OverviewPreferencesV1;
    }
  | {
      /** No usable record; defaults apply. */
      readonly status: "defaulted";
      /** Always `DEFAULT_OVERVIEW_PREFERENCES`. */
      readonly value: OverviewPreferencesV1;
      /** Why defaults were used: no record, storage inaccessible, unparseable JSON, unsupported version, or failed field validation. */
      readonly reason: "missing" | "unavailable" | "malformed" | "unsupported" | "invalid";
    };

// ---------------------------------------------------------------------------------------------
// Estate statistics
// ---------------------------------------------------------------------------------------------

/** Count of targets per effective status; every field is a non-negative integer. */
export interface StatusCounts {
  /** Targets whose effective status is `ok`. */
  readonly ok: number;
  /** Targets whose effective status is `warning`. */
  readonly warning: number;
  /** Targets whose effective status is `critical`. */
  readonly critical: number;
  /** Targets whose effective status is `unknown`, including non-current evidence. */
  readonly unknown: number;
  /** Targets whose declared status is `suppressed`. */
  readonly suppressed: number;
}

/** Count of firing (unsilenced, uninhibited) alerts per severity; non-negative integers. */
export interface AlertSeverityCounts {
  /** Firing alerts with severity `critical`. */
  readonly critical: number;
  /** Firing alerts with severity `warning`. */
  readonly warning: number;
  /** Firing alerts with severity `info`. */
  readonly info: number;
}

/** Monitoring-coverage statistic; unavailable coverage is never rendered as zero gaps. */
export type CoverageStat =
  | {
      /** Coverage counts exist (possibly retained from a last-good cycle). */
      readonly status: "available";
      /** Declared targets represented by scrape configuration. */
      readonly covered: number;
      /** Declared targets without rendered coverage. */
      readonly gaps: number;
      /** Rendered targets that are not declared. */
      readonly extras: number;
      /** Evidence qualifying the retained counts; only `current` permits an affirmative current zero. */
      readonly availability: DataAvailability;
    }
  | {
      /** No coverage value exists in the snapshot. */
      readonly status: "unavailable";
      /** Evidence explaining why coverage is absent. */
      readonly availability: DataAvailability;
      /** Visible operator copy, e.g. “Coverage unavailable”. */
      readonly message: string;
    };

/** Evaluation-engine health statistic; never inferred from other signals. */
export type EngineOkStat =
  | {
      /** An engine health value exists in the snapshot. */
      readonly status: "available";
      /** Reported engine health; affirmative only when `availability` is current. */
      readonly ok: boolean;
      /** Evidence qualifying `ok`. */
      readonly availability: DataAvailability;
    }
  | {
      /** No engine health value exists in the snapshot. */
      readonly status: "unavailable";
      /** Evidence explaining why engine health is absent. */
      readonly availability: DataAvailability;
    };

/** Header statistics derived from one accepted snapshot. */
export interface OverviewStats {
  /** Host rollup status counts. */
  readonly hosts: StatusCounts;
  /** Individual service status counts. */
  readonly services: StatusCounts;
  /** Already-materialized firing counts by severity. */
  readonly firing: AlertSeverityCounts;
  /** Count of silenced alerts from `snapshot.alertCounts.silenced`. */
  readonly silenced: number;
  /** Count of inhibited alerts from `snapshot.alertCounts.inhibited`; supplementary only. */
  readonly inhibited: number;
  /** Monitoring coverage, or its unavailability. */
  readonly coverage: CoverageStat;
  /** Evaluation-engine health, or its unavailability. */
  readonly engine: EngineOkStat;
}

// ---------------------------------------------------------------------------------------------
// Firing ribbon
// ---------------------------------------------------------------------------------------------

export const KIOSK_ALERT_NAME_LIMIT = 5 as const;

/** Text-only kiosk ribbon content. */
export interface KioskFiringSummary {
  /** Firing counts by severity. */
  readonly counts: AlertSeverityCounts;
  /** Up to `KIOSK_ALERT_NAME_LIMIT` alert names in `compareFiringAlerts` order. */
  readonly names: readonly string[];
  /** Number of firing alerts not named; zero when all fit. */
  readonly overflow: number;
}

// ---------------------------------------------------------------------------------------------
// Drawer view model
// ---------------------------------------------------------------------------------------------

/** Snapshot-derived content of the drawer for one canonical target. */
export interface TargetDrawerModel {
  /** The canonical selected target. */
  readonly target: OverviewTarget;
  /** Effective status of the target after applying its governing evidence. */
  readonly status: TargetStatus;
  /** Evidence governing `status`. */
  readonly availability: DataAvailability;
  /** Live signals attributed to exactly this target. */
  readonly signals: readonly OverviewSnapshotV2["signals"][number][];
  /** Active alert summaries attributed to exactly this target. */
  readonly alerts: readonly OverviewAlertSummary[];
  /** Recent snapshot-backed check outcomes for this target. */
  readonly checks: readonly CheckSummary[];
  /** Deterministic `StatusTimeline` lanes built from `checks`. */
  readonly checkLanes: readonly TimelineLane[];
  /** Server-resolved Grafana link, or null when none is configured. */
  readonly grafana: {
    /** Validated dashboard UID. */
    readonly boardUid: string;
    /** Server-resolved safe dashboard URL. */
    readonly url: string;
  } | null;
}

// ---------------------------------------------------------------------------------------------
// Lazy history controller
// ---------------------------------------------------------------------------------------------

/** The fixed curated query behind the drawer's liveness sparkline. */
export const OVERVIEW_HISTORY_QUERY = "estate.liveness" as const;
/** The fixed range requested for the drawer's liveness sparkline. */
export const OVERVIEW_HISTORY_RANGE = "1h" as const;

/** Closed history error set; any other `ApiErrorCode` maps to `INTERNAL_ERROR`. */
export type HistoryErrorCode =
  | "INVALID_REQUEST"
  | "QUERY_NOT_FOUND"
  | "TARGET_NOT_FOUND"
  | "QUERY_NOT_APPLICABLE"
  | "RANGE_UNSUPPORTED"
  | "HISTORY_OVERLOADED"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_TIMEOUT"
  | "HISTORY_LIMIT_EXCEEDED"
  | "HISTORY_CANCELLED"
  | "MODEL_CHANGED"
  | "INTERNAL_ERROR";

/** Lazy liveness-history state for the selected target. */
export type TargetHistoryState =
  | {
      /** No target requested. */
      readonly status: "idle";
    }
  | {
      /** A request is in flight. */
      readonly status: "loading";
      /** Canonical drilldown id of the requested target. */
      readonly targetId: string;
    }
  | {
      /** A validated success is available. */
      readonly status: "ready";
      /** Canonical drilldown id the payload is attributed to. */
      readonly targetId: string;
      /** Validated payload with exactly one series for `targetId`; null samples remain null. */
      readonly payload: HistoryPayload;
      /** Controller clock time (ms) at which the payload was received; governs `HISTORY_TTL_MS`. */
      readonly receivedAt: number;
    }
  | {
      /** The request failed or returned an invalid payload. */
      readonly status: "error";
      /** Canonical drilldown id of the failed request. */
      readonly targetId: string;
      /** Closed failure code. */
      readonly code: HistoryErrorCode;
      /** Operator-facing inline error copy. */
      readonly message: string;
      /** Whether the retry control is offered. */
      readonly retryable: boolean;
    };

/** Injectable history transport; production uses `apiHistoryFetch`. */
export interface HistoryFetch {
  /** Fetch untrusted JSON. The controller validates it before constructing `HistoryPayload`. */
  (path: string, options?: { readonly signal?: AbortSignal }): Promise<ApiFetchResult<unknown>>;
}

/** Receives each state the history controller publishes. */
export type HistoryListener = (state: TargetHistoryState) => void;

/** Construction options for `createHistoryController`. */
export interface HistoryControllerOptions {
  /** Transport used for the single history request per load/retry. */
  readonly fetch: HistoryFetch;
  /** Millisecond clock for cache expiry; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Per-mounted-overview controller for lazy target liveness history. */
export interface HistoryController {
  /** Return the latest committed state. */
  readonly state: () => TargetHistoryState;
  /** Subscribe to every committed state transition. Returns an idempotent unsubscriber. */
  subscribe(listener: HistoryListener): () => void;
  /** Returns cached success within HISTORY_TTL_MS or starts one request for this target. */
  load(target: OverviewTarget): Promise<TargetHistoryState>;
  /** Retries the currently selected target with a new AbortController. */
  retry(): Promise<TargetHistoryState>;
  /** Abort obsolete work without converting user-driven cancellation into an error. */
  cancel(): void;
  /** Abort and clear cache/listeners. Idempotent. */
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Change markers
// ---------------------------------------------------------------------------------------------

export type ChangeMarkerKind = "animated" | "static";

/** One accepted status transition for a target. */
export interface StatusChange {
  /** Canonical drilldown id of the changed target. */
  readonly drilldownId: string;
  /** Effective status before the accepted snapshot. */
  readonly previous: TargetStatus;
  /** Effective status in the accepted snapshot. */
  readonly current: TargetStatus;
  /** `static` under reduced motion; otherwise `animated`. */
  readonly marker: ChangeMarkerKind;
}

/** Per-mount status-change detector that drives change markers. */
export interface ChangeTracker {
  /** First observation seeds state and returns null. Reorder/remount does not count as change. */
  observe(drilldownId: string, status: TargetStatus, reducedMotion: boolean): StatusChange | null;
  /** Remove identities absent from the accepted snapshot. */
  retain(ids: ReadonlySet<string>): void;
  /** Forget every observed identity; the next observation re-seeds. */
  clear(): void;
}

// ---------------------------------------------------------------------------------------------
// Effective status and surface state
// ---------------------------------------------------------------------------------------------

/** Exhaustive top-level overview delivery state. */
export type OverviewSurfaceState =
  | {
      /** No snapshot has been accepted yet. */
      readonly status: "loading";
      /** Visible loading copy. */
      readonly message: string;
    }
  | {
      /** No usable snapshot exists and transport has failed. */
      readonly status: "unavailable";
      /** Visible unavailable copy. */
      readonly message: string;
      /** Always true: the unavailable state offers retry. */
      readonly retryable: true;
    }
  | {
      /** A current accepted snapshot is available. */
      readonly status: "ready";
      /** The accepted snapshot rendered by every surface. */
      readonly snapshot: OverviewSnapshotV2;
      /** Always false in this state. */
      readonly stale: false;
    }
  | {
      /** The last accepted snapshot is retained while the feed is not current. */
      readonly status: "stale";
      /** The retained last-good snapshot. */
      readonly snapshot: OverviewSnapshotV2;
      /** Always true in this state. */
      readonly stale: true;
      /** `store.connection.value.lastGoodAt` epoch milliseconds, or null before any success. */
      readonly lastGoodAt: number | null;
    };

// ---------------------------------------------------------------------------------------------
// Spatial navigation
// ---------------------------------------------------------------------------------------------

/** Spatial arrow-key navigation over grid target triggers. */
export interface SpatialGridController {
  /** Return the target id owning the roving tab stop, or null when none. */
  readonly activeId: () => string | null;
  /** Move the roving tab stop and DOM focus to `id`. */
  focus(id: string): void;
  /** Re-query items and invalidate cached geometry after layout/membership changes. */
  refresh(): void;
  /** Detach listeners and observers; called once on unmount. */
  release(): void;
}

/** Options for `createSpatialGridController`. */
export interface SpatialGridOptions {
  /** CSS selector matching every roving target trigger. */
  readonly itemSelector: string;
  /** Invoked with the target id when a trigger is activated. */
  readonly onActivate: (id: string) => void;
}

// ---------------------------------------------------------------------------------------------
// Kiosk paging
// ---------------------------------------------------------------------------------------------

/** One deterministic kiosk page. */
export interface KioskPage {
  /** Zero-based page position. */
  readonly index: number;
  /** Hosts on this page in current group/sort order. */
  readonly hosts: readonly HostStatus[];
  /** Group labels repeated when a group spans pages. */
  readonly groupStarts: readonly {
    /** Stable `OverviewGroup.id` of the group starting or continuing here. */
    readonly groupId: string;
    /** Group heading text rendered on this page. */
    readonly label: string;
    /** Zero-based index into `hosts` where this group's hosts begin. */
    readonly hostOffset: number;
  }[];
}

/** Start offset of one page within a dwell cycle. */
export interface PageScheduleEntry {
  /** Zero-based page index. */
  readonly pageIndex: number;
  /** Milliseconds from cycle start at which the page becomes visible. */
  readonly startsAtMs: number;
}
