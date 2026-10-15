// apps/web/tests/estate-endpoint-alert-timing.test.ts — the entity page's browser-side copy of the
// GatusCheckFailed timing stays pinned to the stack that renders the rule (#30).

import { describe, expect, test } from "bun:test";

import { GATUS_CHECKS } from "../../../stack/alerting/src/constants.js";
import { syntheticExpr } from "../../../stack/alerting/src/transform/synthetic-rules.js";
import { clearWindowSeconds, ENDPOINT_ALERT_TIMING } from "../src/client/views/estate/endpoint-alert-timing.js";

const SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600 };

/** The clear window the rendered expression uses: the last range selector in it. */
function renderedClearWindowSeconds(successes: number): number {
  const ranges = [...syntheticExpr("h/s", "h", { failures: 3, successes }).matchAll(/\[(\d+)([smh])\]/g)];
  const [, n, unit] = ranges.at(-1)!;
  return Number(n) * SECONDS[unit!]!;
}

describe("endpoint-alert timing matches stack/alerting GATUS_CHECKS", () => {
  test("every copied value equals the stack's", () => {
    for (const [key, value] of Object.entries(ENDPOINT_ALERT_TIMING)) {
      expect(GATUS_CHECKS[key as keyof typeof ENDPOINT_ALERT_TIMING]).toBe(value);
    }
  });

  test("the clear window equals the one syntheticExpr renders, for S = 1…10", () => {
    for (let s = 1; s <= 10; s++) expect(clearWindowSeconds(s)).toBe(renderedClearWindowSeconds(s));
    expect(clearWindowSeconds(2)).toBe(240); // docs/operator/alerting.md: 4 minutes for S = 2
    expect(clearWindowSeconds(1)).toBe(180); // and 3 minutes for S = 1
  });
});
