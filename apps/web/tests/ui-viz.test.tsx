// apps/web/tests/ui-viz.test.tsx — pulse's side of the `@/ui` viz: the vendored Sparkline,
// StatusTimeline and Gauge drawn from pulse's status maps (TARGET_STATUS, ALERT_SEVERITY,
// ALERT_STATE), token-only colours, status-mark contrast, and the pulse-only lazy TimeSeriesChart.
// Geometry and render of the vendored charts themselves: ui-viz-vendored.test.tsx (deck's suite).
//
// uPlot cannot draw under happy-dom, so its default export is mocked here before anything renders
// the chart; the implementation module is only ever imported dynamically (by the lazy wrapper, or
// by the helper tests below), so it binds the mock.
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TargetStatus } from "@pulse/web-data/wire";

import {
  ALERT_SEVERITY,
  ALERT_STATE,
  Gauge,
  Sparkline,
  StatusTimeline,
  TARGET_STATUS,
  TimeSeriesChart,
  type TimelineSegment,
} from "@/ui";
import { TONE_SVG_FILL } from "@/ui/lib/tone";
import { TimeSeriesChartFallback } from "@/ui/viz/time-series-chart";
import { presentationMark } from "@/ui/viz/status-marks";

import { STATUS_STATES } from "../src/shared/constants.js";
import { describeUi, render, screen, waitFor } from "./rtl.js";
import { contrastRatio, tokenColor, type Mode } from "./support/tokens.js";

interface Sized {
  width: number;
  height: number;
}
class MockUPlot {
  static readonly instances: MockUPlot[] = [];
  destroyed = false;
  readonly sizes: Sized[] = [];
  constructor(
    readonly opts: { series: { stroke?: string; dash?: number[] }[] },
    readonly data: unknown,
    readonly el: unknown,
  ) {
    MockUPlot.instances.push(this);
  }
  setSize(s: Sized): void {
    this.sizes.push(s);
  }
  destroy(): void {
    this.destroyed = true;
  }
}
mock.module("uplot", () => ({ default: MockUPlot }));

const loadImpl = () => import("@/ui/viz/uplot-chart");

const MODES: readonly Mode[] = ["light", "dark"];
const VIZ_DIR = resolve(import.meta.dir, "../src/client/ui/viz");

