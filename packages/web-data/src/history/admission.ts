// packages/web-data/src/history/admission.ts — the deterministic work-key derivation and
// the package-private waiter/work-item state (07-history-service.md §§2, 4). Package-private:
// only `history/service.ts` uses these, and the `/history` barrel never re-exports them.
// The work key is a canonical encoding of `(modelGeneration, operation, queryId-or-endpoint,
// exact target id, range)` with type-discriminated, explicitly-null fields — never ambiguous
// string concatenation — so two identical requests under the same model generation coalesce
// onto one work identity and a model change deterministically produces a distinct key.

import { canonicalJson } from "../canonical.js";
import type { RangeId } from "../wire/common.js";
import type { QueryId, TargetIdentity } from "../wire/history.js";
import type { HistoryResult } from "./service.js";

/** The three coalescing history operations. */
export type HistoryOperation = "query" | "alert-intervals" | "endpoint-history";

/**
 * The exact fields that make one history request identical to another for coalescing and
 * caching. Every field is present with an explicit null when it does not apply, so the
 * canonical encoding is unambiguous across operations.
 */
export interface WorkKeyDescriptor {
  /** Coalescing operation discriminator. */ readonly operation: HistoryOperation;
  /** Curated catalog id, or null for endpoint history. */ readonly queryId: QueryId | null;
  /** Exact Gatus endpoint key, or null for VM operations. */ readonly endpoint: string | null;
  /** Target class, or null for estate-wide/untargeted work. */ readonly targetKind: TargetIdentity["kind"] | null;
  /** Exact target id, or null when untargeted. */ readonly targetId: string | null;
  /** Validated closed range. */ readonly range: RangeId;
}

const decoder = new TextDecoder();

/**
 * Derive the deterministic work key for a bound request under `generation`. The canonical
 * JSON of the discriminated descriptor guarantees identical requests hash to the same key
 * and any model-generation change yields a different key.
 */
export function computeWorkKey(generation: number, descriptor: WorkKeyDescriptor): string {
  return decoder.decode(
    canonicalJson({
      g: generation,
      op: descriptor.operation,
      q: descriptor.queryId,
      e: descriptor.endpoint,
      tk: descriptor.targetKind,
      ti: descriptor.targetId,
      r: descriptor.range,
    }),
  );
}

/**
 * One coalesced caller awaiting a work item. The owning service exclusively transitions
 * `settled`, removes the abort listener, adjusts global/per-key accounting, and invokes
 * `resolve` exactly once.
 */
export interface Waiter<T> {
  /** Process-local monotonic waiter identity. */ readonly id: number;
  /** Resolve this caller exactly once; expected failures are values. */
  readonly resolve: (result: HistoryResult<T>) => void;
  /** Delivery path reported to this caller on shared success. */ readonly delivery: "miss" | "coalesced";
  /** Caller cancellation source, or null when none was supplied. */ readonly signal: AbortSignal | null;
  /** Installed cancellation callback, or null; the service owns removing it. */
  abortListener: (() => void) | null;
  /** Prevents duplicate resolve/accounting/listener cleanup. */ settled: boolean;
}

/**
 * The complete result of executing one work item: the delivered `HistoryResult` and the
 * charged canonical byte count when (and only when) the result is a cacheable success.
 */
export interface RunOutput<T> {
  /** Delivered result; failures and partial values are never cached. */ readonly result: HistoryResult<T>;
  /** Canonical bytes to charge on cache insert, or null when the result must not be cached. */
  readonly cacheBytes: number | null;
}

/**
 * One in-flight (queued, active, or settling) unit of work shared by every coalesced waiter.
 * `deadlineAt` and `controller` carry the total-deadline/cancellation seams wired by the
 * lifecycle work in item 027.
 */
export interface WorkItem<T> {
  /** Deterministic work key. */ readonly key: string;
  /** Model generation this work was bound under. */ readonly generation: number;
  /** Admission time in epoch-ms. */ readonly admittedAt: number;
  /** Absolute epoch-ms total deadline (queue plus execution). */ readonly deadlineAt: number;
  /** Upstream cancellation source composed into the run. */ readonly controller: AbortController;
  /** Bound execution producing the shared result and cache charge. */
  readonly run: (signal: AbortSignal) => Promise<RunOutput<T>>;
  /** Live coalesced waiters keyed by waiter id. */ readonly waiters: Map<number, Waiter<T>>;
  /** Pending five-second total-deadline handle (queue plus execution), or null once fired/cleared. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Lifecycle phase across queue, execution, and cleanup. */ phase: "queued" | "active" | "settling";
  /** True once cleanup has released this item's accounting. */ settled: boolean;
  /** True when a late result must be ignored (deadline, abort, or model change). */ ignored: boolean;
}
