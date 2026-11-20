// apps/web/tests/push/sweep.test.ts — the expiry sweep: the bootstrap pass, the 90-day boundary, the hourly interval
// under fake timers, close(), the shared in-flight pass, pairing-token GC and the exception boundary.

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";

import { PUSH_LIMITS } from "../../src/server/push/constants.js";
import { createPairingService, type PairingService } from "../../src/server/push/pairing.js";
import type { DeviceRecord, DeviceRemovalReason } from "../../src/server/push/registry/schema.js";
import { createDeviceStore, type RegistryStore } from "../../src/server/push/registry/store.js";
import { hashCredential } from "../../src/server/push/secrets.js";
import { createSweep } from "../../src/server/push/sweep.js";
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
  type FakeTimers,
  type MemoryPushFs,
} from "./helpers/fakes.js";

const PATH = "/data/push/devices.json";
const START = Date.parse("2026-11-01T00:00:00.000Z");
const EXPIRY = PUSH_LIMITS.deviceExpiryMs;
const HOUR = PUSH_LIMITS.sweepIntervalMs;

function device(n: number, seenAtMs: number): DeviceRecord {
  return {
    id: `dev_Swep${n.toString(36).padStart(7, "0")}`,
    displayName: `Example iPad ${n}`,
    credentialHash: n.toString(16).padStart(64, "0"),
    apnsToken: null,
    environment: null,
    preferences: { critical: true, warning: true, info: true },
    pairedAt: "2026-01-01T00:00:00.000Z",
    seenAt: new Date(seenAtMs).toISOString(),
    lastDelivery: null,
  };
}

interface Rig {
  readonly fs: MemoryPushFs;
  readonly clock: FakeClock;
  readonly timers: FakeTimers;
  readonly store: RegistryStore;
  readonly pairing: PairingService & { snapshotForTest(): { tokens: ReadonlyMap<string, unknown> } };
  readonly removed: Array<[string, DeviceRemovalReason]>;
}

async function rig(devices: readonly DeviceRecord[]): Promise<Rig> {
  const fs = memoryPushFs();
  fs.seed(PATH, JSON.stringify({ formatVersion: 1, devices }));
  const clock = createFakeClock(START);
  const timers = createFakeTimers(clock);
  const store = await createDeviceStore(PATH, {
    clock,
    timers,
    readFile: fs.storeReadFile,
    writeFile: fs.storeWriteFile,
  });
  const pairing = createPairingService({
    store,
    clock,
    random: createSeededRandom(3),
    maxDevices: 20,
    externalUrl: { state: "usable", baseUrl: "https://pulse.example.com", link: "pulse://connect?v=1" },
  });
  const removed: Array<[string, DeviceRemovalReason]> = [];
  store.onRemoved((id, reason) => removed.push([id, reason]));
  return { fs, clock, timers, store, pairing, removed };
}

/** Let the store's write chain settle (microtasks only; the store writes in memory). */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function writes(fs: MemoryPushFs): number {
  return fs.calls.filter((c) => c.startsWith("storeWrite ")).length;
}

let logSpy: Mock<typeof console.log>;
const secrets = new Set<string>();

function lines(): string[] {
  return logSpy.mock.calls.map((args) => String(args[0]));
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
  for (const line of lines()) for (const s of secrets) expect(line.includes(s)).toBe(false);
  logSpy.mockRestore();
  setPushMetricsProvider(null);
  __resetMetricsForTest();
});

