// packages/web-data/src/cycle/index.ts — `/cycle` barrel (02 §4).
// Re-exports cycle types, canonical/hash helpers, folds, and identity materialization;
// never the app runtime/scheduler. Populated by items 004, 009 and 020–024.
export * from "./types.js";
export * from "../canonical.js";
export * from "./identity.js";
// §5 keyed fold-input records and pure source-record helpers (item 020).
export * from "./records.js";
// Pure overview and alerts folds (item 020). Concrete fold subroutines stay in their modules;
// these entry points are exported for cycle composition (item 039) and tests.
export { foldOverview, DEADMANS_SWITCH_ALERTNAME } from "./fold-overview.js";
export { foldAlerts } from "./fold-alerts.js";
// Pure estate and engine folds (item 022).
export { foldEstate } from "./fold-estate.js";
export { foldEngine } from "./fold-engine.js";
// Pure timeline fold (item 024).
export { foldTimeline } from "./fold-timeline.js";
// Coordinator-neutral cycle composition (item 039): fold → materialize → classify.
export { foldCurrentViews, materializeCycle, buildCycleCandidate } from "./fold.js";
