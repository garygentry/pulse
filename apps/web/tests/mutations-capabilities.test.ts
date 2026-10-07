// mutations-capabilities.test.ts — the pure capability rule and its /healthz variant (04 §4).
//
// computeCapabilities: mode × identity × each store failure, first-denial order per CAPABILITY_STORES,
// null snapshot → all false. capabilitiesForHealth: none / undefined mode, null snapshot, proxy-header
// with healthy and degraded stores.

import { describe, expect, test } from "bun:test";

import type { AuthMode, Identity } from "@pulse/web-data/identity";

import {
  CAPABILITY_NAMES,
  CAPABILITY_STORES,
  capabilitiesForHealth,
  computeCapabilities,
} from "../src/server/mutations/capabilities.js";
import {
  WRITE_PATH_STORES,
  type StoreStatus,
  type WritePathReason,
  type WritePathSnapshot,
  type WritePathStore,
} from "../src/server/mutations/write-path.js";

const ALICE: Identity = { subject: "alice", displayName: "Alice", source: "proxy-header" };
const BOB: Identity = { subject: "bob", displayName: "Bob", source: "proxy-header" };

const UP: StoreStatus = { ok: true, reason: null };
const HEALTHY: WritePathSnapshot = Object.freeze({
  audit: UP,
  acks: UP,
  proposals: UP,
  secret: UP,
  alertmanager: UP,
});

function degraded(over: Partial<Record<WritePathStore, WritePathReason>>): WritePathSnapshot {
  const s: Record<WritePathStore, StoreStatus> = { ...HEALTHY };
  for (const [store, reason] of Object.entries(over) as [WritePathStore, WritePathReason][]) {
    s[store] = { ok: false, reason };
  }
  return Object.freeze(s);
}

const MODES: readonly AuthMode[] = ["none", "proxy-header"];

describe("computeCapabilities truth table: mode × identity × store (REQ-AUTHZ-01, REQ-AUTHZ-02)", () => {
  test("CAPABILITY_NAMES is the wire order and CAPABILITY_STORES covers every capability", () => {
    expect([...CAPABILITY_NAMES]).toEqual(["silence", "ack", "proposeEstateEdit"]);
    expect(Object.keys(CAPABILITY_STORES).sort()).toEqual([...CAPABILITY_NAMES].sort());
  });

  for (const mode of MODES) {
    for (const identity of [ALICE, null]) {
      test(`mode ${mode}, identity ${identity === null ? "absent" : "present"}, healthy stores`, () => {
        const { flags, denials } = computeCapabilities(identity, mode, HEALTHY);
        const granted = mode === "proxy-header" && identity !== null;
        for (const cap of CAPABILITY_NAMES) {
          expect(flags[cap]).toBe(granted);
          if (granted) expect(denials[cap]).toBeNull();
          else expect(denials[cap]).toEqual(mode !== "proxy-header" ? { kind: "mode" } : { kind: "identity" });
        }
      });
    }
  }

  test("no per-user rule: any trusted identity gets all three (REQ-AUTHZ-01)", () => {
    expect(computeCapabilities(ALICE, "proxy-header", HEALTHY).flags).toEqual(
      computeCapabilities(BOB, "proxy-header", HEALTHY).flags,
    );
    expect(computeCapabilities(BOB, "proxy-header", HEALTHY).flags).toEqual({
      silence: true,
      ack: true,
      proposeEstateEdit: true,
    });
  });

  for (const store of WRITE_PATH_STORES) {
    test(`store ${store} failure denies exactly the capabilities that depend on it`, () => {
      const { flags, denials } = computeCapabilities(ALICE, "proxy-header", degraded({ [store]: "unwritable" }));
      for (const cap of CAPABILITY_NAMES) {
        const depends = CAPABILITY_STORES[cap].includes(store);
        expect(flags[cap]).toBe(!depends);
        expect(denials[cap]).toEqual(depends ? { kind: "store", store, reason: "unwritable" } : null);
      }
    });
  }

  test("mode outranks identity outranks a store failure", () => {
    const bad = degraded({ audit: "missing" });
    expect(computeCapabilities(null, "none", bad).denials.silence).toEqual({ kind: "mode" });
    expect(computeCapabilities(null, "proxy-header", bad).denials.silence).toEqual({ kind: "identity" });
    expect(computeCapabilities(ALICE, "proxy-header", bad).denials.silence).toEqual({
      kind: "store",
      store: "audit",
      reason: "missing",
    });
  });

  test("result and nested objects are frozen", () => {
    const r = computeCapabilities(ALICE, "proxy-header", HEALTHY);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.flags)).toBe(true);
    expect(Object.isFrozen(r.denials)).toBe(true);
  });
});

