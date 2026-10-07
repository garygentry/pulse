// packages/web-data/src/history/service.ts — the bounded on-demand history service
// (07-history-service.md §§1–6, 9). This item implements validate-and-bind-first admission,
// cache-first/coalesce-before-admission ordering, the four-active / thirty-two-FIFO-queued
// admission bounds, per-key/global waiter bounds, exact active-slot accounting, and the §9
// hard resource limits, plus a working run pipeline that executes bound VM/Gatus work and
// materializes bounded payloads. The five-second total deadline, precise upstream/body abort
// forwarding, waiter/model/close cancellation, and exact timer/listener/accounting teardown
// are hardened here in item 027 (07 §§5–8, 11). The §10 point/interval normalization algorithms
// land in item 029: `runQuery` composes `normalizeHistorySeries` (07 §10.1), `runAlertIntervals`
// composes `buildAlertIntervals` (§10.2) with the target filter, and `runEndpointHistory`
// composes `buildEndpointHistory` (§10.3). Every §9 whole-operation limit rejects at boundary+1.

import { canonicalJson } from "../canonical.js";
import { bindCuratedQuery } from "../queries/binding.js";
import type { QueryBindFailureCode } from "../queries/binding.js";
import { RANGE_SECONDS } from "../queries/ranges.js";
import type { ApiError, ApiErrorCode, RangeId } from "../wire/common.js";
import {
  ERROR_MESSAGES,
  HISTORY_DEADLINE_MS,
  HISTORY_MAX_ACTIVE,
  HISTORY_MAX_BODY_BYTES,
  HISTORY_MAX_QUEUED,
  HISTORY_MAX_WAITERS_GLOBAL,
  HISTORY_MAX_WAITERS_PER_KEY,
} from "../wire/common.js";
import type {
  EndpointHistoryPayload,
  HistoryPayload,
  IntervalHistoryPayload,
  QueryId,
  TargetIdentity,
} from "../wire/history.js";
import type { BoundQuery } from "../queries/binding.js";
import { gatusEndpointKey } from "../sources/gatus.js";
import type { GatusClient } from "../sources/gatus.js";
import type { SourceError } from "../sources/types.js";
import type { VmClient, VmRangeResult } from "../sources/vm.js";
import type { WebEstateModelV2 } from "@pulse/renderer";
import { HistoryCache } from "./cache.js";
import { computeWorkKey } from "./admission.js";
import type { RunOutput, Waiter, WorkItem, WorkKeyDescriptor } from "./admission.js";
import { normalizeHistorySeries } from "./points.js";
import { buildAlertIntervals, buildEndpointHistory } from "./intervals.js";

// ---------------------------------------------------------------------------
// Public request/result contracts (01-core-definitions.md §7)
// ---------------------------------------------------------------------------

/** A curated VictoriaMetrics history request. */
export interface HistoryRequest {
  /** Executed catalog id. */ readonly queryId: QueryId;
  /** Validated target, or null for estate-wide queries. */ readonly target: TargetIdentity | null;
  /** Validated closed range. */ readonly range: RangeId;
  /** Optional waiter-only cancellation; cancellation does not reject. */ readonly signal?: AbortSignal;
}

/** A vmalert-derived alert-interval history request. */
export interface AlertHistoryRequest {
  /** Validated closed range. */ readonly range: RangeId;
  /** Optional target filter. */ readonly target: TargetIdentity | null;
  /** Optional waiter-only cancellation; cancellation does not reject. */ readonly signal?: AbortSignal;
}

/** An exact-endpoint Gatus history request. */
export interface EndpointHistoryRequest {
  /** Exact validated endpoint key. */ readonly endpoint: string;
  /** Validated closed range. */ readonly range: RangeId;
  /** Optional waiter-only cancellation; cancellation does not reject. */ readonly signal?: AbortSignal;
}