describe("ui/viz colours", () => {
  it("uses no colour literals in any ui/viz source file", () => {
    const literal =
      /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(|\b(?:black|white|red|green|blue|gray|grey|orange|yellow|purple)\b(?!-)/;
    const files = readdirSync(VIZ_DIR).filter((f) => /\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const src = readFileSync(join(VIZ_DIR, file), "utf8");
      expect(literal.exec(src)?.[0] ?? null, file).toBeNull();
    }
  });

  it("maps every status to a TARGET_STATUS tone; only suppressed is hatched", async () => {
    const mark = (status: TargetStatus) => presentationMark(TARGET_STATUS[status]);
    expect(mark("ok")).toEqual({ tone: "ok", pattern: "solid" });
    expect(mark("warning")).toEqual({ tone: "warn", pattern: "solid" });
    expect(mark("critical")).toEqual({ tone: "danger", pattern: "solid" });
    expect(mark("unknown")).toEqual({ tone: "neutral", pattern: "solid" });
    expect(mark("suppressed")).toEqual({ tone: "neutral", pattern: "hatched" });
    const { toneFgVar } = await loadImpl();
    for (const tone of Object.keys(TONE_SVG_FILL)) expect(toneFgVar(tone as never)).toBe(`--status-${tone}-fg`);
  });

  for (const mode of MODES) {
    it(`draws every status mark at ≥3:1 against the page and cards in ${mode}`, () => {
      for (const status of STATUS_STATES) {
        const fg = tokenColor(mode, `--status-${TARGET_STATUS[status].tone}-fg`);
        for (const surface of ["--background", "--card"]) {
          const ratio = contrastRatio(fg, tokenColor(mode, surface));
          expect(ratio, `${status} on ${surface}`).toBeGreaterThanOrEqual(3);
        }
      }
    });
  }
});

describeUi("ui/viz render", () => {
  describe("pulse status maps", () => {
    const formatTime = (t: number) => `t${t}`;
    const lane = (segments: TimelineSegment<TargetStatus>[]) => [{ id: "host-a", label: "host-a", segments }];
    const laneRects = (container: HTMLElement, id: string) =>
      [...container.querySelectorAll(`g[data-lane="${id}"] rect[data-status]`)].map((r) => [
        r.getAttribute("data-status"),
        r.getAttribute("data-tone"),
        r.getAttribute("data-mark"),
      ]);

    it("draws TARGET_STATUS: suppressed hatched, unknown solid, both neutral", () => {
      const { container } = render(
        <StatusTimeline
          lanes={lane([
            { status: "ok", start: 0, end: 25 },
            { status: "critical", start: 25, end: 50 },
            { status: "unknown", start: 50, end: 75 },
            { status: "suppressed", start: 75, end: 100 },
          ])}
          statusMap={TARGET_STATUS}
          formatTime={formatTime}
          domainStart={0}
          domainEnd={100}
          ariaLabel="Host status"
        />,
      );
      expect(screen.getByRole("group", { name: "Host status" })).toHaveAttribute("data-slot", "status-timeline");
      expect(laneRects(container, "host-a")).toEqual([
        ["ok", "ok", "solid"],
        ["critical", "danger", "solid"],
        ["unknown", "neutral", "solid"],
        ["suppressed", "neutral", "hatched"],
      ]);
      // The text alternative names each interval by the map's label and the formatted times.
      expect(screen.getByRole("list", { name: "host-a" })).toHaveTextContent("Critical, t25 to t50");
    });

    it("draws another status vocabulary from its status map (alert severity: info gets the info tone)", () => {
      const { container } = render(
        <StatusTimeline
          lanes={[{ id: "sev", label: "severity", segments: [
            { status: "info", start: 0, end: 30 },
            { status: "warning", start: 30, end: 60 },
            { status: "unknown", start: 60, end: 100 },
          ] }]}
          statusMap={ALERT_SEVERITY}
          formatTime={formatTime}
          domainStart={0}
          domainEnd={100}
        />,
      );
      expect(laneRects(container, "sev")).toEqual([
        ["info", "info", "solid"],
        ["warning", "warn", "solid"],
        ["unknown", "neutral", "solid"],
      ]);
    });

    it("hatches an outline map entry (ALERT_STATE suppressed) like target suppressed", () => {
      const { container } = render(
        <StatusTimeline
          lanes={[{ id: "st", label: "state", segments: [{ status: "suppressed", start: 0, end: 100 }] }]}
          statusMap={ALERT_STATE}
          formatTime={formatTime}
          domainStart={0}
          domainEnd={100}
        />,
      );
      expect(laneRects(container, "st")).toEqual([["suppressed", "neutral", "hatched"]]);
    });

    it("Sparkline and Gauge take a TARGET_STATUS entry: suppressed dashed on the neutral tone", () => {
      render(<Sparkline values={[1, 5, 3]} status={TARGET_STATUS.suppressed} ariaLabel="CPU trend, suppressed" />);
      const spark = screen.getByRole("img", { name: "CPU trend, suppressed" });
      expect(spark).toHaveAttribute("data-tone", "neutral");
      expect(spark).toHaveAttribute("data-mark", "hatched");

      render(<Gauge value={90} status={TARGET_STATUS.critical} ariaLabel="Disk usage" />);
      const meter = screen.getByRole("meter", { name: "Disk usage" });
      expect(meter.querySelector('[data-slot="gauge-value"]')).toHaveAttribute("data-tone", "danger");
      expect(meter.querySelector('[data-slot="gauge-status"]')!.textContent).toBe(TARGET_STATUS.critical.label);
    });
  });

  describe("TimeSeriesChart", () => {
    beforeEach(() => {
      MockUPlot.instances.length = 0;
    });

    it("the loading placeholder is a status region at the chart's height", () => {
      render(<TimeSeriesChartFallback height={120} />);
      const loading = screen.getByRole("status");
      const frame = loading.closest('[data-slot="time-series-chart"]');
      expect(frame).toHaveAttribute("data-state", "loading");
      expect(frame).toHaveStyle({ height: "120px" });
    });

    // Whether the placeholder shows first depends on whether an earlier suite in this process already
    // loaded the uPlot chunk (`React.lazy` caches it), so this asserts only the settled state.
    it("builds uPlot in a labelled img", async () => {
      const { unmount } = render(
        <TimeSeriesChart timestamps={[1, 2, 3]} series={[{ label: "cpu", data: [10, 20, 30] }]} height={120} />,
      );

      const chart = await screen.findByRole("img", { name: "time series chart" });
      expect(chart).toHaveAttribute("data-slot", "time-series-chart");
      expect(chart).toHaveAttribute("data-state", "ready");
      await waitFor(() => expect(MockUPlot.instances.length).toBeGreaterThanOrEqual(1));
      const instance = MockUPlot.instances.at(-1)!;
      expect(instance.destroyed).toBe(false);

      unmount();
      expect(instance.destroyed).toBe(true);
    });

    it("builds no uPlot instance for empty data", async () => {
      render(<TimeSeriesChart timestamps={[]} series={[{ label: "cpu", data: [] }]} ariaLabel="empty" />);
      await screen.findByRole("img", { name: "empty" });
      expect(MockUPlot.instances).toHaveLength(0);
    });

    it("rebuilds with fresh token values when <html> attributes change", async () => {
      // happy-dom holds MutationObserver callbacks through a WeakRef, so a real observer can be
      // collected mid-test. Stand in for the one the chart creates and fire it directly.
      const win = window as unknown as { MutationObserver: unknown };
      const RealObserver = win.MutationObserver;
      let observed: { target: unknown; filter: readonly string[] | undefined } | null = null;
      let fire: (() => void) | null = null;
      // Testing Library's waitFor observes too; only the chart's observer filters attributes.
      win.MutationObserver = class {
        constructor(private readonly cb: () => void) {}
        observe(target: unknown, opts: { attributeFilter?: string[] }): void {
          if (opts.attributeFilter === undefined) return;
          observed = { target, filter: opts.attributeFilter };
          fire = this.cb;
        }
        disconnect(): void {}
        takeRecords(): unknown[] {
          return [];
        }
      };
      try {
        render(<TimeSeriesChart timestamps={[1, 2]} series={[{ label: "cpu", data: [1, 2] }]} />);
        await screen.findByRole("img", { name: "time series chart" });
        await waitFor(() => expect(MockUPlot.instances.length).toBe(1));
        expect(observed!.target).toBe(document.documentElement);
        expect(observed!.filter).toContain("class");

        fire!();
        await waitFor(() => expect(MockUPlot.instances.length).toBe(2));
        expect(MockUPlot.instances[0]!.destroyed).toBe(true);
      } finally {
        win.MutationObserver = RealObserver;
      }
    });

    it("reads series strokes from status tones and the chart palette", async () => {
      const { readThemeColors, seriesColorVar, buildOptions, buildData } = await loadImpl();
      expect(seriesColorVar({ label: "a", data: [] }, 0)).toBe("--chart-1");
      expect(seriesColorVar({ label: "b", data: [] }, 6)).toBe("--chart-2");
      expect(seriesColorVar({ label: "c", data: [], status: TARGET_STATUS.critical }, 0)).toBe("--status-danger-fg");

      const root = document.documentElement;
      root.style.setProperty("--border", "rgb(1, 2, 3)");
      root.style.setProperty("--status-neutral-fg", "rgb(9, 9, 9)");
      try {
        const series = [{ label: "x", data: [1], status: TARGET_STATUS.suppressed }];
        const colors = readThemeColors(root, series);
        expect(colors.axis).toBe("rgb(1, 2, 3)");
        expect(colors.text).toBe("currentColor");
        expect(colors.strokes).toEqual(["rgb(9, 9, 9)"]);

        const opts = buildOptions({ timestamps: [1], series }, 0, colors);
        expect(opts.width).toBe(1);
        expect(opts.height).toBe(240);
        expect(opts.series[1]).toMatchObject({ label: "x", stroke: "rgb(9, 9, 9)", dash: [4, 3] });
        expect(opts.legend).toEqual({ show: false });
      } finally {
        root.style.removeProperty("--border");
        root.style.removeProperty("--status-neutral-fg");
      }

      const timestamps = [1, 2];
      const data = buildData({ timestamps, series: [{ label: "a", data: [4, null] }] });
      expect(data).toEqual([[1, 2], [4, null]]);
      expect(data[0]).not.toBe(timestamps);
    });

    it("spaces x ticks for time labels and sizes the y axis to its longest label", async () => {
      const { buildOptions, yAxisSize, X_TICK_SPACE } = await loadImpl();
      const colors = { axis: "a", grid: "g", text: "t", strokes: ["s"] };
      const opts = buildOptions({ timestamps: [1], series: [{ label: "x", data: [1] }] }, 500, colors);
      const [x, y] = opts.axes!;
      expect(x!.space).toBe(X_TICK_SPACE);
      expect(X_TICK_SPACE).toBeGreaterThan(50); // wider than uPlot's default x spacing
      const size = y!.size as (self: unknown, values: string[] | null, axisIdx: number, cycle: number) => number;
      // Short labels keep uPlot's default width; long ones (bytes) widen the axis instead of clipping.
      expect(size(null, ["0.2", "0.4", "0.8"], 1, 0)).toBe(50);
      expect(size(null, null, 1, 0)).toBe(50);
      expect(size(null, ["10,000,000,000"], 1, 0)).toBe(yAxisSize(["10,000,000,000"]));
      expect(yAxisSize(["10,000,000,000"])).toBeGreaterThan(50);
      expect(yAxisSize(["1,000,000"])).toBeLessThan(yAxisSize(["100,000,000,000"]));
    });

    it("uses formatYTicks for the y tick labels when given, uPlot's default otherwise", async () => {
      const { buildOptions } = await loadImpl();
      const colors = { axis: "a", grid: "g", text: "t", strokes: ["s"] };
      const base = { timestamps: [1], series: [{ label: "x", data: [1] }] };
      expect(buildOptions(base, 500, colors).axes![1]!.values).toBeUndefined();
      const formatYTicks = (splits: readonly number[]) => splits.map((v) => `${v} u`);
      const values = buildOptions({ ...base, formatYTicks }, 500, colors).axes![1]!.values as (
        self: unknown,
        splits: number[],
      ) => string[];
      expect(values(null, [0, 5])).toEqual(["0 u", "5 u"]);
    });

    it("uses splitYTicks for the y tick positions, with a tick budget from the chart height", async () => {
      const { buildOptions } = await loadImpl();
      const colors = { axis: "a", grid: "g", text: "t", strokes: ["s"] };
      const base = { timestamps: [1], series: [{ label: "x", data: [1] }] };
      expect(buildOptions(base, 500, colors).axes![1]!.splits).toBeUndefined();
      const calls: [number, number, number][] = [];
      const splitYTicks = (min: number, max: number, maxTicks: number) => {
        calls.push([min, max, maxTicks]);
        return [min, max];
      };
      const splits = buildOptions({ ...base, height: 240, splitYTicks }, 500, colors).axes![1]!.splits as (
        self: unknown, axisIdx: number, min: number, max: number,
      ) => number[];
      expect(splits(null, 1, 0, 10)).toEqual([0, 10]);
      expect(calls).toEqual([[0, 10, 6]]); // floor(240 * 0.8 / 30)
    });
  });
});
