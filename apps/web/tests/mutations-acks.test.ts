// mutations-acks.test.ts — ack.set / ack.remove body schemas, definitions and handlers
// (06-acks-store-and-cycle.md §4, §9 mutations-acks row). Handlers are driven directly with a stub
// ServerContext (only `cycle` populated) and a fake AckStore; registration is item 025.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Identity } from "@pulse/web-data/identity";
import type { ServerContext } from "../src/shared/registry.js";
import {
  normalizeNote,
  removeAckBodySchema,
  removeAckMutation,
  setAckBodySchema,
  setAckMutation,
} from "../src/server/mutations/handlers/acks.js";
import type { AckRecord, AckStore, StoreWriteResult } from "../src/server/mutations/stores/ack-store.js";
import type { MutationHandlerMeta } from "../src/server/mutations/registry.js";
import { FIXTURE_FINGERPRINTS, UNKNOWN_SEL_FINGERPRINT, makeAlertsPayload } from "./alerts-fixtures.js";

const ACTOR: Identity = { subject: "alice", displayName: "Alice A.", source: "proxy-header" };
const NOW = new Date("2026-09-29T12:00:00.000Z");
const META: MutationHandlerMeta = { requestId: "req-1", now: NOW };
const utf8 = new TextEncoder();

/** A stub ServerContext whose captured cycle holds the "mixed" alerts fixture (firing + silenced + inhibited). */
function ctxWithAlerts(): ServerContext {
  const payload = makeAlertsPayload({ scenario: "mixed" });
  return { cycle: { alerts: { value: payload } } } as unknown as ServerContext;
}
const NO_CYCLE = { cycle: null } as unknown as ServerContext;

interface FakeStore extends AckStore {
  readonly setCalls: [string, AckRecord][];
  readonly removeCalls: string[];
}

function fakeStore(opts: { fail?: boolean; existing?: boolean } = {}): FakeStore {
  const setCalls: [string, AckRecord][] = [];
  const removeCalls: string[] = [];
  return {
    setCalls,
    removeCalls,
    loadStatus: { ok: true, reason: null },
    async set(fp: string, record: AckRecord): Promise<StoreWriteResult<AckRecord>> {
      setCalls.push([fp, record]);
      return opts.fail === true ? { ok: false, error: "write-failed" } : { ok: true, value: record };
    },
    async remove(fp: string): Promise<StoreWriteResult<boolean>> {
      removeCalls.push(fp);
      return opts.fail === true ? { ok: false, error: "write-failed" } : { ok: true, value: opts.existing === true };
    },
    async reconcile(): Promise<number> {
      return 0;
    },
    foldView: () => new Map(),
    get: () => undefined,
  };
}

function parseSet(input: unknown) {
  const r = setAckBodySchema.safeParse(input);
  if (!r.success) throw new Error("expected set body to parse");
  return r.data;
}

describe("ack definitions (REQ-ACK-01, 06 §4.2)", () => {
  test("set/remove carry the 06 §4.2 method, path, capability and action and no validate", () => {
    const set = setAckMutation({ ackStore: fakeStore() });
    const remove = removeAckMutation({ ackStore: fakeStore() });
    expect([set.method, set.path, set.capability, set.action]).toEqual(["POST", "/api/mutations/acks", "ack", "ack.set"]);
    expect([remove.method, remove.path, remove.capability, remove.action]).toEqual([
      "POST",
      "/api/mutations/acks/remove",
      "ack",
      "ack.remove",
    ]);
    expect("validate" in set).toBe(false);
    expect("validate" in remove).toBe(false);
    expect(set.body).toBe(setAckBodySchema);
    expect(remove.body).toBe(removeAckBodySchema);
  });

  test("auditTarget is alert:<fp> and ≤ 134 bytes for a 128-byte fingerprint", () => {
    const fp = "f".repeat(128);
    const set = setAckMutation({ ackStore: fakeStore() });
    const remove = removeAckMutation({ ackStore: fakeStore() });
    expect(set.auditTarget({ fingerprint: fp })).toBe(`alert:${fp}`);
    expect(remove.auditTarget({ fingerprint: fp })).toBe(`alert:${fp}`);
    expect(utf8.encode(set.auditTarget({ fingerprint: fp })).length).toBeLessThanOrEqual(134);
    expect(remove.auditDetails({ fingerprint: fp })).toEqual({});
  });
});

