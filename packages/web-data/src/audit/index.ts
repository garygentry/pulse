// packages/web-data/src/audit/index.ts — `/audit` barrel (02 §4).
//
// Re-exports the audit contracts and the public writer factory. It deliberately exposes ONLY
// `createJsonlAuditWriter` (absolute path only) — never a default path, environment variable,
// rotation policy, or production singleton. The internal injectable factory
// (`createJsonlAuditWriterInternal`) is import-path-private to the package tests and is NOT
// re-exported here.
export type {
  AuditActor,
  AuditEvent,
  AuditFailure,
  AuditAppendResult,
  AuditWriter,
  JsonlAuditWriterOptions,
} from "./types.js";
export { createJsonlAuditWriter } from "./writer.js";
