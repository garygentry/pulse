// apps/web/tests/push/pairing.test.ts — the pairing service at the service level: issuing and base selection, the
// token map bounds, redemption (single use, races, guarded restore) and the redemption limiter. Results are
// asserted on the service's return values; the HTTP mapping is covered with the handlers.

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { PAIR_TOKEN_PATTERN } from "@pulse/web-data/contract";

import type { ExternalUrlState } from "../../src/server/config.js";
import type { AtomicWriteOptions, AtomicWriteResult } from "../../src/server/mutations/stores/atomic-file.js";
import { PUSH_LIMITS } from "../../src/server/push/constants.js";
import {
  handleCancelWebToken,
  handleIssueAdminToken,
  handleIssueWebToken,
} from "../../src/server/push/handlers/pairing-tokens.js";
import { handleRedeem, type PushHandlerDeps } from "../../src/server/push/handlers/redeem.js";
import {
  createPairingService,
  createRedemptionLimiter,
  type PairingServiceForTest,
  type RedeemResult,
  type TokenSource,
} from "../../src/server/push/pairing.js";
import type { DeviceRecord } from "../../src/server/push/registry/schema.js";
import { createDeviceStore, type RegistryStore } from "../../src/server/push/registry/store.js";
import { hashCredential } from "../../src/server/push/secrets.js";
import {
  PUSH_PAIRING_EVENTS,
  __resetMetricsForTest,
  renderMetrics,
  setPushMetricsProvider,
} from "../../src/server/routes/metrics.js";
import { getRuntimeStatus } from "../../src/server/refresh.js";
import {
  createFakeClock,
  createFakeTimers,
  createSeededRandom,
  memoryPushFs,
  type FakeClock,
  type MemoryPushFs,
} from "./helpers/fakes.js";

const PATH = "/data/push/devices.json";
const START = Date.parse("2026-11-01T00:00:00.000Z");
const TTL = PUSH_LIMITS.tokenTtlMs;
const WINDOW = PUSH_LIMITS.limiterWindowMs;
const BASE = "https://pulse.example.com";
const UNSET: ExternalUrlState = { state: "unset" };
const USABLE: ExternalUrlState = { state: "usable", baseUrl: BASE, link: "pulse://connect?v=1" };
const REFUSED: ExternalUrlState = { state: "refused", refusal: "not-https" };
const ENOSPC: AtomicWriteResult = { ok: false, kind: "io", step: "rename", code: "ENOSPC" };

function seedDevice(n: number): DeviceRecord {
  return {
    id: `dev_Seed${n.toString(36).padStart(7, "0")}`,
    displayName: `Example iPad ${n}`,
    credentialHash: n.toString(16).padStart(64, "0"),
    apnsToken: null,
    environment: null,
    preferences: { critical: true, warning: true, info: true },
    pairedAt: "2026-10-01T00:00:00.000Z",
    seenAt: "2026-10-01T00:00:00.000Z",
    lastDelivery: null,
  };
}

/** A store writer that can be held: held writes wait until released with a result (or the real writer). */
interface WriteGate {
  hold(): void;
  waiting(): number;
  /** Resolve the oldest held write with `result`, or pass it through to the in-memory writer. */
  release(result?: AtomicWriteResult): void;
  until(n: number): Promise<void>;
  readonly writer: (path: string, bytes: Uint8Array, options: AtomicWriteOptions) => Promise<AtomicWriteResult>;
}

function writeGate(fs: MemoryPushFs): WriteGate {
  let held = false;
  const queue: Array<{ run: (result?: AtomicWriteResult) => void }> = [];
  return {
    hold: () => {
      held = true;
    },
    waiting: () => queue.length,
    release(result) {
      const next = queue.shift();
      if (next === undefined) throw new Error("no held write");
      if (queue.length === 0) held = false;
      next.run(result);
    },
    async until(n) {
      for (let i = 0; i < 1000 && queue.length < n; i++) await Promise.resolve();
      if (queue.length < n) throw new Error(`expected ${n} held writes, saw ${queue.length}`);
    },
    writer(path, bytes, options) {
      if (!held) return fs.storeWriteFile(path, bytes, options);
      return new Promise((resolve) => {
        queue.push({
          run: (result) => {
            if (result !== undefined) resolve(result);
            else void fs.storeWriteFile(path, bytes, options).then(resolve);
          },
        });
      });
    },
  };
}

interface Rig {
  readonly fs: MemoryPushFs;
  readonly clock: FakeClock;
  readonly store: RegistryStore;
  readonly gate: WriteGate;
  readonly svc: PairingServiceForTest;
}

