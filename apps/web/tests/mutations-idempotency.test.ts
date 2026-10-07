// apps/web/tests/mutations-idempotency.test.ts — the in-process idempotency store (mutation-foundation
// 03-mutation-dispatcher.md §4; 00-core-definitions.md §8; 10-testing-strategy.md §3.2).
//
// Pure unit suite over an injected counter clock. Proves REQ-IDEM-02 (injective scope key), REQ-IDEM-03
// (replay / in-flight sharing), REQ-IDEM-04 (conflict on a different body) and REQ-IDEM-05 (bounded,
// in-process, TTL). The dispatcher-level waiter behaviour (abandon → waiter gets the same refusal) is
// asserted in mutations-dispatch.test.ts.

import { describe, expect, test } from "bun:test";

import { IDEMPOTENCY_MAX_ENTRIES, IDEMPOTENCY_TTL_MS } from "../src/server/mutations/constants.js";
import {
  canonicalBodyHash,
  createIdempotencyStore,
  type IdempotencyScope,
  type IdempotencyStore,
  scopeKey,
  type StoredOutcome,
} from "../src/server/mutations/idempotency.js";

const TTL = 1_000;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** A settable epoch-ms clock. */
function counterClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

function scope(key = "key-00000001", subject = "alice", action: IdempotencyScope["action"] = "ack.set"): IdempotencyScope {
  return { subject, action, key };
}

function outcome(requestId = "req-1"): StoredOutcome {
  return { status: 200, body: { outcome: "succeeded", requestId, result: { fingerprint: "abc", at: "t" } }, requestId };
}

function pendingResponse(): Promise<Response> {
  return Promise.resolve(new Response("{}"));
}

function store(opts: { ttlMs?: number; maxEntries?: number } = {}): {
  s: IdempotencyStore;
  clock: ReturnType<typeof counterClock>;
} {
  const clock = counterClock();
  const s = createIdempotencyStore({ ttlMs: opts.ttlMs ?? TTL, maxEntries: opts.maxEntries ?? 100, now: clock.now });
  return { s, clock };
}

describe("idempotency semantics table (03 §4.3; REQ-IDEM-03, REQ-IDEM-04)", () => {
  test("row 1: no stored entry → miss", () => {
    const { s } = store();
    expect(s.lookup(scope(), HASH_A)).toEqual({ kind: "miss" });
    expect(s.size()).toBe(0);
  });

  test("row 2: done + same hash → replay with the stored outcome (REQ-IDEM-03)", () => {
    const { s } = store();
    const o = outcome();
    s.begin(scope(), HASH_A, pendingResponse());
    s.complete(scope(), o);
    const r = s.lookup(scope(), HASH_A);
    expect(r.kind).toBe("replay");
    if (r.kind === "replay") expect(r.outcome).toBe(o);
  });

  test("row 3a: done + different hash → conflict (REQ-IDEM-04)", () => {
    const { s } = store();
    s.begin(scope(), HASH_A, pendingResponse());
    s.complete(scope(), outcome());
    expect(s.lookup(scope(), HASH_B)).toEqual({ kind: "conflict" });
  });

  test("row 3b: in-flight + different hash → conflict (REQ-IDEM-04)", () => {
    const { s } = store();
    s.begin(scope(), HASH_A, pendingResponse());
    expect(s.lookup(scope(), HASH_B)).toEqual({ kind: "conflict" });
  });

  test("row 4: in-flight + same hash → in-flight carrying the begin() promise (REQ-IDEM-03)", () => {
    const { s } = store();
    const p = pendingResponse();
    s.begin(scope(), HASH_A, p);
    const r = s.lookup(scope(), HASH_A);
    expect(r.kind).toBe("in-flight");
    if (r.kind === "in-flight") expect(r.pending).toBe(p);
  });

  test("a stored failed outcome replays too (REQ-IDEM-03)", () => {
    const { s } = store();
    const failed: StoredOutcome = {
      status: 502,
      body: { code: "SOURCE_UNAVAILABLE", message: "m", details: { reason: "upstream-transport", requestId: "r2" } },
      requestId: "r2",
    };
    s.begin(scope(), HASH_A, pendingResponse());
    s.complete(scope(), failed);
    expect(s.lookup(scope(), HASH_A)).toEqual({ kind: "replay", outcome: failed });
  });
});