describe("ack body schemas are strict and bounded (REQ-SEC-03, REQ-SEC-07)", () => {
  test("an unknown key is rejected on both schemas", () => {
    expect(setAckBodySchema.safeParse({ fingerprint: "fp", extra: 1 }).success).toBe(false);
    expect(removeAckBodySchema.safeParse({ fingerprint: "fp", note: "x" }).success).toBe(false);
  });

  test("a 128-byte fingerprint is accepted; 129 bytes, empty, or a control char are rejected", () => {
    expect(setAckBodySchema.safeParse({ fingerprint: "a".repeat(128) }).success).toBe(true);
    expect(removeAckBodySchema.safeParse({ fingerprint: "a".repeat(128) }).success).toBe(true);
    // 127 ASCII + one 2-byte char = 129 bytes
    expect(setAckBodySchema.safeParse({ fingerprint: `${"a".repeat(127)}é` }).success).toBe(false);
    expect(setAckBodySchema.safeParse({ fingerprint: "a".repeat(129) }).success).toBe(false);
    expect(removeAckBodySchema.safeParse({ fingerprint: "a".repeat(129) }).success).toBe(false);
    expect(setAckBodySchema.safeParse({ fingerprint: "" }).success).toBe(false);
    expect(setAckBodySchema.safeParse({ fingerprint: "fp\u0000x" }).success).toBe(false);
    expect(removeAckBodySchema.safeParse({ fingerprint: "fp\nx" }).success).toBe(false);
  });

  test("a 281-code-point note and a note with \\t are rejected; 280 code points and \\n are accepted", () => {
    expect(setAckBodySchema.safeParse({ fingerprint: "fp", note: "😀".repeat(281) }).success).toBe(false);
    expect(setAckBodySchema.safeParse({ fingerprint: "fp", note: "a\tb" }).success).toBe(false);
    expect(setAckBodySchema.safeParse({ fingerprint: "fp", note: "a\u0085b" }).success).toBe(false);
    expect(setAckBodySchema.safeParse({ fingerprint: "fp", note: "😀".repeat(280) }).success).toBe(true);
    expect(parseSet({ fingerprint: "fp", note: "line one\nline two" })).toEqual({
      fingerprint: "fp",
      note: "line one\nline two",
    });
  });

  test("an absent note produces no note key (exactOptionalPropertyTypes)", () => {
    const body = parseSet({ fingerprint: "fp" });
    expect(body).toEqual({ fingerprint: "fp" });
    expect("note" in body).toBe(false);
  });
});

describe("ack note normalization and audit details (REQ-ACK-01)", () => {
  test("normalizeNote trims and maps empty/whitespace/absent to null", () => {
    expect(normalizeNote(undefined)).toBeNull();
    expect(normalizeNote()).toBeNull();
    expect(normalizeNote("   \n ")).toBeNull();
    expect(normalizeNote("  hello \n")).toBe("hello");
  });

  test("whitespace-only note → stored note null and auditDetails {hasNote:false}", async () => {
    const store = fakeStore();
    const def = setAckMutation({ ackStore: store, now: () => NOW });
    const body = parseSet({ fingerprint: FIXTURE_FINGERPRINTS.hostDown, note: "   " });
    expect(def.auditDetails(body)).toEqual({ hasNote: false });
    await def.handler(body, ctxWithAlerts(), ACTOR, META);
    expect(store.setCalls[0]?.[1].note).toBeNull();
  });

  test("a padded note → stored trimmed and auditDetails {hasNote:true, note}", async () => {
    const store = fakeStore();
    const def = setAckMutation({ ackStore: store, now: () => NOW });
    const body = parseSet({ fingerprint: FIXTURE_FINGERPRINTS.hostDown, note: "  on it\nETA 10m  " });
    expect(def.auditDetails(body)).toEqual({ hasNote: true, note: "on it\nETA 10m" });
    await def.handler(body, ctxWithAlerts(), ACTOR, META);
    expect(store.setCalls[0]?.[1].note).toBe("on it\nETA 10m");
  });
});

