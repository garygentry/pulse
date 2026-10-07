// packages/renderer/src/index.ts — the public API surface of @pulse/renderer (01 §3).
// Internal modules (order.ts, format.ts, findings.ts, render/*) are NOT exported here.

// format stamp + manifest ledger (00 §2, §3.4)
export { RENDER_FORMAT_VERSION } from "./manifest.js";
export type { RenderedManifest } from "./manifest.js";

// write-side IO fault (00 §6.1)
export { RenderIoError } from "./materialize.js";
export type { RenderIoErrorCode } from "./materialize.js";

// atomic stage-and-swap writer (03 §3)
export { materialize } from "./materialize.js";

// rendered tree (00 §3.1) — `RenderInputs` is surfaced below via render/index.js (00 §6.1).
export type { RenderedFile, RenderedTree, RenderResult } from "./tree.js";

// coverage (00 §3.2, 03 §5) + rendered-model-v2 coverage artifact (00 §4)
export { computeCoverage } from "./coverage.js";
export type {
  CoverageReport,
  CoverageEntry,
  CoverageTargetKind,
  SuppressionInfo,
  WebCoverageArtifact,
} from "./coverage.js";

// rendered-model-v2 shared identity + coordinated-artifact contracts (00 §§1.2, 5, 6.2, 6.3)
// and the coordinated emitter runtime (04 §§4–5). The public `buildWebEstateModel` (00 §6.1) now
// lives here with its widened v2 signature, delegating to the coordinated payload builder.
export {
  WEB_ARTIFACT_PATHS,
  computeBundleId,
  buildWebArtifactPayloads,
  emitWebArtifacts,
  buildWebEstateModel,
} from "./render/web-artifacts.js";
export type {
  BundleId,
  WebArtifactPath,
  WebFindingsArtifact,
  WebArtifactPayloads,
  UnstampedWebPayloads,
} from "./render/web-artifacts.js";

// rendered-model-v2 safety + projection-result contracts (00 §3)
export type {
  ForbiddenCanarySet,
  SafetyCursor,
  WebSafetyContext,
  WebProjectionResult,
} from "./render/web-safety.js";

// drift (00 §3.3)
export { diffTree } from "./diff.js";
export type { DriftEntry, DriftKind } from "./diff.js";

// top-level render pipeline (00 §2, §6.1, 02 §3): public `render`, `renderOnly`, and `RenderInputs`.
export { render, renderOnly, RENDER_KINDS } from "./render/index.js";
export type { RenderKind, RenderInputs } from "./render/index.js";

// web-estate-model projection (00 §4) — v1 runtime types + names retained until item 010. The
// public `buildWebEstateModel` value is now the widened v2 entry point re-exported from
// `web-artifacts.js` above; the v1 `buildWebEstateModel`/`emitWebEstateModelFile` runtime in
// web-model.ts stays module-internal (driving the unchanged v1 render pipeline) until item 010.
export type {
  WebEstateModel,
  WebEstateHost,
  WebEstateService,
  DrilldownId,
} from "./render/web-model.js";

// rendered-model-v2 strict-superset model + safe projections (00 §§1.3, 2)
export type {
  WebEstateModelV2,
  WebEstateMetadata,
  WebDeadmanMetadata,
  WebEstateHostBaseV2,
  WebEstateHostV2,
  WebManagedLinuxDetail,
  WebHypervisorApiDetail,
  WebNasApiDetail,
  WebProbeOnlyDetail,
  WebCommandSignalBase,
  WebCommandSignal,
  WebEstateServiceV2,
  WebDeepHealthDetail,
  WebBackupFreshness,
  WebEndpointAlert,
  WebChannel,
  WebRoutingOverride,
  WebStandaloneSuppression,
  WebProvenance,
  WebCredentialReference,
  WebScrapeTarget,
  WebSuppressionInfo,
} from "./render/web-model.js";

// init guidance-pack seam (00 §7)
export type { GuidancePack, GuidancePackFile } from "./init-seam.js";
