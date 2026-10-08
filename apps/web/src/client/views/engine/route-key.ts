// src/client/views/engine/route-key.ts — the engine page boundary's reset key, read from the store
// outside the .tsx files (04 §2.2: engine components never read store signals directly).

import { routeKey } from "../../router.js";
import type { AppStore } from "../../store/index.js";

/**
 * The current route (path and query) as the page boundary's reset key.
 *
 * @param store - The application store.
 */
export function readRouteKey(store: AppStore): string {
  return routeKey(store.route.value);
}
