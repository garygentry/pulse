// apps/web/src/client/views/overview/drawer/CheckHistory.tsx — snapshot-backed recent check outcomes.
// Lanes come from `buildCheckTimeline` and render through the shared dependency-free StatusTimeline;
// the adjacent text list (server order) conveys every outcome without colour and keeps rows whose
// time is unavailable. Never performs I/O.

import type { ReactElement } from "react";

import type { CheckSummary } from "@pulse/web-data/wire";
import { Section, StatusTimeline, type TimelineLane } from "@/ui";
import type { EstateClock } from "../../../format.js";
import { formatInstant } from "../stats/format.js";
import { DRAWER_EMPTY_CLASS, DRAWER_LIST_CLASS, DRAWER_ROW_CLASS } from "./classes.js";

/** Empty-section copy. */
export const NO_RECENT_CHECKS_TEXT = "No recent checks for this target.";
/** Copy for a check row whose observation time is null or invalid. */
export const OBSERVATION_TIME_UNAVAILABLE_TEXT = "Observation time unavailable";
/** Accessible name of the shared timeline. */
export const CHECK_TIMELINE_LABEL = "Recent check outcomes";

/** Shared domain spanning every lane segment, or null when no segment exists. */
export function checkTimelineDomain(lanes: readonly TimelineLane[]): { readonly start: number; readonly end: number } | null {
  let start = Infinity;
  let end = -Infinity;
  for (const lane of lanes) {
    for (const segment of lane.segments) {
      start = Math.min(start, segment.start);
      end = Math.max(end, segment.end);
    }
  }
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

function outcomeText(success: boolean | null): string {
  return success === true ? "Succeeded" : success === false ? "Failed" : "Result unavailable";
}

function CheckRow(props: { readonly check: CheckSummary; readonly clock: EstateClock }): ReactElement {
  const { check, clock } = props;
  const observed = formatInstant(clock, check.observedAt);
  const outcome = check.success === true ? "ok" : check.success === false ? "critical" : "unknown";
  return (
    <li className={DRAWER_ROW_CLASS} data-endpoint={check.endpoint} data-outcome={outcome}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span data-slot="drawer-check-endpoint" className="font-medium break-all">{check.endpoint}</span>
        <span data-slot="drawer-check-outcome">{outcomeText(check.success)}</span>
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
        <span data-slot="drawer-check-time">{observed === null ? OBSERVATION_TIME_UNAVAILABLE_TEXT : observed}</span>
        {check.durationMs !== null && Number.isFinite(check.durationMs) ? (
          <span data-slot="drawer-check-duration">{`${check.durationMs} ms`}</span>
        ) : null}
      </div>
    </li>
  );
}

/** Render snapshot-backed recent outcomes; this component never performs I/O. */
export function CheckHistory(props: {
  readonly checks: readonly CheckSummary[];
  readonly lanes: readonly TimelineLane[];
  readonly clock: EstateClock;
}): ReactElement {
  const domain = checkTimelineDomain(props.lanes);
  return (
    <Section level={3} title="Recent checks" data-section="checks">
      {props.checks.length === 0 ? (
        <p data-slot="drawer-empty" className={DRAWER_EMPTY_CLASS}>{NO_RECENT_CHECKS_TEXT}</p>
      ) : (
        <>
          {domain !== null ? (
            <div data-slot="drawer-timeline" className="min-w-0 overflow-x-auto">
              <StatusTimeline lanes={props.lanes} domainStart={domain.start} domainEnd={domain.end} ariaLabel={CHECK_TIMELINE_LABEL} />
            </div>
          ) : null}
          <ul className={DRAWER_LIST_CLASS}>
            {props.checks.map((check, i) => <CheckRow key={`${check.endpoint}:${i}`} check={check} clock={props.clock} />)}
          </ul>
        </>
      )}
    </Section>
  );
}
