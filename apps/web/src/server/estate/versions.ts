// src/server/estate/versions.ts — the rendered web-model versions this server accepts.
//
// Server-only on purpose: it takes a RUNTIME import from `@pulse/renderer`, whose barrel reaches
// @pulse/core (yaml, zod, node:crypto/stream). Keeping it out of `src/shared/constants.ts` stops the
// client graph (which imports shared/constants for glyphs and cadences) from bundling that runtime.
import { RENDER_FORMAT_VERSION } from "@pulse/renderer";

/** The web-estate-model `formatVersion`s this build renders (REQ-MODEL-02). Equals the renderer's
 *  current `RENDER_FORMAT_VERSION`; a model whose `formatVersion` is outside this set is refused
 *  (errors.ts `EstateModelError` kind `version`). Imported, never hardcoded. */
export const SUPPORTED_WEB_MODEL_VERSIONS: readonly number[] = [RENDER_FORMAT_VERSION];
