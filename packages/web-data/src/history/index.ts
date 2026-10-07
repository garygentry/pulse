// packages/web-data/src/history/index.ts — `/history` barrel (02 §4).
// Re-exports the public history service and its request/result/stats contracts; never the
// cache/admission implementation. Points/intervals normalization exports are added by
// item 029.
export {
  createHistoryService,
} from "./service.js";
export type {
  AlertHistoryRequest,
  EndpointHistoryRequest,
  HistoryFailure,
  HistoryRequest,
  HistoryResult,
  HistoryService,
  HistoryServiceOptions,
  HistoryStats,
} from "./service.js";
export { normalizeHistorySeries } from "./points.js";
export { buildAlertIntervals, buildEndpointHistory } from "./intervals.js";