describe("idempotency scope (REQ-IDEM-02)", () => {
  test("keys are scoped by subject and action", () => {
    const { s } = store();
    s.begin(scope("key-00000001", "alice", "ack.set"), HASH_A, pendingResponse());
    expect(s.lookup(scope("key-00000001", "bob", "ack.set"), HASH_B)).toEqual({ kind: "miss" });
    expect(s.lookup(scope("key-00000001", "alice", "ack.remove"), HASH_B)).toEqual({ kind: "miss" });
    expect(s.lookup(scope("key-00000001", "alice", "ack.set"), HASH_B)).toEqual({ kind: "conflict" });
  });

  test("scopeKey is NUL-separated and distinct where naive concatenation collides", () => {
    const naive = (x: IdempotencyScope): string => `${x.subject}${x.action}${x.key}`;
    const i: IdempotencyScope = { subject: "xack.set", action: "ack.set", key: "yyyyyyyy" };
    const j: IdempotencyScope = { subject: "x", action: "ack.set", key: "ack.setyyyyyyyy" };
    expect(naive(i)).toBe(naive(j));
    expect(scopeKey(i)).not.toBe(scopeKey(j));
    expect(scopeKey(j)).toBe("x\u0000ack.set\u0000ack.setyyyyyyyy");
    const { s } = store();
    s.begin(i, HASH_A, pendingResponse());
    expect(s.lookup(j, HASH_B)).toEqual({ kind: "miss" });
  });
});

describe("idempotency TTL and sweep (REQ-IDEM-05)", () => {
  test("a done entry replays until completedAt + ttlMs, then lookup → miss", () => {
    const { s, clock } = store();
    s.begin(scope(), HASH_A, pendingResponse());
    clock.advance(50); // completedAt is taken at complete(), not begin()
    s.complete(scope(), outcome());
    clock.advance(TTL - 1);
    expect(s.lookup(scope(), HASH_A).kind).toBe("replay");
    clock.advance(1);
    expect(s.lookup(scope(), HASH_A)).toEqual({ kind: "miss" });
    expect(s.size()).toBe(0);
  });

  test("an expired entry does not conflict with a different body", () => {
    const { s, clock } = store();
    s.begin(scope(), HASH_A, pendingResponse());
    s.complete(scope(), outcome());
    clock.advance(TTL);
    expect(s.lookup(scope(), HASH_B)).toEqual({ kind: "miss" });
  });

  test("in-flight entries never expire", () => {
    const { s, clock } = store();
    s.begin(scope(), HASH_A, pendingResponse());
    clock.advance(TTL * 10);
    expect(s.lookup(scope(), HASH_A).kind).toBe("in-flight");
    expect(s.sweep()).toBe(0);
  });

  test("sweep() removes only expired entries and returns the count", () => {
    const { s, clock } = store();
    for (const k of ["key-00000001", "key-00000002", "key-00000003"]) {
      s.begin(scope(k), HASH_A, pendingResponse());
      s.complete(scope(k), outcome());
    }
    clock.advance(TTL / 2);
    s.begin(scope("key-00000004"), HASH_A, pendingResponse());
    s.complete(scope("key-00000004"), outcome());
    s.begin(scope("key-00000005"), HASH_A, pendingResponse()); // in flight
    expect(s.size()).toBe(5);
    expect(s.sweep()).toBe(0);
    clock.advance(TTL / 2);
    expect(s.sweep()).toBe(3);
    expect(s.size()).toBe(2);
    expect(s.lookup(scope("key-00000004"), HASH_A).kind).toBe("replay");
    expect(s.sweep()).toBe(0);
  });

  test("production TTL constant is 24 h", () => {
    expect(IDEMPOTENCY_TTL_MS).toBe(86_400_000);
  });
});