describe("ack.set handler (REQ-ACK-01, REQ-ACK-05, REQ-SEC-06)", () => {
  test("fp absent from ctx.cycle.alerts → failed 404 alert-not-firing and the store is not called", async () => {
    const store = fakeStore();
    const def = setAckMutation({ ackStore: store });
    const outcome = await def.handler({ fingerprint: UNKNOWN_SEL_FINGERPRINT }, ctxWithAlerts(), ACTOR, META);
    expect(outcome).toEqual({ outcome: "failed", status: 404, code: "TARGET_NOT_FOUND", reason: "alert-not-firing" });
    expect(store.setCalls).toHaveLength(0);
  });

  test("ctx.cycle === null → failed 404 alert-not-firing and the store is not called", async () => {
    const store = fakeStore();
    const def = setAckMutation({ ackStore: store });
    const outcome = await def.handler({ fingerprint: FIXTURE_FINGERPRINTS.hostDown }, NO_CYCLE, ACTOR, META);
    expect(outcome).toEqual({ outcome: "failed", status: 404, code: "TARGET_NOT_FOUND", reason: "alert-not-firing" });
    expect(store.setCalls).toHaveLength(0);
  });

  test("a silenced alert is ackable → 200 {fingerprint, at}; the record is minimized (no source) (REQ-ACK-02)", async () => {
    const ctx = ctxWithAlerts();
    const silenced = ctx.cycle!.alerts.value.alerts.find((a) => a.fingerprint === FIXTURE_FINGERPRINTS.backupAge);
    expect(silenced?.state).toBe("silenced");
    const store = fakeStore();
    const def = setAckMutation({ ackStore: store, now: () => NOW });
    const outcome = await def.handler({ fingerprint: FIXTURE_FINGERPRINTS.backupAge }, ctx, ACTOR, META);
    expect(outcome).toEqual({
      outcome: "succeeded",
      status: 200,
      result: { fingerprint: FIXTURE_FINGERPRINTS.backupAge, at: NOW.toISOString() },
    });
    expect(store.setCalls).toEqual([
      [FIXTURE_FINGERPRINTS.backupAge, { actor: { subject: "alice", displayName: "Alice A." }, at: NOW.toISOString(), note: null }],
    ]);
    expect(JSON.stringify(store.setCalls)).not.toContain("proxy-header");
  });

  test("an inhibited alert is ackable too", async () => {
    const def = setAckMutation({ ackStore: fakeStore(), now: () => NOW });
    const outcome = await def.handler({ fingerprint: FIXTURE_FINGERPRINTS.loadHigh }, ctxWithAlerts(), ACTOR, META);
    expect(outcome.outcome).toBe("succeeded");
  });

  test("store failure → failed 500 INTERNAL_ERROR write-failed", async () => {
    const def = setAckMutation({ ackStore: fakeStore({ fail: true }), now: () => NOW });
    const outcome = await def.handler({ fingerprint: FIXTURE_FINGERPRINTS.hostDown }, ctxWithAlerts(), ACTOR, META);
    expect(outcome).toEqual({ outcome: "failed", status: 500, code: "INTERNAL_ERROR", reason: "write-failed" });
  });
});

describe("ack.remove handler (REQ-ACK-01, REQ-ACK-05)", () => {
  test("removed true/false passes through with details {removed}", async () => {
    for (const existing of [true, false]) {
      const store = fakeStore({ existing });
      const def = removeAckMutation({ ackStore: store });
      const outcome = await def.handler({ fingerprint: "fp-gone" }, NO_CYCLE, ACTOR, META);
      expect(outcome).toEqual({
        outcome: "succeeded",
        status: 200,
        result: { fingerprint: "fp-gone", removed: existing },
        details: { removed: existing },
      });
      expect(store.removeCalls).toEqual(["fp-gone"]);
    }
  });

  test("store failure → failed 500 INTERNAL_ERROR write-failed", async () => {
    const def = removeAckMutation({ ackStore: fakeStore({ fail: true }) });
    const outcome = await def.handler({ fingerprint: "fp" }, NO_CYCLE, ACTOR, META);
    expect(outcome).toEqual({ outcome: "failed", status: 500, code: "INTERNAL_ERROR", reason: "write-failed" });
  });
});

describe("ack mutations make no upstream call (REQ-ACK-08)", () => {
  let fetchSpy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  test("a set and a remove perform zero fetch calls", async () => {
    fetchSpy = spyOn(globalThis, "fetch");
    const store = fakeStore({ existing: true });
    const set = setAckMutation({ ackStore: store, now: () => NOW });
    const remove = removeAckMutation({ ackStore: store });
    const a = await set.handler({ fingerprint: FIXTURE_FINGERPRINTS.hostDown, note: "x" }, ctxWithAlerts(), ACTOR, META);
    const b = await remove.handler({ fingerprint: FIXTURE_FINGERPRINTS.hostDown }, ctxWithAlerts(), ACTOR, META);
    expect(a.outcome).toBe("succeeded");
    expect(b.outcome).toBe("succeeded");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
