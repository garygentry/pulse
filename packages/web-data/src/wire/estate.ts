// packages/web-data/src/wire/estate.ts — authoritative browser-safe estate wire
// contracts (01-core-definitions.md §9). Carries the exact immutable rendered model
// joined with live target evidence, provenance, optional coverage/findings artifacts,
// and declared-versus-scraped comparison, each with explicit availability semantics and
// no unknown or secret-bearing field. `generatedAt` is body materialization time. The
// renderer imports are type-only and erased, so `/wire` stays runtime-free.

import type { AvailabilitySection, DataAvailability, HealthState } from "./common.js";
import type { TargetIdentity } from "./history.js";
import type { WebCoverageArtifact, WebEstateModelV2, WebFindingsArtifact } from "@pulse/renderer";

/** Live state for one rendered target, joined with alert attribution. */
export interface EstateTargetState {
  /** Exact rendered drilldown identity. */ readonly target: TargetIdentity;
  /** Human-readable rendered name. */ readonly name: string;
  /** Current explicit status. */ readonly state: HealthState;
  /** Governing live evidence. */ readonly availability: DataAvailability;
  /** Alerts attributed to this target, by Alertmanager fingerprint, in stable order. */ readonly alertFingerprints: readonly string[];
}

/** One declared-versus-discovered scrape comparison outcome. */
export interface DeclaredScrapeComparison {
  /** Declared target drilldown identity. */ readonly drilldownId: string;
  /** Rendered scrape relationship, or null when none is declared. */ readonly scrapeTarget: string | null;
  /** Comparison outcome; unknown when scrape discovery is unavailable. */
  readonly state: "matched" | "missing" | "unexpected" | "unknown";
  /** Human-readable explanation. */ readonly message: string;
}

/** The estate view payload: rendered model, live target joins, and optional artifacts. */
export interface EstatePayload {
  /** Content materialization time in UTC. */ readonly generatedAt: string;
  /** Exact immutable rendered estate model. */ readonly estate: Readonly<WebEstateModelV2>;
  /** Live state for every rendered target in model order. */ readonly liveTargets: readonly EstateTargetState[];
  /** Coverage artifact and its governing availability. */ readonly coverage: AvailabilitySection<WebCoverageArtifact>;
  /** Findings artifact and its governing availability. */ readonly findings: AvailabilitySection<WebFindingsArtifact>;
  /** Declared-versus-discovered comparisons and VM discovery availability. */
  readonly declaredVersusScraped: AvailabilitySection<readonly DeclaredScrapeComparison[]>;
}
