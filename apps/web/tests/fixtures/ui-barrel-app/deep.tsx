// Bundle entry for build-budget.test.ts: the control for barrel.tsx — the same component imported
// from its own file, so no other library module can reach the build.
import { createRoot } from "react-dom/client";

import { Badge } from "../../../src/client/ui/primitives/badge.js";

const mount = globalThis.document?.getElementById("app");
if (mount) createRoot(mount).render(<Badge>ok</Badge>);