/** A stable, bounded expected history failure. */
export interface HistoryFailure {
  /** Stable expected-failure category. */
  readonly code:
    | "INVALID_REQUEST" | "QUERY_NOT_FOUND" | "TARGET_NOT_FOUND"
    | "QUERY_NOT_APPLICABLE" | "RANGE_UNSUPPORTED" | "HISTORY_OVERLOADED"
    | "SOURCE_UNAVAILABLE" | "SOURCE_TIMEOUT" | "HISTORY_LIMIT_EXCEEDED"
    | "HISTORY_CANCELLED" | "MODEL_CHANGED";
  /** Exact `ERROR_MESSAGES[code]` text. */ readonly message: string;
  /** Whole seconds before retry, or null when not applicable. */ readonly retryAfterSeconds: number | null;
}

/** The discriminated result of a history operation; expected failures never reject. */
export type HistoryResult<T> =
  | {
      /** Success discriminator. */ readonly ok: true;
      /** Immutable payload. */ readonly data: T;
      /** Admission/cache path. */ readonly delivery: "hit" | "miss" | "coalesced";
    }
  | {
      /** Failure discriminator. */ readonly ok: false;
      /** Expected bounded failure. */ readonly error: HistoryFailure;
    };

/** Instantaneous bounded-resource counters. */
export interface HistoryStats {
  /** Charged upstream operations (active plus settling). */ readonly active: number;
  /** FIFO work items awaiting admission. */ readonly queued: number;
  /** Coalescing keys with live joinable work. */ readonly inFlightKeys: number;
  /** Unexpired retained entries. */ readonly cachedKeys: number;
  /** Canonical bytes charged to retained entries. */ readonly cachedBytes: number;
  /** Unsettled callers across active and queued work. */ readonly waiters: number;
}

/** The bounded on-demand history service. */
export interface HistoryService {
  /** Resolve curated VM history; expected failures never reject. */
  query(request: HistoryRequest): Promise<HistoryResult<HistoryPayload>>;
  /** Resolve vmalert-derived alert intervals; expected failures never reject. */
  alertIntervals(request: AlertHistoryRequest): Promise<HistoryResult<IntervalHistoryPayload>>;
  /** Resolve exact-endpoint Gatus history; expected failures never reject. */
  endpointHistory(request: EndpointHistoryRequest): Promise<HistoryResult<EndpointHistoryPayload>>;
  /** Return instantaneous bounded-resource counters. */ stats(): HistoryStats;
  /** Synchronously invalidate cache/work after model replacement or loss. */ invalidateModel(): void;
  /** Idempotently cancel work and reject future admission through result values. */ close(): void;
}

/** Construction options for {@link createHistoryService}. */
export interface HistoryServiceOptions {
  /** VM range client. */ readonly vm: VmClient;
  /** Gatus endpoint-history client. */ readonly gatus: GatusClient;
  /** Current immutable model, or null during bundle error. */ readonly model: () => WebEstateModelV2 | null;
  /** Injected epoch-ms clock for deterministic tests. */ readonly now?: () => number;
  /** Injected deadline scheduler. */ readonly setTimer?: typeof setTimeout;
  /** Matching injected deadline cancellation. */ readonly clearTimer?: typeof clearTimeout;
}

// ---------------------------------------------------------------------------
// Local validation primitives (mirrors the binder's bounded-id rules, 06 §3)
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

/** UTF-8 byte length of `value`. */
function byteLength(value: string): number {
  return utf8.encode(value).length;
}

/** Whether `value` is one of the four closed range ids. */
function isRangeId(value: string): value is RangeId {
  return Object.prototype.hasOwnProperty.call(RANGE_SECONDS, value);
}

/** A non-empty, control-free id within the 512-byte request bound. */
function isBoundedControlFreeId(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return byteLength(value) <= 512;
}

/**
 * Resolve a pulse endpoint name to its Gatus group against the captured model (12 §2).
 * A service endpoint is declared by exactly one service (group = that service's host); a
 * domain endpoint is `dns:<domain>` for a declared estate domain (group = ""). Anything else,
 * including a name declared by several services, is unresolvable (`null`).
 */
