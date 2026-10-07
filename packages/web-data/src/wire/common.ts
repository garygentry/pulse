// packages/web-data/src/wire/common.ts — authoritative browser-safe common wire
// contracts (01-core-definitions.md §§2, 4, 8, 9). No Node/Bun, runtime renderer,
// source implementation, CIDR, audit, or app dependency may enter this module's
// runtime graph. The single `SourceErrorKind` reference below is an erased type-only
// import, so `/wire` stays free of any source runtime module.

import type { SourceErrorKind } from "../sources/types.js";

// ---------------------------------------------------------------------------
// §2 Fixed identifiers and limits
// ---------------------------------------------------------------------------

/** Closed set of current-data view identities. */
export type ViewId = "overview" | "alerts" | "estate" | "engine" | "timeline";
/** Closed set of fixed upstream source identities, including slow/optional sources. */
export type SourceId =
  | "victoriametrics-signals" | "victoriametrics-targets" | "victoriametrics-buildinfo"
  | "alertmanager-alerts" | "alertmanager-silences" | "alertmanager-status"
  | "alertmanager-receivers" | "vmalert-rules" | "gatus-statuses" | "grafana-health";
/** Strong content identity string of the form `sha256:<hex>`. */
export type HashId = `sha256:${string}`;
/** Closed component/source health vocabulary. */
export type HealthState = "healthy" | "unhealthy" | "unknown" | "not-configured";
/** Closed currentness vocabulary for governed evidence. */
export type AvailabilityState = "current" | "stale" | "unavailable" | "not-configured";
/** Closed set of accepted history range ids. */
export type RangeId = "1h" | "6h" | "24h" | "7d";
/** Closed target class accepted by curated queries and the binder. */
export type TargetKind = "estate" | "host" | "service" | "endpoint";
/** Closed display-unit vocabulary for values and series. */
export type Unit = "state" | "percent" | "count" | "seconds" | "milliseconds" | "bytes" | "scalar";

/** Core (fast) publication cadence in milliseconds. */
export const CORE_CADENCE_MS = 10_000 as const;
/** Slow-source acquisition cadence in milliseconds. */
export const SLOW_CADENCE_MS = 60_000 as const;
/** Per-source acquisition timeout in milliseconds. */
export const SOURCE_TIMEOUT_MS = 5_000 as const;
/** Maximum decoded current-source body bytes enforced before JSON parsing (§2). */
export const SOURCE_MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Maximum UTF-8 bytes for a consumed source name, id, or fingerprint (§2). */
export const SOURCE_MAX_NAME_BYTES = 512 as const;
/** Fixed Gatus status page size requested every cycle. */
export const GATUS_STATUS_PAGE_SIZE = 512 as const;
/** Maximum total Gatus endpoints supported before overflow. */
export const GATUS_MAX_ENDPOINTS = 511 as const;
/** Shared SSE heartbeat interval in milliseconds. */
export const SSE_HEARTBEAT_MS = 5_000 as const;
/** Maximum concurrently admitted SSE streams. */
export const SSE_MAX_STREAMS = 64 as const;
/** History success cache time-to-live in milliseconds. */
export const HISTORY_TTL_MS = 60_000 as const;
/** History queue-plus-execution deadline in milliseconds. */
export const HISTORY_DEADLINE_MS = 5_000 as const;
/** Maximum distinct concurrently active history operations. */
export const HISTORY_MAX_ACTIVE = 4 as const;
/** Maximum FIFO-queued history operations awaiting admission. */
export const HISTORY_MAX_QUEUED = 32 as const;
/** Maximum points per history series, including boundary samples. */
export const HISTORY_MAX_POINTS = 600 as const;
/** Maximum series or lanes per history result. */
export const HISTORY_MAX_SERIES = 1_024 as const;
/** Maximum upstream/response body bytes for a history operation. */
export const HISTORY_MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Maximum retained history cache entries. */
export const HISTORY_MAX_CACHE_ENTRIES = 64 as const;
/** Maximum canonical bytes charged across history cache entries. */
export const HISTORY_MAX_CACHE_BYTES = 64 * 1024 * 1024;
/** Maximum attribution labels retained per series or lane. */
export const HISTORY_MAX_LABELS = 32 as const;
/** Maximum UTF-8 bytes for an attribution label key. */
export const HISTORY_MAX_LABEL_KEY_BYTES = 128 as const;
/** Maximum UTF-8 bytes for an attribution label value. */
export const HISTORY_MAX_LABEL_VALUE_BYTES = 256 as const;
/** Maximum unsettled waiters per coalescing key. */
export const HISTORY_MAX_WAITERS_PER_KEY = 64 as const;
/** Maximum unsettled waiters across all history work. */
export const HISTORY_MAX_WAITERS_GLOBAL = 256 as const;
/** Maximum plain canonical bytes for a current-view representation. */
export const CURRENT_MAX_PLAIN_BYTES = 5 * 1024 * 1024;
/** Maximum gzip bytes for a current-view representation. */
export const CURRENT_MAX_GZIP_BYTES = 1 * 1024 * 1024;
/** Maximum bytes for a base64url observation response header. */
export const OBSERVATION_HEADER_MAX_BYTES = 8 * 1024;

// ---------------------------------------------------------------------------
// §4 Availability, observation, and representation
// ---------------------------------------------------------------------------

export interface DataAvailability {
  /** Currentness of the represented evidence. */ readonly state: AvailabilityState;
  /** Governing source or rendered estate. */ readonly source: SourceId | "rendered-estate";
  /** Stable most recent complete success. */ readonly lastGoodAt: string | null;
  /** Concise human-readable status. */ readonly message: string | null;
}

