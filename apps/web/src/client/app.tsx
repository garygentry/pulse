// src/client/app.tsx — reduced to bootstrap. The app frame, ViewHost and the chunk-reload constants
// live in shell/; main.tsx mounts this tree.

// The global stylesheet (Tailwind + theme), imported eagerly and first so it lands in
// manifest.entries.css before first paint and its `@layer` order statement leads the entry sheet.
import "./styles/app.css";
import { registerFonts } from "./styles/fonts.js";

import type { ReactElement } from "react";
import type { AppStore } from "./store/index.js";
import type { NextKioskView } from "./store/live-state.js";
import type { PathRouter } from "./router.js";
import type { ViewDefinition } from "../shared/registry.js";
import { Shell } from "./shell/index.js"; // 01 §3 barrel
import { RouterProvider } from "./shell/router-hooks.js";

registerFonts();

/** Props for the root, constructed once in `main.tsx` (unchanged shape). */
export interface AppProps {
  store: AppStore;
  router: PathRouter;
  views: readonly ViewDefinition[];
  /** Development-only views: routable and hosted, never in nav or kiosk rotation. */
  devViews?: readonly ViewDefinition[] | undefined;
  /** The shared once-only reload (`LiveStateHandle.reloadOnce`) — REQ-CONC-03. */
  reloadOnce: () => void;
  /** `<meta name="pulse-build-id">` content; `null` in manifest-fallback mode. */
  buildId: string | null;
  /** Shell-to-live-state imminent-view prefetch publication seam. */
  setNextKioskView?: ((next: NextKioskView | null) => void) | undefined;
}

/** Root: forwards its props straight to the shell (06 §2), inside the router context the
 *  router hooks read. No layout logic remains here. */
export function App(props: AppProps): ReactElement {
  return (
    <RouterProvider router={props.router}>
      <Shell
        store={props.store}
        router={props.router}
        views={props.views}
        devViews={props.devViews}
        reloadOnce={props.reloadOnce}
        buildId={props.buildId}
        setNextKioskView={props.setNextKioskView}
      />
    </RouterProvider>
  );
}
