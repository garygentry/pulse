// Bundle entry for build-budget.test.ts: the control for barrel.tsx — the same component imported
// from its own file, so no other library module can reach the build.
import { createRoot } from "react-dom/client";

import { Button } from "../../../src/client/ui/primitives/button.js";

const mount = globalThis.document?.getElementById("app");
if (mount) createRoot(mount).render(<Button>ok</Button>);
