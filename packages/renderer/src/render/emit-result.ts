// packages/renderer/src/render/emit-result.ts — the shared per-kind emitter contract (02 §3.2).
//
// Every per-kind emitter (scrape/gatus/alertmanager/prober/web-model) returns this one internal
// shape: the files it produced plus any findings it raised. Homed in its own module (rather than
// render/index.ts) so the emitters can share it without depending on the render() orchestrator
// (authored later); the orchestrator imports `EmitResult` from here too. Internal to render/* —
// never on the public barrel (01 §3.1).
import type { EstateModel, Finding } from "@pulse/core";

import type { RenderedFile } from "../tree.js";

/** The output of a single per-kind emitter: the files it produced and any findings it raised. */
export interface EmitResult {
  /** Zero or more rendered files (unsorted; the pipeline sorts the merged list). */
  files: RenderedFile[];
  /** Renderer-raised findings (02 §7); empty on the happy path. */
  findings: Finding[];
}

/** A per-kind emitter: pure `EstateModel` → `EmitResult`. No I/O (REQ-SEC-01, REQ-DET-01). */
export type Emitter = (model: EstateModel) => EmitResult;
