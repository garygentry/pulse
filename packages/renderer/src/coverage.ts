// packages/renderer/src/coverage.ts
import type { CollectionClass, EstateModel, Host, Service, SuppressionClass } from "@pulse/core";

import { compareString } from "./order.js";
import type { BundleId } from "./render/web-artifacts.js";
import type { ArtifactIndex } from "./render/artifact-index.js";
import { buildArtifactIndex } from "./render/artifact-index.js";
import { RenderInvariantError } from "./render/scrape.js";
import { buildSuppressionIndex } from "./render/web-model.js";

/**
 * The kind of estate entity a coverage entry describes. Hosts and services are the two
 * declared entity classes `coverage` reports over (REQ-COV-01).
 */
export type CoverageTargetKind = "host" | "service";

/**
 * One entry in a coverage report: a declared entity and whether it maps to a rendered
 * monitoring artifact. Reuses the same estate→artifact mapping the renderer uses, so a
 * stale on-disk tree can never fool it (REQ-COV-03).
 */
export interface CoverageEntry {
  /** Whether this entry is a host or a service. */
  kind: CoverageTargetKind;
  /** Entity identity: the host name, or `"<host>/<service>"` for a service. */
  name: string;
  /** The host's collection class (for a service: its owning host's class). */
  collectionClass: CollectionClass;
  /**
   * The rendered artifact paths (relative to `outputRoot`) that monitor this entity; a fresh copy
   * of the shared index's relationships. Empty for a `gaps` entry (declared-but-unmonitored). A
   * `suppressed` entry RETAINS its real artifact relationships — suppression changes the bucket, not
   * relationship truth (04 §3.2, REQ-COV-04).
   */
  artifacts: string[];
  /**
   * Deliberate suppression, or `null` when actively monitored. A non-null value routes
   * the entry to `suppressed`, NEVER to `gaps`, even if `artifacts` is empty (REQ-COV-02).
   */
  suppressed: SuppressionInfo | null;
}

/** A deliberate suppression: its class and mandatory rationale (mirrors core's `SuppressionMark`). */
export interface SuppressionInfo {
  /** Which suppression class applies (`excluded` | `expected-churn` | `known-expected`). */
  class: SuppressionClass;
  /** The mandatory human rationale carried through from the estate declaration. */
  rationale: string;
}

/**
 * The full coverage answer (REQ-COV-01/02): three disjoint, sorted buckets over every
 * declared entity. A non-empty `gaps` sets exit `1`; `suppressed` entries are deliberate
 * and never gaps.
 */
export interface CoverageReport {
  /** Declared entities that map to ≥1 rendered artifact. */
  covered: CoverageEntry[];
  /** Declared, non-suppressed entities that map to NO rendered artifact (REQ-COV-01). */
  gaps: CoverageEntry[];
  /** Deliberately suppressed entities, shown as intentional (REQ-COV-02). */
  suppressed: CoverageEntry[];
}

/**
 * The versioned `web-coverage.json` artifact (rendered-model-v2, 00-core-definitions.md §4):
 * a `CoverageReport` stamped with the shared bundle identity and literal format. This is a
 * frozen compile-time contract for items 005–010; current v1 coverage runtime is unchanged.
 */
export interface WebCoverageArtifact extends CoverageReport {
  /** Literal artifact format. */
  formatVersion: 2;
  /** Shared deterministic bundle identity. */
  bundleId: BundleId;
}

/**
 * Compute coverage: for every declared host and service, does it map to ≥1 rendered monitoring
 * artifact? The answer is derived from the SAME estate→artifact mapping the renderer uses
 * (`buildArtifactIndex`, 03 §5.2), computed in memory — so coverage needs NO prior `render` and
 * can never be fooled by a stale on-disk tree (REQ-COV-03). Pure: performs no I/O and never throws.
 *
 * Bucketing (03 §5.3): a deliberately suppressed entity ⇒ `suppressed` (never a gap, REQ-COV-02);
 * a non-suppressed entity with no artifact ⇒ `gaps` (exit `1`, REQ-COV-01); otherwise ⇒ `covered`.
 * All three buckets are sorted by `(name, kind)` (03 §5.4).
 *
 * @param model - A validated `EstateModel` (coverage runs only after `loadAndValidate` succeeds).
 * @returns The three disjoint, sorted coverage buckets.
 */
export function computeCoverage(model: EstateModel): CoverageReport {
  return computeCoverageFromIndex(model, buildArtifactIndex(model));
}

