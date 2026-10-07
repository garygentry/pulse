// apps/web/tests/format.test.ts — estate-timezone absolute-time formatting (06-client-ui.md §4,
// REQ-LIVE-02). Pure (no DOM): asserts America/Chicago renders an absolute estate-TZ time and, on
// tzFallback, UTC WITH the mandatory "TZ not configured" marker (never a silent UTC).

import { describe, expect, test } from "bun:test";

import { createEstateClock, TZ_FALLBACK_MARKER } from "../src/client/format.js";
import { NOW } from "./factories.js";

describe("createEstateClock", () => {
  test("renders an absolute time in America/Chicago, not the runner locale", () => {
    const clock = createEstateClock({ name: "home-estate", timezone: "America/Chicago", tzFallback: false });

    expect(clock.timezone).toBe("America/Chicago");
    expect(clock.tzFallback).toBe(false);

    // NOW is 2026-08-22T12:00:00Z → 07:00:00 CDT (America/Chicago is UTC-5 in August).
    const formatted = clock.format(NOW);
    expect(formatted).toContain("2026-08-22");
    expect(formatted).toContain("07:00:00");
    expect(formatted).toContain("CDT");
  });

  test("absoluteWithRelative pairs the absolute time with a relative age (never age alone)", () => {
    const clock = createEstateClock({ name: "home-estate", timezone: "America/Chicago", tzFallback: false });
    const nowMs = new Date("2026-08-22T12:00:12.000Z").getTime();

    const combined = clock.absoluteWithRelative(NOW, nowMs);
    expect(combined).toContain("07:00:00");
    expect(combined).toContain("(12s ago)");
  });

  test("on tzFallback, renders UTC WITH the 'TZ not configured' marker", () => {
    const clock = createEstateClock({ name: "home-estate", timezone: "UTC", tzFallback: true });

    expect(clock.tzFallback).toBe(true);

    const formatted = clock.format(NOW);
    expect(formatted).toContain("2026-08-22");
    expect(formatted).toContain("12:00:00");
    expect(formatted).toContain("UTC");

    // The marker is mandatory (never a silent UTC) — REQ-LIVE-02, §3.1 rule 4.
    expect(TZ_FALLBACK_MARKER).toContain("TZ not configured");
    expect(TZ_FALLBACK_MARKER).toContain("UTC");
  });

  test("an invalid zone falls back to UTC + forces tzFallback (belt-and-braces guard)", () => {
    const clock = createEstateClock({ name: "home-estate", timezone: "Not/AZone", tzFallback: false });

    expect(clock.timezone).toBe("UTC");
    expect(clock.tzFallback).toBe(true);
    expect(clock.format(NOW)).toContain("UTC");
  });

  test("an unparseable instant yields the defensive em-dash literal", () => {
    const clock = createEstateClock({ name: "home-estate", timezone: "America/Chicago", tzFallback: false });
    expect(clock.format("not-a-date")).toBe("—");
  });
});
