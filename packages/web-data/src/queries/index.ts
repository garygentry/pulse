// packages/web-data/src/queries/index.ts — `/queries` barrel (02 §4).
// Re-exports the curated catalog metadata, range/step planning, and the safe binder.
// `BoundQuery.promql` is server-internal; no raw client query string is ever exposed and
// no wire/client module imports the query builders (06 §1). Populated by item 019.
export {
  QUERY_CATALOG,
  QUERY_IDS,
  isQueryId,
  queryIdsForTargetKind,
} from "./catalog.js";
export type { CuratedQueryDefinition } from "./catalog.js";
export {
  RANGE_SECONDS,
  RANGE_IDS,
  effectiveStepSeconds,
  acceptedRangesForQuery,
  parseRange,
} from "./ranges.js";
export { escapePrometheusLabelValue, bindCuratedQuery } from "./binding.js";
export type { BoundQuery, QueryBindFailureCode, QueryBindResult } from "./binding.js";