describe("idempotency bound at maxEntries (REQ-IDEM-05)", () => {
  const key = (i: number): string => `key-${String(i).padStart(8, "0")}`;

  test(`at maxEntries = ${IDEMPOTENCY_MAX_ENTRIES} the oldest-inserted done entry is evicted; in-flight survive`, () => {
    expect(IDEMPOTENCY_MAX_ENTRIES).toBe(10_000);
    const { s } = store({ maxEntries: IDEMPOTENCY_MAX_ENTRIES, ttlMs: IDEMPOTENCY_TTL_MS });
    // Two in-flight entries inserted first (oldest), then done entries fill the store.
    s.begin(scope(key(0)), HASH_A, pendingResponse());
    s.begin(scope(key(1)), HASH_A, pendingResponse());
    for (let i = 2; i < IDEMPOTENCY_MAX_ENTRIES; i += 1) {
      s.begin(scope(key(i)), HASH_A, pendingResponse());
      s.complete(scope(key(i)), outcome());
    }
    expect(s.size()).toBe(IDEMPOTENCY_MAX_ENTRIES);

    s.begin(scope("new-key-0001"), HASH_A, pendingResponse());
    expect(s.size()).toBe(IDEMPOTENCY_MAX_ENTRIES);
    // The oldest done entry (key 2) is gone; the older in-flight entries survive.
    expect(s.lookup(scope(key(2)), HASH_A)).toEqual({ kind: "miss" });
    expect(s.lookup(scope(key(0)), HASH_A).kind).toBe("in-flight");
    expect(s.lookup(scope(key(1)), HASH_A).kind).toBe("in-flight");
    expect(s.lookup(scope(key(3)), HASH_A).kind).toBe("replay");
    expect(s.lookup(scope("new-key-0001"), HASH_A).kind).toBe("in-flight");
  });

  test("complete does not reorder: eviction follows begin order", () => {
    const { s } = store({ maxEntries: 3 });
    s.begin(scope(key(1)), HASH_A, pendingResponse());
    s.begin(scope(key(2)), HASH_A, pendingResponse());
    s.begin(scope(key(3)), HASH_A, pendingResponse());
    // Complete in reverse order; key 1 is still the oldest-inserted.
    s.complete(scope(key(3)), outcome());
    s.complete(scope(key(2)), outcome());
    s.complete(scope(key(1)), outcome());
    s.begin(scope(key(4)), HASH_A, pendingResponse());
    expect(s.lookup(scope(key(1)), HASH_A)).toEqual({ kind: "miss" });
    expect(s.lookup(scope(key(2)), HASH_A).kind).toBe("replay");
  });

  test("expired entries are dropped before live done entries", () => {
    const { s, clock } = store({ maxEntries: 3 });
    s.begin(scope(key(1)), HASH_A, pendingResponse());
    s.complete(scope(key(1)), outcome());
    clock.advance(TTL / 2);
    s.begin(scope(key(2)), HASH_A, pendingResponse());
    s.complete(scope(key(2)), outcome());
    s.begin(scope(key(3)), HASH_A, pendingResponse());
    s.complete(scope(key(3)), outcome());
    clock.advance(TTL / 2); // key 1 expired, keys 2/3 live
    s.begin(scope(key(4)), HASH_A, pendingResponse());
    expect(s.size()).toBe(3);
    expect(s.lookup(scope(key(2)), HASH_A).kind).toBe("replay");
    expect(s.lookup(scope(key(3)), HASH_A).kind).toBe("replay");
  });

  test("a store full of in-flight entries never evicts them (may briefly exceed the cap)", () => {
    const { s } = store({ maxEntries: 2 });
    s.begin(scope(key(1)), HASH_A, pendingResponse());
    s.begin(scope(key(2)), HASH_A, pendingResponse());
    s.begin(scope(key(3)), HASH_A, pendingResponse());
    expect(s.size()).toBe(3);
    for (const i of [1, 2, 3]) expect(s.lookup(scope(key(i)), HASH_A).kind).toBe("in-flight");
  });
});

