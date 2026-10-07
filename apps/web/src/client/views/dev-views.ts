// src/client/views/dev-views.ts — views registered only outside production builds.

import type { ViewDefinition } from "../../shared/registry.js";
import { uiWorkbenchView } from "./_ui/index.js";

/**
 * The development-only views for a build whose `process.env.NODE_ENV` is `nodeEnv`: routable by
 * URL, rendered by the view host, never in the side nav, the command palette or a kiosk rotation.
 * Empty for a production build.
 *
 * Callers gate the call on the literal `process.env.NODE_ENV !== "production"` as well (see
 * main.tsx): the client build inlines NODE_ENV, so a production bundle folds that condition to
 * `false` and drops this module, the workbench and its chunk entirely.
 */
export function devViews(nodeEnv: string | undefined): readonly ViewDefinition[] {
  return nodeEnv === "production" ? [] : [uiWorkbenchView];
}
