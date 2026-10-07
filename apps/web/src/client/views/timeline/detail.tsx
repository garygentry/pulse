// The selected-target detail region (07 §8; REQ-CHART-01..06, REQ-RANGE-02, REQ-PERF-03): heading,
// Estate/Grafana links, a close button and the curated charts for exactly one selected host or
// service. Host slots chart HOST_CHART_QUERIES ∩ node.queryIds on the page axis (REQ-CHART-03);
// service slots chart one endpoint's check latency when the index lists it (09 §1, the `reachable`
// prop). Each slot owns its RegionErrorBoundary (REQ-OBS-01). The region never
// mounts in kiosk, so every chart is interactive. Every upstream string is a JSX text child.
import type { ReactElement } from "react";
import type { HistoryPayload, RangeId } from "@pulse/web-data/wire";
import { Button, EmptyState, ExternalLink, Section } from "@/ui";
import type { EstateClock } from "../../format.js";
import type { TimeAxis } from "../_shared/timeseries/axis.js";
import { useHistory } from "../_shared/timeseries/history/use-history.js";
import { HistoryRegion } from "../_shared/timeseries/history/region.js";
import { RegionErrorBoundary } from "../_shared/timeseries/history/boundary.js";
import type { HistoryRegionState, RequestQueue } from "../_shared/timeseries/history/client.js";
import { ChartChunkPrefetch, SyncedChart } from "../_shared/timeseries/chart.js";
import type { ReadoutRegistry } from "../_shared/timeseries/readout.js";
import { CLIENT_QUERY_META, HOST_CHART_QUERIES, rangeExceedsMax, SERVICE_CHART_QUERY } from "../_shared/timeseries/query-meta.js";
import type { ClientQueryMeta } from "../_shared/timeseries/query-meta.js";
import { targetKey } from "./model.js";
import type { LaneNode } from "./model.js";
import { CHART_READOUT_ORDER, CHECK_LATENCY_UNAVAILABLE, HOST_CHART_TITLE, estateHref, notAvailableAtRange, safeGrafanaHref } from "./detail-model.js";

const TITLE_ID = "timeline-detail-title";
/** Auto-fit chart columns, at least 20rem each; one column on narrow viewports. */
const CHARTS_CLASS = "grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] [@media(max-width:30rem)]:grid-cols-1";

// ---------------------------------------------------------------------------
// Component (07 §8.1)
// ---------------------------------------------------------------------------

/** Props for TargetDetail. */
export interface TargetDetailProps {
  /** The selected host or service lane. */ readonly node: LaneNode;
  /** Selected range. */ readonly range: RangeId;
  /** Current window end (key component, §3.6). */ readonly end: number;
  /** Server generation (key component). */ readonly generation: string | null;
  /** Page queue. */ readonly queue: RequestQueue;
  /** Page axis (charts share it: REQ-CHART-03). */ readonly axis: TimeAxis;
  /** Page readout registry. */ readonly readouts: ReadoutRegistry;
  /** Estate clock. */ readonly clock: EstateClock;
  /** CursorReadout summaryId (READOUT_ID), passed as each chart's `readout.summaryId`. */ readonly readoutId: string;
  /** Remove `sel` (push). */ readonly onClose: () => void;
  /** Check-history gate (09 §1): `(key) => checkHistoryReachable(key, index)`. */ readonly reachable: (key: string) => boolean;
}

type HostChartQuery = (typeof HOST_CHART_QUERIES)[number];

