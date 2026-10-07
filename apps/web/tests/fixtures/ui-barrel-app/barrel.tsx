// Bundle entry for build-budget.test.ts: one component imported through the `@/ui` barrel. Its build
// must carry the same `@/ui` modules as deep.tsx (the same component imported from its own file).
import { createRoot } from "react-dom/client";

import { Button } from "../../../src/client/ui/index.js";

const mount = globalThis.document?.getElementById("app");
if (mount) createRoot(mount).render(<Button>ok</Button>);
