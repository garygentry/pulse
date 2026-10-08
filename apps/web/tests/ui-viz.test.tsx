// apps/web/tests/ui-viz.test.tsx — the `@/ui` viz ports (Sparkline, StatusTimeline, Gauge,
// TimeSeriesChart): geometry, render, token-only colours, suppressed contrast, lazy uPlot.
//
// uPlot cannot draw under happy-dom, so its default export is mocked here before anything renders
// the chart; the implementation module is only ever imported dynamically (by the lazy wrapper, or
// by the helper tests below), so it binds the mock.
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TargetStatus } from "@pulse/web-data/wire";

import { ALERT_SEVERITY, ALERT_STATE, Gauge, Sparkline, StatusTimeline, TimeSeriesChart } from "@/ui";
import { TimeSeriesChartFallback } from "@/ui/viz/time-series-chart";
import { GAUGE_START_ANGLE, GAUGE_SWEEP, arcPath, gaugeValueAngle, polarToCartesian } from "@/ui/viz/gauge";
import { sparklineGeometry, sparklineSampleGeometry } from "@/ui/viz/sparkline";
import { timelineHeight, timelineSegmentRect, type TimelineLayoutOpts, type TimelineSegment } from "@/ui/viz/status-timeline";
import { TONE_FILL, toneFgVar, vizStatusMark } from "@/ui/viz/status-marks";

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

  it("maps every status to a TARGET_STATUS tone; only suppressed is hatched", () => {
    expect(vizStatusMark("ok")).toEqual({ tone: "ok", pattern: "solid" });
    expect(vizStatusMark("warning")).toEqual({ tone: "warn", pattern: "solid" });
    expect(vizStatusMark("critical")).toEqual({ tone: "danger", pattern: "solid" });
    expect(vizStatusMark("unknown")).toEqual({ tone: "neutral", pattern: "solid" });
    expect(vizStatusMark("suppressed")).toEqual({ tone: "neutral", pattern: "hatched" });
    for (const tone of Object.keys(TONE_FILL)) expect(toneFgVar(tone as never)).toBe(`--status-${tone}-fg`);
  });

  for (const mode of MODES) {
    it(`draws every status mark at ≥3:1 against the page and cards in ${mode}`, () => {
      for (const status of STATUS_STATES) {
        const fg = tokenColor(mode, toneFgVar(vizStatusMark(status).tone));
        for (const surface of ["--background", "--card"]) {
          const ratio = contrastRatio(fg, tokenColor(mode, surface));
          expect(ratio, `${status} on ${surface}`).toBeGreaterThanOrEqual(3);
        }
      }
    });
  }
});

describe("ui/viz geometry", () => {
  const OPTS: TimelineLayoutOpts = { domainStart: 0, domainEnd: 100, width: 200, laneHeight: 16, laneGap: 4 };

  it("sparklineGeometry spaces points evenly, inverts y and honours min/max", () => {
    expect(sparklineGeometry([0, 5, 10], { width: 100, height: 20 })).toEqual({
      points: [{ x: 0, y: 20 }, { x: 50, y: 10 }, { x: 100, y: 0 }],
      path: "M 0,20 L 50,10 L 100,0",
    });
    expect(sparklineGeometry([5, 5], { width: 100, height: 20 })!.points).toEqual([
      { x: 0, y: 20 },
      { x: 100, y: 20 },
    ]);
    expect(sparklineGeometry([5, 5], { width: 100, height: 20, min: 0, max: 10 })!.points[0]).toEqual({ x: 0, y: 10 });
    expect(sparklineGeometry([1], { width: 120, height: 32 })).toBeNull();
    expect(sparklineGeometry([Number.NaN, 3], { width: 120, height: 32 })).toBeNull();
  });

  it("sparklineSampleGeometry sorts, deduplicates and splits at gaps", () => {
    const geo = sparklineSampleGeometry(
      [
        { at: 30, value: 3 },
        { at: 10, value: 1 },
        { at: 20, value: null },
        { at: 30, value: 4 },
        { at: 40, value: 5 },
      ],
      { width: 90, height: 20 },
    );
    expect(geo.runs).toHaveLength(2);
    expect(geo.paths).toHaveLength(1);
    expect(geo.paths[0]!.startsWith("M 60,")).toBe(true);
    expect(geo.markers).toHaveLength(1);
  });

  it("timelineSegmentRect offsets lanes, clamps to the domain and drops empty segments", () => {
    expect(timelineSegmentRect({ status: "ok", start: 0, end: 100 }, 0, OPTS)).toEqual({ x: 0, y: 0, width: 200, height: 16 });
    expect(timelineSegmentRect({ status: "warning", start: 50, end: 100 }, 1, OPTS)).toEqual({ x: 100, y: 20, width: 100, height: 16 });
    expect(timelineSegmentRect({ status: "ok", start: 90, end: 150 }, 0, OPTS)).toEqual({ x: 180, y: 0, width: 20, height: 16 });
    expect(timelineSegmentRect({ status: "ok", start: 50, end: 50 }, 0, OPTS)).toBeNull();
    expect(timelineSegmentRect({ status: "ok", start: -20, end: -5 }, 0, OPTS)).toBeNull();
    expect(timelineHeight(3, 16, 4)).toBe(60);
  });

  it("gauge angles clamp to the sweep and arcs end on the value angle", () => {
    expect(polarToCartesian(0, 0, 10, 90)).toEqual({ x: 0, y: 10 });
    expect(gaugeValueAngle(0, 0, 100)).toBe(GAUGE_START_ANGLE);
    expect(gaugeValueAngle(150, 0, 100)).toBe(GAUGE_START_ANGLE + GAUGE_SWEEP);
    expect(gaugeValueAngle(5, 5, 5)).toBe(GAUGE_START_ANGLE);
    const end = polarToCartesian(50, 50, 44, 270);
    expect(arcPath(50, 50, 44, 135, 270)).toBe(`M 18.89,81.11 A 44 44 0 0 1 ${end.x},${end.y}`);
    expect(arcPath(0, 0, 10, 135, 405)).toContain("A 10 10 0 1 1");
  });
});

