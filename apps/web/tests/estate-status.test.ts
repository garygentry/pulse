// apps/web/tests/estate-status.test.ts — estate HealthState → TargetStatus map (estate-explorer
// item 003; spec 06 §3, 09 §6.1). Exhaustive over HealthState × suppressed × availability.

import { describe, expect, test } from "bun:test";

import type { DataAvailability, HealthState, TargetStatus } from "@pulse/web-data/wire";

import { STATUS_LABEL } from "../src/client/a11y/index.js";
import { describeHealth, statusLabel, toTargetStatus } from "../src/client/views/estate/status.js";

const HEALTHS: readonly HealthState[] = ["healthy", "unhealthy", "unknown", "not-configured"];
const SUPPRESSED: readonly boolean[] = [true, false];
const AVAILABILITIES: readonly DataAvailability["state"][] = [
  "current",
  "stale",
  "unavailable",
  "not-configured",
];
const STATUSES: readonly TargetStatus[] = ["ok", "warning", "critical", "unknown", "suppressed"];

const MATRIX = HEALTHS.flatMap((health) =>
  SUPPRESSED.flatMap((suppressed) =>
    AVAILABILITIES.map((availability) => ({ health, suppressed, availability })),
  ),
);

describe("toTargetStatus (spec 09 §6.1)", () => {
  test("matrix covers every HealthState × suppressed × availability combination", () => {
    expect(MATRIX).toHaveLength(4 * 2 * 4);
  });

  test("current + not suppressed maps raw health (unhealthy is loud/safe critical)", () => {
    const expected: Record<HealthState, TargetStatus> = {
      healthy: "ok",
      unhealthy: "critical",
      unknown: "unknown",
      "not-configured": "unknown",
    };
    for (const health of HEALTHS) {
      expect(toTargetStatus({ health, suppressed: false, availability: "current" })).toEqual({
        status: expected[health],
        staleNote: null,
      });
    }
  });

  test("suppressed overrides health and availability, with no staleNote", () => {
    for (const input of MATRIX.filter((i) => i.suppressed)) {
      expect(toTargetStatus(input)).toEqual({ status: "suppressed", staleNote: null });
    }
  });

  test("every non-current availability forces unknown with a non-null staleNote", () => {
    for (const input of MATRIX.filter((i) => !i.suppressed && i.availability !== "current")) {
      const out = toTargetStatus(input);
      expect(out.status).toBe("unknown");
      expect(out.staleNote).not.toBeNull();
      expect(out.staleNote!.length).toBeGreaterThan(0);
    }
  });

  test("each non-current availability has its own distinct note", () => {
    const notes = AVAILABILITIES.filter((a) => a !== "current").map(
      (availability) => toTargetStatus({ health: "healthy", suppressed: false, availability }).staleNote,
    );
    expect(notes).toEqual([
      "Live state is stale",
      "Live state unavailable",
      "Live state not configured",
    ]);
  });

  test("never-ok invariant (I3): ok only when suppressed===false AND availability===current", () => {
    for (const input of MATRIX) {
      const { status } = toTargetStatus(input);
      if (status === "ok") {
        expect(input).toEqual({ health: "healthy", suppressed: false, availability: "current" });
      }
      if (input.suppressed || input.availability !== "current") {
        expect(status).not.toBe("ok");
      }
    }
    const okInputs = MATRIX.filter((i) => toTargetStatus(i).status === "ok");
    expect(okInputs).toEqual([{ health: "healthy", suppressed: false, availability: "current" }]);
  });
});

describe("label helpers", () => {
  test("statusLabel mirrors STATUS_LABEL for every TargetStatus", () => {
    for (const status of STATUSES) {
      expect(statusLabel(status)).toBe(STATUS_LABEL[status]);
    }
  });

  test("describeHealth phrases raw health, including the not-configured nuance", () => {
    expect(describeHealth("healthy")).toBe("healthy");
    expect(describeHealth("unhealthy")).toBe("unhealthy");
    expect(describeHealth("unknown")).toBe("unknown");
    expect(describeHealth("not-configured")).toBe("not configured");
  });
});
