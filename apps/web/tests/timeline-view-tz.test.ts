// Pin the process zone before any Date use so localOffsetSeconds is deterministic (08 §1, 06 §9).
const PRIOR_TZ = process.env.TZ;
process.env.TZ = "UTC";

// Unit tests for views/timeline/tz-shift.ts (06 §3, §9 tz row). Pure: no DOM.

import { afterAll, describe, expect, test } from "bun:test";

import {
  browserZone,
  isZoneSupported,
  localOffsetSeconds,
  shiftForEstateZone,
  zoneOffsetSeconds,
} from "../src/client/views/_shared/timeseries/tz-shift.js";

afterAll(() => {
  if (PRIOR_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = PRIOR_TZ;
});

const CHICAGO = "America/Chicago";
const ST_JOHNS = "America/St_Johns";
/** 2026-03-08 02:00 CST → 03:00 CDT, i.e. 08:00:00 UTC. */
const SPRING_S = Date.UTC(2026, 2, 8, 8, 0, 0) / 1000;
/** 2026-11-01 02:00 CDT → 01:00 CST, i.e. 07:00:00 UTC. */
const FALL_S = Date.UTC(2026, 10, 1, 7, 0, 0) / 1000;
/** 2026-03-08 02:00 NST → 03:00 NDT, i.e. 05:30:00 UTC (a non-hour transition). */
const ST_JOHNS_SPRING_S = Date.UTC(2026, 2, 8, 5, 30, 0) / 1000;

function strictlyAscending(xs: readonly number[]): boolean {
  for (let i = 1; i < xs.length; i++) if (!(xs[i]! > xs[i - 1]!)) return false;
  return true;
}

function grid(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let t = from; t <= to; t += step) out.push(t);
  return out;
}

describe("zoneOffsetSeconds", () => {
  test("REQ-RANGE-03: the process zone is pinned to UTC", () => {
    expect(localOffsetSeconds(Date.UTC(2026, 6, 1))).toBe(0);
    expect(localOffsetSeconds(NaN)).toBe(0);
    expect(browserZone()).toBe(browserZone());
    expect(isZoneSupported(browserZone())).toBe(true);
  });

  test("REQ-RANGE-03: America/Chicago spring 2026 transition is exact to the second", () => {
    expect(zoneOffsetSeconds((SPRING_S - 3600) * 1000, CHICAGO)).toBe(-21_600);
    expect(zoneOffsetSeconds((SPRING_S - 1) * 1000, CHICAGO)).toBe(-21_600);
    expect(zoneOffsetSeconds(SPRING_S * 1000, CHICAGO)).toBe(-18_000);
    expect(zoneOffsetSeconds((SPRING_S + 1) * 1000, CHICAGO)).toBe(-18_000);
    // Sub-second instants floor to the containing second.
    expect(zoneOffsetSeconds(SPRING_S * 1000 - 1, CHICAGO)).toBe(-21_600);
  });

  test("REQ-RANGE-03: America/Chicago fall 2026 transition is exact to the second", () => {
    expect(zoneOffsetSeconds((FALL_S - 1) * 1000, CHICAGO)).toBe(-18_000);
    expect(zoneOffsetSeconds(FALL_S * 1000, CHICAGO)).toBe(-21_600);
    expect(zoneOffsetSeconds((FALL_S + 3599) * 1000, CHICAGO)).toBe(-21_600);
  });

  test("REQ-RANGE-03: the bucket cache returns identical values on repeat", () => {
    const probes = [SPRING_S - 1, SPRING_S, FALL_S - 1, FALL_S, FALL_S + 12_345, 1_790_251_200];
    const first = probes.map((t) => zoneOffsetSeconds(t * 1000, CHICAGO));
    const second = probes.map((t) => zoneOffsetSeconds(t * 1000, CHICAGO));
    expect(second).toEqual(first);
    // Every second across a transition hour agrees with a fresh Intl read.
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: CHICAGO, timeZoneName: "shortOffset" });
    for (let t = FALL_S - 3600; t < FALL_S + 3600; t += 599) {
      const name = fmt.formatToParts(new Date(t * 1000)).find((p) => p.type === "timeZoneName")?.value;
      expect(zoneOffsetSeconds(t * 1000, CHICAGO)).toBe(name === "GMT-5" ? -18_000 : -21_600);
    }
  });

  test("REQ-RANGE-03: America/St_Johns non-hour transition is exact to the second", () => {
    expect(zoneOffsetSeconds((ST_JOHNS_SPRING_S - 1) * 1000, ST_JOHNS)).toBe(-12_600);
    expect(zoneOffsetSeconds(ST_JOHNS_SPRING_S * 1000, ST_JOHNS)).toBe(-9_000);
    // Repeat reads hit the cached transition entry.
    expect(zoneOffsetSeconds((ST_JOHNS_SPRING_S - 1) * 1000, ST_JOHNS)).toBe(-12_600);
    expect(zoneOffsetSeconds(ST_JOHNS_SPRING_S * 1000, ST_JOHNS)).toBe(-9_000);
  });

  test("REQ-RANGE-03: an invalid zone gives offset 0 and isZoneSupported false", () => {
    expect(isZoneSupported("Not/A_Zone")).toBe(false);
    expect(isZoneSupported("")).toBe(false);
    expect(zoneOffsetSeconds(SPRING_S * 1000, "Not/A_Zone")).toBe(0);
    expect(isZoneSupported(CHICAGO)).toBe(true);
  });

  test("REQ-RANGE-03: non-finite and out-of-range instants give 0 and never throw", () => {
    expect(zoneOffsetSeconds(NaN, CHICAGO)).toBe(0);
    expect(zoneOffsetSeconds(Infinity, CHICAGO)).toBe(0);
    expect(zoneOffsetSeconds(1e20, CHICAGO)).toBe(0);
  });
});