async function rig(opts: { maxDevices?: number; externalUrl?: ExternalUrlState; seeded?: number } = {}): Promise<Rig> {
  const fs = memoryPushFs();
  if (opts.seeded !== undefined && opts.seeded > 0) {
    const devices = Array.from({ length: opts.seeded }, (_, i) => seedDevice(i + 1));
    fs.seed(PATH, JSON.stringify({ formatVersion: 1, devices }));
  } else {
    fs.seed("/data/push/.keep", "");
    fs.files.delete("/data/push/.keep");
  }
  const clock = createFakeClock(START);
  const timers = createFakeTimers(clock);
  const gate = writeGate(fs);
  const store = await createDeviceStore(PATH, { clock, timers, readFile: fs.storeReadFile, writeFile: gate.writer });
  const svc = createPairingService({
    store,
    clock,
    random: createSeededRandom(42),
    maxDevices: opts.maxDevices ?? 20,
    externalUrl: opts.externalUrl ?? USABLE,
  });
  return { fs, clock, store, gate, svc };
}

// ── secret tracking and log capture ─────────────────────────────────────────────────────────────

const secrets = new Set<string>();
let logSpy: Mock<typeof console.log>;

function lines(): string[] {
  return logSpy.mock.calls.map((args) => String(args[0]));
}

function events(): Array<Record<string, unknown>> {
  return lines().map((l) => JSON.parse(l) as Record<string, unknown>);
}

function eventsNamed(name: string): Array<Record<string, unknown>> {
  return events().filter((e) => e.event === name);
}

function track(value: string): void {
  secrets.add(value);
  secrets.add(hashCredential(value));
}

/** Issue a token, assert success, and return the token (tracked as a secret). */
function issueToken(svc: PairingServiceForTest, source: TokenSource = "cli", base: string | null = null): string {
  const result = svc.issue(source, base);
  if (!result.ok) throw new Error(`issue refused: ${result.refusal}`);
  secrets.add(result.issued.link);
  const token = new URL(result.issued.link).searchParams.get("pair");
  if (token === null) throw new Error("link has no pair parameter");
  track(token);
  return token;
}

async function redeem(svc: PairingServiceForTest, token: string, displayName = "Example iPhone") {
  const result = await svc.redeem({ token, displayName });
  if (result.ok) track(result.response.credential);
  return result;
}

function refusalOf(result: RedeemResult): string | null {
  return result.ok ? null : result.refusal;
}

function pairingCounts(): Record<string, number> {
  setPushMetricsProvider(() => ({ state: "configured", devices: 0, lastSuccessAtMs: null }));
  const out: Record<string, number> = {};
  for (const line of renderMetrics(getRuntimeStatus(), Date.now()).split("\n")) {
    const m = /^pulse_web_push_pairing_events_total\{event="([a-z_]+)"\} (\d+)$/.exec(line);
    if (m !== null) out[m[1] as string] = Number(m[2]);
  }
  return out;
}

function counts(nonZero: Record<string, number>): Record<string, number> {
  return { ...Object.fromEntries(PUSH_PAIRING_EVENTS.map((e) => [e, 0])), ...nonZero };
}

beforeEach(() => {
  secrets.clear();
  logSpy = spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  // Every test: no captured line carries a token, link, credential or one of their hashes, and displayName
  // appears only on the redeemed pairing event.
  for (const line of lines()) {
    for (const secret of secrets) expect(line.includes(secret)).toBe(false);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if ("displayName" in parsed) {
      expect(parsed.event).toBe("push_pairing");
      expect(parsed.pairingEvent).toBe("redeemed");
    }
  }
  logSpy.mockRestore();
  setPushMetricsProvider(null);
  __resetMetricsForTest();
});

// ── issuing ─────────────────────────────────────────────────────────────────────────────────────

