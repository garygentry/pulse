// packages/web-data/src/index.ts — root public barrel of @pulse/web-data (02 §4).
// Re-exports fixed public constants and common wire discriminants; canonical/hash
// helpers are added by item 009. Must not export source internals, the audit writer,
// or tests. Browser code must use the `/wire` subpath instead of this root.
export * from "./wire/common.js";