export interface SourceObservation {
  /** Latest source freshness independent of body identity. */ readonly state: AvailabilityState;
  /** Latest attempted acquisition, or null when never attempted. */ readonly lastAttemptAt: string | null;
  /** Latest complete successful acquisition. */ readonly lastSuccess: string | null;
}

export interface CycleObservation {
  /** Random process UUID. */ readonly generation: string;
  /** Positive safe integer, monotonic only within generation. */ readonly seq: number;
  /** Latest complete publication time. */ readonly observedAt: string;
  /** Application/build version used for reload guarding. */ readonly appVersion: string;
  /** All fixed sources, including slow/not-configured sources. */
  readonly sources: Readonly<Record<SourceId, SourceObservation>>;
}

// ---------------------------------------------------------------------------
// §9 Availability section (shared by view payloads)
// ---------------------------------------------------------------------------

export type AvailabilitySection<T> =
  | {
      /** Evidence governing the present value. */ readonly availability: DataAvailability;
      /** Complete available value. */ readonly value: T;
    }
  | {
      /** Evidence explaining absence. */ readonly availability: DataAvailability;
      /** Explicit unavailable value. */ readonly value: null;
    };

// ---------------------------------------------------------------------------
// §8 API errors and message catalogs
// ---------------------------------------------------------------------------

/** Closed estate-bundle failure codes surfaced through the API. */
export type EstateBundleApiErrorCode =
  | "ESTATE_BUNDLE_MISSING" | "ESTATE_BUNDLE_UNREADABLE"
  | "ESTATE_BUNDLE_UNPARSEABLE" | "ESTATE_BUNDLE_VERSION"
  | "ESTATE_BUNDLE_STRUCTURE" | "ESTATE_BUNDLE_INCOHERENT";
/** Complete closed catalog of externally surfaced API failure codes. */
export type ApiErrorCode =
  | "INVALID_REQUEST" | "API_NOT_FOUND" | "METHOD_NOT_ALLOWED"
  | "QUERY_NOT_FOUND" | "TARGET_NOT_FOUND" | "QUERY_NOT_APPLICABLE"
  | "RANGE_UNSUPPORTED" | "NOT_READY" | "HISTORY_OVERLOADED"
  | "SOURCE_UNAVAILABLE" | "SOURCE_TIMEOUT" | "HISTORY_LIMIT_EXCEEDED"
  | "MODEL_CHANGED" | "HISTORY_CANCELLED" | "CYCLE_BUILD_FAILED"
  | EstateBundleApiErrorCode | "INTERNAL_ERROR";

export interface ApiError<C extends string = ApiErrorCode> {
  /** Stable machine-readable failure category. */ readonly code: C;
  /** Exact catalog message for `code`; never interpolated. */ readonly message: string;
  /** Optional closed, bounded, non-sensitive scalar context. */
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

/** Canonical request-error envelope over the full API error code set. */
export type ErrorEnvelope = ApiError<ApiErrorCode>;

/** Exact default text for every externally surfaced API/history failure. Details carry bounded context. */
export const ERROR_MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  INVALID_REQUEST: "The request is invalid.",
  API_NOT_FOUND: "The requested API route does not exist.",
  METHOD_NOT_ALLOWED: "The request method is not allowed.",
  QUERY_NOT_FOUND: "The requested history query does not exist.",
  TARGET_NOT_FOUND: "The requested target does not exist.",
  QUERY_NOT_APPLICABLE: "The history query does not apply to this target.",
  RANGE_UNSUPPORTED: "The requested range is not supported for this query.",
  NOT_READY: "Current data is not ready yet.",
  HISTORY_OVERLOADED: "History capacity is temporarily exhausted.",
  SOURCE_UNAVAILABLE: "The required upstream source is unavailable.",
  SOURCE_TIMEOUT: "The history request exceeded its deadline.",
  HISTORY_LIMIT_EXCEEDED: "The history result exceeded a safety limit.",
  MODEL_CHANGED: "The rendered estate changed while history was loading.",
  HISTORY_CANCELLED: "The history request was cancelled.",
  CYCLE_BUILD_FAILED: "The latest current-data cycle could not be materialized.",
  ESTATE_BUNDLE_MISSING: "The rendered estate bundle is unavailable.",
  ESTATE_BUNDLE_UNREADABLE: "The rendered estate bundle is unavailable.",
  ESTATE_BUNDLE_UNPARSEABLE: "The rendered estate bundle is unavailable.",
  ESTATE_BUNDLE_VERSION: "The rendered estate bundle is incompatible.",
  ESTATE_BUNDLE_STRUCTURE: "The rendered estate bundle is invalid.",
  ESTATE_BUNDLE_INCOHERENT: "The rendered estate bundle is incoherent.",
  INTERNAL_ERROR: "An unexpected server error occurred.",
};

/** Exact default text for every bounded source-failure category. */
export const SOURCE_ERROR_MESSAGES: Readonly<Record<SourceErrorKind, string>> = {
  timeout: "The upstream request exceeded its deadline.",
  transport: "The upstream source could not be reached.",
  "upstream-status": "The upstream source returned an unsuccessful status.",
  "malformed-json": "The upstream source returned invalid JSON.",
  "invalid-shape": "The upstream source response is missing required data.",
  incompatible: "The upstream source response is incompatible.",
  overflow: "The upstream source response may be incomplete.",
  disabled: "The upstream source is not configured.",
};

/** Exact operator-facing text for source-configuration validation failures. */
export const CONFIG_ERROR_MESSAGES = {
  invalidUrl: "The configured source URL must be an absolute HTTP(S) URL without credentials.",
} as const;