/**
 * Compute coverage from a SUPPLIED relationship index (04 §3.2). The coordinated web emitter builds
 * one `ArtifactIndex` and passes the SAME instance to both model projection and coverage, so an
 * entity's coverage artifacts and its model artifacts can never diverge (REQ-COV-05, REQ-MODEL-12).
 * Public `computeCoverage` delegates here with a freshly built index. Never exported from
 * `@pulse/renderer`. Pure: no I/O. Every declared entity is expected to have an index entry and (for
 * a service) a declared owning host; absence is an internal invariant failure, not a fallback.
 *
 * @param model - A validated `EstateModel`.
 * @param index - The shared relationship index built once by the coordinated emitter.
 * @returns The three disjoint, sorted coverage buckets.
 */
export function computeCoverageFromIndex(model: EstateModel, index: ArtifactIndex): CoverageReport {
  // Shared with the web model so gaps-vs-suppressed stays in lockstep (04 §3.2).
  const suppressionIndex = buildSuppressionIndex(model);
  const ownerClass = new Map<string, CollectionClass>();
  for (const host of model.hosts) ownerClass.set(host.name, host.collectionClass);

  const covered: CoverageEntry[] = [];
  const gaps: CoverageEntry[] = [];
  const suppressed: CoverageEntry[] = [];

  for (const host of model.hosts) {
    place(coverageForHost(host, index, suppressionIndex), covered, gaps, suppressed);
  }
  for (const svc of model.services) {
    place(coverageForService(svc, index, ownerClass, suppressionIndex), covered, gaps, suppressed);
  }

  covered.sort(compareEntry);
  gaps.sort(compareEntry);
  suppressed.sort(compareEntry);
  return { covered, gaps, suppressed };
}

/** Route one entry to its bucket. Suppression wins over the artifact test (REQ-COV-02). */
function place(
  entry: CoverageEntry,
  covered: CoverageEntry[],
  gaps: CoverageEntry[],
  suppressed: CoverageEntry[],
): void {
  if (entry.suppressed !== null) {
    suppressed.push(entry); // deliberate — NEVER a gap (REQ-COV-02)
    return;
  }
  if (entry.artifacts.length === 0) {
    gaps.push(entry); // declared-but-unmonitored (REQ-COV-01)
    return;
  }
  covered.push(entry);
}

/**
 * Build the `CoverageEntry` for a host. The `expectedChurn?: boolean` flag is NOT a suppression — an
 * expected-churn host still maps to a scrape target and lands in `covered` (04 §3.2). A suppressed
 * host RETAINS its real artifact relationships (a fresh copy of the shared index's paths); only the
 * bucket changes (REQ-COV-04). Every declared host has an index entry (02 §8.1); its absence is an
 * internal invariant failure.
 */
function coverageForHost(
  host: Host,
  index: ArtifactIndex,
  suppressionIndex: Map<string, SuppressionInfo>,
): CoverageEntry {
  const suppressed = suppressionIndex.get(`host:${host.name}`) ?? null;
  const relationships = index.hosts.get(host.name);
  if (relationships === undefined) {
    throw new RenderInvariantError(
      `Host "${host.name}" is missing from the artifact index; coverage cannot be computed.`,
    );
  }
  return {
    kind: "host",
    name: host.name,
    collectionClass: host.collectionClass,
    artifacts: [...relationships.artifacts],
    suppressed,
  };
}

/**
 * Build the `CoverageEntry` for a service. Its identity is `"<host>/<service>"` and its class is its
 * required owning host's class (04 §3.2). A missing owner or missing index entry is an internal
 * invariant failure on a validated model — NOT a guessed `excluded` fallback, which would conceal
 * an upstream contract violation (REQ-REL-03). A suppressed service RETAINS its real artifact
 * relationships; only the bucket changes (REQ-COV-04).
 */
function coverageForService(
  svc: Service,
  index: ArtifactIndex,
  ownerClass: Map<string, CollectionClass>,
  suppressionIndex: Map<string, SuppressionInfo>,
): CoverageEntry {
  const id = `${svc.host}/${svc.name}`;
  const suppressed = suppressionIndex.get(`svc:${id}`) ?? null;
  const collectionClass = ownerClass.get(svc.host);
  if (collectionClass === undefined) {
    throw new RenderInvariantError(
      `Service "${id}" references undeclared host "${svc.host}"; coverage cannot resolve its class.`,
    );
  }
  const relationships = index.services.get(id);
  if (relationships === undefined) {
    throw new RenderInvariantError(
      `Service "${id}" is missing from the artifact index; coverage cannot be computed.`,
    );
  }
  return {
    kind: "service",
    name: id,
    collectionClass,
    artifacts: [...relationships.artifacts],
    suppressed,
  };
}

/** Sort coverage entries by name, then kind — raw code-point (REQ-DET-01). */
function compareEntry(a: CoverageEntry, b: CoverageEntry): number {
  const byName = compareString(a.name, b.name);
  return byName !== 0 ? byName : compareString(a.kind, b.kind);
}
