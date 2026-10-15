// apps/web/tests/ui-viz-vendored.test.tsx — deck's apps/web/test/ui-viz.test.tsx (v0.5.0), ported to bun
// test + happy-dom (tests/rtl.ts); the viz files are deck's. Pulse's own viz checks (status maps,
// contrast, TimeSeriesChart) stay in ui-viz.test.tsx.
//
// The viz charts (Sparkline, StatusTimeline, Gauge): geometry, render, token-only colours.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { Gauge, Sparkline, StatusTimeline, defineStatusMap, type TimelineSegment } from "@/ui";
// ui-deep-import: geometry helpers are internal to the viz modules
import { GAUGE_START_ANGLE, GAUGE_SWEEP, arcPath, gaugeValueAngle, polarToCartesian } from "@/ui/viz/gauge";
// ui-deep-import: geometry helpers are internal to the viz modules
import { sparklineGeometry, valuesToSamples } from "@/ui/viz/sparkline";
// ui-deep-import: mark helpers are internal to the viz modules
import { presentationMark, statusMapMark } from "@/ui/viz/status-marks";
// ui-deep-import: geometry helpers are internal to the viz modules
import { timelineHeight, timelineSegmentRect, type TimelineLayoutOpts } from "@/ui/viz/status-timeline";

import { describeUi, render, screen, within } from "./rtl.js";

const VIZ_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src/client/ui/viz");

type Health = "up" | "degraded" | "down" | "unknown" | "suppressed" | "maintenance";
const HEALTH = defineStatusMap<Health>({
  up: { tone: "ok", icon: "circle-check", label: "Up" },
  degraded: { tone: "warn", icon: "triangle-alert", label: "Degraded" },
  down: { tone: "danger", icon: "circle-x", label: "Down" },
  unknown: { tone: "neutral", icon: "circle-help", label: "Unknown" },
  suppressed: { tone: "neutral", icon: "eye-off", label: "Suppressed", variant: "outline" },
  maintenance: { tone: "warn", icon: "triangle-alert", label: "Maintenance", variant: "outline" },
});

