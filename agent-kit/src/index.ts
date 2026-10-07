// agent-kit/src/index.ts — the public API barrel.
//
// The public surface is deliberately narrow: the internal content-model and slot types are
// exported as *types* for tests and emitters, but the only exported *function* is
// `buildGuidancePack` (emit/pack.ts) alongside the four public types.

export type { ContentUnit, Manifest, EmittedFile, Ecosystem } from "./emit/types.js";
export { buildGuidancePack } from "./emit/pack.js";
