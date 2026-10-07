// stack/alerting/src/transform/time-intervals.ts
// The native `time_intervals` fragment: the quiet-hours MUTE window (attached to warning/info by
// routing.ts, 007) and the daily 09:00 digest ACTIVE window (attached to info). Every interval
// carries `location: <estate.timezone>` (IANA, required) so all quiet-hour/digest math is
// estate-tz-explicit (REQ-ROUTE-03, REQ-SEV-04). See 04-alertmanager-config.md §4.
//
// A pure fragment generator: no file I/O, no clock, no secret resolution.

import type { Estate } from "./estate.js";
import type { AmTimeInterval } from "./am-config.js";
import type { AlertingFinding } from "./findings.js";
import { TIMING } from "../constants.js";

/** The stable name of the digest active-window interval (the info gate). Always present. */
const DIGEST_NAME = "daily-0900";
/** The stable name of the quiet-hours mute interval. Present only when the estate declares it. */
const QUIET_HOURS_NAME = "quiet-hours";

/**
 * A declared quiet-hours window, in `HH:MM` 24-hour estate-local time. `end <= start` (or an
 * `end` of `'00:00'`) denotes a window that spans midnight and is emitted as two non-wrapping
 * windows (AM time-of-day windows do not wrap — §4.1).
 */
export interface QuietHoursWindow {
  start: string;
  end: string;
}

/**
 * The estate fields this fragment reads: a core `Estate` (for `timezone`) plus an OPTIONAL
 * alerting-local quiet-hours declaration. The core model carries no quiet-hours field yet
 * (§13 cross-feature warning), so a real estate leaves `quietHours` undefined and no mute
 * interval is emitted; the declaration is honored the moment it lands (activation-on-delivery).
 */
export type TimeIntervalsEstate = Estate & { quietHours?: QuietHoursWindow };

/**
 * Emit the native `time_intervals` block plus the interval names routing.ts (007) attaches to the
 * severity route. If `estate.timezone` is missing or not a valid IANA name, push an INVALID_ROUTE
 * (error) finding and emit NO intervals — quiet hours/digest cannot be rendered without a tz, so
 * this aborts the whole config (REQ-CONFIG-01, §4).
 *
 * @param estate   - The validated estate; reads `estate.timezone` (IANA) and quiet-hours declaration.
 * @param findings - Accumulator (INVALID_ROUTE on a missing/invalid timezone).
 * @returns The named time intervals, the quiet-hours name (or undefined), and the digest name.
 */
export function buildTimeIntervals(
  estate: TimeIntervalsEstate,
  findings: AlertingFinding[],
): { intervals: AmTimeInterval[]; quietHoursName: string | undefined; digestName: string } {
  const tz = estate.timezone;
  if (!isValidIanaTimezone(tz)) {
    findings.push({
      severity: "error",
      code: "INVALID_ROUTE",
      file: "estate",
      path: "estate.timezone",
      message:
        `Estate timezone is ${tz ? `not a valid IANA name (${tz})` : "missing"}; ` +
        "quiet-hours and digest windows cannot be rendered.",
      fix: 'Set estate.timezone to a valid IANA zone, e.g. "America/New_York".',
    });
    return { intervals: [], quietHoursName: undefined, digestName: DIGEST_NAME };
  }

  const intervals: AmTimeInterval[] = [];

  // Quiet-hours mute window — emitted only when the estate declares one.
  let quietHoursName: string | undefined;
  if (estate.quietHours) {
    intervals.push({
      name: QUIET_HOURS_NAME,
      time_intervals: [
        {
          location: tz,
          times: splitWindow(estate.quietHours.start, estate.quietHours.end),
        },
      ],
    });
    quietHoursName = QUIET_HOURS_NAME;
  }

  // Daily digest gate — a one-minute active window at TIMING.digestTime (09:00 → 09:01).
  intervals.push({
    name: DIGEST_NAME,
    time_intervals: [
      {
        location: tz,
        times: [{ start_time: TIMING.digestTime, end_time: addOneMinute(TIMING.digestTime) }],
      },
    ],
  });

  return { intervals, quietHoursName, digestName: DIGEST_NAME };
}

/** True iff `tz` is a non-empty, valid IANA timezone name (Intl rejects unknown zones). */
function isValidIanaTimezone(tz: string | undefined): tz is string {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    // `Intl.DateTimeFormat` throws a RangeError for an unknown IANA zone.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Parse `HH:MM` (00:00–24:00) to minutes-since-midnight; `24:00`→1440, `00:00`→0. */
function toMinutes(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Malformed time-of-day: ${hhmm}`);
  return Number(m[1]!) * 60 + Number(m[2]!);
}

/** Format minutes-since-midnight to `HH:MM`; 1440→`24:00`. */
function fromMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const mm = min % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Add one minute to an `HH:MM` value (used for the one-minute digest window). */
function addOneMinute(hhmm: string): string {
  return fromMinutes(toMinutes(hhmm) + 1);
}

/**
 * Split a declared quiet-hours window into non-wrapping AM windows. A window whose `end` is at or
 * before its `start` (or ends at midnight) spans midnight and is emitted as TWO windows
 * (`start–24:00` and `00:00–end`); a same-day window is emitted as one. §4.1.
 */
function splitWindow(start: string, end: string): { start_time: string; end_time: string }[] {
  const startMin = toMinutes(start);
  // An `end` of `00:00` means end-of-day (24:00), not the start of the day.
  const endMin = toMinutes(end) === 0 ? 1440 : toMinutes(end);
  if (endMin > startMin) {
    return [{ start_time: fromMinutes(startMin), end_time: fromMinutes(endMin) }];
  }
  return [
    { start_time: fromMinutes(startMin), end_time: "24:00" },
    { start_time: "00:00", end_time: fromMinutes(endMin) },
  ];
}
