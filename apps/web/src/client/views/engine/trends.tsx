// apps/web/src/client/views/engine/trends.tsx
import type { ReactElement } from "react";
import { useEffect, useId, useMemo } from "react";
import { useSignal } from "@preact/signals-react";
import type { HistoryPayload, RangeId } from "@pulse/web-data/wire";
import { EmptyState, Section, useDisposable } from "@/ui";
import type { EstateClock } from "../../format.js";
import { useHistory } from "../_shared/timeseries/history/use-history.js";
import { HistoryRegion } from "../_shared/timeseries/history/region.js";
import { RegionErrorBoundary } from "../_shared/timeseries/history/boundary.js";
import { createRequestQueue, HISTORY_CONCURRENCY, LIVE_REFRESH_MS } from "../_shared/timeseries/history/client.js";
import type { RequestQueue } from "../_shared/timeseries/history/client.js";
import { CLIENT_QUERY_META, ENGINE_TREND_QUERIES } from "../_shared/timeseries/query-meta.js";
import type { ClientQueryMeta } from "../_shared/timeseries/query-meta.js";
import { createTimeAxis } from "../_shared/timeseries/axis.js";
import type { TimeWindow } from "../_shared/timeseries/axis.js";
import { SyncedChart } from "../_shared/timeseries/chart.js";
import { trendWindow } from "./trends-model.js";
import { useSignals } from "@preact/signals-react/runtime";

/** The five curated engine trend query ids (00 §6.1 ENGINE_TREND_QUERIES). */
export type EngineTrendQueryId = (typeof ENGINE_TREND_QUERIES)[number];

/** Title, region label and unit text per trend (REQ-CAP-02 "labelled with that range and unit").
 *  The unit text follows the curated query semantics (packages/web-data/src/queries/binding.ts:326-331).
 *  It is the one unit wording for the card: the meta line, the chart's accessible name and its
 *  description all use it (the chart shows no second caption). */
export const TREND_LABEL: Readonly<
  Record<EngineTrendQueryId, { readonly title: string; readonly region: string; readonly unit: string }>
> = {
  "engine.ingestion-rate": { title: "Ingestion rate", region: "ingestion rate", unit: "rows per second" },
  "engine.active-series": { title: "Active series", region: "active series", unit: "series" },
  "engine.disk-usage": { title: "TSDB disk usage", region: "disk usage", unit: "bytes" },
  "engine.notification-failures": { title: "Notification failures", region: "notification failures", unit: "failures per second" },
  "engine.notification-latency": { title: "Notification latency (p99)", region: "notification latency", unit: "seconds" },
};

/** Human-readable range label for the chart caption. */
export const RANGE_LABEL: Readonly<Record<RangeId, string>> = {
  "1h": "Last 1 hour", "6h": "Last 6 hours", "24h": "Last 24 hours", "7d": "Last 7 days",
};

/** Placeholder step until the first payload reports `effectiveStepSeconds`. No request depends
 *  on it, because zoom only magnifies data already fetched (REQ-ZOOM-03). */
const INITIAL_TREND_STEP_S = 60;

/** Props for {@link EngineTrends}. */
export interface EngineTrendsProps {
  /** Estate clock: the zone for the axis shift and the readouts. */
  readonly clock: EstateClock;
  /** Kiosk: charts are shown but are not interactive (REQ-KIOSK-02). */
  readonly kiosk: boolean;
  /** `readObservation(store)?.generation ?? null`: a server restart re-keys every trend (02 §7.1). */
  readonly generation: string | null;
}

/**
 * The five curated engine trend charts, in ENGINE_TREND_QUERIES order (REQ-CAP-02). This component
 * owns the view's single request queue (02 §5, §8.6). Each chart has its own RegionErrorBoundary
 * **outside** its HistoryRegion (02 §9.1 placement rule), so a render fault in one chart never
 * blanks the others (REQ-OBS-01).
 */
