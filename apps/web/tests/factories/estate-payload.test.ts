// apps/web/tests/factories/estate-payload.test.ts — self-test for the estate wire-envelope
// fixture (09 §3.2). Pure data; touches no DOM.

import { describe, expect, test } from "bun:test";
import {
  absentSection,
  currentAvailability,
  makeComparison,
  makeEstatePayloadFixture,
  makeLiveTarget,
  NOW,
  presentSection,
} from "./estate-payload.js";

describe("makeEstatePayloadFixture", () => {
  test("returns a non-null payload with one live row per model host", () => {
    const payload = makeEstatePayloadFixture();
    expect(payload).not.toBeNull();
    expect(payload.generatedAt).toBe(NOW);
    expect(payload.estate.hosts.length).toBeGreaterThan(0);
    expect(payload.liveTargets.length).toBe(payload.estate.hosts.length);
    payload.estate.hosts.forEach((h, i) => {
      expect(payload.liveTargets[i]?.target).toEqual({ kind: "host", id: h.drilldownId });
      expect(payload.liveTargets[i]?.name).toBe(h.name);
    });
  });

  test("coverage, findings and declaredVersusScraped are present and current", () => {
    const payload = makeEstatePayloadFixture();
    expect(payload.coverage.value).not.toBeNull();
    expect(payload.findings.value).not.toBeNull();
    expect(payload.declaredVersusScraped.value).toEqual([makeComparison()]);
    expect(payload.coverage.availability.state).toBe("current");
  });

  test("overrides replace fields whole; each call is a fresh, isolated fixture", () => {
    const absent = absentSection<never>();
    const payload = makeEstatePayloadFixture({ coverage: absent, liveTargets: [] });
    expect(payload.coverage).toBe(absent);
    expect(payload.liveTargets).toEqual([]);
    expect(makeEstatePayloadFixture().estate).not.toBe(makeEstatePayloadFixture().estate);
  });
});

describe("section helpers", () => {
  test("absentSection().value is null with unavailable availability", () => {
    const section = absentSection();
    expect(section.value).toBeNull();
    expect(section.availability).toEqual({
      state: "unavailable",
      source: "rendered-estate",
      lastGoodAt: null,
      message: "not present in this rendered tree",
    });
    expect(absentSection("gone").availability.message).toBe("gone");
  });

  test("presentSection(x).value is x under a current availability", () => {
    const x = { a: 1 };
    const section = presentSection(x);
    expect(section.value).toBe(x);
    expect(section.availability).toEqual(currentAvailability());
  });

  test("currentAvailability applies overrides", () => {
    expect(currentAvailability()).toEqual({
      state: "current",
      source: "rendered-estate",
      lastGoodAt: NOW,
      message: null,
    });
    expect(currentAvailability({ state: "stale" }).state).toBe("stale");
  });
});

describe("row builders", () => {
  test("makeLiveTarget defaults to a healthy hostA row with no alerts", () => {
    expect(makeLiveTarget()).toEqual({
      target: { kind: "host", id: "host:hostA-managed" },
      name: "host:hostA-managed",
      state: "healthy",
      availability: currentAvailability(),
      alertFingerprints: [],
    });
    expect(makeLiveTarget({ state: "unhealthy", alertFingerprints: ["fp1"] }).alertFingerprints).toEqual(["fp1"]);
  });

  test("makeComparison honours an explicit null scrapeTarget", () => {
    expect(makeComparison().state).toBe("matched");
    expect(makeComparison({ scrapeTarget: null, state: "unexpected" }).scrapeTarget).toBeNull();
  });
});