describe("shiftForEstateZone", () => {
  test("REQ-RANGE-03: fast path for the browser zone returns a new, unchanged copy", () => {
    const input = [1, 2, 3, FALL_S];
    const out = shiftForEstateZone(input, browserZone());
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(shiftForEstateZone([], CHICAGO)).toEqual([]);
  });

  test("REQ-RANGE-03: a steady instant shifts by the estate offset (local is UTC)", () => {
    expect(shiftForEstateZone([1_790_251_200], CHICAGO)).toEqual([1_790_251_200 + zoneOffsetSeconds(1_790_251_200_000, CHICAGO)]);
  });

  test("REQ-RANGE-03: spring-forward gap stretches without breaking ascent", () => {
    const input = grid(SPRING_S - 7200, SPRING_S + 7200, 600);
    const out = shiftForEstateZone(input, CHICAGO);
    expect(out).toHaveLength(input.length);
    expect(strictlyAscending(out)).toBe(true);
    input.forEach((t, i) => expect(out[i]).toBe(t < SPRING_S ? t - 21_600 : t - 18_000));
    // Wall clock jumps from 01:50 to 03:00 CDT across the gap.
    const k = input.indexOf(SPRING_S);
    expect(out[k]! - out[k - 1]!).toBe(600 + 3600);
  });

  test("REQ-RANGE-03: fall-back fold is repaired to a strictly ascending output", () => {
    const input = grid(FALL_S - 7200, FALL_S + 7200, 600);
    const naive = input.map((t) => t + zoneOffsetSeconds(t * 1000, CHICAGO));
    expect(strictlyAscending(naive)).toBe(false);
    const out = shiftForEstateZone(input, CHICAGO);
    expect(out).toHaveLength(input.length);
    expect(strictlyAscending(out)).toBe(true);
    // Outside [at − delta, at + delta) the plain shift applies; inside it runs at half speed.
    input.forEach((t, i) => {
      if (t < FALL_S - 3600) expect(out[i]).toBe(t - 18_000);
      else if (t >= FALL_S + 3600) expect(out[i]).toBe(t - 21_600);
      else expect(out[i]).toBe(FALL_S - 3600 - 18_000 + (t - (FALL_S - 3600)) / 2);
    });
  });

  test("REQ-RANGE-03: output length always equals input length", () => {
    for (const input of [[], [FALL_S], grid(FALL_S - 90_000, FALL_S + 90_000, 3_600), [1, 1, 1], [NaN, 5]]) {
      expect(shiftForEstateZone(input, CHICAGO)).toHaveLength(input.length);
      expect(shiftForEstateZone(input, "Not/A_Zone")).toHaveLength(input.length);
    }
  });

  test("REQ-RANGE-03: an unsupported zone shows UTC wall time and equal inputs stay strictly ascending", () => {
    expect(shiftForEstateZone([10, 20], "Not/A_Zone")).toEqual([10, 20]);
    const out = shiftForEstateZone([5, 5, 5], CHICAGO);
    expect(strictlyAscending(out)).toBe(true);
  });
});
