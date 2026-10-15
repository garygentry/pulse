// Bundle entry for build-budget.test.ts: one component imported through the `@/ui` barrel. Its build
// must carry the same `@/ui` modules as deep.tsx (the same component imported from its own file).
//
// The component uses no icon. Bun still emits the barrel's lazy chunks (the icon set, uPlot) from
// the modules it tree-shakes, and splits shared code around them, so a component that imports lucide
// (Button's spinner, since deck v0.5.0) or one that renders `Icon` makes Bun hoist the curated icon
// set or the TimeSeriesChart wrapper onto the barrel build's first load only. The app pays neither:
// its shell renders `Icon` on the initial route, and `@/ui` imports are rewritten per module.
import { createRoot } from "react-dom/client";

import { Badge } from "../../../src/client/ui/index.js";

const mount = globalThis.document?.getElementById("app");
if (mount) createRoot(mount).render(<Badge>ok</Badge>);
