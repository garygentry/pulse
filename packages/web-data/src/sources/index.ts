// packages/web-data/src/sources/index.ts — `/sources` barrel (02 §4).
// Re-exports source result/types and the five typed clients; never the internal
// fetch.ts primitive. Populated by items 004 and 010–018.
export * from "./types.js";
export * from "./vm.js";
export * from "./alertmanager.js";
export * from "./vmalert.js";
export * from "./gatus.js";
export * from "./grafana.js";