describe("sweep", () => {
  test("the bootstrap pass removes a device 90 days + 1 ms old and keeps one exactly 90 days old", async () => {
    const stale = device(1, START - EXPIRY - 1);
    const edge = device(2, START - EXPIRY);
    const fresh = device(3, START);
    const r = await rig([stale, edge, fresh]);
    const sweep = createSweep(r);
    await settle();
    expect(r.store.list().map((d) => d.id)).toEqual([edge.id, fresh.id]);
    expect(r.removed).toEqual([[stale.id, "expired"]]);
    const removedLines = lines()
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.event === "push_device_removed");
    expect(removedLines).toEqual([
      expect.objectContaining({ event: "push_device_removed", deviceId: stale.id, reason: "expired" }),
    ]);
    expect(pairingCounts()).toEqual(counts({ expired: 1 }));
    // runOnce reports the result; nothing more is due, so nothing is written.
    const before = writes(r.fs);
    expect(await sweep.runOnce()).toEqual({ expired: 0, writeFailed: false });
    expect(writes(r.fs)).toBe(before);
    sweep.close();
  });

  test("runOnce reports the count; nothing due writes nothing", async () => {
    const r = await rig([device(1, START)]);
    const sweep = createSweep(r);
    await settle();
    expect(writes(r.fs)).toBe(0);
    r.clock.advance(EXPIRY + 1);
    expect(await sweep.runOnce()).toEqual({ expired: 1, writeFailed: false });
    expect(r.store.list()).toEqual([]);
    sweep.close();
  });

  test("the interval fires hourly under fake timers and close() stops it", async () => {
    const r = await rig([device(1, START - EXPIRY + HOUR + HOUR / 2), device(2, START - EXPIRY + 3 * HOUR + 1)]);
    const sweep = createSweep(r);
    await settle();
    expect(r.store.list().length).toBe(2);
    expect(r.timers.pending()).toBe(1);

    // Device 1 crosses the cutoff at +1.5 h: the +1 h pass keeps it, the +2 h pass removes it.
    expect(r.timers.advance(HOUR)).toBe(1);
    await settle();
    expect(r.store.list().length).toBe(2);
    expect(r.timers.advance(HOUR)).toBe(1);
    await settle();
    expect(r.store.list().length).toBe(1);
    expect(r.removed).toEqual([[device(1, 0).id, "expired"]]);

    sweep.close();
    sweep.close();
    expect(r.timers.pending()).toBe(0);
    expect(r.timers.advance(10 * HOUR)).toBe(0);
    await settle();
    expect(r.store.list().length).toBe(1);
  });

  test("concurrent runOnce calls share the in-flight pass", async () => {
    const r = await rig([device(1, START - EXPIRY - 1)]);
    const sweep = createSweep(r); // bootstrap pass in flight
    const a = sweep.runOnce();
    const b = sweep.runOnce();
    expect(a).toBe(b);
    expect(await a).toEqual({ expired: 1, writeFailed: false });
    expect(writes(r.fs)).toBe(1);
    sweep.close();
  });

  test("a pass also GCs expired pairing tokens", async () => {
    const r = await rig([]);
    const issued = r.pairing.issue("cli", null);
    if (!issued.ok) throw new Error("issue refused");
    secrets.add(issued.issued.link);
    const token = new URL(issued.issued.link).searchParams.get("pair") ?? "";
    secrets.add(token);
    secrets.add(hashCredential(token));
    const sweep = createSweep(r);
    await settle();
    expect(r.pairing.snapshotForTest().tokens.size).toBe(1);
    r.clock.advance(PUSH_LIMITS.tokenTtlMs);
    await sweep.runOnce();
    expect(r.pairing.snapshotForTest().tokens.size).toBe(0);
    sweep.close();
  });

  test("a write failure reports writeFailed and the next pass retries", async () => {
    const r = await rig([device(1, START)]);
    const sweep = createSweep(r);
    await settle();
    r.clock.advance(EXPIRY + 1);
    r.fs.failNext("storeWrite", { code: "ENOSPC" });
    expect(await sweep.runOnce()).toEqual({ expired: 0, writeFailed: true });
    expect(r.store.list().length).toBe(1);
    expect(await sweep.runOnce()).toEqual({ expired: 1, writeFailed: false });
    sweep.close();
  });

  test("a throwing pass logs push_internal_error {route: sweep} and the interval keeps running", async () => {
    const r = await rig([]);
    let calls = 0;
    const pairing: PairingService = {
      ...r.pairing,
      gc() {
        calls++;
        throw new Error("boom web-01.example.com");
      },
    };
    const sweep = createSweep({ store: r.store, pairing, clock: r.clock, timers: r.timers });
    await settle();
    r.timers.advance(HOUR);
    await settle();
    expect(calls).toBe(2);
    const errors = lines()
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.event === "push_internal_error");
    expect(errors.length).toBe(2);
    for (const e of errors) {
      expect(e.route).toBe("sweep");
      expect(JSON.stringify(e).includes("boom")).toBe(false);
    }
    expect(r.timers.pending()).toBe(1);
    sweep.close();
  });
});