export function EngineTrends({ clock, kiosk, generation }: EngineTrendsProps): ReactElement {
  const queue = useMemo(() => createRequestQueue(HISTORY_CONCURRENCY), []);
  return (
    <Section title="Trends" level={2}>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,calc(var(--spacing)*96)),1fr))] gap-3 p-0">
        {ENGINE_TREND_QUERIES.map((id) => {
          const meta = CLIENT_QUERY_META[id];
          return (
            <li key={id} className="min-w-0" data-query={id}>
              <RegionErrorBoundary label={TREND_LABEL[id].title} resetKey={generation}>
                {meta === undefined ? (
                  <EmptyState icon="circle-help" title={`${TREND_LABEL[id].title}: trend not available`} />
                ) : (
                  <EngineTrendChart
                    queryId={id}
                    meta={meta}
                    queue={queue}
                    generation={generation}
                    clock={clock}
                    kiosk={kiosk}
                  />
                )}
              </RegionErrorBoundary>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** Props for {@link EngineTrendChart}. */
export interface EngineTrendChartProps {
  /** Curated query id. */ readonly queryId: EngineTrendQueryId;
  /** Its client metadata (defaultRange, unit). */ readonly meta: ClientQueryMeta;
  /** The view's shared request queue (02 §5). */ readonly queue: RequestQueue;
  /** Cycle generation for the history key (02 §7.2). */ readonly generation: string | null;
  /** Estate clock. */ readonly clock: EstateClock;
  /** Kiosk: interactive={false}. */ readonly kiosk: boolean;
}

/**
 * One trend chart at its curated default range. It has its OWN TimeAxis: engine charts are NOT
 * synced across the page (tech-spec §3.2), so each chart has only a local cursor and readout. Data
 * is requested through useHistory at priority 0 and refreshed every LIVE_REFRESH_MS while mounted.
 */
export function EngineTrendChart({ queryId, meta, queue, generation, clock, kiosk }: EngineTrendChartProps): ReactElement {
  useSignals();
  const headingId = `${useId()}-trend`;
  const metaId = `${headingId}-meta`;
  const range = meta.defaultRange;
  const label = TREND_LABEL[queryId];

  const { state, retry } = useHistory(
    { op: "estate", queryId, range },
    { queue, priority: 0, refreshMs: LIVE_REFRESH_MS, generation },
  );

  // Local axis, not synced with the page (tech-spec §3.2). Created once per mounted chart.
  const domain = useSignal<TimeWindow>(trendWindow(Math.floor(Date.now() / 1000), range));
  const axis = useDisposable(
    () => createTimeAxis({ domain, initialZoom: null, initialStepSeconds: INITIAL_TREND_STEP_S }),
    (a) => a.dispose(),
  );

  // Latest payload: ready data, or the previous data retained under loading/error (02 §7.4).
  const latest: HistoryPayload | null =
    state.phase === "ready" ? state.data
    : state.phase === "loading" || state.phase === "error" ? state.previous
    : null;

  useEffect(() => {
    if (latest === null) return;
    const endSec = Math.floor(Date.parse(latest.fetchedAt) / 1000);
    if (Number.isFinite(endSec)) domain.value = trendWindow(endSec, range);
    axis.stepSeconds.value = latest.effectiveStepSeconds;
  }, [latest]);

  return (
    <section className="flex min-w-0 flex-col gap-1" aria-labelledby={headingId}>
      <h3 id={headingId} className="m-0 text-sm font-semibold wrap-anywhere">{label.title}</h3>
      <p id={metaId} className="m-0 text-sm text-muted-foreground">
        {RANGE_LABEL[range]} · {label.unit} · Times in {clock.timezone}
      </p>
      <HistoryRegion state={state} label={label.region} onRetry={retry} onShorterRange={null}>
        {(data: HistoryPayload) =>
          data.series.length === 0 ? (
            <EmptyState icon="circle-help" title={`No data in the ${RANGE_LABEL[range].toLowerCase()}`} />
          ) : (
            <SyncedChart
              chartId={queryId}
              title={label.title}
              unit={meta.unit}
              unitLabel={label.unit}
              caption={{ labelledBy: headingId, describedBy: metaId }}
              range={range}
              payload={data}
              axis={axis}
              clock={clock}
              interactive={!kiosk}
              readout={{ mode: "local" }}
            />
          )
        }
      </HistoryRegion>
    </section>
  );
}
