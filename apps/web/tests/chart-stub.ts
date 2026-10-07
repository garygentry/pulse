// apps/web/tests/chart-stub.ts — shared by every DOM file that stubs the lazy chart
import { createElement } from "react";
import type { ReactElement } from "react";
import type { TimeSeriesChartProps } from "../src/client/ui/viz/time-series-chart.js";

/** Which DOM the stub renders: the uPlot 1.6.32 structure with or without `.u-over`. */
export type ChartStubVariant = "u-over" | "no-u-over";
let variant: ChartStubVariant = "u-over";

/** Select the variant for the next render (06 §9 `.u-over` guard cases). */
export function setChartStubVariant(v: ChartStubVariant): void { variant = v; }
/** Restore the default variant; call in `afterEach`. */
export function resetChartStub(): void { variant = "u-over"; }

/** Stand-in for the lazy uPlot chart; renders `[data-slot="time-series-chart"] > .uplot > .u-wrap [> .u-over]`. */
export function StubChart(props: TimeSeriesChartProps): ReactElement {
  const wrap = variant === "u-over" ? createElement("div", { className: "u-wrap" }, createElement("div", { className: "u-over" })) : createElement("div", { className: "u-wrap" });
  return createElement("div", { "data-slot": "time-series-chart", "aria-label": props.ariaLabel }, createElement("div", { className: "uplot" }, wrap)) as ReactElement;
}