describe("first denial follows CAPABILITY_STORES order (REQ-AUTHZ-02, REQ-AUTHZ-03)", () => {
  test("every store of every capability failing reports the first store in order", () => {
    const all = degraded({
      audit: "write-failed",
      acks: "corrupt",
      proposals: "unwritable",
      secret: "secret-missing",
      alertmanager: "not-configured",
    });
    const { denials } = computeCapabilities(ALICE, "proxy-header", all);
    for (const cap of CAPABILITY_NAMES) {
      const first = CAPABILITY_STORES[cap][0]!;
      expect(denials[cap]).toEqual({ kind: "store", store: first, reason: all[first].reason! });
    }
  });

  test("with the leading store healthy, the next failing store in order wins", () => {
    const s = degraded({ proposals: "missing", secret: "secret-too-short", alertmanager: "not-configured", acks: "corrupt" });
    const { denials } = computeCapabilities(ALICE, "proxy-header", s);
    expect(denials.silence).toEqual({ kind: "store", store: "alertmanager", reason: "not-configured" });
    expect(denials.ack).toEqual({ kind: "store", store: "acks", reason: "corrupt" });
    expect(denials.proposeEstateEdit).toEqual({ kind: "store", store: "proposals", reason: "missing" });
  });

  test("the snapshot is re-read per call: capability flips between calls (REQ-AUTHZ-03)", () => {
    expect(computeCapabilities(ALICE, "proxy-header", HEALTHY).flags.ack).toBe(true);
    expect(computeCapabilities(ALICE, "proxy-header", degraded({ acks: "write-failed" })).flags.ack).toBe(false);
    expect(computeCapabilities(ALICE, "proxy-header", HEALTHY).flags.ack).toBe(true);
  });
});

describe("null snapshot → all flags false (REQ-AUTHZ-02, REQ-CFG-02)", () => {
  test("trusted identity in proxy-header with no WritePath installed", () => {
    const { flags, denials } = computeCapabilities(ALICE, "proxy-header", null);
    expect(flags).toEqual({ silence: false, ack: false, proposeEstateEdit: false });
    for (const cap of CAPABILITY_NAMES) {
      expect(denials[cap]).toEqual({ kind: "store", store: "audit", reason: "not-configured" });
    }
  });
});

describe("capabilitiesForHealth (REQ-OBS-02, REQ-CFG-02, REQ-CFG-03)", () => {
  const NONE = { ok: false, reason: "auth-mode-none" } as const;

  test("mode none → every entry auth-mode-none, whatever the snapshot", () => {
    for (const snap of [HEALTHY, null, degraded({ audit: "missing" })]) {
      expect(capabilitiesForHealth("none", snap)).toEqual({ silence: NONE, ack: NONE, proposeEstateEdit: NONE });
    }
  });

  test("undefined mode (defensive read) → every entry auth-mode-none", () => {
    expect(capabilitiesForHealth(undefined, HEALTHY)).toEqual({ silence: NONE, ack: NONE, proposeEstateEdit: NONE });
  });

  test("proxy-header with a null snapshot → not-configured", () => {
    const nc = { ok: false, reason: "not-configured" } as const;
    expect(capabilitiesForHealth("proxy-header", null)).toEqual({ silence: nc, ack: nc, proposeEstateEdit: nc });
  });

  test("proxy-header with healthy stores → all ok", () => {
    const up = { ok: true, reason: null };
    expect(capabilitiesForHealth("proxy-header", HEALTHY)).toEqual({ silence: up, ack: up, proposeEstateEdit: up });
  });

  test("proxy-header with a degraded store reports the first failing store's reason per capability", () => {
    expect(capabilitiesForHealth("proxy-header", degraded({ secret: "secret-missing" }))).toEqual({
      silence: { ok: true, reason: null },
      ack: { ok: true, reason: null },
      proposeEstateEdit: { ok: false, reason: "secret-missing" },
    });
    expect(capabilitiesForHealth("proxy-header", degraded({ audit: "unwritable", acks: "corrupt" }))).toEqual({
      silence: { ok: false, reason: "unwritable" },
      ack: { ok: false, reason: "unwritable" },
      proposeEstateEdit: { ok: false, reason: "unwritable" },
    });
    expect(capabilitiesForHealth("proxy-header", degraded({ acks: "corrupt", alertmanager: "not-configured" }))).toEqual({
      silence: { ok: false, reason: "not-configured" },
      ack: { ok: false, reason: "corrupt" },
      proposeEstateEdit: { ok: true, reason: null },
    });
  });

  test("health availability agrees with computeCapabilities for a trusted caller", () => {
    for (const store of WRITE_PATH_STORES) {
      const snap = degraded({ [store]: "write-failed" });
      const health = capabilitiesForHealth("proxy-header", snap);
      const { flags } = computeCapabilities(ALICE, "proxy-header", snap);
      for (const cap of CAPABILITY_NAMES) expect(health[cap].ok).toBe(flags[cap]);
    }
  });
});