describeUi("ui/viz render", () => {
  describe("Sparkline", () => {
    it("renders a labelled img with one path and no status by default", () => {
      render(<Sparkline values={[1, 2, 3, 2, 4]} />);
      const svg = screen.getByRole("img", { name: "sparkline" });
      expect(svg).toHaveAttribute("data-slot", "sparkline");
      expect(svg).toHaveAttribute("viewBox", "0 0 120 32");
      expect(svg).not.toHaveAttribute("data-status");
      expect(svg.querySelectorAll("path")).toHaveLength(1);
      expect(svg.outerHTML).not.toContain("NaN");
    });

    it("carries the status tone; suppressed draws dashed, unknown solid", () => {
      const { rerender } = render(<Sparkline values={[1, 5, 3]} status="critical" />);
      let svg = screen.getByRole("img", { name: "sparkline" });
      expect(svg).toHaveAttribute("data-status", "critical");
      expect(svg).toHaveAttribute("data-tone", "danger");
      expect(svg.querySelector("path")).not.toHaveAttribute("stroke-dasharray");

      rerender(<Sparkline values={[1, 5, 3]} status="suppressed" />);
      svg = screen.getByRole("img", { name: "sparkline" });
      expect(svg).toHaveAttribute("data-tone", "neutral");
      expect(svg).toHaveAttribute("data-mark", "hatched");
      expect(svg.querySelector("path")).toHaveAttribute("stroke-dasharray", "4 3");

      rerender(<Sparkline values={[1, 5, 3]} status="unknown" />);
      svg = screen.getByRole("img", { name: "sparkline" });
      expect(svg).toHaveAttribute("data-mark", "solid");
      expect(svg.querySelector("path")).not.toHaveAttribute("stroke-dasharray");
    });

    it("never bridges a null gap and marks an isolated sample", () => {
      const { rerender } = render(
        <Sparkline
          samples={[
            { at: 0, value: 1 },
            { at: 1, value: 2 },
            { at: 2, value: null },
            { at: 3, value: 3 },
            { at: 4, value: 4 },
          ]}
        />,
      );
      expect(screen.getByRole("img").querySelectorAll("path")).toHaveLength(2);

      rerender(<Sparkline samples={[{ at: 0, value: null }, { at: 1, value: 7 }]} ariaLabel="liveness history" />);
      const svg = screen.getByRole("img", { name: "liveness history" });
      expect(svg.querySelector('[data-spark-point="single"]')).not.toBeNull();
    });

    it("renders an empty img below two points", () => {
      render(<Sparkline values={[1]} />);
      expect(screen.getByRole("img").querySelectorAll("path")).toHaveLength(0);
    });
  });

  describe("StatusTimeline", () => {
    const lane = (segments: TimelineSegment[]) => [
      { id: "host-a", label: "host-a", segments },
    ];

    it("renders one rect per visible segment in a labelled lane group", () => {
      render(
        <StatusTimeline
          lanes={lane([
            { status: "ok", start: 0, end: 50 },
            { status: "critical", start: 50, end: 100 },
            { status: "ok", start: 200, end: 300 },
          ])}
          domainStart={0}
          domainEnd={100}
        />,
      );
      const svg = screen.getByRole("img", { name: "status timeline" });
      expect(svg).toHaveAttribute("data-slot", "status-timeline");
      const group = screen.getByRole("group", { name: "host-a" });
      expect(group).toHaveAttribute("data-lane", "host-a");
      const rects = group.querySelectorAll("rect[data-status]");
      expect(rects).toHaveLength(2);
      expect(rects[0]).toHaveAttribute("data-status", "ok");
      expect(rects[0]).toHaveAttribute("data-tone", "ok");
      expect(rects[1]).toHaveAttribute("data-status", "critical");
      expect(rects[1]).toHaveAttribute("data-tone", "danger");
      expect(svg.querySelector("pattern")).toBeNull();
      expect(svg.outerHTML).not.toContain("NaN");
    });

    it("hatches suppressed and keeps unknown solid, both on the neutral tone", () => {
      render(
        <StatusTimeline
          lanes={lane([
            { status: "unknown", start: 0, end: 50 },
            { status: "suppressed", start: 50, end: 100 },
          ])}
          domainStart={0}
          domainEnd={100}
        />,
      );
      const svg = screen.getByRole("img", { name: "status timeline" });
      const unknown = svg.querySelector('rect[data-status="unknown"]')!;
      const suppressed = svg.querySelector('rect[data-status="suppressed"]')!;
      expect(unknown).toHaveAttribute("data-tone", "neutral");
      expect(unknown).toHaveAttribute("data-mark", "solid");
      expect(unknown).not.toHaveAttribute("fill");
      expect(suppressed).toHaveAttribute("data-tone", "neutral");
      expect(suppressed).toHaveAttribute("data-mark", "hatched");
      const pattern = svg.querySelector("pattern")!;
      expect(suppressed.getAttribute("fill")).toBe(`url(#${pattern.id})`);
    });

    it("draws another status vocabulary from its status map (alert severity: info gets the info tone)", () => {
      render(
        <StatusTimeline
          lanes={[{ id: "sev", label: "severity", segments: [
            { status: "info", start: 0, end: 30 },
            { status: "warning", start: 30, end: 60 },
            { status: "unknown", start: 60, end: 100 },
          ] }]}
          statusMap={ALERT_SEVERITY}
          domainStart={0}
          domainEnd={100}
        />,
      );
      const group = screen.getByRole("group", { name: "severity" });
      const rects = [...group.querySelectorAll("rect[data-status]")];
      expect(rects.map((r) => [r.getAttribute("data-status"), r.getAttribute("data-tone"), r.getAttribute("data-mark")])).toEqual([
        ["info", "info", "solid"],
        ["warning", "warn", "solid"],
        ["unknown", "neutral", "solid"],
      ]);
    });

    it("hatches an outline map entry (ALERT_STATE suppressed) like target suppressed", () => {
      render(
        <StatusTimeline
          lanes={[{ id: "st", label: "state", segments: [{ status: "suppressed", start: 0, end: 100 }] }]}
          statusMap={ALERT_STATE}
          domainStart={0}
          domainEnd={100}
        />,
      );
      const rect = screen.getByRole("group", { name: "state" }).querySelector("rect[data-status]")!;
      expect(rect).toHaveAttribute("data-tone", "neutral");
      expect(rect).toHaveAttribute("data-mark", "hatched");
    });

    it("renders an empty img for no lanes", () => {
      render(<StatusTimeline lanes={[]} domainStart={0} domainEnd={100} />);
      const svg = screen.getByRole("img", { name: "status timeline" });
      expect(svg).toHaveAttribute("viewBox", "0 0 320 0");
      expect(svg.querySelectorAll("rect")).toHaveLength(0);
    });
  });

  describe("Gauge", () => {
    it("renders track, value arc and the rounded value as the label", () => {
      render(<Gauge value={42} />);
      const svg = screen.getByRole("img", { name: "42" });
      expect(svg).toHaveAttribute("data-slot", "gauge");
      expect(svg).not.toHaveAttribute("data-status");
      expect(svg.querySelector('[data-slot="gauge-track"]')).not.toBeNull();
      expect(svg.querySelector('[data-slot="gauge-value"]')).not.toHaveAttribute("data-tone");
      expect(svg.querySelector('[data-slot="gauge-label"]')!.textContent).toBe("42");
    });

    it("status → data-status, tone on the value arc, glyph in the label", () => {
      render(<Gauge value={90} status="critical" />);
      const svg = screen.getByRole("img", { name: "90, Critical" }); // the glyph is inside role=img, so the name carries the status
      expect(svg).toHaveAttribute("data-status", "critical");
      expect(svg.querySelector('[data-slot="gauge-value"]')).toHaveAttribute("data-tone", "danger");
      expect(svg.querySelector('[data-slot="gauge-label"]')!.textContent).toBe("✖ 90");
    });

    it("suppressed draws a dashed neutral arc", () => {
      render(<Gauge value={10} status="suppressed" />);
      const arc = screen.getByRole("img").querySelector('[data-slot="gauge-value"]')!;
      expect(arc).toHaveAttribute("data-tone", "neutral");
      expect(arc).toHaveAttribute("stroke-dasharray", "4 3");
    });

    it("survives a degenerate domain", () => {
      render(<Gauge value={5} min={5} max={5} />);
      expect(screen.getByRole("img").outerHTML).not.toContain("NaN");
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
      expect(seriesColorVar({ label: "c", data: [], status: "critical" }, 0)).toBe("--status-danger-fg");

      const root = document.documentElement;
      root.style.setProperty("--border", "rgb(1, 2, 3)");
      root.style.setProperty("--status-neutral-fg", "rgb(9, 9, 9)");
      try {
        const series = [{ label: "x", data: [1], status: "suppressed" as const }];
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
  });
});
