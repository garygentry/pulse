// src/client/views/_ui/index.ts — the dev-only component workbench registration.

import type { ViewDefinition } from "../../../shared/registry.js";

/** `/_ui`: every `@/ui` component in its states, over static fixtures. No `nav`, so it is never
 *  listed in the side nav or a kiosk rotation; it is reached by URL. Registered only through
 *  `devViews`.
 *
 *  `load()` is the only reference to `./view.js`, so the workbench is its own chunk. The import sits
 *  behind the literal NODE_ENV check because the bundler emits a chunk for every `import()` it parses,
 *  even one tree-shaking later drops: a production build folds the check and never sees the import. */
export const uiWorkbenchView: ViewDefinition = {
  id: "_ui",
  label: "UI workbench",
  load: () =>
    process.env.NODE_ENV !== "production"
      ? import("./view.js").then((m) => m.default)
      : Promise.reject(new Error("the UI workbench is not part of production builds")),
};
