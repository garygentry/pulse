// src/client/views/registry.ts — the view-slots contract (REQ-SLOT-01/02, SC-05/06).
//
// Pre-registers ALL FIVE M1 view ids in nav order with stub components so the shell, nav, routing,
// and kiosk rotation are exercisable end-to-end BEFORE any real view exists. A wave-3 member
// replaces ONLY its own views/<id>/** module. Rev-13 carve-out (move-boundary ECR): a member may
// edit only its OWN entry's `routes` field here, and edits no other view's entry (SC-06, CON-04).
//
// Entry filenames are view.tsx (NOT index.ts) to match ViewHost's hardcoded chunkCss attach key
// `views/<id>/view` and the ViewDefinition doc-comment (shared/registry.ts) — V-001.

import type { ViewDefinition } from "../../shared/registry.js";
import type { IconName } from "../theme/index.js";
import { overviewView } from "./overview/index.js";

/** The five M1 view ids, in nav order. A typed const so kiosk rotation (07) validates rotate= ids
 *  against exactly this set and the registry cannot silently drift from the nav. */
export const VIEW_IDS = ["overview", "alerts", "estate", "engine", "timeline"] as const;
export type ViewId = (typeof VIEW_IDS)[number];

/** Every registered client view, in nav order. `overview` is the EXISTING real view; the other four
 *  are wave-2 stubs (§3) that wave-3 members replace in place (SC-06). The shell sidebar sorts by
 *  nav.order (ties by registry index); every entry sets nav.kiosk:true so all five participate in
 *  kiosk rotation (REQ-KIOSK-03). Icons are typed as IconName at THIS construction site — the
 *  `icon?: string` field in shared/registry.ts stays unedited (CON-04, 00 §6). */
export const VIEWS: readonly ViewDefinition[] = [
  // overview — the existing real view (web-foundation). Its module (views/overview/index.ts) is
  // NOT edited (CON-04); the typed icon is applied here at the construction site by augmenting the
  // imported definition, not by editing overview's own module. overviewView already carries
  // nav:{ order:0, kiosk:true }, preserved by the spread.
  { ...overviewView, icon: "activity" satisfies IconName },

  {
    id: "alerts",
    label: "Alerts",
    icon: "alert-triangle" satisfies IconName,
    load: () => import("./alerts/view.js").then((m) => m.default),
    // Alert deep route (alert-triage, charter 04 §2 carve-out) — overview's alertTriagePath emits
    // /alerts/<encoded fingerprint>; views/alerts/url-state.ts decodeTriageRoute reads the param.
    routes: ["/alerts/:fingerprint"],
    nav: { order: 1, kiosk: true },
  },
  {
    id: "estate",
    label: "Estate",
    icon: "server" satisfies IconName,
    load: () => import("./estate/view.js").then((m) => m.default),
    // Entity deep routes (estate-explorer, rev-13 ECR) — mirrors ESTATE_ROUTES in estate/types.ts.
    routes: ["/estate/host/:name", "/estate/service/:host/:name"],
    nav: { order: 2, kiosk: true },
  },
  {
    id: "engine",
    label: "Engine",
    icon: "network" satisfies IconName,
    load: () => import("./engine/view.js").then((m) => m.default),
    nav: { order: 3, kiosk: true },
  },
  {
    id: "timeline",
    label: "Timeline",
    icon: "clock" satisfies IconName,
    load: () => import("./timeline/view.js").then((m) => m.default),
    nav: { order: 4, kiosk: true },
  },
];
