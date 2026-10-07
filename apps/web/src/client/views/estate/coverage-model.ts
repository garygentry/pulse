// src/client/views/estate/coverage-model.ts — pure data model for the coverage tab: per-artifact
// availability resolution, bucket metadata, class totals, and the declared-vs-scraped diff partition.
// Pure: no JSX, no UI-framework import; coverage.tsx renders from these.

import type {
  AvailabilitySection,
  DeclaredScrapeComparison,
  TargetStatus,
} from "@pulse/web-data/wire";
import type { CoverageEntry, WebCoverageArtifact } from "@pulse/renderer";

import type { IconName } from "@/ui";
import { classifyAvailability } from "./delivery.js";

// ── Per-artifact availability resolution ─────────────────────────────────────

/** The render decision for one sub-artifact, derived from `classifyAvailability`. */
export type ArtifactRenderState<T> =
  | { readonly kind: "absent"; readonly message: string | null }
  | { readonly kind: "empty" }
  /** `stale` is true iff availability is not `current` — no ok glyph may render. */
  | { readonly kind: "present"; readonly value: T; readonly stale: boolean };

/**
 * Resolve an AvailabilitySection through the shared classifier. A stale-but-empty section stays
 * `present` (with `stale`) — the clean empty-state is reserved for current data.
 */
export function resolveArtifact<T>(
  section: AvailabilitySection<T>,
  isEmpty: (value: T) => boolean,
): ArtifactRenderState<T> {
  if (section.value === null) return { kind: "absent", message: section.availability.message };
  const cls = classifyAvailability(section, isEmpty);
  if (cls === "empty") return { kind: "empty" };
  return { kind: "present", value: section.value, stale: cls === "stale" };
}

/** Downgrade: an `ok` glyph becomes `unknown` while the governing data is not current. */
export function effectiveStatus(base: TargetStatus, stale: boolean): TargetStatus {
  return stale && base === "ok" ? "unknown" : base;
}

// ── Coverage buckets ─────────────────────────────────────────────────────────

/** Bucket ids — the three disjoint WebCoverageArtifact collections. */
export type CoverageBucketId = "covered" | "gaps" | "suppressed";

/** Static bucket metadata. */
export interface BucketSpec {
  readonly id: CoverageBucketId;
  readonly title: string;
  readonly icon: IconName;
  /** Bucket-intrinsic status when coverage is current. A gap is a config concern → warning. */
  readonly status: TargetStatus;
}

export const BUCKETS: readonly BucketSpec[] = [
  { id: "covered", title: "Covered", icon: "circle-check", status: "ok" },
  { id: "gaps", title: "Gaps", icon: "circle-alert", status: "warning" },
  { id: "suppressed", title: "Suppressed", icon: "minus", status: "suppressed" },
];

/** Fallback shown when a suppressed entry carries no SuppressionInfo — never blank. */
export const NO_RATIONALE = "— (no rationale recorded)";

/** `${class}: ${rationale}` for a suppressed entry, null-safe on every level. */
export function rationaleText(entry: CoverageEntry): string {
  const s = entry.suppressed;
  if (s === null || s === undefined) return NO_RATIONALE;
  const cls: string = typeof s.class === "string" && s.class.length > 0 ? s.class : "unclassified";
  const why = typeof s.rationale === "string" && s.rationale.trim() !== "" ? s.rationale : "no rationale recorded";
  return `${cls}: ${why}`;
}

// ── Class totals ─────────────────────────────────────────────────────────────

/** Aggregation key, derived structurally so no @pulse/core import is needed. */
export type CollectionClassKey = CoverageEntry["collectionClass"];

/** One collection class's tally across the three buckets. */
export interface ClassTotals {
  readonly collectionClass: CollectionClassKey;
  readonly covered: number;
  readonly gaps: number;
  readonly suppressed: number;
  /** covered + gaps + suppressed. */
  readonly total: number;
}

/** Tally covered/gaps/suppressed per collection class; rows sorted by class name. */
export function aggregateClassTotals(artifact: WebCoverageArtifact): readonly ClassTotals[] {
  const acc = new Map<CollectionClassKey, Record<CoverageBucketId, number>>();
  for (const bucket of BUCKETS) {
    for (const entry of artifact[bucket.id]) {
      const cur = acc.get(entry.collectionClass) ?? { covered: 0, gaps: 0, suppressed: 0 };
      cur[bucket.id] += 1;
      acc.set(entry.collectionClass, cur);
    }
  }
  return [...acc.entries()]
    .map(([collectionClass, c]) => ({
      collectionClass,
      covered: c.covered,
      gaps: c.gaps,
      suppressed: c.suppressed,
      total: c.covered + c.gaps + c.suppressed,
    }))
    .sort((a, b) => a.collectionClass.localeCompare(b.collectionClass));
}

// ── Declared-vs-scraped diff — BOTH directions ───────────────────────────────

/** Return the wire comparison list, using an empty list only for an absent section. */
export function toComparisonList(
  value: readonly DeclaredScrapeComparison[] | null,
): readonly DeclaredScrapeComparison[] {
  return value ?? [];
}

/** The diff split by direction + the count-only outcomes. */
export interface DiffPartition {
  /** Declared-but-not-scraped. */
  readonly missing: readonly DeclaredScrapeComparison[];
  /** Scraped-but-not-declared. */
  readonly unexpected: readonly DeclaredScrapeComparison[];
  readonly matched: readonly DeclaredScrapeComparison[];
  readonly unknown: readonly DeclaredScrapeComparison[];
}

/** Partition comparisons by outcome; an unrecognized state is treated as unknown (never matched). */
export function partitionComparisons(list: readonly DeclaredScrapeComparison[]): DiffPartition {
  const missing: DeclaredScrapeComparison[] = [];
  const unexpected: DeclaredScrapeComparison[] = [];
  const matched: DeclaredScrapeComparison[] = [];
  const unknown: DeclaredScrapeComparison[] = [];
  for (const c of list) {
    if (c.state === "missing") missing.push(c);
    else if (c.state === "unexpected") unexpected.push(c);
    else if (c.state === "matched") matched.push(c);
    else unknown.push(c);
  }
  return { missing, unexpected, matched, unknown };
}
