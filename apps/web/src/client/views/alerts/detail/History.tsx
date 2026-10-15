// src/client/views/alerts/detail/History.tsx — per-alert firing-history strip.
//
// The alerts view's ONLY on-demand upstream fetch: one GET /api/history/alerts?range=<RangeId> per pane
// open, aborted on close/re-open. A self-contained state machine over HistoryViewState — never throws
// into DetailPane, never renders a partial strip on overflow, never drops a lane, and never attributes
// by the Alertmanager fingerprint (canonical tuple + TargetIdentity only).
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { announce } from "../../../a11y/index.js";
import { ALERT_INTERVAL, EmptyState, ScrollRegion, Section, Skeleton, StatusTimeline } from "@/ui";
import type { ActiveAlert, RangeId } from "@pulse/web-data/wire";
import { TZ_FALLBACK_MARKER } from "../../../format.js";
import type { EstateClock } from "../../../format.js";
import { DEFAULT_HISTORY_RANGE } from "../taxonomy.js";
import { fetchAlertHistory } from "./history-client.js";
import { buildLanes, deriveDomain } from "./history-model.js";
import type { HistoryViewState } from "./history-model.js";

/** Props for the per-alert history strip. Owned by DetailPane (04). Client-only (not a wire type). */
export interface HistoryProps {
  /** The selected alert whose history is shown. Drives the fetch guard (historyRef) and attribution. */
  readonly alert: ActiveAlert;
  /** Range window for the strip. Defaults to DEFAULT_HISTORY_RANGE ("24h"). */
  readonly range?: RangeId;
  /** The estate clock: the strip's interval times read in the estate zone, as on the timeline. */
  readonly clock: EstateClock;
}

/** The selected alert's firing-history strip, inside its "Firing history" section. */
export function History(props: HistoryProps): ReactElement {
  return (
    <Section level={3} title="Firing history" data-section="history">
      <HistoryBody {...props} />
    </Section>
  );
}

function HistoryBody(props: HistoryProps): ReactElement {
  const range: RangeId = props.range ?? DEFAULT_HISTORY_RANGE;
  const historyRef = props.alert.historyRef;
  // The live store replaces the alerts payload every cycle, so historyRef gets a new identity each
  // update. Key the fetch on a stable primitive so an open pane keeps exactly one GET (no refetch or
  // Skeleton flash per cycle); attribution still reads props.alert at render time.
  const refKey =
    historyRef === null
      ? null
      : `${historyRef.queryId}|${historyRef.target ? `${historyRef.target.kind}:${historyRef.target.id}` : ""}`;

  const [state, setState] = useState<HistoryViewState>(
    historyRef === null ? { kind: "no-ref" } : { kind: "loading" },
  );

  useEffect(() => {
    if (refKey === null) {
      setState({ kind: "no-ref" });
      return;
    }

    const ctrl = new AbortController();
    setState({ kind: "loading" });

    void (async () => {
      const next = await fetchAlertHistory(range, ctrl.signal);
      if (next !== null && !ctrl.signal.aborted) setState(next);
    })();

    return () => ctrl.abort();
  }, [refKey, range]);

  useEffect(() => {
    if (state.kind === "error") announce("Alert history is unavailable.", "polite");
  }, [state.kind]);

  switch (state.kind) {
    case "loading":
      return (
        <div data-history-state="loading" aria-busy="true">
          <Skeleton className="h-6 w-full" />
        </div>
      );
    case "no-ref":
      return (
        <div data-history-state="no-ref">
          <EmptyState
            compact
            icon="clock"
            title="No history reference"
            description="This alert has no history reference, so a firing-history strip is unavailable."
          />
        </div>
      );
    case "ready": {
      const lanes = buildLanes(state.payload, props.alert);
      if (lanes.length === 0) {
        return (
          <div data-history-state="empty">
            <EmptyState compact icon="clock" title="No firing history" description={`No firing intervals in the last ${range}.`} />
          </div>
        );
      }
      const { domainStart, domainEnd } = deriveDomain(state.payload);
      const hasUnmatched = state.payload.lanes.some((l) => l.attribution === "unmatched");
      return (
        <div
          className="grid gap-2"
          data-history-state="ready"
          data-stale={String(state.payload.stale)}
        >
          {/* The chart is a fixed-size SVG: scroll it in a narrow pane rather than widen the page. */}
          <ScrollRegion label="Firing history chart">
            <StatusTimeline
              lanes={lanes}
              statusMap={ALERT_INTERVAL}
              formatTime={(t) => props.clock.format(new Date(t).toISOString())}
              domainStart={domainStart}
              domainEnd={domainEnd}
              ariaLabel={`Firing history for ${props.alert.name} over the last ${range}`}
            />
          </ScrollRegion>
          {props.clock.tzFallback ? (
            <p className="text-sm text-status-warn-fg" data-history-note="tz-fallback">
              {TZ_FALLBACK_MARKER}
            </p>
          ) : null}
          {hasUnmatched ? (
            <p className="text-sm text-muted-foreground" data-history-note="unmatched">
              Some lanes could not be attributed to a rendered target (shown, labeled “unmatched”).
            </p>
          ) : null}
        </div>
      );
    }
    case "error": {
      const overflow = state.code === "HISTORY_LIMIT_EXCEEDED";
      return (
        <div data-history-state="error" data-history-code={state.code}>
          <EmptyState
            compact
            icon="wifi-off"
            title="History unavailable"
            description={
              overflow
                ? "This alert's firing history exceeds the history service's limits and cannot be shown."
                : "The firing-history strip could not be loaded."
            }
          />
        </div>
      );
    }
  }
}
