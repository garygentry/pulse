// packages/web-data/src/cycle/types.ts — cycle representation and construction-result
// contracts (01-core-definitions.md §§4–5). The materialized-representation authority
// downstream items import rather than redeclare, plus the composed `CycleState` /
// `CycleBuildResult` (all five per-view payloads landed with items 006–008, so the
// composition is now expressible; the app's `ServerContext.cycle` reference is
// established by item 033, and item 039 populates it from the scheduler). The §5 keyed
// fold-input records (`CycleSourceRecords`, `CurrentViewValues`) live in `./records.ts`.

import type { CycleObservation, HashId, SourceId, ViewId } from "../wire/common.js";
import type { SourceRecord } from "../sources/types.js";
import type { OverviewSnapshotV2 } from "../wire/overview.js";
import type { AlertsPayload } from "../wire/alerts.js";
import type { EstatePayload } from "../wire/estate.js";
import type { EnginePayload } from "../wire/engine.js";
import type { TimelinePayload } from "../wire/timeline.js";

export interface EncodedRepresentation {
  /** Strong SHA-256 validator over these exact bytes. */ readonly etag: HashId;
  /** Exact canonical JSON or deterministic gzip bytes. */ readonly bytes: Uint8Array;
}

export interface MaterializedPayload<T> {
  /** Semantic identity excluding observation-only metadata. */ readonly identity: HashId;
  /** Immutable parsed payload. */ readonly value: T;
  /** Canonical JSON representation. */ readonly plain: EncodedRepresentation;
  /** Deterministic gzip representation. */ readonly gzip: EncodedRepresentation;
}

/** Closed cycle-construction failure categories; none is a source acquisition failure. */
export type CycleBuildFailureKind =
  | "fold" | "canonicalization" | "hash" | "compression" | "payload-limit";

export interface CycleBuildFailure {
  /** Stable category used by status, metrics, and logs. */ readonly kind: CycleBuildFailureKind;
  /** Affected view, or null when construction failed before one view was selected. */
  readonly view: ViewId | null;
  /** Safe fixed diagnostic from ERROR_MESSAGES.CYCLE_BUILD_FAILED. */ readonly message: string;
}

/** The complete immutable current-cycle authority — one atomic publication (01 §5). Its five
 *  representations are captured together; a request reads exactly one coherent `CycleState`. */
export interface CycleState {
  /** Publication metadata independent of payload identity. */ readonly observation: CycleObservation;
  /** Complete fixed source-record authority captured for this publication. The concrete keyed
   *  records live in `CycleSourceRecords`; `unknown` here avoids a mis-indexable union. */
  readonly sources: Readonly<Record<SourceId, SourceRecord<unknown>>>;
  /** Materialized overview representation. */ readonly overview: MaterializedPayload<OverviewSnapshotV2>;
  /** Materialized alerts representation. */ readonly alerts: MaterializedPayload<AlertsPayload>;
  /** Materialized estate representation. */ readonly estate: MaterializedPayload<EstatePayload>;
  /** Materialized engine representation. */ readonly engine: MaterializedPayload<EnginePayload>;
  /** Materialized timeline representation. */ readonly timeline: MaterializedPayload<TimelinePayload>;
}

/** Result of composing one cycle candidate: a complete immutable `CycleState`, or a classified
 *  safe construction failure. Expected construction failures never reject (04 §6). */
export type CycleBuildResult =
  | {
      /** Success discriminator. */ readonly ok: true;
      /** Complete immutable candidate. */ readonly cycle: CycleState;
    }
  | {
      /** Failure discriminator. */ readonly ok: false;
      /** Classified safe construction failure. */ readonly error: CycleBuildFailure;
    };
