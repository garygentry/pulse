// src/client/views/overview/index.ts — the overview view registration (ViewDefinition v2).

import type { ViewDefinition } from "../../../shared/registry.js";

/** The overview view. `id` doubles as its path segment (`/overview`). `load()` is the ONLY
 *  reference to `./view.js` in the static import graph — it is what makes the view its own chunk. */
export const overviewView: ViewDefinition = {
  id: "overview",
  label: "Overview",
  load: () => import("./view.js").then((m) => m.OverviewView),
  nav: { order: 0, kiosk: true },
};