describe("ui/viz colours", () => {
  it("uses no colour literals in any ui/viz source file", () => {
    const literal =
      /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(|\b(?:black|white|red|green|blue|gray|grey|orange|yellow|purple)\b(?!-)/;
    const files = readdirSync(VIZ_DIR).filter((f) => /\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const src = readFileSync(join(VIZ_DIR, file), "utf8");
      expect(literal.exec(src)?.[0] ?? null, file).toBeNull();
    }
  });

  it("marks a map entry with its tone; only an outline entry is hatched", () => {
    expect(presentationMark(HEALTH.up)).toEqual({ tone: "ok", pattern: "solid" });
    expect(presentationMark(HEALTH.unknown)).toEqual({ tone: "neutral", pattern: "solid" });
    expect(presentationMark(HEALTH.suppressed)).toEqual({ tone: "neutral", pattern: "hatched" });
    expect(presentationMark({ tone: "info" })).toEqual({ tone: "info", pattern: "solid" });
  });

  it("falls back to a neutral mark labelled with the raw status for a state the map lacks", () => {
    expect(statusMapMark(HEALTH, "down")).toEqual({ tone: "danger", pattern: "solid", label: "Down" });
    expect(statusMapMark(HEALTH, "retired")).toEqual({ tone: "neutral", pattern: "solid", label: "retired" });
    expect(statusMapMark(HEALTH, "constructor")).toEqual({ tone: "neutral", pattern: "solid", label: "constructor" });
  });
});

describe("ui/viz geometry", () => {
  const OPTS: TimelineLayoutOpts = { domainStart: 0, domainEnd: 100, width: 200, laneHeight: 16, laneGap: 4 };

  it("sparklineGeometry spaces plain values by index, inverts y and honours min/max", () => {
    expect(sparklineGeometry(valuesToSamples([0, 5, 10]), { width: 100, height: 20 })).toEqual({
      runs: [
        [
          { x: 0, y: 20 },
          { x: 50, y: 10 },
          { x: 100, y: 0 },
        ],
      ],
      paths: ["M 0,20 L 50,10 L 100,0"],
      markers: [],
    });
    expect(sparklineGeometry(valuesToSamples([5, 5]), { width: 100, height: 20 }).runs[0]).toEqual([
      { x: 0, y: 20 },
      { x: 100, y: 20 },
    ]);
    expect(sparklineGeometry(valuesToSamples([5, 5]), { width: 100, height: 20, min: 0, max: 10 }).runs[0]![0]).toEqual({ x: 0, y: 10 });
  });

  it("plain values share the samples' gap and single-point semantics", () => {
    // A non-finite value is a gap: never bridged, and later points keep their slot.
    const gapped = sparklineGeometry(valuesToSamples([10, Number.NaN, Number.NaN, 50]), { width: 90, height: 20 });
    expect(gapped.paths).toEqual([]);
    expect(gapped.markers).toEqual([
      { x: 0, y: 20 },
      { x: 90, y: 0 },
    ]);
    // One finite value is a marker, as one sample is.
    expect(sparklineGeometry(valuesToSamples([42]), { width: 120, height: 32 }).markers).toHaveLength(1);
    expect(sparklineGeometry(valuesToSamples([Number.NaN, 3]), { width: 120, height: 32 }).markers).toEqual([{ x: 120, y: 32 }]);
    expect(sparklineGeometry(valuesToSamples([]), { width: 120, height: 32 })).toEqual({ runs: [], paths: [], markers: [] });
  });

  it("clamps y to the drawing area when an explicit min/max excludes a value", () => {
    const geo = sparklineGeometry(valuesToSamples([-20, 50, 140]), { width: 100, height: 20, min: 0, max: 100 });
    expect(geo.runs[0]!.map((p) => p.y)).toEqual([20, 10, 0]);
  });

  it("sparklineGeometry sorts samples, deduplicates and splits at gaps", () => {
    const geo = sparklineGeometry(
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
    expect(timelineSegmentRect({ status: "up", start: 0, end: 100 }, 0, OPTS)).toEqual({ x: 0, y: 0, width: 200, height: 16, widened: false });
    expect(timelineSegmentRect({ status: "degraded", start: 50, end: 100 }, 1, OPTS)).toEqual({ x: 100, y: 20, width: 100, height: 16, widened: false });
    expect(timelineSegmentRect({ status: "up", start: 90, end: 150 }, 0, OPTS)).toEqual({ x: 180, y: 0, width: 20, height: 16, widened: false });
    expect(timelineSegmentRect({ status: "up", start: 50, end: 50 }, 0, OPTS)).toBeNull();
    expect(timelineSegmentRect({ status: "up", start: -20, end: -5 }, 0, OPTS)).toBeNull();
    expect(timelineSegmentRect({ status: "up", start: 0, end: 10 }, 0, { ...OPTS, domainEnd: 0 })).toBeNull();
    expect(timelineHeight(3, 16, 4)).toBe(60);
  });

  it("widens a short interval to the 2px minimum around its centre, inside the chart", () => {
    // A 60 s outage in a 24 h, 280 px lane is 0.19 px wide.
    const day: TimelineLayoutOpts = { domainStart: 0, domainEnd: 86_400, width: 280, laneHeight: 16, laneGap: 2 };
    const rect = timelineSegmentRect({ status: "down", start: 43_200, end: 43_260 }, 0, day)!;
    expect(rect).toMatchObject({ width: 2, widened: true });
    expect(rect.x).toBeCloseTo(140 + 0.0972 - 1, 1);
    expect(timelineSegmentRect({ status: "down", start: 0, end: 60 }, 0, day)).toMatchObject({ x: 0, width: 2 });
    expect(timelineSegmentRect({ status: "down", start: 86_340, end: 86_400 }, 0, day)).toMatchObject({ x: 278, width: 2 });
  });

  it("gauge angles clamp to the sweep and arcs end on the value angle", () => {
    expect(polarToCartesian(0, 0, 10, 90)).toEqual({ x: 0, y: 10 });
    expect(gaugeValueAngle(0, 0, 100)).toBe(GAUGE_START_ANGLE);
    expect(gaugeValueAngle(150, 0, 100)).toBe(GAUGE_START_ANGLE + GAUGE_SWEEP);
    const end = polarToCartesian(50, 50, 44, 270);
    expect(arcPath(50, 50, 44, 135, 270)).toBe(`M 18.89,81.11 A 44 44 0 0 1 ${end.x},${end.y}`);
    expect(arcPath(0, 0, 10, 135, 405)).toContain("A 10 10 0 1 1");
  });

  it("a degenerate domain (max === min) yields the start angle below, at and above the bound", () => {
    expect(gaugeValueAngle(4, 5, 5)).toBe(GAUGE_START_ANGLE);
    expect(gaugeValueAngle(5, 5, 5)).toBe(GAUGE_START_ANGLE);
    expect(gaugeValueAngle(5.5, 5, 5)).toBe(GAUGE_START_ANGLE);
    expect(gaugeValueAngle(6, 5, 5)).toBe(GAUGE_START_ANGLE);
  });
});

describeUi("ui/viz render", () => {
  describe("Sparkline", () => {
    it("renders a labelled img with one path and no tone by default", () => {
      render(<Sparkline values={[1, 2, 3, 2, 4]} />);
      const svg = screen.getByRole("img", { name: "sparkline" });
      expect(svg).toHaveAttribute("data-slot", "sparkline");
      expect(svg).toHaveAttribute("viewBox", "0 0 120 32");
      expect(svg).not.toHaveAttribute("data-tone");
      expect(svg.querySelectorAll("path")).toHaveLength(1);
      expect(svg.outerHTML).not.toContain("NaN");
    });

    it("carries the status tone; an outline entry draws dashed", () => {
      const { rerender } = render(<Sparkline values={[1, 5, 3]} status={HEALTH.down} />);
      let svg = screen.getByRole("img", { name: "sparkline" });
      expect(svg).toHaveAttribute("data-tone", "danger");
      expect(svg.querySelector("path")).not.toHaveAttribute("stroke-dasharray");

      rerender(<Sparkline values={[1, 5, 3]} status={HEALTH.suppressed} />);
      svg = screen.getByRole("img", { name: "sparkline" });
      expect(svg).toHaveAttribute("data-tone", "neutral");
      expect(svg).toHaveAttribute("data-mark", "hatched");
      expect(svg.querySelector("path")).toHaveAttribute("stroke-dasharray", "4 3");

      rerender(<Sparkline values={[1, 5, 3]} status={HEALTH.unknown} />);
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

      rerender(
        <Sparkline
          samples={[
            { at: 0, value: null },
            { at: 1, value: 7 },
          ]}
          ariaLabel="liveness history"
        />,
      );
      const svg = screen.getByRole("img", { name: "liveness history" });
      expect(svg.querySelector('[data-spark-point="single"]')).not.toBeNull();
    });

    it("marks a single plain value, as a single sample is marked", () => {
      render(<Sparkline values={[42]} />);
      const svg = screen.getByRole("img");
      expect(svg.querySelectorAll("path")).toHaveLength(0);
      expect(svg.querySelectorAll('[data-spark-point="single"]')).toHaveLength(1);
    });

    it("splits plain values at a non-finite gap", () => {
      render(<Sparkline values={[1, 2, Number.NaN, 3, 4]} />);
      const svg = screen.getByRole("img");
      expect(svg.querySelectorAll("path")).toHaveLength(2);
      expect(svg.outerHTML).not.toContain("NaN");
    });
  });

  /** Roles whose children are presentational (ARIA 1.2): content under them never reaches AT. */
  const PRESENTATIONAL_CHILDREN = new Set(["img", "meter", "progressbar", "button", "checkbox", "math", "separator", "slider", "tab"]);

  /** Fails unless `el` reaches the accessibility tree: no aria-hidden, hidden or presentational-children ancestor. */
  function expectExposed(el: Element) {
    for (let node: Element | null = el; node !== null; node = node.parentElement) {
      expect(node.getAttribute("aria-hidden"), node.outerHTML.slice(0, 60)).not.toBe("true");
      expect(node.hasAttribute("hidden")).toBe(false);
      if (node !== el) expect(PRESENTATIONAL_CHILDREN.has(node.getAttribute("role") ?? "")).toBe(false);
      if (node.tagName.toLowerCase() === "svg" && node !== el) expect(node.getAttribute("role")).toBeNull();
    }
  }

  describe("StatusTimeline", () => {
    const lane = (segments: TimelineSegment<Health>[]) => [{ id: "host-a", label: "host-a", segments }];

    it("renders one rect per visible segment, titled by the state", () => {
      const { container } = render(
        <StatusTimeline
          lanes={lane([
            { status: "up", start: 0, end: 50 },
            { status: "down", start: 50, end: 100 },
            { status: "up", start: 200, end: 300 },
          ])}
          statusMap={HEALTH}
          domainStart={0}
          domainEnd={100}
          formatTime={(t) => `t${t}`}
        />,
      );
      const root = screen.getByRole("group", { name: "status timeline" });
      expect(root).toHaveAttribute("data-slot", "status-timeline");
      const svg = container.querySelector("svg")!;
      expect(svg).toHaveAttribute("aria-hidden", "true");
      const rects = svg.querySelectorAll('[data-lane="host-a"] rect[data-status]');
      expect(rects).toHaveLength(2);
      expect(rects[0]).toHaveAttribute("data-status", "up");
      expect(rects[0]).toHaveAttribute("data-tone", "ok");
      expect(rects[1]).toHaveAttribute("data-status", "down");
      expect(rects[1]).toHaveAttribute("data-tone", "danger");
      expect(rects[1]!.querySelector("title")).toHaveTextContent("Down");
      expect(svg.querySelector("pattern")).toBeNull();
      expect(container.innerHTML).not.toContain("NaN");
    });

    it("states each lane's intervals as text that reaches assistive technology", () => {
      render(
        <StatusTimeline
          lanes={[
            {
              id: "web",
              label: "web",
              segments: [
                { status: "up", start: 0, end: 600 },
                { status: "down", start: 600, end: 601 },
                { status: "up", start: 601, end: 1440 },
              ],
            },
            { id: "db", label: "db", segments: [] },
          ]}
          statusMap={HEALTH}
          domainStart={0}
          domainEnd={1440}
          formatTime={(t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`}
        />,
      );
      const root = screen.getByRole("group", { name: "status timeline" });
      expect(root.getAttribute("role")).toBe("group");
      const web = within(root).getByRole("list", { name: "web" });
      const items = within(web).getAllByRole("listitem").map((li) => li.textContent);
      expect(items).toEqual(["Up, 00:00 to 10:00", "Down, 10:00 to 10:01", "Up, 10:01 to 24:00"]);
      for (const li of within(web).getAllByRole("listitem")) expectExposed(li);
      expect(within(within(root).getByRole("list", { name: "db" })).getByRole("listitem")).toHaveTextContent("No intervals");
    });

    it("keeps a short interval visible and separates only adjacent segments", () => {
      const { container } = render(
        <StatusTimeline
          lanes={lane([
            { status: "up", start: 0, end: 43_200 },
            { status: "down", start: 43_200, end: 43_260 },
            { status: "up", start: 43_260, end: 60_000 },
            { status: "degraded", start: 60_000, end: 70_000 },
            { status: "up", start: 80_000, end: 86_400 },
          ])}
          statusMap={HEALTH}
          domainStart={0}
          domainEnd={86_400}
          width={280}
          formatTime={(t) => `t${t}`}
        />,
      );
      const down = container.querySelector('rect[data-status="down"]')!;
      expect(Number(down.getAttribute("width"))).toBe(2);
      // Drawn after its neighbours, so nothing paints over it.
      const g = container.querySelector('[data-lane="host-a"]')!;
      expect(g.lastElementChild).toBe(down);
      // One separator, between the two wide adjacent segments (up → degraded); none at the
      // widened outage's edges and none across the 70 000–80 000 hole.
      const separators = g.querySelectorAll("[data-separator]");
      expect(separators).toHaveLength(1);
      expect(Number(separators[0]!.getAttribute("x1"))).toBeCloseTo((60_000 / 86_400) * 280, 1);
      expect(g.querySelectorAll("rect[data-status]:not([fill])")).toHaveLength(5);
      for (const rect of g.querySelectorAll("rect[data-status]")) expect(rect).not.toHaveAttribute("stroke-width");
    });

    it("hatches each outline entry in its own tone and keeps a solid one on the same tone solid", () => {
      const { container } = render(
        <StatusTimeline
          lanes={lane([
            { status: "unknown", start: 0, end: 25 },
            { status: "suppressed", start: 25, end: 50 },
            { status: "maintenance", start: 50, end: 75 },
          ])}
          statusMap={HEALTH}
          domainStart={0}
          domainEnd={100}
          formatTime={(t) => `t${t}`}
        />,
      );
      const unknown = container.querySelector('rect[data-status="unknown"]')!;
      const suppressed = container.querySelector('rect[data-status="suppressed"]')!;
      const maintenance = container.querySelector('rect[data-status="maintenance"]')!;
      expect(unknown).toHaveAttribute("data-mark", "solid");
      expect(unknown).not.toHaveAttribute("fill");
      expect(suppressed).toHaveAttribute("data-mark", "hatched");
      expect(maintenance).toHaveAttribute("data-mark", "hatched");

      const patterns = [...container.querySelectorAll("pattern")];
      expect(patterns.map((p) => p.getAttribute("data-tone")).sort()).toEqual(["neutral", "warn"]);
      const warn = patterns.find((p) => p.getAttribute("data-tone") === "warn")!;
      const neutral = patterns.find((p) => p.getAttribute("data-tone") === "neutral")!;
      expect(maintenance.getAttribute("fill")).toBe(`url(#${warn.id})`);
      expect(suppressed.getAttribute("fill")).toBe(`url(#${neutral.id})`);
      expect(warn.querySelector("line")).toHaveClass("stroke-status-warn-fg");
      expect(neutral.querySelector("line")).toHaveClass("stroke-status-neutral-fg");
      expect(maintenance).toHaveClass("stroke-status-warn-fg");
    });

    it("draws a status missing from the map as neutral, labelled with the raw status", () => {
      const { container } = render(
        <StatusTimeline<string>
          lanes={[{ id: "a", label: "a", segments: [{ status: "retired", start: 0, end: 100 }] }]}
          statusMap={HEALTH}
          domainStart={0}
          domainEnd={100}
          formatTime={(t) => `t${t}`}
        />,
      );
      const rect = container.querySelector('rect[data-status="retired"]')!;
      expect(rect).toHaveAttribute("data-tone", "neutral");
      expect(rect.querySelector("title")).toHaveTextContent("retired");
      expect(within(screen.getByRole("list", { name: "a" })).getByRole("listitem")).toHaveTextContent("retired, t0 to t100");
    });

    const DAY = { domainStart: 0, domainEnd: 86_400, width: 280, formatTime: (t: number) => `t${t}` };
    const drawn = (container: HTMLElement) =>
      [...container.querySelectorAll('[data-lane="host-a"] rect[data-status]')].map((r) => ({
        status: r.getAttribute("data-status"),
        x: Number(r.getAttribute("x")),
        width: Number(r.getAttribute("width")),
        title: r.querySelector("title")!.textContent,
      }));

    it("merges colliding short intervals into one rect in the worst tone (down then up, mid-domain)", () => {
      const { container } = render(
        <StatusTimeline
          lanes={lane([
            { status: "up", start: 0, end: 43_200 },
            { status: "down", start: 43_200, end: 43_230 },
            { status: "up", start: 43_230, end: 43_260 },
            { status: "up", start: 43_260, end: 86_400 },
          ])}
          statusMap={HEALTH}
          {...DAY}
        />,
      );
      const short = drawn(container).filter((r) => r.width < 10);
      expect(short).toHaveLength(1);
      expect(short[0]).toMatchObject({ status: "down", title: "Down / Up" });
      expect(short[0]!.width).toBeGreaterThanOrEqual(2);
      // The text alternative still lists every interval.
      expect(within(screen.getByRole("list", { name: "host-a" })).getAllByRole("listitem")).toHaveLength(4);
    });

    it("keeps a short outage visible where edge clamping gives two short intervals the same rect", () => {
      const { container } = render(
        <StatusTimeline
          lanes={lane([
            { status: "up", start: 0, end: 86_340 },
            { status: "down", start: 86_340, end: 86_370 },
            { status: "up", start: 86_370, end: 86_400 },
          ])}
          statusMap={HEALTH}
          {...DAY}
        />,
      );
      const rects = drawn(container);
      const top = rects[rects.length - 1]!;
      expect(top).toMatchObject({ status: "down", x: 278, width: 2 });
      expect(rects.filter((r) => r.x === 278 && r.status === "up")).toHaveLength(0);
    });

    it("draws a flapping down/up/down run as one danger rect", () => {
      const { container } = render(
        <StatusTimeline
          lanes={lane([
            { status: "up", start: 0, end: 40_000 },
            { status: "down", start: 40_000, end: 40_020 },
            { status: "up", start: 40_020, end: 40_040 },
            { status: "down", start: 40_040, end: 40_060 },
            { status: "up", start: 40_060, end: 86_400 },
          ])}
          statusMap={HEALTH}
          {...DAY}
        />,
      );
      const short = drawn(container).filter((r) => r.width < 10);
      expect(short).toHaveLength(1);
      expect(short[0]).toMatchObject({ status: "down", title: "Down / Up" });
      expect(container.querySelector('rect[data-status="down"]')).toHaveAttribute("data-tone", "danger");
    });

    it("names each lane's interval list once, by its visible label", () => {
      render(<StatusTimeline lanes={lane([{ status: "up", start: 0, end: 100 }])} statusMap={HEALTH} domainStart={0} domainEnd={100} formatTime={(t) => `t${t}`} />);
      const list = screen.getByRole("list", { name: "host-a" });
      expect(list).not.toHaveAttribute("aria-label");
      const labelId = list.getAttribute("aria-labelledby")!;
      expect(document.getElementById(labelId)).toHaveTextContent("host-a");
      expect(list.parentElement!.textContent!.match(/host-a/g)).toHaveLength(1);
    });

    it("renders an empty chart for no lanes", () => {
      const { container } = render(<StatusTimeline lanes={[]} statusMap={HEALTH} domainStart={0} domainEnd={100} formatTime={String} />);
      expect(screen.getByRole("group", { name: "status timeline" })).toBeInTheDocument();
      expect(container.querySelector("svg")).toHaveAttribute("viewBox", "0 0 320 0");
      expect(container.querySelectorAll("rect")).toHaveLength(0);
    });
  });

  describe("Gauge", () => {
    it("is a meter named by its subject, with range, value and value text", () => {
      render(<Gauge ariaLabel="Disk usage" value={42.4} />);
      const meter = screen.getByRole("meter", { name: "Disk usage" });
      expect(meter).toHaveAttribute("data-slot", "gauge");
      expect(meter).toHaveAttribute("aria-valuemin", "0");
      expect(meter).toHaveAttribute("aria-valuemax", "100");
      expect(meter).toHaveAttribute("aria-valuenow", "42.4");
      expect(meter).toHaveAttribute("aria-valuetext", "42");
      expect(meter.querySelector('[data-slot="gauge-track"]')).not.toBeNull();
      expect(meter.querySelector('[data-slot="gauge-value"]')).not.toHaveAttribute("data-tone");
      expect(meter.querySelector('[data-slot="gauge-label"]')!.textContent).toBe("42");
      expect(meter.querySelector('[data-slot="gauge-status"]')).toBeNull();
    });

    it("a status puts its tone on the value arc and its label under the value and in the value text", () => {
      render(<Gauge ariaLabel="CPU" value={90} label="90%" status={HEALTH.down} />);
      const meter = screen.getByRole("meter", { name: "CPU" });
      expect(meter).toHaveAttribute("aria-valuetext", "90%, Down");
      expect(meter.querySelector('[data-slot="gauge-value"]')).toHaveAttribute("data-tone", "danger");
      expect(meter.querySelector('[data-slot="gauge-label"]')!.textContent).toBe("90%");
      expect(meter.querySelector('[data-slot="gauge-status"]')!.textContent).toBe("Down");
    });

    it("notes a clamped value in the value text", () => {
      const { rerender } = render(<Gauge ariaLabel="CPU" value={140} label="140%" status={HEALTH.up} />);
      let meter = screen.getByRole("meter", { name: "CPU" });
      expect(meter).toHaveAttribute("aria-valuenow", "100");
      expect(meter).toHaveAttribute("aria-valuetext", "140%, Up, above the maximum of 100");
      rerender(<Gauge ariaLabel="CPU" value={-5} min={0} max={10} />);
      meter = screen.getByRole("meter", { name: "CPU" });
      expect(meter).toHaveAttribute("aria-valuenow", "0");
      expect(meter).toHaveAttribute("aria-valuetext", "-5, below the minimum of 0");
    });

    it("an outline entry draws a dashed arc", () => {
      render(<Gauge ariaLabel="Load" value={10} status={HEALTH.suppressed} />);
      const arc = screen.getByRole("meter").querySelector('[data-slot="gauge-value"]')!;
      expect(arc).toHaveAttribute("data-tone", "neutral");
      expect(arc).toHaveAttribute("stroke-dasharray", "4 3");
    });

    it("draws no value arc at or below the minimum", () => {
      const { rerender } = render(<Gauge ariaLabel="Load" value={0} status={HEALTH.down} />);
      expect(screen.getByRole("meter").querySelector('[data-slot="gauge-value"]')).toBeNull();
      rerender(<Gauge ariaLabel="Load" value={-3} />);
      expect(screen.getByRole("meter").querySelector('[data-slot="gauge-value"]')).toBeNull();
    });

    it.each([4, 5, 6])("a degenerate domain draws no arc (value %d, min = max = 5)", (value) => {
      render(<Gauge ariaLabel="Load" value={value} min={5} max={5} />);
      const meter = screen.getByRole("meter");
      expect(meter.querySelector('[data-slot="gauge-value"]')).toBeNull();
      expect(meter.outerHTML).not.toContain("NaN");
    });

    it.each([
      [5, 5],
      [10, 0],
    ])("a degenerate domain (min %d, max %d) never reports valuemin > valuemax", (min, max) => {
      render(<Gauge ariaLabel="Load" value={7} min={min} max={max} label="7" />);
      const meter = screen.getByRole("meter");
      expect(meter).toHaveAttribute("aria-valuemin", String(min));
      expect(meter).toHaveAttribute("aria-valuemax", String(min));
      expect(meter).toHaveAttribute("aria-valuenow", String(min));
      expect(meter).toHaveAttribute("aria-valuetext", "7");
      expect(meter.querySelector('[data-slot="gauge-value"]')).toBeNull();
    });

    it("reversed bounds yield the start angle", () => {
      expect(gaugeValueAngle(5, 10, 0)).toBe(GAUGE_START_ANGLE);
      expect(gaugeValueAngle(-5, 10, 0)).toBe(GAUGE_START_ANGLE);
      expect(gaugeValueAngle(15, 10, 0)).toBe(GAUGE_START_ANGLE);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("shows %d as unavailable", (value) => {
      render(<Gauge ariaLabel="Disk usage" value={value} label={`${value}%`} status={HEALTH.unknown} />);
      const meter = screen.getByRole("meter", { name: "Disk usage" });
      expect(meter).toHaveAttribute("aria-valuetext", "unavailable, Unknown");
      expect(meter).toHaveAttribute("aria-valuenow", "0");
      expect(meter.querySelector('[data-slot="gauge-label"]')!.textContent).toBe("–");
      expect(meter.querySelector('[data-slot="gauge-value"]')).toBeNull();
      expect(meter.outerHTML).not.toMatch(/NaN|Infinity/);
    });
  });
});