describe("pairing: issue", () => {
  test("an issued link carries a pair token, is keyed by its hash and expires after the TTL", async () => {
    const { svc } = await rig();
    const result = svc.issue("cli", null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    secrets.add(result.issued.link);
    const url = new URL(result.issued.link);
    const token = url.searchParams.get("pair") ?? "";
    track(token);
    expect(PAIR_TOKEN_PATTERN.test(token)).toBe(true);
    expect(url.searchParams.get("url")).toBe(BASE);
    expect(result.issued.expiresAt).toBe(new Date(START + TTL).toISOString());
    const snap = svc.snapshotForTest();
    expect([...snap.tokens.keys()]).toEqual([hashCredential(token)]);
    expect(snap.tokens.get(hashCredential(token))).toEqual({ source: "cli", issuedAt: START, expiresAt: START + TTL });
    expect([...snap.tokens.keys()].some((k) => k.includes(token))).toBe(false);
    expect(pairingCounts()).toEqual(counts({ issued: 1 }));
    expect(eventsNamed("push_pairing")).toEqual([
      expect.objectContaining({ ok: true, pairingEvent: "issued", source: "cli" }),
    ]);
  });

  test("a web issue replaces the previous web token and bumps webEpoch; a CLI issue leaves it", async () => {
    const { svc, clock } = await rig();
    const w1 = issueToken(svc, "web");
    expect(svc.snapshotForTest().webEpoch).toBe(1);
    clock.advance(1);
    const w2 = issueToken(svc, "web");
    expect(svc.snapshotForTest().webEpoch).toBe(2);
    clock.advance(1);
    const c1 = issueToken(svc, "cli");
    const snap = svc.snapshotForTest();
    expect(snap.webEpoch).toBe(2);
    expect([...snap.tokens.keys()].sort()).toEqual([hashCredential(w2), hashCredential(c1)].sort());
    expect(await redeem(svc, w1)).toEqual({ ok: false, refusal: "pairing-refused" });
    expect((await redeem(svc, w2)).ok).toBe(true);
  });

  test("the 9th outstanding token evicts the smallest issuedAt and the map never exceeds 8", async () => {
    const { svc, clock } = await rig();
    const tokens: string[] = [];
    for (let i = 0; i < 12; i++) {
      tokens.push(issueToken(svc, i === 3 ? "web" : "cli"));
      expect(svc.snapshotForTest().tokens.size).toBeLessThanOrEqual(PUSH_LIMITS.maxOutstandingTokens);
      clock.advance(1000);
    }
    const kept = [...svc.snapshotForTest().tokens.keys()].sort();
    expect(kept).toEqual(tokens.slice(4).map(hashCredential).sort());
  });

  test("a 9th token in the same millisecond evicts the first in insertion order", async () => {
    const { svc } = await rig();
    const tokens = Array.from({ length: 9 }, () => issueToken(svc));
    expect([...svc.snapshotForTest().tokens.keys()]).toEqual(tokens.slice(1).map(hashCredential));
  });

  describe("base selection", () => {
    test("a usable external URL wins over the Origin", async () => {
      const { svc } = await rig({ externalUrl: USABLE });
      const result = svc.issue("web", "https://other.example.org");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      secrets.add(result.issued.link);
      track(new URL(result.issued.link).searchParams.get("pair") ?? "");
      expect(new URL(result.issued.link).searchParams.get("url")).toBe(BASE);
    });

    for (const [name, externalUrl] of [
      ["unset", UNSET],
      ["refused", REFUSED],
    ] as const) {
      test(`an ${name} external URL uses a valid https Origin`, async () => {
        const { svc } = await rig({ externalUrl });
        const result = svc.issue("web", "https://pulse.example.com");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        secrets.add(result.issued.link);
        const url = new URL(result.issued.link);
        const token = url.searchParams.get("pair") ?? "";
        track(token);
        expect(url.searchParams.get("url")).toBe(BASE);
        expect(PAIR_TOKEN_PATTERN.test(token)).toBe(true);
        expect(result.issued.link).toBe(
          `pulse://connect?v=1&url=${encodeURIComponent(BASE)}&pair=${token}`,
        );
      });
    }

    test("an http Origin, or none, with no external URL gives no-usable-address and stores no token", async () => {
      const { svc } = await rig({ externalUrl: UNSET });
      expect(svc.issue("web", "http://pulse.example.com")).toEqual({ ok: false, refusal: "no-usable-address" });
      expect(svc.issue("cli", null)).toEqual({ ok: false, refusal: "no-usable-address" });
      expect(svc.issue("cli", "not a url")).toEqual({ ok: false, refusal: "no-usable-address" });
      const snap = svc.snapshotForTest();
      expect(snap.tokens.size).toBe(0);
      expect(snap.webEpoch).toBe(0);
      expect(pairingCounts()).toEqual(counts({}));
      expect(lines()).toEqual([]);
    });

    test("a base of about 200 characters gives address-too-long and stores no token", async () => {
      const { svc } = await rig({ externalUrl: UNSET });
      const long = `${BASE}/${"a".repeat(200 - BASE.length - 1)}`;
      expect(long.length).toBe(200);
      expect(svc.issue("web", long)).toEqual({ ok: false, refusal: "address-too-long" });
      expect(svc.snapshotForTest().tokens.size).toBe(0);
      expect(svc.snapshotForTest().webEpoch).toBe(0);
      expect(lines()).toEqual([]);
    });
  });
});

// ── cancel, outstanding, gc ─────────────────────────────────────────────────────────────────────

describe("pairing: cancelWeb, outstandingWeb, gc", () => {
  test("cancelWeb with a web token returns true and counts cancelled; without one false; both bump webEpoch", async () => {
    const { svc } = await rig();
    const cli = issueToken(svc, "cli");
    issueToken(svc, "web");
    expect(svc.cancelWeb()).toBe(true);
    expect(svc.snapshotForTest().webEpoch).toBe(2);
    expect(svc.cancelWeb()).toBe(false);
    expect(svc.snapshotForTest().webEpoch).toBe(3);
    expect([...svc.snapshotForTest().tokens.keys()]).toEqual([hashCredential(cli)]);
    expect(pairingCounts()).toEqual(counts({ issued: 2, cancelled: 1 }));
    expect(eventsNamed("push_pairing").filter((e) => e.pairingEvent === "cancelled")).toEqual([
      expect.objectContaining({ ok: true, source: "web" }),
    ]);
  });

  test("outstandingWeb ignores CLI tokens and returns null after expiry", async () => {
    const { svc, clock } = await rig();
    issueToken(svc, "cli");
    expect(svc.outstandingWeb()).toBeNull();
    clock.advance(1000);
    issueToken(svc, "web");
    expect(svc.outstandingWeb()).toEqual({ expiresAt: START + 1000 + TTL });
    clock.set(START + 1000 + TTL);
    expect(svc.outstandingWeb()).toBeNull();
  });

  test("gc removes expired tokens only", async () => {
    const { svc, clock } = await rig();
    issueToken(svc);
    clock.advance(1000);
    const later = issueToken(svc);
    clock.set(START + TTL);
    svc.gc();
    expect([...svc.snapshotForTest().tokens.keys()]).toEqual([hashCredential(later)]);
  });
});

// ── redeem ──────────────────────────────────────────────────────────────────────────────────────

describe("pairing: redeem", () => {
  test("a token redeems once; the record holds only the credential hash and default preferences", async () => {
    const { svc, store } = await rig();
    const token = issueToken(svc, "web");
    const result = await redeem(svc, token, "  Example iPhone  ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { deviceId, credential } = result.response;
    expect(Object.keys(result.response).sort()).toEqual(["credential", "deviceId"]);
    const stored = store.get(deviceId);
    expect(stored).toEqual({
      id: deviceId,
      displayName: "Example iPhone",
      credentialHash: hashCredential(credential),
      apnsToken: null,
      environment: null,
      preferences: { critical: true, warning: true, info: true },
      pairedAt: new Date(START).toISOString(),
      seenAt: new Date(START).toISOString(),
      lastDelivery: null,
    });
    expect(JSON.stringify(store.list()).includes(credential)).toBe(false);
    expect(store.byCredentialHash(hashCredential(credential))?.id).toBe(deviceId);

    expect(await redeem(svc, token)).toEqual({ ok: false, refusal: "pairing-refused" });
    expect(store.list().length).toBe(1);
    expect(pairingCounts()).toEqual(counts({ issued: 1, redeemed: 1, refused: 1 }));
    const redeemedLines = eventsNamed("push_pairing").filter((e) => e.pairingEvent === "redeemed");
    expect(redeemedLines).toEqual([
      expect.objectContaining({ ok: true, source: "web", deviceId, displayName: "Example iPhone" }),
    ]);
    const refusedLine = eventsNamed("push_pairing").find((e) => e.pairingEvent === "refused");
    expect(refusedLine !== undefined && "source" in refusedLine).toBe(false);
  });

  test("TTL boundary: issuedAt + ttl − 1 redeems, issuedAt + ttl is refused", async () => {
    const { svc, clock } = await rig();
    const early = issueToken(svc);
    const late = issueToken(svc);
    clock.set(START + TTL - 1);
    expect((await redeem(svc, early)).ok).toBe(true);
    clock.set(START + TTL);
    expect(await redeem(svc, late)).toEqual({ ok: false, refusal: "pairing-refused" });
  });

  test("unknown, malformed and expired tokens are refused alike and each records one failure", async () => {
    const { svc, clock } = await rig();
    const expired = issueToken(svc);
    clock.advance(TTL);
    expect(await redeem(svc, expired)).toEqual({ ok: false, refusal: "pairing-refused" });
    expect(await redeem(svc, "short")).toEqual({ ok: false, refusal: "pairing-refused" });
    expect(await redeem(svc, "A".repeat(22))).toEqual({ ok: false, refusal: "pairing-refused" });
    expect(svc.snapshotForTest().limiterFailures.length).toBe(3);
  });

  test("double redemption via Promise.all: one ok, one pairing-refused, one device", async () => {
    const { svc, store } = await rig();
    const token = issueToken(svc);
    const [a, b] = await Promise.all([redeem(svc, token), redeem(svc, token)]);
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, refusal: "pairing-refused" });
    expect(store.list().length).toBe(1);
  });

  test("cap race at maxDevices − 1: one ok, one device-cap-reached, losing token restored with its expiresAt", async () => {
    const { svc, store, clock } = await rig({ maxDevices: 3, seeded: 2 });
    const t1 = issueToken(svc);
    clock.advance(500);
    const t2 = issueToken(svc);
    const t2Record = svc.snapshotForTest().tokens.get(hashCredential(t2));
    clock.advance(500);
    const [a, b] = await Promise.all([redeem(svc, t1), redeem(svc, t2)]);
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, refusal: "device-cap-reached" });
    expect(store.list().length).toBe(3);
    const snap = svc.snapshotForTest();
    expect([...snap.tokens.keys()]).toEqual([hashCredential(t2)]);
    expect(snap.tokens.get(hashCredential(t2))).toEqual(t2Record);
    expect(snap.tokens.get(hashCredential(t2))?.expiresAt).toBe(START + 500 + TTL);
    expect(snap.limiterFailures).toEqual([]);
    expect(pairingCounts()).toEqual(counts({ issued: 2, redeemed: 1, cap_reached: 1 }));
  });

  test("at the cap the token is kept, and redeems after a revoke", async () => {
    const { svc, store } = await rig({ maxDevices: 2, seeded: 2 });
    const token = issueToken(svc);
    expect(await redeem(svc, token)).toEqual({ ok: false, refusal: "device-cap-reached" });
    expect(svc.snapshotForTest().tokens.has(hashCredential(token))).toBe(true);
    expect(svc.snapshotForTest().limiterFailures).toEqual([]);
    const victim = seedDevice(1).id;
    await store.mutate((devices) => ({ kind: "commit", devices: devices.filter((d) => d.id !== victim), result: null }), "revoked");
    expect((await redeem(svc, token)).ok).toBe(true);
    expect(store.list().length).toBe(2);
  });

  test("a write failure gives unavailable and restores the token; the next healthy redeem succeeds", async () => {
    const { svc, store, gate } = await rig();
    const token = issueToken(svc);
    const record = svc.snapshotForTest().tokens.get(hashCredential(token));
    gate.hold();
    const pending = redeem(svc, token);
    await gate.until(1);
    gate.release(ENOSPC);
    expect(await pending).toEqual({ ok: false, refusal: "unavailable" });
    expect(store.list()).toEqual([]);
    expect(svc.snapshotForTest().tokens.get(hashCredential(token))).toEqual(record);
    expect(svc.snapshotForTest().limiterFailures).toEqual([]);
    expect(eventsNamed("push_registry_write_failed")).toEqual([
      expect.objectContaining({ step: "rename", code: "ENOSPC" }),
    ]);
    expect((await redeem(svc, token)).ok).toBe(true);
    expect(store.list().length).toBe(1);
  });

  describe("guarded restore", () => {
    async function consumeHeld(r: Rig, token: string): Promise<{ readonly pending: Promise<unknown> }> {
      r.gate.hold();
      const pending = redeem(r.svc, token);
      await r.gate.until(1);
      expect(r.svc.snapshotForTest().tokens.has(hashCredential(token))).toBe(false);
      // Wrapped: returning the promise itself from an async function would make the caller await the write.
      return { pending };
    }

    test("suppressed after a limiter trip", async () => {
      const r = await rig();
      const token = issueToken(r.svc);
      const { pending } = await consumeHeld(r, token);
      for (let i = 0; i < PUSH_LIMITS.limiterMaxFailures; i++) await redeem(r.svc, "short");
      expect(r.svc.snapshotForTest().voidEpoch).toBe(1);
      r.gate.release(ENOSPC);
      expect(await pending).toEqual({ ok: false, refusal: "unavailable" });
      expect(r.svc.snapshotForTest().tokens.size).toBe(0);
    });

    test("suppressed after a newer web token", async () => {
      const r = await rig();
      const w1 = issueToken(r.svc, "web");
      const { pending } = await consumeHeld(r, w1);
      const w2 = issueToken(r.svc, "web");
      r.gate.release(ENOSPC);
      expect(await pending).toEqual({ ok: false, refusal: "unavailable" });
      expect([...r.svc.snapshotForTest().tokens.keys()]).toEqual([hashCredential(w2)]);
    });

    test("suppressed after cancelWeb", async () => {
      const r = await rig();
      const w1 = issueToken(r.svc, "web");
      const { pending } = await consumeHeld(r, w1);
      expect(r.svc.cancelWeb()).toBe(false);
      r.gate.release(ENOSPC);
      expect(await pending).toEqual({ ok: false, refusal: "unavailable" });
      expect(r.svc.snapshotForTest().tokens.size).toBe(0);
    });

    test("suppressed when the token expired during the persist", async () => {
      const r = await rig();
      const token = issueToken(r.svc);
      const { pending } = await consumeHeld(r, token);
      r.clock.advance(TTL);
      r.gate.release(ENOSPC);
      expect(await pending).toEqual({ ok: false, refusal: "unavailable" });
      expect(r.svc.snapshotForTest().tokens.size).toBe(0);
    });

    test("suppressed when 8 newer tokens fill the map", async () => {
      const r = await rig();
      const token = issueToken(r.svc);
      const { pending } = await consumeHeld(r, token);
      const newer = Array.from({ length: PUSH_LIMITS.maxOutstandingTokens }, () => issueToken(r.svc));
      r.gate.release(ENOSPC);
      expect(await pending).toEqual({ ok: false, refusal: "unavailable" });
      const keys = [...r.svc.snapshotForTest().tokens.keys()];
      expect(keys).toEqual(newer.map(hashCredential));
      expect(keys.includes(hashCredential(token))).toBe(false);
    });

    test("a consumed CLI token is still restored after a web issue", async () => {
      const r = await rig();
      const cli = issueToken(r.svc, "cli");
      const record = r.svc.snapshotForTest().tokens.get(hashCredential(cli));
      const { pending } = await consumeHeld(r, cli);
      const web = issueToken(r.svc, "web");
      r.gate.release(ENOSPC);
      expect(await pending).toEqual({ ok: false, refusal: "unavailable" });
      const snap = r.svc.snapshotForTest();
      expect([...snap.tokens.keys()].sort()).toEqual([hashCredential(cli), hashCredential(web)].sort());
      expect(snap.tokens.get(hashCredential(cli))).toEqual(record);
    });
  });
});

