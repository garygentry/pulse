// packages/core/src/index.ts — the complete public API surface (01 §3).
// Nothing else is importable by consumers. Every symbol appears exactly once; nothing outside
// the authoritative surface is exported (notably NOT checkVersion, an internal pipeline seam).

// load-and-validate contract (03-loader-and-pipeline.md)
export { loadAndValidate, ConfigIoError } from "./loader/index.js";
export type { LoadResult, LoadOptions } from "./loader/index.js";
export type { ConfigIoErrorCode } from "./loader/errors.js";

// estate-model contract (00-core-definitions.md §3)
export type {
  EstateModel,
  Estate,
  Host,
  CollectionClass,
  ProbeSpec,
  Service,
  DeepHealthProbe,
  BackupFreshness,
  EndpointAlert,
  CommandSignal,
  Channel,
  ChannelKind,
  ChannelOptions,
  RoutingOverride,
  Suppression,
  SuppressionMark,
  SuppressionClass,
  SecretRef,
  Provenance,
} from "./model/index.js";

// findings (00-core-definitions.md §3.8, 05-findings.md)
export type { Finding, Severity, FindingCode } from "./findings/index.js";
export { FINDING_CODES } from "./findings/codes.js";
export { formatFindings } from "./findings/format.js";

// versioning (06-versioning-and-compat.md)
export { SUPPORTED_SCHEMA_MAJORS, CURRENT_SCHEMA_MAJOR } from "./version/index.js";

// inventory-schema — exported for tooling/tests only (05.3 tech spec)
export { inventorySchema } from "./schema/index.js";
