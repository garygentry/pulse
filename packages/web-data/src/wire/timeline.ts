// packages/web-data/src/wire/timeline.ts — authoritative browser-safe timeline wire
// contracts (01-core-definitions.md §§6 and 9). Indexes queryable targets with stable
// renderer identities, the exact applicable curated-catalog query ids and accepted
// ranges, parent links (service→host, endpoint→service), estate-level per-domain DNS
// checks, and distinct vmalert (alert-history) versus Gatus (check-history) provenance.
// No query text, PromQL, or historical body is ever exposed here — only ids/metadata.
// `generatedAt` is body materialization time. All imports are type-only and erased, so
// `/wire` stays runtime-free.

import type { RangeId } from "./common.js";
import type { QueryId, TargetIdentity } from "./history.js";

/** One queryable target with its applicable catalog ids and accepted ranges. */
export interface TimelineTarget {
  /** Exact renderer target identity. */ readonly target: TargetIdentity;
  /** Human-readable model name. */ readonly name: string;
  /** Applicable catalog ids in catalog order. */ readonly queryIds: readonly QueryId[];
  /** Union of accepted ranges in ascending duration order. */ readonly ranges: readonly RangeId[];
  /** Parent identity: a service's host, an endpoint's owning service; null for hosts or an undeclared host. */
  readonly parent: TargetIdentity | null;
}

/** One estate-level per-domain DNS check. */
export interface TimelineDomain {
  /** The declared domain (`model.estate.domains[]`). */ readonly domain: string;
  /** Its Gatus endpoint name, exactly `dns:<domain>`; addressable by /api/history/checks. */
  readonly endpoint: string;
}

/** The timeline view payload: queryable targets plus alert/check history capability metadata. */
export interface TimelinePayload {
  /** Content materialization time in UTC. */ readonly generatedAt: string;
  /** Queryable targets in stable model order. */ readonly targets: readonly TimelineTarget[];
  /** Alert-history capability metadata. */
  readonly alertHistory: {
    /** Accepted ranges in ascending duration order. */ readonly ranges: readonly RangeId[];
    /** Fixed alert-history source. */ readonly provenance: "vmalert";
  };
  /** Check-history capability metadata. */
  readonly checkHistory: {
    /** Service endpoints declared by exactly one service, plus every domain endpoint; ascending. */
    readonly endpoints: readonly string[];
    /** Fixed check-history source. */ readonly provenance: "gatus";
  };
  /** Estate-level domain DNS checks in `model.estate.domains` order (deduplicated, first wins). */
  readonly domains: readonly TimelineDomain[];
}
