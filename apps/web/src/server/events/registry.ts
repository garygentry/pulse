// src/server/events/registry.ts — the process-lifetime SSE stream registry backing `/api/events`
// (08-events-live-state-and-freshness-migration.md §§2–4). It owns the insertion-ordered set of open
// streams, ONE shared heartbeat timer (never one per stream), and the post-publication tick fan-out.
//
// Lifecycle guarantees (§3):
//  • Each connection emits `retry: 10000`, then — only if a current cycle already exists AND the
//    reconnect `Last-Event-ID` does not exactly equal the current generation:sequence — the current
//    tick, so an absent/malformed/older/newer/different-generation cursor converges immediately while
//    an up-to-date cursor waits. Before the first publication no invented tick is sent.
//  • Before admitting stream 65 the oldest stream is closed/removed (one `displaced` event), then the
//    newcomer is admitted.
//  • A stream is removed on browser cancel, on any controller enqueue/write failure (that stream
//    only), or on `close()`. `count()` feeds the open-stream gauge and returns to zero after cleanup.
//  • `publish(cycle)` frames one tick and fans it out to every open stream exactly once; the runtime
//    calls it exactly once after each atomic `state.cycle = nextCycle` assignment.

import type { CycleState } from "@pulse/web-data/cycle";
import type { StreamRegistryEvent } from "@pulse/web-data/wire";

import {
  RETRY_FRAME,
  HEARTBEAT_FRAME,
  SSE_HEARTBEAT_MS,
  SSE_MAX_STREAMS,
  frameTick,
  parseEventId,
} from "./stream.js";

/** The registry surface the runtime constructs once and the `/api/events` handler reads (§3). */
export interface EventStreamRegistry {
  /** Open one SSE body for a connection, converging to the current cycle unless `lastEventId`
   *  exactly equals the current generation:sequence (§3/§4). */
  connect(lastEventId: string | null): ReadableStream<Uint8Array>;
  /** Fan the just-published cycle out to every open stream as one `tick` (§3). */
  publish(cycle: CycleState): void;
  /** The number of currently open streams — the gauge source (§3). */
  count(): number;
  /** Close every open stream and clear the shared heartbeat timer; idempotent (§3). */
  close(): void;
}

/** Construction options for the registry — every field is injectable for deterministic tests (§3). */
export interface EventStreamRegistryOptions {
  /** Heartbeat cadence in ms (default `SSE_HEARTBEAT_MS` = 5000). */ readonly heartbeatMs?: number;
  /** Maximum concurrent streams (default `SSE_MAX_STREAMS` = 64). */ readonly maxStreams?: number;
  /** Timer scheduler (default global `setTimeout`). */ readonly setTimer?: typeof setTimeout;
  /** Timer canceller (default global `clearTimeout`). */ readonly clearTimer?: typeof clearTimeout;
  /** Bounded lifecycle telemetry sink; never receives a payload, identity, or peer (§11). */
  readonly onEvent?: (event: StreamRegistryEvent) => void;
}

/** One open stream: its insertion id (ordering + identity) and its captured controller (`null` only
 *  in the instant before `start` runs during `ReadableStream` construction). */
interface StreamRecord {
  readonly id: number;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
}

/**
 * Build the process-lifetime SSE stream registry (§3). One instance is created per runtime; it holds
 * no per-viewer state beyond the open-stream records and a single heartbeat timer.
 */
