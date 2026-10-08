// src/client/main.tsx — the SPA entry.
//
// Wires the signals store (06), the path router (07) and the live-state adapter (06 §5) to the app
// shell (08 §4) and mounts once over the static shell HTML the server serves at `/`.
// `startLiveState` is called BEFORE `render` so the first `/api/overview` fetch is already in flight
// when React paints the first frame (REQ-PERF-02).

import { setNonce } from "get-nonce";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.js";
import { readShellMeta, SHELL_MARKERS } from "./api/client.js";
import { ROOT_OPTIONS } from "./root-options.js";
import { createPathRouter, routesFromViews } from "./router.js";
import { createAppStore } from "./store/index.js";
import { startLiveState } from "./store/live-state.js";
import { devViews } from "./views/dev-views.js";
import { VIEWS } from "./views/registry.js";

const root = document.getElementById("app");
if (!root) throw new Error("[main] #app mount node missing from shell HTML");

// Shell markers (00 §1.4). `buildId` is null in manifest-fallback mode (REQ-BUILD-04, REQ-OBS-02).
const buildId = readShellMeta(SHELL_MARKERS.buildIdMeta);
const devMode = readShellMeta(SHELL_MARKERS.devMeta) === "1";

// The per-response CSP style nonce (security-headers.ts). react-remove-scroll's scroll lock — the
// one <style> element the app injects (modal dialogs, sheets, selects, menus) — reads it through
// get-nonce; without it the strict `style-src` blocks that element. The value is in the meta's
// `nonce` property: browsers hide the attribute once the CSP header applies.
const styleNonce = document.querySelector<HTMLMetaElement>(`meta[name="${SHELL_MARKERS.cspNonceMeta}"]`)?.nonce;
if (styleNonce) setNonce(styleNonce);

// Development-only views (the `/_ui` workbench). The client build inlines NODE_ENV, so a production
// bundle folds this to `[]` and drops the workbench and its chunk.
const DEV_VIEWS = process.env.NODE_ENV !== "production" ? devViews(process.env.NODE_ENV) : [];

const store = createAppStore();
const router = createPathRouter({
  routes: routesFromViews([...VIEWS, ...DEV_VIEWS]),
  fallback: "/overview",
});

// REQ-STORE-05: the router is the only writer of `store.route`.
store.route.value = router.current();
router.subscribe((match) => {
  store.route.value = match;
});

const live = startLiveState(store, {
  transport: "auto",
  devBuildCheck: devMode ? { buildId } : null,
});

// StrictMode's double render/effect checks run in development builds only.
createRoot(root, ROOT_OPTIONS).render(
  <StrictMode>
    <App
      store={store}
      router={router}
      views={VIEWS}
      devViews={DEV_VIEWS}
      reloadOnce={live.reloadOnce}
      buildId={buildId}
      setNextKioskView={live.setNextKioskView}
    />
  </StrictMode>,
);