function resolveEndpointGroup(model: WebEstateModelV2, endpoint: string): string | null {
  const declaring = model.services.filter((service) => service.gatusEndpoints.includes(endpoint));
  if (declaring.length === 1) return declaring[0]!.host;
  if (declaring.length > 1) return null;
  for (const domain of model.estate.domains) {
    if (endpoint === `dns:${domain}`) return "";
  }
  return null;
}

/** Reproject a success result under the delivery path reported to one waiter. */
function withDelivery<T>(result: HistoryResult<T>, delivery: "miss" | "coalesced"): HistoryResult<T> {
  return result.ok ? { ok: true, data: result.data, delivery } : result;
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

class HistoryServiceImpl implements HistoryService {
  private readonly vm: VmClient;
  private readonly gatus: GatusClient;
  private readonly model: () => WebEstateModelV2 | null;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  private readonly cache = new HistoryCache();
  /** Joinable work (queued or active) keyed by work key; settling/aborted work is removed. */
  private readonly inFlight = new Map<string, WorkItem<unknown>>();
  /** Insertion-ordered FIFO of queued work items awaiting an active slot. */
  private readonly queue: WorkItem<unknown>[] = [];

  private activeSlots = 0;
  private globalWaiters = 0;
  private nextWaiterId = 1;
  private modelGeneration = 0;
  private closed = false;

  constructor(options: HistoryServiceOptions) {
    this.vm = options.vm;
    this.gatus = options.gatus;
    this.model = options.model;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  // --- public API ----------------------------------------------------------

  query(request: HistoryRequest): Promise<HistoryResult<HistoryPayload>> {
    if (this.closed) return Promise.resolve(this.cancelled());
    const model = this.model();
    if (model === null) return Promise.resolve(this.failure("SOURCE_UNAVAILABLE"));

    const bound = bindCuratedQuery(request.queryId, request.target, request.range, model);
    if (!bound.ok) return Promise.resolve(this.bindFailure(bound.error));
    const query = bound.query;

    const descriptor: WorkKeyDescriptor = {
      operation: "query",
      queryId: query.queryId,
      endpoint: null,
      targetKind: query.target?.kind ?? null,
      targetId: query.target?.id ?? null,
      range: query.range,
    };
    return this.admit<HistoryPayload>(descriptor, (signal) => this.runQuery(query, signal), request.signal);
  }

  alertIntervals(request: AlertHistoryRequest): Promise<HistoryResult<IntervalHistoryPayload>> {
    if (this.closed) return Promise.resolve(this.cancelled());
    const model = this.model();
    if (model === null) return Promise.resolve(this.failure("SOURCE_UNAVAILABLE"));

    // The fixed estate-wide `alerts.firing` query supplies the range/step/PromQL; the
    // request target is carried as a post-fetch filter (interval attribution lands in item 029).
    const bound = bindCuratedQuery("alerts.firing", null, request.range, model);
    if (!bound.ok) return Promise.resolve(this.bindFailure(bound.error));
    const query = bound.query;

    const descriptor: WorkKeyDescriptor = {
      operation: "alert-intervals",
      queryId: "alerts.firing",
      endpoint: null,
      targetKind: request.target?.kind ?? null,
      targetId: request.target?.id ?? null,
      range: query.range,
    };
    return this.admit<IntervalHistoryPayload>(
      descriptor,
      (signal) => this.runAlertIntervals(query, model, request.target, signal),
      request.signal,
    );
  }

  endpointHistory(request: EndpointHistoryRequest): Promise<HistoryResult<EndpointHistoryPayload>> {
    if (this.closed) return Promise.resolve(this.cancelled());
    const model = this.model();
    if (model === null) return Promise.resolve(this.failure("SOURCE_UNAVAILABLE"));

    if (!isBoundedControlFreeId(request.endpoint)) return Promise.resolve(this.failure("INVALID_REQUEST"));
    if (!isRangeId(request.range)) return Promise.resolve(this.failure("INVALID_REQUEST"));
    const group = resolveEndpointGroup(model, request.endpoint);
    if (group === null) return Promise.resolve(this.failure("TARGET_NOT_FOUND"));
    // Gatus addresses history by its composite key; the pulse name stays the wire identity.
    const gatusKey = gatusEndpointKey(group, request.endpoint);

    const target: TargetIdentity = { kind: "endpoint", id: request.endpoint };
    const descriptor: WorkKeyDescriptor = {
      operation: "endpoint-history",
      queryId: null,
      endpoint: request.endpoint,
      targetKind: "endpoint",
      targetId: request.endpoint,
      range: request.range,
    };
    return this.admit<EndpointHistoryPayload>(
      descriptor,
      (signal) => this.runEndpointHistory(request.endpoint, gatusKey, request.range, target, signal),
      request.signal,
    );
  }

  stats(): HistoryStats {
    const cache = this.cache.stats();
    return {
      active: this.activeSlots,
      queued: this.queue.length,
      inFlightKeys: this.inFlight.size,
      cachedKeys: cache.cachedKeys,
      cachedBytes: cache.cachedBytes,
      waiters: this.globalWaiters,
    };
  }

  invalidateModel(): void {
    this.modelGeneration += 1;
    this.cache.clear();
    this.retireAll(this.failure("MODEL_CHANGED"));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    this.retireAll(this.cancelled());
  }

  // --- admission core (07 §§4–6) -------------------------------------------

  private admit<T>(
    descriptor: WorkKeyDescriptor,
    makeRun: (signal: AbortSignal) => Promise<RunOutput<T>>,
    signal: AbortSignal | undefined,
  ): Promise<HistoryResult<T>> {
    if (signal?.aborted === true) return Promise.resolve(this.cancelled());

    const now = this.now();
    const generation = this.modelGeneration;
    this.cache.sweepExpired(now);
    const key = computeWorkKey(generation, descriptor);

    // 1. unexpired successful cache hit.
    const cached = this.cache.get(key, generation, now);
    if (cached !== null) {
      return Promise.resolve({ ok: true, data: cached as T, delivery: "hit" });
    }

    // 2. coalesce onto identical queued/active work.
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      return this.joinWaiter(existing as unknown as WorkItem<T>, signal, "coalesced");
    }

    // Waiter admission bound for a brand-new key (per-key count is zero here).
    if (this.globalWaiters >= HISTORY_MAX_WAITERS_GLOBAL) {
      return Promise.resolve(this.overloaded());
    }

    // 3/4/5. admit active, else enqueue FIFO, else overload.
    const admitActive = this.activeSlots < HISTORY_MAX_ACTIVE;
    if (!admitActive && this.queue.length >= HISTORY_MAX_QUEUED) {
      return Promise.resolve(this.overloaded());
    }

    const item: WorkItem<T> = {
      key,
      generation,
      admittedAt: now,
      deadlineAt: now + HISTORY_DEADLINE_MS,
      controller: new AbortController(),
      run: makeRun,
      waiters: new Map(),
      timer: null,
      phase: "queued",
      settled: false,
      ignored: false,
    };
    const promise = this.joinWaiter(item, signal, "miss");
    this.inFlight.set(key, item as unknown as WorkItem<unknown>);
    // Arm the single five-second total deadline before queueing so it covers queue plus
    // execution (07 §7); coalesced waiters inherit this item's deadline and never extend it.
    this.scheduleDeadline(item as unknown as WorkItem<unknown>);
    if (admitActive) {
      this.start(item as unknown as WorkItem<unknown>);
    } else {
      this.queue.push(item as unknown as WorkItem<unknown>);
    }
    return promise;
  }

  /** Attach one waiter to `item`, enforcing the per-key and global waiter bounds. */
  private joinWaiter<T>(
    item: WorkItem<T>,
    signal: AbortSignal | undefined,
    delivery: "miss" | "coalesced",
  ): Promise<HistoryResult<T>> {
    if (item.waiters.size >= HISTORY_MAX_WAITERS_PER_KEY || this.globalWaiters >= HISTORY_MAX_WAITERS_GLOBAL) {
      return Promise.resolve(this.overloaded());
    }
    return new Promise<HistoryResult<T>>((resolve) => {
      const id = this.nextWaiterId;
      this.nextWaiterId += 1;
      const waiter: Waiter<T> = {
        id,
        resolve,
        delivery,
        signal: signal ?? null,
        abortListener: null,
        settled: false,
      };
      if (signal !== undefined) {
        const listener = (): void =>
          this.onWaiterAbort(item as unknown as WorkItem<unknown>, waiter as unknown as Waiter<unknown>);
        waiter.abortListener = listener;
        signal.addEventListener("abort", listener, { once: true });
      }
      item.waiters.set(id, waiter);
      this.globalWaiters += 1;
    });
  }

  /** Arm the five-second total deadline for a freshly-created work item (07 §7). */
  private scheduleDeadline(item: WorkItem<unknown>): void {
    const handle = this.setTimer(() => this.onDeadline(item), HISTORY_DEADLINE_MS);
    // A request-scoped deadline must never keep the host process alive on its own; unref when
    // the injected timer supports it (real timers do; a test's numeric fake handle does not).
    (handle as { unref?: () => void }).unref?.();
    item.timer = handle;
  }

  /** Cancel and forget an item's pending deadline timer, idempotently. */
  private clearItemTimer(item: WorkItem<unknown>): void {
    if (item.timer !== null) {
      this.clearTimer(item.timer);
      item.timer = null;
    }
  }

  /**
   * The five-second total deadline fired (07 §7): remove queued work or mark the active
   * result ignored, drop the key from join eligibility, abort the operation controller (and
   * thus the forwarded upstream fetch/streamed body reader), and resolve every remaining
   * waiter by the deadline as `SOURCE_TIMEOUT`. An active slot stays charged until the
   * ignored run's own cleanup settles; a late completion is never cached.
   */
  private onDeadline(item: WorkItem<unknown>): void {
    item.timer = null;
    if (item.settled) return;
    const timeout = this.failure("SOURCE_TIMEOUT");
    if (item.phase === "queued") {
      this.removeFromQueue(item);
      item.settled = true;
    } else if (item.phase === "active") {
      item.ignored = true;
    }
    this.inFlight.delete(item.key);
    item.controller.abort();
    for (const waiter of [...item.waiters.values()]) {
      this.resolveWaiter(item, waiter, timeout);
    }
  }

  /** Begin executing a queued item, charging exactly one active slot until cleanup settles. */
  private start(item: WorkItem<unknown>): void {
    item.phase = "active";
    this.activeSlots += 1;
    const signal = item.controller.signal;
    void item.run(signal).then(
      (out) => this.settleWork(item, out),
      () => this.settleWork(item, { result: this.failure("SOURCE_UNAVAILABLE"), cacheBytes: null }),
    );
  }

  /**
   * Resolve waiters, cache a fresh success, then release the active slot and promote FIFO
   * head items. A slot is released only here — after the run's upstream fetch/body settle —
   * so hidden concurrency above four is impossible even when an ignored result arrives late.
   */
  private settleWork(item: WorkItem<unknown>, out: RunOutput<unknown>): void {
    if (item.settled) return;
    item.phase = "settling";
    if (!item.ignored) {
      for (const waiter of [...item.waiters.values()]) {
        this.resolveWaiter(item, waiter, withDelivery(out.result, waiter.delivery));
      }
      if (
        out.result.ok &&
        out.cacheBytes !== null &&
        item.generation === this.modelGeneration &&
        !this.closed
      ) {
        this.cache.set(item.key, item.generation, out.result.data, out.cacheBytes, this.now());
      }
    }
    this.inFlight.delete(item.key);
    this.clearItemTimer(item);
    item.settled = true;
    this.activeSlots -= 1;
    this.promoteQueued();
  }

  /** Start FIFO head items while active slots remain, skipping any discarded queued work. */
  private promoteQueued(): void {
    while (this.activeSlots < HISTORY_MAX_ACTIVE && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next === undefined) return;
      if (next.settled) continue;
      this.start(next);
    }
  }

  /** Resolve one waiter exactly once and release its listener and global accounting. */
  private resolveWaiter<T>(item: WorkItem<T>, waiter: Waiter<T>, result: HistoryResult<T>): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.signal !== null && waiter.abortListener !== null) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
    item.waiters.delete(waiter.id);
    this.globalWaiters -= 1;
    waiter.resolve(result);
  }

  /**
   * Handle one waiter's cancellation: resolve only it as cancelled. If it was the last
   * waiter, drop queued work immediately or remove active work from join eligibility while
   * keeping its slot charged until the run settles (07 §5).
   */
  private onWaiterAbort(item: WorkItem<unknown>, waiter: Waiter<unknown>): void {
    if (waiter.settled) return;
    this.resolveWaiter(item, waiter, this.cancelled());
    if (item.waiters.size > 0 || item.settled) return;
    if (item.phase === "queued") {
      this.removeFromQueue(item);
      this.inFlight.delete(item.key);
      this.clearItemTimer(item);
      item.settled = true;
      item.controller.abort();
    } else if (item.phase === "active") {
      this.inFlight.delete(item.key);
      this.clearItemTimer(item);
      item.ignored = true;
      item.controller.abort();
    }
  }

  /** Retire all queued/active work under `result` (model invalidation or close). */
  private retireAll(result: HistoryResult<never>): void {
    for (const item of [...this.inFlight.values()]) {
      this.inFlight.delete(item.key);
      this.clearItemTimer(item);
      item.ignored = true;
      for (const waiter of [...item.waiters.values()]) {
        this.resolveWaiter(item, waiter, result);
      }
      item.controller.abort();
      if (item.phase === "queued") {
        this.removeFromQueue(item);
        item.settled = true;
      }
    }
    // Active items keep their slot charged until their run settles (ignored → no re-resolve
    // and no cache); queued items are fully removed above.
    this.queue.length = 0;
  }

  private removeFromQueue(item: WorkItem<unknown>): void {
    const index = this.queue.indexOf(item);
    if (index >= 0) this.queue.splice(index, 1);
  }

  // --- run pipeline (07 §§3, 9; §10 normalization is item 029) --------------

  private async runQuery(query: BoundQuery, signal: AbortSignal): Promise<RunOutput<HistoryPayload>> {
    const window = this.rangeWindow(query.range);
    const source = await this.vm.queryRange(
      { promql: query.promql, startSeconds: window.start, endSeconds: window.end, stepSeconds: query.effectiveStepSeconds },
      { signal },
    );
    if (!source.ok) return { result: this.sourceFailure(source.error), cacheBytes: null };
    return this.buildQueryPayload(query, source.data);
  }

  private async runAlertIntervals(
    query: BoundQuery,
    model: WebEstateModelV2,
    target: TargetIdentity | null,
    signal: AbortSignal,
  ): Promise<RunOutput<IntervalHistoryPayload>> {
    const window = this.rangeWindow(query.range);
    const source = await this.vm.queryRange(
      { promql: query.promql, startSeconds: window.start, endSeconds: window.end, stepSeconds: query.effectiveStepSeconds },
      { signal },
    );
    if (!source.ok) return { result: this.sourceFailure(source.error), cacheBytes: null };
    // Build the estate-wide attributed lanes (07 §10.2), then apply the exact target filter.
    const built = buildAlertIntervals(source.data.series, model, query.range, this.nowIso(), query.effectiveStepSeconds);
    if (!built.ok) return { result: built, cacheBytes: null };
    return this.finalizePayload(this.filterAlertPayload(built.data, target));
  }

  private async runEndpointHistory(
    endpoint: string,
    gatusKey: string,
    range: RangeId,
    target: TargetIdentity,
    signal: AbortSignal,
  ): Promise<RunOutput<EndpointHistoryPayload>> {
    const source = await this.gatus.endpointHistory(gatusKey, { signal });
    if (!source.ok) return { result: this.sourceFailure(source.error), cacheBytes: null };
    const built = buildEndpointHistory(source.data.results, endpoint, target, range, this.nowIso());
    if (!built.ok) return { result: built, cacheBytes: null };
    return this.finalizePayload(built.data);
  }

  /** Build a bounded numeric-series payload from a VM range result (07 §10.1 normalization). */
  private buildQueryPayload(query: BoundQuery, data: VmRangeResult): RunOutput<HistoryPayload> {
    const normalized = normalizeHistorySeries(data.series, query.effectiveStepSeconds);
    if (!normalized.ok) return { result: normalized, cacheBytes: null };
    const payload: HistoryPayload = {
      queryId: query.queryId,
      target: query.target,
      range: query.range,
      fetchedAt: this.nowIso(),
      effectiveStepSeconds: query.effectiveStepSeconds,
      unit: query.unit,
      stale: false,
      series: normalized.data,
    };
    return this.finalizePayload(payload);
  }

  /**
   * Apply a target-scoped filter to estate-wide alert lanes (07 §10.2). An estate-wide request
   * (`target` null) keeps every lane, including unmatched ones; a target-scoped request keeps
   * only lanes whose attribution matched that exact target and never guesses unmatched lanes.
   */
  private filterAlertPayload(payload: IntervalHistoryPayload, target: TargetIdentity | null): IntervalHistoryPayload {
    if (target === null) return payload;
    const lanes = payload.lanes.filter(
      (lane) => lane.attribution === "matched" && lane.target !== null && lane.target.id === target.id,
    );
    return { ...payload, target, lanes };
  }

  /** Enforce the §9 canonical-response 32 MiB bound and compute the cache byte charge. */
  private finalizePayload<T>(payload: T): RunOutput<T> {
    let bytes: number;
    try {
      bytes = canonicalJson(payload).byteLength;
    } catch {
      return { result: this.failure("SOURCE_UNAVAILABLE"), cacheBytes: null };
    }
    if (bytes > HISTORY_MAX_BODY_BYTES) {
      return { result: this.failure("HISTORY_LIMIT_EXCEEDED"), cacheBytes: null };
    }
    return { result: { ok: true, data: payload, delivery: "miss" }, cacheBytes: bytes };
  }

  /** Derive the VM `[start, end]` window in whole seconds from one captured clock read. */
  private rangeWindow(range: RangeId): { readonly start: number; readonly end: number } {
    const end = Math.floor(this.now() / 1000);
    return { start: end - RANGE_SECONDS[range], end };
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  // --- result helpers ------------------------------------------------------

  private failure(code: HistoryFailure["code"], retryAfterSeconds: number | null = null): HistoryResult<never> {
    return { ok: false, error: { code, message: ERROR_MESSAGES[code as ApiErrorCode], retryAfterSeconds } };
  }

  /** Map a source-client failure: its internal timeout is a deadline, all else unavailable. */
  private sourceFailure(error: SourceError): HistoryResult<never> {
    return error.kind === "timeout" ? this.failure("SOURCE_TIMEOUT") : this.failure("SOURCE_UNAVAILABLE");
  }

  private overloaded(): HistoryResult<never> {
    return this.failure("HISTORY_OVERLOADED", 1);
  }

  private cancelled(): HistoryResult<never> {
    return this.failure("HISTORY_CANCELLED");
  }

  private bindFailure(error: ApiError<QueryBindFailureCode>): HistoryResult<never> {
    return this.failure(error.code);
  }
}

/**
 * Create a bounded on-demand history service (07 §§1–6, 9). The returned service is
 * process-local with no persistence: it captures and binds the model before any allocation,
 * serves unexpired successes from cache, coalesces identical work before admission, bounds
 * active/queued/waiter concurrency, and enforces the §9 hard resource limits.
 */
export function createHistoryService(options: HistoryServiceOptions): HistoryService {
  return new HistoryServiceImpl(options);
}