export function createEventStreamRegistry(
  options: EventStreamRegistryOptions = {},
): EventStreamRegistry {
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const maxStreams = options.maxStreams ?? SSE_MAX_STREAMS;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const onEvent = options.onEvent;

  /** Insertion-ordered open streams (a `Map` preserves insertion order for oldest-first displacement). */
  const streams = new Map<number, StreamRecord>();
  let nextId = 0;
  /** The latest published cycle, or `null` before the first publication (no invented tick before it). */
  let current: CycleState | null = null;
  /** The single shared heartbeat timer handle, or `null` when no stream is open (§3). */
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  /** Emit one bounded lifecycle event, isolating an observer throw so it can never break the registry. */
  function emit(event: StreamRegistryEvent["event"], outcome: StreamRegistryEvent["outcome"]): void {
    if (onEvent === undefined) return;
    try {
      onEvent({ event, outcome, openStreams: streams.size });
    } catch {
      /* telemetry observer failures are isolated (§11) */
    }
  }

  /** Try to release a controller (close on displacement, error on write failure); never throws. */
  function releaseController(record: StreamRecord, mode: "close" | "error"): void {
    const controller = record.controller;
    record.controller = null;
    if (controller === null) return;
    try {
      if (mode === "close") controller.close();
      else controller.error();
    } catch {
      /* a controller already closed/errored by the client is fine */
    }
  }

  /** Remove one stream from the registry and stop the shared timer once the last stream is gone. */
  function forget(id: number): void {
    streams.delete(id);
    if (streams.size === 0 && heartbeatTimer !== null) {
      clearTimer(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  /** Enqueue bytes to one stream; on a write failure remove ONLY that stream and report it. Returns
   *  whether the write succeeded so callers can stop touching a dead stream. */
  function safeEnqueue(record: StreamRecord, bytes: Uint8Array): boolean {
    if (record.controller === null) return false;
    try {
      record.controller.enqueue(bytes);
      return true;
    } catch {
      // Controller enqueue/write failure removes only this stream (§3/§11).
      releaseController(record, "error");
      forget(record.id);
      emit("write-failed", "failure");
      return false;
    }
  }

  /** Start the single shared heartbeat timer if a stream is open and it is not already running (§3). */
  function ensureHeartbeat(): void {
    if (closed || heartbeatTimer !== null || streams.size === 0) return;
    scheduleHeartbeat();
  }

  /** Schedule one heartbeat tick; it re-arms itself while streams remain (a self-rescheduling
   *  `setTimeout`, so the ONE timer handle serves every stream). */
  function scheduleHeartbeat(): void {
    heartbeatTimer = setTimer(() => {
      heartbeatTimer = null;
      for (const record of [...streams.values()]) safeEnqueue(record, HEARTBEAT_FRAME);
      if (!closed && streams.size > 0) scheduleHeartbeat();
    }, heartbeatMs);
    // A background heartbeat timer must never keep the host process alive on its own; a fake timer
    // handle injected by a test has no `unref` (optional-chained no-op).
    (heartbeatTimer as { unref?: () => void }).unref?.();
  }

  /** Whether a connection with `lastEventId` should receive the current tick immediately (§3/§4).
   *  Only an id that exactly equals the current generation AND sequence waits; everything else
   *  (absent, malformed, prior-generation, lower, or higher) converges to current. Before the first
   *  publication there is nothing to converge to, so no tick is sent. */
  function shouldConverge(lastEventId: string | null): boolean {
    if (current === null) return false;
    const parsed = parseEventId(lastEventId);
    if (parsed === null) return true; // absent or malformed → converge
    const { generation, seq } = current.observation;
    return !(parsed.generation === generation && parsed.seq === seq);
  }

  return {
    connect(lastEventId: string | null): ReadableStream<Uint8Array> {
      // Displace the oldest stream before admitting stream 65 so the cap is never exceeded (§3).
      if (streams.size >= maxStreams) {
        const oldest = streams.values().next().value as StreamRecord | undefined;
        if (oldest !== undefined) {
          releaseController(oldest, "close");
          forget(oldest.id);
          emit("displaced", "success");
        }
      }

      const id = ++nextId;
      const record: StreamRecord = { id, controller: null };
      // Register before constructing the stream so a write failure inside `start` can clean up.
      streams.set(id, record);
      const converge = shouldConverge(lastEventId);

      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          record.controller = controller;
          if (!safeEnqueue(record, RETRY_FRAME)) return; // dead already — cleaned up
          if (converge && current !== null) {
            const frame = frameTick(current);
            if (frame !== null) safeEnqueue(record, frame);
          }
        },
        cancel: () => {
          // Browser disconnect: remove only this stream (a normal, expected close).
          releaseController(record, "close");
          forget(id);
          emit("closed", "success");
        },
      });

      ensureHeartbeat();
      emit("connected", "success");
      return stream;
    },

    publish(cycle: CycleState): void {
      current = cycle;
      if (streams.size === 0) return;
      const frame = frameTick(cycle);
      if (frame === null) return; // invalid/oversized observation → no tick (§2)
      for (const record of [...streams.values()]) safeEnqueue(record, frame);
    },

    count(): number {
      return streams.size;
    },

    close(): void {
      closed = true;
      if (heartbeatTimer !== null) {
        clearTimer(heartbeatTimer);
        heartbeatTimer = null;
      }
      for (const record of [...streams.values()]) {
        releaseController(record, "close");
        forget(record.id);
      }
      emit("closed", "success");
    },
  };
}