/** The selected-target region: heading, links, close button and the curated charts for the target. */
export function TargetDetail(props: TargetDetailProps): ReactElement {
  const { node } = props;
  const isService = node.target.kind === "service";
  const heading = isService ? `Service ${node.name} on ${node.hostName ?? ""}` : `Host ${node.name}`;
  const grafana = safeGrafanaHref(node.grafanaUrl);

  let charts: ReactElement;
  if (isService) {
    charts = node.endpoints.length === 0 ? (
      <EmptyState
        icon="info"
        title="No Gatus checks for this service"
        description="This service declares no Gatus endpoints, so there is no check latency to chart."
      />
    ) : (
      <div data-slot="timeline-detail-charts" className={CHARTS_CLASS}>
        {node.endpoints.map((endpoint, slotIndex) => (
          <ServiceEndpointSlot key={endpoint} {...props} endpoint={endpoint} slotIndex={slotIndex} />
        ))}
      </div>
    );
  } else {
    const queries: HostChartQuery[] = HOST_CHART_QUERIES.filter((q) => node.queryIds.includes(q));
    charts = queries.length === 0 ? (
      <EmptyState
        icon="info"
        title="No curated charts for this host"
        description="The timeline index advertises no capacity charts for this host."
      />
    ) : (
      <div data-slot="timeline-detail-charts" className={CHARTS_CLASS}>
        {queries.map((queryId, slotIndex) => (
          <HostChartSlot key={queryId} {...props} queryId={queryId} slotIndex={slotIndex} />
        ))}
      </div>
    );
  }

  return (
    <Section
      variant="card"
      title={heading}
      headingId={TITLE_ID}
      data-slot="timeline-detail"
      data-target-kind={node.target.kind}
      className="min-w-0 [@media(max-width:30rem)]:p-2"
      actions={
        <>
          <nav data-slot="timeline-detail-links" aria-label="Links for this target" className="flex flex-wrap items-center gap-3 text-sm">
            <a className="text-foreground underline underline-offset-4" href={estateHref(node)}>Open in Estate</a>
            {grafana !== null ? <ExternalLink href={grafana}>Open in Grafana</ExternalLink> : null}
          </nav>
          <Button type="button" variant="outline" size="sm" onClick={() => props.onClose()}>
            Close detail
          </Button>
        </>
      }
    >
      <ChartChunkPrefetch />
      {charts}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Slots (07 §8.3)
// ---------------------------------------------------------------------------

interface ChartSlotBodyProps {
  readonly detail: TargetDetailProps;
  readonly slotKey: string;
  readonly title: string;
  readonly chartId: string;
  readonly unit: ClientQueryMeta["unit"];
  readonly slotIndex: number;
  readonly state: HistoryRegionState<HistoryPayload>;
  readonly retry: () => void;
}

/** RegionErrorBoundary › chart-slot › h3 › HistoryRegion › SyncedChart, shared by both slot kinds. */
function ChartSlotBody(props: ChartSlotBodyProps): ReactElement {
  const d = props.detail;
  return (
    <RegionErrorBoundary label={props.title} resetKey={`${d.range}|${d.node.target.id}`}>
      <div data-slot="timeline-chart-slot" data-query-id={props.slotKey} className="flex min-w-0 flex-col gap-1">
        {/* The h3 duplicates the chart figcaption on purpose (07 Warning W9). */}
        <h3 data-slot="timeline-chart-title" className="text-sm font-medium text-muted-foreground">{props.title}</h3>
        <HistoryRegion state={props.state} label={props.title.toLowerCase()} onRetry={props.retry}>
          {(payload) => (
            <SyncedChart
              chartId={props.chartId}
              title={props.title}
              unit={props.unit}
              range={d.range}
              payload={payload}
              axis={d.axis}
              clock={d.clock}
              interactive /* the detail region never mounts in kiosk (§8.1) */
              readout={{ mode: "page", registry: d.readouts, summaryId: d.readoutId, order: CHART_READOUT_ORDER + props.slotIndex }}
            />
          )}
        </HistoryRegion>
      </div>
    </RegionErrorBoundary>
  );
}

/** One host capacity chart. Private. */
function HostChartSlot(props: TargetDetailProps & { readonly queryId: HostChartQuery; readonly slotIndex: number }): ReactElement {
  const meta = CLIENT_QUERY_META[props.queryId];
  const title = HOST_CHART_TITLE[props.queryId];
  const tooLong = rangeExceedsMax(props.queryId, props.range);
  const { state, retry } = useHistory(
    { op: "target", target: props.node.target, queryId: props.queryId, range: props.range } as const,
    {
      queue: props.queue,
      priority: 1,
      end: props.end,
      generation: props.generation,
      notApplicable: tooLong && meta !== undefined ? notAvailableAtRange(meta.maxRange) : null,
    },
  );
  return (
    <ChartSlotBody
      detail={props}
      slotKey={props.queryId}
      title={title}
      chartId={`${targetKey(props.node.target)}|${props.queryId}`}
      unit={meta?.unit ?? "percent"}
      slotIndex={props.slotIndex}
      state={state}
      retry={retry}
    />
  );
}

/** One service endpoint's latency chart slot. Private. Issues no request for an unlisted endpoint. */
function ServiceEndpointSlot(props: TargetDetailProps & { readonly endpoint: string; readonly slotIndex: number }): ReactElement {
  const meta = CLIENT_QUERY_META[SERVICE_CHART_QUERY];
  const reachable = props.reachable(props.endpoint);
  const tooLong = rangeExceedsMax(SERVICE_CHART_QUERY, props.range);
  const maxRange = meta?.maxRange ?? "24h";
  const { state, retry } = useHistory(
    { op: "target", target: { kind: "endpoint", id: props.endpoint }, queryId: SERVICE_CHART_QUERY, range: props.range } as const,
    {
      queue: props.queue,
      priority: 1,
      end: props.end,
      generation: props.generation,
      // Reachability before range: "at this range" would falsely suggest a shorter range helps (§8.3).
      notApplicable: !reachable ? CHECK_LATENCY_UNAVAILABLE : tooLong ? notAvailableAtRange(maxRange) : null,
    },
  );
  return (
    <ChartSlotBody
      detail={props}
      slotKey={SERVICE_CHART_QUERY}
      title={`Check latency — ${props.endpoint}`}
      chartId={`${props.endpoint}|${SERVICE_CHART_QUERY}`}
      unit={meta?.unit ?? "milliseconds"}
      slotIndex={props.slotIndex}
      state={state}
      retry={retry}
    />
  );
}