// ── limiter ─────────────────────────────────────────────────────────────────────────────────────

describe("pairing: limiter", () => {
  test("createRedemptionLimiter: sliding window, edge, Retry-After floor of 1", () => {
    const limiter = createRedemptionLimiter(2, 10_000);
    expect(limiter.retryAfterSeconds(0)).toBeNull();
    expect(limiter.recordFailure(0)).toBe(false);
    expect(limiter.recordFailure(100)).toBe(true);
    expect(limiter.retryAfterSeconds(100)).toBe(10);
    expect(limiter.recordFailure(200)).toBe(false);
    expect(limiter.failures()).toEqual([0, 100]);
    expect(limiter.retryAfterSeconds(9_999)).toBe(1);
    expect(limiter.retryAfterSeconds(10_000)).toBeNull();
    expect(limiter.failures()).toEqual([100]);
  });

  test("9 failures allowed; the 10th is refused and trips; while tripped 429 with a fixed Retry-After", async () => {
    const { svc, clock } = await rig();
    const web = issueToken(svc, "web");
    issueToken(svc, "cli");
    for (let i = 0; i < 9; i++) {
      expect(await redeem(svc, "short")).toEqual({ ok: false, refusal: "pairing-refused" });
      clock.advance(1000);
    }
    expect(svc.snapshotForTest().limiterTripped).toBe(false);
    expect(svc.snapshotForTest().tokens.size).toBe(2);
    expect(eventsNamed("push_pairing_rate_limited")).toEqual([]);

    // 10th failure at START + 9000: answered as a miss, and trips.
    expect(await redeem(svc, "short")).toEqual({ ok: false, refusal: "pairing-refused" });
    let snap = svc.snapshotForTest();
    expect(snap.limiterTripped).toBe(true);
    expect(snap.tokens.size).toBe(0);
    expect(snap.voidEpoch).toBe(1);
    expect(eventsNamed("push_pairing_rate_limited")).toEqual([
      expect.objectContaining({ event: "push_pairing_rate_limited", ok: false }),
    ]);
    expect(pairingCounts()).toEqual(counts({ issued: 2, refused: 10, rate_limited: 1 }));

    clock.advance(500); // START + 9500
    const expected = Math.ceil((START + WINDOW - clock.nowMs()) / 1000);
    expect(expected).toBe(591);
    const failures = snap.limiterFailures;
    const lineCount = lines().length;
    for (let i = 0; i < 100; i++) {
      expect(await redeem(svc, i % 2 === 0 ? "short" : web)).toEqual({
        ok: false,
        refusal: "rate-limited",
        retryAfterSeconds: expected,
      });
    }
    snap = svc.snapshotForTest();
    expect(snap.limiterFailures).toEqual(failures);
    expect(snap.voidEpoch).toBe(1);
    expect(lines().length).toBe(lineCount);
    expect(pairingCounts()).toEqual(counts({ issued: 2, refused: 10, rate_limited: 1 }));

    // Recovery at oldest + window, and one more failure re-trips (a new edge).
    clock.set(START + WINDOW - 1);
    expect(refusalOf(await redeem(svc, "short"))).toBe("rate-limited");
    clock.set(START + WINDOW);
    expect(svc.snapshotForTest().limiterTripped).toBe(false);
    const fresh = issueToken(svc);
    expect(await redeem(svc, "short")).toEqual({ ok: false, refusal: "pairing-refused" });
    snap = svc.snapshotForTest();
    expect(snap.limiterTripped).toBe(true);
    expect(snap.voidEpoch).toBe(2);
    expect(snap.tokens.has(hashCredential(fresh))).toBe(false);
    expect(eventsNamed("push_pairing_rate_limited").length).toBe(2);
    expect(pairingCounts()).toEqual(counts({ issued: 3, refused: 11, rate_limited: 2 }));
  });

  test("issuing works while tripped and that token redeems once the window clears", async () => {
    const { svc, clock, store } = await rig();
    for (let i = 0; i < PUSH_LIMITS.limiterMaxFailures; i++) await redeem(svc, "short");
    expect(svc.snapshotForTest().limiterTripped).toBe(true);
    clock.advance(1000);
    const token = issueToken(svc);
    expect(refusalOf(await redeem(svc, token))).toBe("rate-limited");
    expect(svc.snapshotForTest().tokens.has(hashCredential(token))).toBe(true);
    clock.set(START + WINDOW);
    expect((await redeem(svc, token)).ok).toBe(true);
    expect(store.list().length).toBe(1);
  });

  test("cap and write-failure refusals add no limiter failure", async () => {
    const { svc } = await rig({ maxDevices: 1, seeded: 1 });
    const token = issueToken(svc);
    for (let i = 0; i < 15; i++) {
      expect(refusalOf(await redeem(svc, token))).toBe("device-cap-reached");
    }
    expect(svc.snapshotForTest().limiterFailures).toEqual([]);

    const r2 = await rig();
    const t2 = issueToken(r2.svc);
    for (let i = 0; i < 12; i++) {
      r2.gate.hold();
      const pending = redeem(r2.svc, t2);
      await r2.gate.until(1);
      r2.gate.release(ENOSPC);
      expect(refusalOf(await pending)).toBe("unavailable");
    }
    expect(r2.svc.snapshotForTest().limiterFailures).toEqual([]);
    expect(r2.svc.snapshotForTest().tokens.has(hashCredential(t2))).toBe(true);
  });
});

