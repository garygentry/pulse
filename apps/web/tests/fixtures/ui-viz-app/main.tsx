// Bundle entry for build-budget.test.ts: an app that renders the `@/ui` barrel's TimeSeriesChart,
// so the build shows where uPlot lands when a view uses the chart.
import { createRoot } from "react-dom/client";

import { TimeSeriesChart } from "../../../src/client/ui/index.js";

const mount = globalThis.document?.getElementById("app");
if (mount) createRoot(mount).render(<TimeSeriesChart timestamps={[1, 2]} series={[{ label: "a", data: [1, 2] }]} />);
