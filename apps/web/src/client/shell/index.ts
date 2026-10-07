// shell/index.ts — the app-shell barrel. Exports the single top-level Shell component App renders,
// plus ViewHost and the chunk-reload constants co-located with it (tests/view-host.test.ts).
export { Shell } from "./Shell.js";
export {
  ViewHost,
  escalateToReload,
  resolveView,
  CHUNK_RELOAD_SESSION_KEY,
  MAIN_ID,
  VIEW_LOAD_RETRIES,
} from "./Shell.js";
export type { ShellProps, ViewHostProps, ViewHostState } from "./Shell.js";