// ── handlers (HTTP mapping) ─────────────────────────────────────────────────────────────────────

function handlerDeps(r: Rig): PushHandlerDeps {
  return { pairing: r.svc, store: r.store, clock: r.clock };
}

function webIssueRequest(origin: string | null): Request {
  return new Request(`${BASE}/api/push/pairing-tokens`, {
    method: "POST",
    headers: origin === null ? {} : { Origin: origin },
  });
}

async function issuedLink(res: Response): Promise<string> {
  expect(res.status).toBe(201);
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  const body = JSON.parse(await res.text()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["expiresAt", "link"]);
  const link = String(body.link);
  secrets.add(link);
  const token = new URL(link).searchParams.get("pair") ?? "";
  track(token);
  expect(PAIR_TOKEN_PATTERN.test(token)).toBe(true);
  return token;
}

async function redeemVia(deps: PushHandlerDeps, token: string): Promise<Response> {
  const res = await handleRedeem(deps, { token, displayName: "Example iPhone" });
  if (res.status === 201) {
    const body = JSON.parse(await res.clone().text()) as { credential: string };
    track(body.credential);
  }
  return res;
}

describe("pairing: handlers", () => {
  test("used, unknown, malformed and expired tokens give byte-identical 403 bodies with no details", async () => {
    const r = await rig();
    const deps = handlerDeps(r);
    const used = issueToken(r.svc);
    const ok = await redeemVia(deps, used);
    expect(ok.status).toBe(201);
    expect(ok.headers.get("Cache-Control")).toBe("private, no-store");
    const okBody = JSON.parse(await ok.text()) as Record<string, unknown>;
    expect(Object.keys(okBody).sort()).toEqual(["credential", "deviceId"]);

    const expired = issueToken(r.svc);
    const unknown = "B".repeat(22);
    const refusals: Response[] = [];
    refusals.push(await redeemVia(deps, used));
    refusals.push(await redeemVia(deps, unknown));
    refusals.push(await redeemVia(deps, "short"));
    r.clock.advance(TTL);
    refusals.push(await redeemVia(deps, expired));

    const texts = await Promise.all(refusals.map((res) => res.text()));
    for (const res of refusals) {
      expect(res.status).toBe(403);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("Retry-After")).toBeNull();
    }
    expect(new Set(texts).size).toBe(1);
    const body = JSON.parse(texts[0] as string) as Record<string, unknown>;
    expect(body.code).toBe("PAIRING_REFUSED");
    expect("details" in body).toBe(false);
  });

  test("web and admin issue give 201 PairingTokenIssued with no-store; the web Origin is the fallback base", async () => {
    const r = await rig({ externalUrl: UNSET });
    const deps = handlerDeps(r);
    const webToken = await issuedLink(handleIssueWebToken(deps, webIssueRequest(BASE)));
    const cliToken = await issuedLink(handleIssueAdminToken(deps, { baseUrl: BASE }));
    expect(webToken).not.toBe(cliToken);
    expect(r.svc.snapshotForTest().tokens.size).toBe(2);
  });

  test("issue refusals are 409 INVALID_REQUEST with details.reason, and store no token", async () => {
    const r = await rig({ externalUrl: UNSET });
    const deps = handlerDeps(r);
    const cases: Array<[Response, string]> = [
      [handleIssueWebToken(deps, webIssueRequest(null)), "no-usable-address"],
      [handleIssueWebToken(deps, webIssueRequest("http://pulse.example.com")), "no-usable-address"],
      [handleIssueAdminToken(deps, {}), "no-usable-address"],
      [handleIssueAdminToken(deps, { baseUrl: `https://pulse.example.com/${"a".repeat(190)}` }), "address-too-long"],
    ];
    for (const [res, reason] of cases) {
      expect(res.status).toBe(409);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(JSON.parse(await res.text())).toEqual(
        expect.objectContaining({ code: "INVALID_REQUEST", details: { reason } }),
      );
    }
    expect(r.svc.snapshotForTest().tokens.size).toBe(0);
  });

  test("cancel gives 204 with and without an outstanding web token", async () => {
    const r = await rig();
    const deps = handlerDeps(r);
    await issuedLink(handleIssueWebToken(deps, webIssueRequest(null)));
    expect(r.svc.outstandingWeb()).not.toBeNull();
    for (let i = 0; i < 2; i++) {
      const res = handleCancelWebToken(deps);
      expect(res.status).toBe(204);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await res.text()).toBe("");
      expect(r.svc.outstandingWeb()).toBeNull();
    }
    expect(pairingCounts()).toEqual(counts({ issued: 1, cancelled: 1 }));
  });

  test("a tripped limiter gives 429 with Retry-After", async () => {
    const r = await rig();
    const deps = handlerDeps(r);
    for (let i = 0; i < PUSH_LIMITS.limiterMaxFailures; i++) {
      expect((await redeemVia(deps, "short")).status).toBe(403);
    }
    r.clock.advance(1500);
    const res = await redeemVia(deps, "short");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(Math.ceil((WINDOW - 1500) / 1000)));
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect((JSON.parse(await res.text()) as { code: string }).code).toBe("RATE_LIMITED");
  });

  test("cap reached gives 409 DEVICE_CAP_REACHED and a write failure gives 503 PUSH_UNAVAILABLE", async () => {
    const full = await rig({ maxDevices: 1, seeded: 1 });
    const capRes = await redeemVia(handlerDeps(full), issueToken(full.svc));
    expect(capRes.status).toBe(409);
    expect((JSON.parse(await capRes.text()) as { code: string }).code).toBe("DEVICE_CAP_REACHED");

    const r = await rig();
    const token = issueToken(r.svc);
    r.gate.hold();
    const pending = { res: redeemVia(handlerDeps(r), token) };
    await r.gate.until(1);
    r.gate.release(ENOSPC);
    const res = await pending.res;
    expect(res.status).toBe(503);
    expect((JSON.parse(await res.text()) as { code: string }).code).toBe("PUSH_UNAVAILABLE");
  });
});
