// apps/web/src/server/mutations/idempotency.ts — the in-process idempotency store.
//
// Keys are scoped by subject + action + client key (REQ-IDEM-02). A `done` entry replays its stored outcome
// until `completedAt + ttlMs`; a different body hash under the same scope is a conflict for both `done` and
// `in-flight` entries (REQ-IDEM-03/04). The store lives in process memory only and is lost on restart
// (REQ-IDEM-05). No method throws.

import { createHash } from "node:crypto";
import { canonicalJson } from "@pulse/web-data/cycle";

import type { MutationRefusal, MutationSuccess } from "../../shared/mutations.js";
import type { MutationAction } from "./registry.js";

/** The stored (replayable) result of a completed mutation. */
export interface StoredOutcome {
  /** HTTP status of the original response. */ readonly status: number;
  /** Exact JSON body of the original response. */ readonly body: MutationSuccess<unknown> | MutationRefusal;
  /** Original request id (echoed on replay in body and X-Request-Id). */ readonly requestId: string;
}
/** Lookup result (REQ-IDEM-03/04). */
export type IdempotencyLookup =
  | { readonly kind: "miss" }
  | { readonly kind: "replay"; readonly outcome: StoredOutcome }
  | { readonly kind: "conflict" }
  | { readonly kind: "in-flight"; readonly pending: Promise<Response> };

/** In-process store; lost on restart (REQ-IDEM-05). */
export interface IdempotencyStore {
  /** Look up by scope; `bodyHash` = sha256 hex of canonical JSON of the validated body. */
  lookup(scope: IdempotencyScope, bodyHash: string): IdempotencyLookup;
  /** Insert an in-flight entry holding the pending response promise (before the audit step). */
  begin(scope: IdempotencyScope, bodyHash: string, pending: Promise<Response>): void;
  /** Replace the in-flight entry with the final outcome (steps 11–13 only). */
  complete(scope: IdempotencyScope, outcome: StoredOutcome): void;
  /** Drop the in-flight entry (step-10 refusal); waiters already hold the refusal via `pending`. */
  abandon(scope: IdempotencyScope): void;
  /** Remove expired entries (slow-cycle sweep); returns the count removed. */
  sweep(): number;
  /** Current entry count (tests/metrics). */
  size(): number;
}
/** Key scope: subject + action + client key (REQ-IDEM-02). */
export interface IdempotencyScope {
  /** Acting identity subject. */ readonly subject: string;
  /** Mutation action the key is scoped to. */ readonly action: MutationAction;
  /** Client Idempotency-Key value (matches IDEMPOTENCY_KEY_RE). */ readonly key: string;
}
/** Store construction options. */
export interface IdempotencyStoreOptions {
  /** Entry lifetime in ms (IDEMPOTENCY_TTL_MS). */ readonly ttlMs: number;
  /** Entry cap (IDEMPOTENCY_MAX_ENTRIES). */ readonly maxEntries: number;
  /** Injected monotonic-ish clock in ms (tests); defaults to Date.now. */ readonly now?: () => number;
}

/** Internal entry. */
type Entry =
  | { readonly state: "in-flight"; readonly bodyHash: string; readonly pending: Promise<Response> }
  | { readonly state: "done"; readonly bodyHash: string; readonly outcome: StoredOutcome; readonly expiresAt: number };

const MISS: IdempotencyLookup = { kind: "miss" };
const CONFLICT: IdempotencyLookup = { kind: "conflict" };

/** Injective map key for a scope (REQ-IDEM-02). */
export function scopeKey(scope: IdempotencyScope): string {
  return `${scope.subject}\u0000${scope.action}\u0000${scope.key}`;
}

/**
 * SHA-256 (lowercase hex) of the canonical JSON of a validated body.
 * @returns The hash, or null when the value is not canonicalizable (a schema whose output is not plain
 *   JSON, e.g. a transform producing a Date). The dispatcher maps null to an `internal` refusal.
 */
export function canonicalBodyHash(body: unknown): string | null {
  try {
    return createHash("sha256").update(canonicalJson(body)).digest("hex");
  } catch {
    return null; // CanonicalJsonError
  }
}

/**
 * Create the in-process idempotency store. Production options: { ttlMs: IDEMPOTENCY_TTL_MS,
 * maxEntries: IDEMPOTENCY_MAX_ENTRIES } (set by buildWriteRuntime). `now` is an epoch-ms clock seam for tests.
 */
export function createIdempotencyStore(options: IdempotencyStoreOptions): IdempotencyStore {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const expired = (e: Entry, t: number): boolean => e.state === "done" && e.expiresAt <= t;

  function makeRoom(): void {
    if (entries.size < options.maxEntries) return;
    const t = now();
    for (const [k, e] of entries) if (expired(e, t)) entries.delete(k);
    for (const [k, e] of entries) {
      if (entries.size < options.maxEntries) break;
      if (e.state === "done") entries.delete(k); // oldest-inserted first (Map order)
    }
    // If every remaining entry is in flight the store may briefly exceed maxEntries (bounded by concurrency).
  }

  return {
    lookup(scope, bodyHash) {
      const k = scopeKey(scope);
      const e = entries.get(k);
      if (e === undefined) return MISS;
      if (expired(e, now())) {
        entries.delete(k);
        return MISS;
      }
      if (e.bodyHash !== bodyHash) return CONFLICT; // applies to in-flight entries too (REQ-IDEM-04)
      return e.state === "in-flight" ? { kind: "in-flight", pending: e.pending } : { kind: "replay", outcome: e.outcome };
    },
    begin(scope, bodyHash, pending) {
      const k = scopeKey(scope);
      entries.delete(k); // only reachable after a miss; re-inserts at the tail
      makeRoom();
      entries.set(k, { state: "in-flight", bodyHash, pending });
    },
    complete(scope, outcome) {
      const k = scopeKey(scope);
      const e = entries.get(k);
      if (e === undefined || e.state !== "in-flight") return; // defensive: nothing to complete
      entries.set(k, { state: "done", bodyHash: e.bodyHash, outcome, expiresAt: now() + options.ttlMs });
    },
    abandon(scope) {
      const k = scopeKey(scope);
      if (entries.get(k)?.state === "in-flight") entries.delete(k);
    },
    sweep() {
      const t = now();
      let removed = 0;
      for (const [k, e] of entries) {
        if (expired(e, t)) {
          entries.delete(k);
          removed += 1;
        }
      }
      return removed;
    },
    size() {
      return entries.size;
    },
  };
}
