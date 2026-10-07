// stack/alerting/tests/time-intervals.test.ts
// Tier-A unit tests for the time-intervals fragment (04 §4): the daily-0900 digest window (always
// present, one-minute active window at TIMING.digestTime), the quiet-hours midnight two-window
// split, quietHoursName presence semantics, and the INVALID_ROUTE finding on a missing/invalid
// IANA timezone.
/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import {
  buildTimeIntervals,
  type TimeIntervalsEstate,
} from "../src/transform/time-intervals.js";
import type { AlertingFinding } from "../src/transform/findings.js";

/** A minimal valid estate carrying the fields buildTimeIntervals reads. */
function makeEstate(over: Partial<TimeIntervalsEstate> = {}): TimeIntervalsEstate {
  return {
    name: "acme-fictional",
    domains: ["acme.example"],
    timezone: "America/New_York",
    deadmanHook: "${PULSE_DEADMANSSWITCH_URL}",
    provenance: { file: "estate.yaml", path: "estate", line: 1, col: 1 },
    ...over,
  };
}

describe("buildTimeIntervals", () => {
  test("digestName is always 'daily-0900' with a 09:00→09:01 window in the estate tz", () => {
    const findings: AlertingFinding[] = [];
    const out = buildTimeIntervals(makeEstate(), findings);

    expect(findings.length).toBe(0);
    expect(out.digestName).toBe("daily-0900");

    const digest = out.intervals.find((i) => i.name === "daily-0900");
    expect(digest).toBeDefined();
    expect(digest!.time_intervals.length).toBe(1);
    const spec = digest!.time_intervals[0]!;
    expect(spec.location).toBe("America/New_York");
    expect(spec.times).toEqual([{ start_time: "09:00", end_time: "09:01" }]);
  });

  test("quietHoursName is undefined and no quiet-hours interval when none is declared", () => {
    const findings: AlertingFinding[] = [];
    const out = buildTimeIntervals(makeEstate(), findings);

    expect(out.quietHoursName).toBe(undefined);
    expect(out.intervals.find((i) => i.name === "quiet-hours")).toBe(undefined);
  });

  test("a quiet-hours window spanning midnight is split into two non-wrapping windows", () => {
    const findings: AlertingFinding[] = [];
    const out = buildTimeIntervals(
      makeEstate({ quietHours: { start: "22:00", end: "08:00" } }),
      findings,
    );

    expect(findings.length).toBe(0);
    expect(out.quietHoursName).toBe("quiet-hours");

    const quiet = out.intervals.find((i) => i.name === "quiet-hours");
    expect(quiet).toBeDefined();
    const spec = quiet!.time_intervals[0]!;
    expect(spec.location).toBe("America/New_York");
    expect(spec.times).toEqual([
      { start_time: "22:00", end_time: "24:00" },
      { start_time: "00:00", end_time: "08:00" },
    ]);
  });

  test("a same-day quiet-hours window is emitted as a single window", () => {
    const findings: AlertingFinding[] = [];
    const out = buildTimeIntervals(
      makeEstate({ quietHours: { start: "01:00", end: "05:00" } }),
      findings,
    );

    const quiet = out.intervals.find((i) => i.name === "quiet-hours");
    expect(quiet!.time_intervals[0]!.times).toEqual([
      { start_time: "01:00", end_time: "05:00" },
    ]);
  });

  test("a missing timezone yields an INVALID_ROUTE error at path 'estate.timezone' and no intervals", () => {
    const findings: AlertingFinding[] = [];
    // Force a missing timezone (bypasses the type via the estate helper).
    const estate = makeEstate({ timezone: "" as unknown as string });
    const out = buildTimeIntervals(estate, findings);

    expect(out.intervals.length).toBe(0);
    expect(out.quietHoursName).toBe(undefined);
    expect(findings.length).toBe(1);
    const f = findings[0]!;
    expect(f.severity).toBe("error");
    expect(f.code).toBe("INVALID_ROUTE");
    expect(f.path).toBe("estate.timezone");
  });

  test("an invalid (non-IANA) timezone yields an INVALID_ROUTE error and no intervals", () => {
    const findings: AlertingFinding[] = [];
    const out = buildTimeIntervals(makeEstate({ timezone: "Not/AZone" }), findings);

    expect(out.intervals.length).toBe(0);
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("INVALID_ROUTE");
    expect(findings[0]!.path).toBe("estate.timezone");
  });
});
