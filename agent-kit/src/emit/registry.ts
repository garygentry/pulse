// agent-kit/src/emit/registry.ts
// The emitter registry (REQ-ECO-04, REQ-MAINT-01, REQ-SCALE-01).
//
// One registry maps each `Ecosystem` to its `Emitter`. All emitters consume the ONE manifest —
// the single-source guarantee. Adding an ecosystem is additive: extend the `Ecosystem` union,
// add one `emit/<eco>.ts`, add one line here, and widen units' `targets`.

import type { Ecosystem, Emitter } from "./types.js";
import { UnknownEcosystemError } from "./errors.js";
import { claudeEmitter } from "./claude.js";
import { codexEmitter } from "./codex.js";
import { piEmitter } from "./pi.js";
import { genericEmitter } from "./generic.js";

/**
 * Registry of every ecosystem emitter, keyed by `Ecosystem`. The `Record<Ecosystem, …>`
 * type makes adding an `Ecosystem` a compile error until its emitter is registered here —
 * additive-by-construction (REQ-SCALE-01), no silent gap.
 */
export const EMITTERS: Record<Ecosystem, Emitter> = {
  claude: claudeEmitter,
  codex: codexEmitter,
  pi: piEmitter,
  generic: genericEmitter,
};

/** Resolve an emitter or throw `UnknownEcosystemError`. */
export function emitterFor(ecosystem: Ecosystem): Emitter {
  const emitter = EMITTERS[ecosystem];
  if (emitter === undefined) throw new UnknownEcosystemError(ecosystem);
  return emitter;
}
