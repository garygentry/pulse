import type { TargetStatus } from "@pulse/web-data/wire";
import {
  Gauge,
  Sparkline,
  StatusTimeline,
  TimeSeriesChart,
  type SparklineSample,
  type TimelineLane,
  type TimeSeriesSeries,
} from "@/ui";
import { Specimen, type WorkbenchSectionDef } from "../kit.js";

// Fixed data only: the workbench is snapshotted, so nothing here may vary per render.
const START = Date.parse("2026-01-15T00:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const STATUSES: readonly TargetStatus[] = ["ok", "warning", "critical", "unknown", "suppressed"];

const WAVE = Array.from({ length: 40 }, (_, i) => 50 + Math.round(30 * Math.sin(i / 4) + ((i * 7) % 11)));

const GAPPED: SparklineSample[] = WAVE.map((value, i) => ({
  at: START + i * MINUTE,
  value: i >= 14 && i < 19 ? null : value,
}));

const LANES: TimelineLane[] = [
  {
    id: "nas-01",
    label: "nas-01",
    segments: [
      { status: "ok", start: START, end: START + 6 * HOUR },
      { status: "warning", start: START + 6 * HOUR, end: START + 9 * HOUR },
      { status: "critical", start: START + 9 * HOUR, end: START + 11 * HOUR },
      { status: "ok", start: START + 11 * HOUR, end: START + 24 * HOUR },
    ],
  },
  {
    id: "edge-01",
    label: "edge-01",
    segments: [
      { status: "ok", start: START, end: START + 14 * HOUR },
      { status: "suppressed", start: START + 14 * HOUR, end: START + 18 * HOUR },
      { status: "ok", start: START + 18 * HOUR, end: START + 24 * HOUR },
    ],
  },
  {
    id: "pve-02",
    label: "pve-02",
    segments: [
      { status: "unknown", start: START, end: START + 3 * HOUR },
      { status: "ok", start: START + 3 * HOUR, end: START + 24 * HOUR },
    ],
  },
];

const TIMESTAMPS = Array.from({ length: 60 }, (_, i) => (START + i * 5 * MINUTE) / 1000);

const SERIES: TimeSeriesSeries[] = [
  { label: "nas-01 cpu %", data: TIMESTAMPS.map((_, i) => 30 + ((i * 13) % 40)) },
  { label: "edge-01 cpu %", data: TIMESTAMPS.map((_, i) => (i >= 20 && i < 26 ? null : 12 + ((i * 7) % 18))) },
  { label: "pve-02 cpu %", data: TIMESTAMPS.map((_, i) => 55 + Math.round(20 * Math.sin(i / 6))) },
];

const STATUS_SERIES: TimeSeriesSeries[] = [
  { label: "latency (critical)", status: "critical", data: TIMESTAMPS.map((_, i) => 80 + ((i * 11) % 30)) },
  { label: "latency (suppressed)", status: "suppressed", data: TIMESTAMPS.map((_, i) => 40 + ((i * 5) % 20)) },
];

function Viz() {
  return (
    <>
      <Specimen label="Sparkline: every status (suppressed is dashed)">
        {STATUSES.map((status) => (
          <span key={status} className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
            <Sparkline values={WAVE} status={status} ariaLabel={`CPU trend, ${status}`} />
            {status}
          </span>
        ))}
      </Specimen>
      <Specimen label="Sparkline: timestamped samples with a gap; empty">
        <Sparkline samples={GAPPED} width={160} ariaLabel="Scrape latency with a gap" />
        <Sparkline values={[]} ariaLabel="No samples" />
      </Specimen>
      <Specimen label="StatusTimeline: lanes, suppressed hatched, unknown solid">
        <StatusTimeline
          lanes={LANES}
          domainStart={START}
          domainEnd={START + 24 * HOUR}
          width={560}
          ariaLabel="Host status over 24 hours"
        />
      </Specimen>
      <Specimen label="Gauge: every status, label, custom range">
        {STATUSES.map((status, i) => (
          <Gauge key={status} value={20 + i * 18} status={status} label={status} ariaLabel={`Disk ${status}`} />
        ))}
        <Gauge value={750} min={0} max={1000} size={96} thickness={10} label="ms" ariaLabel="Latency 750 ms" />
      </Specimen>
      <Specimen label="TimeSeriesChart (lazy uPlot): chart tokens per series, gap">
        <div className="w-full">
          <TimeSeriesChart timestamps={TIMESTAMPS} series={SERIES} height={220} ariaLabel="CPU by host" />
        </div>
      </Specimen>
      <Specimen label="TimeSeriesChart: status-coloured series (suppressed dashed)">
        <div className="w-full">
          <TimeSeriesChart
            timestamps={TIMESTAMPS}
            series={STATUS_SERIES}
            height={180}
            ariaLabel="Latency by status"
          />
        </div>
      </Specimen>
    </>
  );
}

export const viz: WorkbenchSectionDef = {
  id: "viz",
  title: "Visualisation",
  Demo: Viz,
};
