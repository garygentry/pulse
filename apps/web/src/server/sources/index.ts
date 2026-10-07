// src/server/sources/index.ts — the engine-source client barrel.
//
// The app's engine-access sandbox: everything outside `sources/` consumes engine data only through
// the three client interfaces surfaced here on `ServerContext.sources`. Re-exports the three clients
// and their factories plus the shared `SourceResult`/`fetchJson` boundary and the build-input shapes.

export type {
  SourceResult,
  FetchLike,
  LiveSeries,
  RawActiveAlert,
  RawCheckStatus,
} from "./types.js";
export { fetchJson, describeFetchError, trimTrailingSlash } from "./types.js";

export type { VmClient, VmQueryResponse, VmVectorSample } from "./vm.js";
export { createVmClient, parseLiveness } from "./vm.js";

export type { AlertmanagerClient, AmGettableAlert, AmAlertsResponse } from "./alertmanager.js";
export { createAlertmanagerClient, parseAlerts } from "./alertmanager.js";

export type {
  GatusClient,
  GatusEndpointStatus,
  GatusResult,
  GatusStatusesResponse,
} from "./gatus.js";
export { createGatusClient, parseChecks } from "./gatus.js";
