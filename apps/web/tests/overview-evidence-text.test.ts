// tests/overview-evidence-text.test.ts — F41: evidence times are estate time, never raw UTC ISO.
import { expect, test } from "bun:test";

import { lastGoodText } from "../src/client/views/overview/grid/evidence.js";
import { createEstateClock } from "../src/client/format.js";

const availability = { state: "stale", source: "victoriametrics-signals", lastGoodAt: "2026-11-12T03:09:49.809Z", message: null } as const;

test("with the estate clock the last-good time is in estate time, not ISO UTC", () => {
  const clock = createEstateClock({ name: "e", timezone: "America/New_York", tzFallback: false });
  const text = lastGoodText(availability, clock);
  expect(text).toBe(`Last good observation: ${clock.format(availability.lastGoodAt)}`);
  expect(text).not.toContain("2026-11-12T03:09:49.809Z");
});

test("no observation stays explicit", () => {
  expect(lastGoodText({ ...availability, lastGoodAt: null })).toBe("No successful observation");
});