describe("idempotency abandon / complete / size (REQ-IDEM-03, REQ-IDEM-05)", () => {
  test("abandon drops an in-flight entry; the next lookup is a miss and the key is reusable", () => {
    const { s } = store();
    s.begin(scope(), HASH_A, pendingResponse());
    expect(s.size()).toBe(1);
    s.abandon(scope());
    expect(s.size()).toBe(0);
    expect(s.lookup(scope(), HASH_B)).toEqual({ kind: "miss" });
    s.begin(scope(), HASH_B, pendingResponse());
    s.complete(scope(), outcome());
    expect(s.lookup(scope(), HASH_B).kind).toBe("replay");
  });

  test("abandon does not drop a done entry; abandon on an unknown scope is a no-op", () => {
    const { s } = store();
    s.begin(scope(), HASH_A, pendingResponse());
    s.complete(scope(), outcome());
    s.abandon(scope());
    expect(s.lookup(scope(), HASH_A).kind).toBe("replay");
    expect(() => s.abandon(scope("unknown-key-1"))).not.toThrow();
    expect(s.size()).toBe(1);
  });

  test("complete on a missing scope is a no-op; complete on a done entry does not overwrite it", () => {
    const { s } = store();
    expect(() => s.complete(scope(), outcome())).not.toThrow();
    expect(s.size()).toBe(0);
    expect(s.lookup(scope(), HASH_A)).toEqual({ kind: "miss" });
    const first = outcome("req-first");
    s.begin(scope(), HASH_A, pendingResponse());
    s.complete(scope(), first);
    s.complete(scope(), outcome("req-second"));
    expect(s.lookup(scope(), HASH_A)).toEqual({ kind: "replay", outcome: first });
  });

  test("size() reflects entries across begin/complete/abandon/sweep", () => {
    const { s, clock } = store();
    expect(s.size()).toBe(0);
    s.begin(scope("key-00000001"), HASH_A, pendingResponse());
    s.begin(scope("key-00000002"), HASH_A, pendingResponse());
    expect(s.size()).toBe(2);
    s.complete(scope("key-00000001"), outcome());
    expect(s.size()).toBe(2);
    s.abandon(scope("key-00000002"));
    expect(s.size()).toBe(1);
    clock.advance(TTL);
    expect(s.sweep()).toBe(1);
    expect(s.size()).toBe(0);
  });

  test("the default clock is Date.now", () => {
    const s = createIdempotencyStore({ ttlMs: 60_000, maxEntries: 10 });
    s.begin(scope(), HASH_A, pendingResponse());
    s.complete(scope(), outcome());
    expect(s.lookup(scope(), HASH_A).kind).toBe("replay");
  });
});

describe("canonicalBodyHash (REQ-IDEM-04)", () => {
  test("identical for objects differing only in key order (nested too)", () => {
    const a = canonicalBodyHash({ fingerprint: "abc", note: "hi", nested: { x: 1, y: [1, 2] } });
    const b = canonicalBodyHash({ nested: { y: [1, 2], x: 1 }, note: "hi", fingerprint: "abc" });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  test("lowercase 64-hex SHA-256", () => {
    expect(canonicalBodyHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  test("differs for different values (and array order)", () => {
    expect(canonicalBodyHash({ fingerprint: "abc" })).not.toBe(canonicalBodyHash({ fingerprint: "abd" }));
    expect(canonicalBodyHash([1, 2])).not.toBe(canonicalBodyHash([2, 1]));
  });

  test("returns null, never throws, for non-canonicalizable values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    for (const v of [new Date(0), { a: undefined }, Number.NaN, Infinity, 1n, cyclic, new Map()]) {
      expect(() => canonicalBodyHash(v)).not.toThrow();
      expect(canonicalBodyHash(v)).toBeNull();
    }
  });
});
