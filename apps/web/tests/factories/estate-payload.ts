// apps/web/tests/factories/estate-payload.ts — in-boundary wire-envelope fixture (09 §3.2).
// Wraps the renderer-level makeEstateBundleFixture() (rendered-model-v2-owned) with the wire
// EstatePayload envelope the /estate view reads off store.estate (00 §1, §5). Owned by
// estate-explorer; an additive file alongside the per-domain factories (edits none of them).

import type {
  AvailabilitySection,
  DataAvailability,
  DeclaredScrapeComparison,
  EstatePayload,
  EstateTargetState,
  TargetIdentity,
} from "@pulse/web-data/wire";
import type { WebCoverageArtifact, WebFindingsArtifact } from "@pulse/renderer";
import { makeEstateBundleFixture } from "./estate-bundle.js";

/** The fixed "now" the fixture stamps, matching factories/wire.ts NOW for cross-suite determinism. */
export const NOW = "2026-08-22T12:00:00.000Z" as const;

/** A `current` freshness envelope sourced from the rendered estate (00 §1). */
export function currentAvailability(over: Partial<DataAvailability> = {}): DataAvailability {
  return { state: "current", source: "rendered-estate", lastGoodAt: NOW, message: null, ...over };
}

/** Wrap a present value in an AvailabilitySection (value !== null). */
export function presentSection<T>(
  value: T,
  availability: DataAvailability = currentAvailability(),
): AvailabilitySection<T> {
  return { availability, value };
}

/** An ABSENT sub-artifact (value === null) — the older-tree degrade case (00 §4.2, REQ-DEG-02). */
export function absentSection<T>(
  message = "not present in this rendered tree",
): AvailabilitySection<T> {
  return {
    availability: { state: "unavailable", source: "rendered-estate", lastGoodAt: null, message },
    value: null,
  };
}

/** One live-state join row (00 §1). Defaults to a healthy host with no attributed alerts. */
export function makeLiveTarget(over: Partial<EstateTargetState> = {}): EstateTargetState {
  const target: TargetIdentity = over.target ?? { kind: "host", id: "host:hostA-managed" };
  return {
    target,
    name: target.id,
    state: "healthy",
    availability: currentAvailability(),
    alertFingerprints: [],
    ...over,
  };
}

/** One declared-vs-scraped comparison (00 §1). Defaults to a matched hostA scrape. */
export function makeComparison(
  over: Partial<DeclaredScrapeComparison> = {},
): DeclaredScrapeComparison {
  return {
    drilldownId: "host:hostA-managed",
    scrapeTarget: "10.0.0.1:9100",
    state: "matched",
    message: "",
    ...over,
  };
}

/**
 * Build a complete wire `EstatePayload` the /estate view can render (00 §1).
 * Defaults: the coherent bundle from makeEstateBundleFixture() with one live row per model host,
 * present coverage/findings, and one declaredVersusScraped comparison row.
 *
 * @param overrides - Partial payload; any provided field replaces the synthesised default whole.
 */
export function makeEstatePayloadFixture(overrides: Partial<EstatePayload> = {}): EstatePayload {
  const bundle = makeEstateBundleFixture();
  const liveTargets: EstateTargetState[] = bundle.model.hosts.map((h) =>
    makeLiveTarget({ target: { kind: "host", id: h.drilldownId }, name: h.name }),
  );
  const base: EstatePayload = {
    generatedAt: NOW,
    estate: bundle.model,
    liveTargets,
    coverage: presentSection<WebCoverageArtifact>(bundle.coverage),
    findings: presentSection<WebFindingsArtifact>(bundle.findings),
    declaredVersusScraped: presentSection<readonly DeclaredScrapeComparison[]>([makeComparison()]),
  };
  return { ...base, ...overrides };
}
