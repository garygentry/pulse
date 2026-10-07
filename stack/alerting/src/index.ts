// stack/alerting/src/index.ts
// Public barrel — EXACTLY the 01 §5 surface: files + one function, no network/management surface
// (REQ-SEC-03). The transform entrypoint + its I/O types, the published severity taxonomy, and the
// alerting finding taxonomy.
export { buildAlertingConfig, type TransformInput, type TransformOutput } from "./render.js";
export {
  SEVERITY_TAXONOMY,
  SEVERITY_TAXONOMY_VERSION,
  type Severity,
  type SeverityDef,
  type WebhookMirror,
} from "./taxonomy.js";
export type { AlertingFinding, AlertingFindingCode } from "./transform/findings.js";
