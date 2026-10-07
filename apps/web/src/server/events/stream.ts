// src/server/events/stream.ts — the SSE wire encoding + event-id parsing for `/api/events`
// (08-events-live-state-and-freshness-migration.md §§2, 4). These are the pure, side-effect-free
// pieces the stream registry (`./registry.ts`) composes: they turn a published `CycleState` into a
// canonical `tick` frame, produce the fixed `retry`/heartbeat frames, and parse a reconnect
// `Last-Event-ID` back to a strict `<UUID>:<positive-safe-integer>` cursor.
//
// A tick carries ONLY the latest `CycleObservation` and the five semantic view identities — never a
// view body, ETag, history, session, raw source response, target-id list, identity, or secret (§2).
// The `LiveTick` is validated and canonicalized before it can be framed, so an oversized/malformed
// observation fails safely (no invented tick) rather than emitting an unbounded frame.

import { canonicalJson, type CycleState } from "@pulse/web-data/cycle";
import { validateLiveTick, type LiveTick } from "@pulse/web-data/wire";

/** Client reconnect backoff advertised once per connection (§2). */
export const SSE_RETRY_MS = 10_000;
/** Shared heartbeat cadence — one registry timer serves every stream (§3). */
export const SSE_HEARTBEAT_MS = 5_000;
/** Maximum concurrently admitted streams; stream 65 displaces the oldest first (§3). */
export const SSE_MAX_STREAMS = 64;

/** The exact SSE response headers (§2). `connection: keep-alive` and `x-accel-buffering: no` defeat
 *  proxy buffering so ticks/heartbeats are delivered promptly; `cache-control: no-cache` forbids
 *  caching the event stream. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** The `retry: 10000` frame sent once when a connection opens (§2). */
export const RETRY_FRAME: Uint8Array = ENCODER.encode(`retry: ${SSE_RETRY_MS}\n\n`);
/** The comment heartbeat frame `: heartbeat` sent every five seconds (§2/§3). */
export const HEARTBEAT_FRAME: Uint8Array = ENCODER.encode(": heartbeat\n\n");

/** Strict RFC-4122 UUID form (case-insensitive); a generation contains no colon, so the id is split
 *  on its FINAL colon (§4). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A parsed `Last-Event-ID` cursor: the process generation and its positive-safe sequence (§4). */
export interface ParsedEventId {
  /** The stream's process-generation UUID. */ readonly generation: string;
  /** The positive safe integer sequence within that generation. */ readonly seq: number;
}

/**
 * Parse a reconnect `Last-Event-ID` into its `<UUID>:<positive-safe-integer>` parts (§4). Splits on
 * the final colon (a UUID has none), then validates the left part as a strict UUID and the right part
 * as an unsigned decimal integer that is a positive safe integer. Returns `null` for an absent,
 * empty, or malformed id — never throws. A malformed id is not an error; it simply requires
 * current-state convergence, which the registry decides from this result.
 */
export function parseEventId(raw: string | null): ParsedEventId | null {
  if (raw === null) return null;
  const idx = raw.lastIndexOf(":");
  if (idx <= 0 || idx === raw.length - 1) return null; // no colon, empty UUID, or empty sequence
  const generation = raw.slice(0, idx);
  const seqText = raw.slice(idx + 1);
  if (!UUID_RE.test(generation)) return null;
  if (!/^[0-9]+$/.test(seqText)) return null; // strict digits only — no sign, decimal, or whitespace
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq) || seq <= 0) return null;
  return { generation, seq };
}

/** Project a published `CycleState` into the `LiveTick` shape: the latest publication observation and
 *  each current view's semantic identity, and nothing else (§2). */
export function buildLiveTick(cycle: CycleState): LiveTick {
  return {
    observation: cycle.observation,
    identities: {
      overview: cycle.overview.identity,
      alerts: cycle.alerts.identity,
      estate: cycle.estate.identity,
      engine: cycle.engine.identity,
      timeline: cycle.timeline.identity,
    },
  };
}

/**
 * Frame a published cycle as a complete `tick` SSE event, or `null` when the tick fails validation
 * (§2). The `LiveTick` is validated (`validateLiveTick`, which enforces the bounded observation
 * rules) and only then canonicalized to JSON, so an oversized or otherwise invalid observation yields
 * `null` — the caller sends no invented/malformed tick. The event id is the exact
 * `<generation>:<seq>` cursor.
 */
export function frameTick(cycle: CycleState): Uint8Array | null {
  const tick = buildLiveTick(cycle);
  if (validateLiveTick(tick) === null) return null; // fail safely: never enqueue an invalid tick
  const data = DECODER.decode(canonicalJson(tick));
  const { generation, seq } = cycle.observation;
  return ENCODER.encode(`id: ${generation}:${seq}\nevent: tick\ndata: ${data}\n\n`);
}
