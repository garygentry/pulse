// apps/web/tests/push/queue.test.ts — the per-device delivery queues and the delivery monitor, with fake clock and
// timers, a scripted fake ApnsClient, a real device store on the in-memory file seam and a real notified memory.
// The auth-expired case runs through the real APNs client against the fake APNs.

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { createPrivateKey } from "node:crypto";

import type { PushEnvironment } from "@pulse/web-data/wire";
import {
  createApnsClient,
  type ApnsClient,
  type ApnsRequest,
  type ApnsResult,
} from "../../src/server/push/apns/client.js";
import { createProviderTokenSigner } from "../../src/server/push/apns/jwt.js";
import type { ApnsSettings } from "../../src/server/push/config.js";
import { PUSH_LIMITS } from "../../src/server/push/constants.js";
import { nextDelay } from "../../src/server/push/dispatch/backoff.js";
import {
  createDeliveryMonitor,
  createDeviceQueues,
  type DeliveryMonitor,
  type DeviceQueues,
  type QueueItem,
  type QueueItemFate,
} from "../../src/server/push/dispatch/queue.js";
import type { RandomSource } from "../../src/server/push/ids.js";
import { createNotifiedMemory, type MarkRef, type NotifiedMemory } from "../../src/server/push/memory.js";
import { planDeliveries, type PlannedNotification } from "../../src/server/push/plan.js";
import type { DeviceRecord } from "../../src/server/push/registry/schema.js";
import { createDeviceStore, type RegistryStore } from "../../src/server/push/registry/store.js";
import { removeDevice } from "../../src/server/push/registry/summary.js";
import { __resetMetricsForTest, renderMetrics, setPushMetricsProvider } from "../../src/server/routes/metrics.js";
import { getRuntimeStatus } from "../../src/server/refresh.js";
import { amAlert, amNotification } from "./helpers/am-fixtures.js";
import { startFakeApns, type FakeApns } from "./helpers/fake-apns.js";
import { createFakeClock, createFakeTimers, memoryPushFs, type FakeClock, type FakeTimers, type MemoryPushFs } from "./helpers/fakes.js";
import { createTestApnsKey } from "./helpers/keys.js";
import { createTestTls } from "./helpers/tls.js";

const PATH = "/data/push/devices.json";
const START = Date.parse("2026-11-20T12:00:00.000Z");
const TOPIC = "com.example.pulse";
const TOKEN_A = "a1".repeat(32);
const TOKEN_B = "b2".repeat(32);
const TOKEN_C = "c3".repeat(32);
const TOKEN_D = "d4".repeat(32);
const SECRETS = [TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D];

function device(n: number, overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: `dev_Test${n.toString(36).padStart(7, "0")}`,
    displayName: `Example iPhone ${n}`,
    credentialHash: n.toString(16).padStart(64, "0"),
    apnsToken: null,
    environment: null,
    preferences: { critical: true, warning: true, info: true },
    pairedAt: "2026-10-01T00:00:00.000Z",
    seenAt: "2026-11-20T00:00:00.000Z",
    lastDelivery: null,
    ...overrides,
  };
}

const DEV_X = device(1, { apnsToken: TOKEN_A, environment: "sandbox" });
const DEV_Y = device(2, { apnsToken: TOKEN_B, environment: "production" });

// ── Scripted fake client ──────────────────────────────────────────────────────────────────────────────────────

type Reply = ApnsResult | "hang";

interface SentRecord {
  readonly environment: PushEnvironment;
  readonly token: string;
  readonly collapseId: string | undefined;
}

interface FakeClient extends ApnsClient {
  /** Append replies for a token (FIFO). Without a script the answer is 200. */
  script(token: string, ...replies: Reply[]): void;
  readonly sent: SentRecord[];
  /** Resolve every hanging send with this result. */
  release(result: ApnsResult): void;
  closed: number;
}

const OK: ApnsResult = { kind: "response", status: 200, reason: null };
const status = (s: number, reason: string | null = null): ApnsResult => ({ kind: "response", status: s, reason });

function createFakeClient(): FakeClient {
  const scripts = new Map<string, Reply[]>();
  const hanging: Array<(r: ApnsResult) => void> = [];
  const client: FakeClient = {
    sent: [],
    closed: 0,
    script(token, ...replies) {
      scripts.set(token, [...(scripts.get(token) ?? []), ...replies]);
    },
    release(result) {
      for (const resolve of hanging.splice(0)) resolve(result);
    },
    send(environment: PushEnvironment, token: string, request: ApnsRequest): Promise<ApnsResult> {
      client.sent.push({ environment, token, collapseId: request.headers["apns-collapse-id"] });
      const reply = scripts.get(token)?.shift() ?? OK;
      if (reply === "hang") return new Promise((resolve) => hanging.push(resolve));
      return Promise.resolve(reply);
    },
    close() {
      client.closed += 1;
      return Promise.resolve();
    },
  };
  return client;
}

// ── Rig ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface Rig {
  readonly fs: MemoryPushFs;
  readonly clock: FakeClock;
  /** Queue timers only (the store's soft-flush timer has its own registry). */
  readonly timers: FakeTimers;
  readonly store: RegistryStore;
  readonly memory: NotifiedMemory;
  readonly unmarks: Array<{ deviceId: string; refs: readonly MarkRef[] }>;
  readonly dropped: string[];
  readonly client: FakeClient;
  readonly monitor: DeliveryMonitor;
  readonly queues: DeviceQueues;
  readonly fates: Array<{ item: QueueItem; fate: QueueItemFate; atMs: number }>;
}

const RANDOM_LOW: RandomSource = { bytes: (n) => new Uint8Array(n), unit: () => 0 };

async function rig(
  devices: readonly DeviceRecord[],
  opts: { apns?: ApnsClient; random?: RandomSource; signer?: { invalidate(): void; current(): string } } = {},
): Promise<Rig> {
  const fs = memoryPushFs();
  fs.seed(PATH, JSON.stringify({ formatVersion: 1, devices }));
  const clock = createFakeClock(START);
  const timers = createFakeTimers(clock);
  const store = await createDeviceStore(PATH, {
    clock,
    timers: createFakeTimers(clock),
    readFile: fs.storeReadFile,
    writeFile: fs.storeWriteFile,
  });
  const real = createNotifiedMemory();
  const unmarks: Rig["unmarks"] = [];
  const dropped: string[] = [];
  const memory: NotifiedMemory = {
    ...real,
    unmarkIfCurrent(deviceId, refs) {
      unmarks.push({ deviceId, refs });
      real.unmarkIfCurrent(deviceId, refs);
    },
    dropDevice(deviceId) {
      dropped.push(deviceId);
      real.dropDevice(deviceId);
    },
  };
  const client = createFakeClient();
  const monitor = createDeliveryMonitor({ clock });
  const fates: Rig["fates"] = [];
  const queues = createDeviceQueues(
    {
      apns: opts.apns ?? client,
      store,
      memory,
      ...(opts.signer !== undefined ? { signer: opts.signer } : {}),
      monitor,
      clock,
      timers,
      random: opts.random ?? RANDOM_LOW,
      topic: TOPIC,
    },
    { onSettled: (item, fate) => fates.push({ item, fate, atMs: clock.nowMs() }) },
  );
  return { fs, clock, timers, store, memory, unmarks, dropped, client, monitor, queues, fates };
}

/** Plan one firing alert (fingerprint `fp`) for `dev`, setting a real mark in the rig's memory. */
function firing(r: Rig, dev: DeviceRecord, fp: string): PlannedNotification {
  const plan = planDeliveries(
    amNotification({ alerts: [amAlert({ fingerprint: fp })] }),
    [r.store.get(dev.id) ?? dev],
    r.memory,
    { badge: null, nowMs: r.clock.nowMs() },
  );
  const items = plan.perDevice.get(dev.id);
  if (items === undefined || items.length !== 1) throw new Error("expected one planned item");
  return items[0] as PlannedNotification;
}

/** A hand-made copy of `base` with its own collapse id and marks (for bulk enqueues). */
function variant(base: PlannedNotification, i: number, marks: readonly MarkRef[] = []): PlannedNotification {
  return { ...base, collapseId: `a-${i.toString(16).padStart(16, "0")}`, marks };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Bun.sleep(0);
}

/** Run queue timers one at a time, letting promises settle between them, until none remain. */
async function drain(r: Rig, maxSteps = 1000): Promise<void> {
  await settle();
  for (let i = 0; i < maxSteps && r.timers.pending() > 0; i++) {
    r.timers.step();
    await settle();
  }
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(2);
  }
}

// ── Logs and metrics ──────────────────────────────────────────────────────────────────────────────────────────

let logSpy: Mock<typeof console.log>;

function events(name: string): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((args) => JSON.parse(String(args[0])) as Record<string, unknown>)
    .filter((e) => e.event === name);
}

function metricLines(): string[] {
  setPushMetricsProvider(() => ({ state: "configured", devices: 0, lastSuccessAtMs: null }));
  return renderMetrics(getRuntimeStatus(), Date.now())
    .split("\n")
    .filter((l) => l.startsWith("pulse_web_push_notifications_total") || l.startsWith("pulse_web_push_pairing_events_total"));
}

/** Non-zero notification counters as `kind|outcome` → n. */
function notificationCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of metricLines()) {
    const m = /^pulse_web_push_notifications_total\{kind="([a-z]+)",outcome="([a-z_]+)"\} (\d+)$/.exec(line);
    if (m !== null && Number(m[3]) > 0) out[`${m[1]}|${m[2]}`] = Number(m[3]);
  }
  return out;
}

function pairingCount(event: string): number {
  for (const line of metricLines()) {
    const m = /^pulse_web_push_pairing_events_total\{event="([a-z_]+)"\} (\d+)$/.exec(line);
    if (m !== null && m[1] === event) return Number(m[2]);
  }
  return 0;
}

let openRigs: Rig[] = [];

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => undefined);
  openRigs = [];
});

afterEach(() => {
  for (const r of openRigs) {
    r.queues.close();
    r.client.release(OK);
  }
  // No captured line carries an APNs token.
  for (const args of logSpy.mock.calls) {
    const line = String(args[0]);
    for (const secret of SECRETS) expect(line.includes(secret)).toBe(false);
  }
  logSpy.mockRestore();
  setPushMetricsProvider(null);
  __resetMetricsForTest();
});

async function openRig(...args: Parameters<typeof rig>): Promise<Rig> {
  const r = await rig(...args);
  openRigs.push(r);
  return r;
}

// ── Monitor ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("createDeliveryMonitor", () => {
  test("lastSuccessAtMs starts null and follows noteSuccess", () => {
    const clock = createFakeClock(START);
    const m = createDeliveryMonitor({ clock, log: () => undefined });
    expect(m.lastSuccessAtMs()).toBeNull();
    m.noteSuccess(START + 5);
    expect(m.lastSuccessAtMs()).toBe(START + 5);
  });

  test("the auth latch logs only on the false → true edge; success and token-accepted clear it", () => {
    const clock = createFakeClock(START);
    const lines: Array<Record<string, unknown>> = [];
    const m = createDeliveryMonitor({ clock, log: (e) => lines.push(e) });
    m.noteAuthFailed(403, "InvalidProviderToken");
    m.noteAuthFailed(403, "InvalidProviderToken");
    expect(lines).toEqual([{ event: "push_apns_auth_failed", ok: false, status: 403, reason: "InvalidProviderToken" }]);
    m.noteTokenAccepted();
    m.noteAuthFailed(403, "MissingProviderToken");
    m.noteSuccess(START);
    m.noteAuthFailed(403, "InvalidProviderToken");
    expect(lines).toHaveLength(3);
  });

  test("failed and dropped lines are rate-limited per device and key, and forgetDevice resets them", () => {
    const clock = createFakeClock(START);
    const lines: Array<Record<string, unknown>> = [];
    const m = createDeliveryMonitor({ clock, log: (e) => lines.push(e) });
    m.logFailed("dev_Test0000001", "firing", "permanent", 400, "BadDeviceToken");
    m.logFailed("dev_Test0000001", "firing", "permanent", 400, "BadDeviceToken");
    m.logDropped("dev_Test0000001", "firing", "overflow");
    m.logDropped("dev_Test0000001", "repeat", "deadline");
    m.logFailed("dev_Test0000002", "resolved", "auth-failed", 403, "InvalidProviderToken");
    expect(lines.map((l) => [l.event, l.deviceId])).toEqual([
      ["push_delivery_failed", "dev_Test0000001"],
      ["push_delivery_dropped", "dev_Test0000001"],
      ["push_delivery_failed", "dev_Test0000002"],
    ]);
    expect(lines[0]).toEqual({
      event: "push_delivery_failed",
      ok: false,
      deviceId: "dev_Test0000001",
      kind: "firing",
      classification: "permanent",
      status: 400,
      reason: "BadDeviceToken",
    });
    expect(lines[1]).toEqual({ event: "push_delivery_dropped", ok: false, deviceId: "dev_Test0000001", kind: "firing", cause: "overflow" });
    clock.advance(PUSH_LIMITS.deliveryFailedLogIntervalMs - 1);
    m.logFailed("dev_Test0000001", "firing", "permanent", 400, "BadDeviceToken");
    expect(lines).toHaveLength(3);
    clock.advance(1);
    m.logFailed("dev_Test0000001", "firing", "permanent", 400, "BadDeviceToken");
    expect(lines).toHaveLength(4);
    m.forgetDevice("dev_Test0000001");
    m.logFailed("dev_Test0000001", "firing", "permanent", 400, "BadDeviceToken");
    expect(lines).toHaveLength(5);
  });
});

// ── Queues ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("createDeviceQueues: ordering and isolation", () => {
  test("FIFO across retries: A transient twice then delivered, B queued → A, A, A, B", async () => {
    const r = await openRig([DEV_X]);
    const a = firing(r, DEV_X, "aaaaaaaaaaaaaaaa");
    const b = firing(r, DEV_X, "bbbbbbbbbbbbbbbb");
    r.client.script(TOKEN_A, status(500), { kind: "error", error: "timeout" });
    r.queues.enqueue([a, b]);
    await drain(r);
    await r.queues.idle();
    expect(r.client.sent.map((s) => s.collapseId)).toEqual([a.collapseId, a.collapseId, a.collapseId, b.collapseId].map(String));
    expect(r.fates.map((f) => [f.item.planned.collapseId, f.fate])).toEqual([
      [a.collapseId, "delivered"],
      [b.collapseId, "delivered"],
    ]);
    expect(r.fates[0]?.item.attempt).toBe(2);
    expect(notificationCounts()).toEqual({ "firing|delivered": 2 });
    expect(r.monitor.lastSuccessAtMs()).toBe(r.clock.nowMs());
    expect(r.store.get(DEV_X.id)?.lastDelivery).toEqual({ outcome: "delivered", at: new Date(r.clock.nowMs()).toISOString(), reason: null });
  });

  test("a device whose sends never return does not delay another device's deliveries", async () => {
    const r = await openRig([DEV_X, DEV_Y]);
    r.client.script(TOKEN_A, "hang");
    const x = firing(r, DEV_X, "aaaaaaaaaaaaaaaa");
    const ys = ["1111111111111111", "2222222222222222", "3333333333333333"].map((fp) => firing(r, DEV_Y, fp));
    r.queues.enqueue([x, ...ys]);
    await until(() => r.fates.filter((f) => f.item.planned.deviceId === DEV_Y.id && f.fate === "delivered").length === 3);
    expect(r.timers.pending()).toBe(0); // no timer of X's was advanced
    expect(r.fates.some((f) => f.item.planned.deviceId === DEV_X.id)).toBe(false);
    r.client.release({ kind: "error", error: "timeout" });
    await drain(r);
    await r.queues.idle();
    expect(r.fates.filter((f) => f.item.planned.deviceId === DEV_X.id).map((f) => f.fate)).toEqual(["delivered"]);
  });
});

describe("createDeviceQueues: overflow", () => {
  test("with the head in flight, the 257th enqueue drops items[1], counted and unmarked once", async () => {
    const r = await openRig([DEV_X]);
    r.client.script(TOKEN_A, "hang");
    const head = firing(r, DEV_X, "aaaaaaaaaaaaaaaa");
    r.queues.enqueue([head]);
    await settle();
    expect(r.client.sent).toHaveLength(1);
    const victimMarks = [r.memory.mark(DEV_X.id, "bbbbbbbbbbbbbbbb")];
    const rest = Array.from({ length: PUSH_LIMITS.queueMaxPerDevice }, (_, i) => variant(head, i + 1, i === 0 ? victimMarks : []));
    r.queues.enqueue(rest);
    const drops = r.fates.filter((f) => f.fate === "dropped");
    expect(drops).toHaveLength(1);
    expect(drops[0]?.item.planned).toBe(rest[0] as PlannedNotification);
    expect(notificationCounts()).toEqual({ "firing|dropped": 1 });
    expect(r.unmarks).toEqual([{ deviceId: DEV_X.id, refs: victimMarks }]);
    expect(r.memory.isMarked(DEV_X.id, "bbbbbbbbbbbbbbbb")).toBe(false);
    expect(r.store.get(DEV_X.id)?.lastDelivery).toEqual({ outcome: "dropped", at: new Date(START).toISOString(), reason: "overflow" });
    expect(events("push_delivery_dropped")).toEqual([
      expect.objectContaining({ deviceId: DEV_X.id, kind: "firing", cause: "overflow" }),
    ]);
    // The head is still in flight and is the first item delivered once it returns.
    r.client.release(OK);
    await drain(r);
    await r.queues.idle();
    expect(r.fates.find((f) => f.fate === "delivered")?.item.planned).toBe(head);
    expect(r.fates.filter((f) => f.fate === "delivered")).toHaveLength(PUSH_LIMITS.queueMaxPerDevice);
  });

  test("without a busy head the oldest unsent item is the victim", async () => {
    const r = await openRig([DEV_X]);
    const head = firing(r, DEV_X, "aaaaaaaaaaaaaaaa");
    const items = Array.from({ length: PUSH_LIMITS.queueMaxPerDevice + 1 }, (_, i) => variant(head, i));
    // Enqueued in one call, the worker starts after the appends, so nothing is busy yet.
    r.queues.enqueue(items);
    expect(r.fates.filter((f) => f.fate === "dropped").map((f) => f.item.planned)).toEqual([items[0] as PlannedNotification]);
    await drain(r);
    await r.queues.idle();
  });
});

describe("createDeviceQueues: deadline", () => {
  test("a transient item is retried until now + delay − enqueuedAt > deadline, then dropped and unmarked", async () => {
    const r = await openRig([DEV_X, DEV_Y]);
    for (let i = 0; i < 50; i++) r.client.script(TOKEN_A, status(503, "ServiceUnavailable"));
    for (let i = 0; i < 50; i++) r.client.script(TOKEN_B, status(503, "ServiceUnavailable"));
    const x = firing(r, DEV_X, "aaaaaaaaaaaaaaaa");
    const y = firing(r, DEV_Y, "bbbbbbbbbbbbbbbb");
    r.queues.enqueue([x, y]);
    await settle();
    // A later re-fire for Y's fingerprint (a higher generation) must survive the drop.
    const later = r.memory.mark(DEV_Y.id, "bbbbbbbbbbbbbbbb");
    expect(later.generation).toBeGreaterThan(y.marks[0]?.generation ?? Infinity);
    await drain(r);
    await r.queues.idle();

    const xDrop = r.fates.find((f) => f.item.planned === x);
    expect(xDrop?.fate).toBe("dropped");
    const item = xDrop?.item as QueueItem;
    const at = xDrop?.atMs as number;
    expect(at + nextDelay(item.attempt, RANDOM_LOW) - item.enqueuedAt).toBeGreaterThan(PUSH_LIMITS.retryDeadlineMs);
    expect(at - item.enqueuedAt).toBeLessThanOrEqual(PUSH_LIMITS.retryDeadlineMs);
    expect(item.attempt).toBeGreaterThan(3);
    expect(r.client.sent.filter((s) => s.token === TOKEN_A)).toHaveLength(item.attempt + 1);

    expect(notificationCounts()).toEqual({ "firing|dropped": 2 });
    expect(r.unmarks).toEqual([
      { deviceId: DEV_X.id, refs: x.marks },
      { deviceId: DEV_Y.id, refs: y.marks },
    ]);
    expect(r.memory.isMarked(DEV_X.id, "aaaaaaaaaaaaaaaa")).toBe(false);
    expect(r.memory.isMarked(DEV_Y.id, "bbbbbbbbbbbbbbbb")).toBe(true);
    expect(r.store.get(DEV_X.id)?.lastDelivery).toEqual({ outcome: "dropped", at: new Date(at).toISOString(), reason: "ServiceUnavailable" });
    expect(events("push_delivery_dropped")).toEqual([
      { ts: expect.any(String), event: "push_delivery_dropped", ok: false, deviceId: DEV_X.id, kind: "firing", cause: "deadline" },
      { ts: expect.any(String), event: "push_delivery_dropped", ok: false, deviceId: DEV_Y.id, kind: "firing", cause: "deadline" },
    ]);
  });
});

describe("createDeviceQueues: permanent and auth failures", () => {
  test("permanent and auth-failed never unmark; the auth edge logs once over 3 failures and again after a delivery", async () => {
    const r = await openRig([DEV_X]);
    r.client.script(
      TOKEN_A,
      status(400, "BadDeviceToken"),
      status(403, "InvalidProviderToken"),
      status(403, "InvalidProviderToken"),
      status(403, "MissingProviderToken"),
      OK,
      status(403, "InvalidProviderToken"),
    );
    const items = ["1", "2", "3", "4", "5", "6"].map((d) => firing(r, DEV_X, d.repeat(16)));
    r.queues.enqueue(items);
    await drain(r);
    await r.queues.idle();
    expect(r.fates.map((f) => f.fate)).toEqual(["failed", "failed", "failed", "failed", "delivered", "failed"]);
    expect(r.unmarks).toEqual([]);
    for (const it of items.slice(0, 4)) expect(r.memory.isMarked(DEV_X.id, it.marks[0]?.fingerprint ?? "")).toBe(true);
    expect(events("push_apns_auth_failed").map((e) => [e.status, e.reason])).toEqual([
      [403, "InvalidProviderToken"],
      [403, "InvalidProviderToken"],
    ]);
    expect(notificationCounts()).toEqual({ "firing|failed": 5, "firing|delivered": 1 });
    expect(r.store.get(DEV_X.id)?.lastDelivery?.outcome).toBe("failed");
    expect(r.store.get(DEV_X.id)?.lastDelivery?.reason).toBe("InvalidProviderToken");
  });

  test("push_delivery_failed is logged at most once per device per 60 s", async () => {
    const r = await openRig([DEV_X]);
    for (let i = 0; i < 6; i++) r.client.script(TOKEN_A, status(400, "BadDeviceToken"));
    r.queues.enqueue(["1", "2", "3"].map((d) => firing(r, DEV_X, d.repeat(16))));
    await drain(r);
    await r.queues.idle();
    expect(events("push_delivery_failed")).toHaveLength(1);
    expect(events("push_delivery_failed")[0]).toEqual({
      ts: expect.any(String),
      event: "push_delivery_failed",
      ok: false,
      deviceId: DEV_X.id,
      kind: "firing",
      classification: "permanent",
      status: 400,
      reason: "BadDeviceToken",
    });
    r.clock.advance(PUSH_LIMITS.deliveryFailedLogIntervalMs - 1);
    r.queues.enqueue([firing(r, DEV_X, "4".repeat(16))]);
    await drain(r);
    await r.queues.idle();
    expect(events("push_delivery_failed")).toHaveLength(1);
    r.clock.advance(1);
    r.queues.enqueue(["5", "6"].map((d) => firing(r, DEV_X, d.repeat(16))));
    await drain(r);
    await r.queues.idle();
    expect(events("push_delivery_failed")).toHaveLength(2);
    expect(notificationCounts()).toEqual({ "firing|failed": 6 });
  });
});

describe("createDeviceQueues: dead tokens", () => {
  test("a 410 removes the device: token_removed by the queue, removed_dead by the store, queue and memory cleared", async () => {
    const r = await openRig([DEV_X]);
    r.client.script(TOKEN_A, status(410, "Unregistered"));
    const items = ["1", "2", "3"].map((d) => firing(r, DEV_X, d.repeat(16)));
    r.queues.enqueue(items);
    await until(() => r.store.get(DEV_X.id) === undefined);
    await drain(r);
    await r.queues.idle();
    expect(r.client.sent).toHaveLength(1);
    expect(r.fates.map((f) => f.fate)).toEqual(["abandoned", "abandoned", "token_removed"]);
    expect(notificationCounts()).toEqual({ "firing|token_removed": 1 });
    expect(pairingCount("removed_dead")).toBe(1);
    expect(events("push_device_removed")).toEqual([
      expect.objectContaining({ deviceId: DEV_X.id, reason: "dead-token" }),
    ]);
    expect(r.dropped).toEqual([DEV_X.id]);
    expect(r.memory.size(DEV_X.id)).toBe(0);
    expect(r.unmarks).toEqual([]);
  });

  test("with the token changed before classification nothing is removed and the item counts failed", async () => {
    const r = await openRig([DEV_X]);
    r.client.script(TOKEN_A, "hang");
    r.queues.enqueue([firing(r, DEV_X, "1".repeat(16))]);
    await settle();
    const changed = await r.store.mutate((devices) => ({
      kind: "commit",
      devices: devices.map((d) => (d.id === DEV_X.id ? { ...d, apnsToken: TOKEN_C } : d)),
      result: null,
    }));
    expect(changed.ok).toBe(true);
    r.client.release(status(410, "Unregistered"));
    await drain(r);
    await r.queues.idle();
    expect(r.store.get(DEV_X.id)?.apnsToken).toBe(TOKEN_C);
    expect(r.fates.map((f) => f.fate)).toEqual(["failed"]);
    expect(notificationCounts()).toEqual({ "firing|failed": 1 });
    expect(pairingCount("removed_dead")).toBe(0);
    expect(r.store.get(DEV_X.id)?.lastDelivery).toEqual(expect.objectContaining({ outcome: "failed", reason: "Unregistered" }));
    expect(events("push_device_removed")).toEqual([]);
  });

  test("a removal write failure counts failed, keeps the device and lets the next 410 retry the removal", async () => {
    const r = await openRig([DEV_X]);
    r.client.script(TOKEN_A, status(410, "Unregistered"), status(410, "Unregistered"));
    r.fs.failNext("storeWrite", { code: "ENOSPC", step: "write" });
    r.queues.enqueue(["1", "2"].map((d) => firing(r, DEV_X, d.repeat(16))));
    await until(() => r.store.get(DEV_X.id) === undefined);
    await drain(r);
    await r.queues.idle();
    expect(r.fates.map((f) => f.fate)).toEqual(["failed", "token_removed"]);
    expect(notificationCounts()).toEqual({ "firing|failed": 1, "firing|token_removed": 1 });
    expect(events("push_delivery_failed")).toEqual([
      expect.objectContaining({ classification: "dead-token-unremoved", status: 410, reason: "Unregistered" }),
    ]);
    expect(pairingCount("removed_dead")).toBe(1);
  });
});

describe("createDeviceQueues: removal and send-time lookup", () => {
  test("onRemoved for a device with 5 queued items and a pending backoff clears the timer, counts nothing, idle resolves", async () => {
    const r = await openRig([DEV_X]);
    r.client.script(TOKEN_A, status(500));
    const items = ["1", "2", "3", "4", "5"].map((d) => firing(r, DEV_X, d.repeat(16)));
    r.queues.enqueue(items);
    await settle();
    expect(r.timers.pending()).toBe(1);
    expect(await removeDevice(r.store, DEV_X.id, "revoked")).toBe("removed");
    expect(r.timers.pending()).toBe(0);
    await r.queues.idle();
    expect(r.client.sent).toHaveLength(1);
    expect(notificationCounts()).toEqual({});
    expect(r.fates.map((f) => f.fate)).toEqual(Array(5).fill("abandoned"));
    expect(r.dropped).toEqual([DEV_X.id]);
    expect(r.memory.size(DEV_X.id)).toBe(0);
  });

  test("a retry re-reads the device and uses its changed token and environment", async () => {
    const r = await openRig([DEV_X]);
    r.client.script(TOKEN_A, status(500));
    r.queues.enqueue([firing(r, DEV_X, "1".repeat(16))]);
    await settle();
    await r.store.mutate((devices) => ({
      kind: "commit",
      devices: devices.map((d) => (d.id === DEV_X.id ? { ...d, apnsToken: TOKEN_D, environment: "production" as const } : d)),
      result: null,
    }));
    await drain(r);
    await r.queues.idle();
    expect(r.client.sent.map((s) => [s.environment, s.token])).toEqual([
      ["sandbox", TOKEN_A],
      ["production", TOKEN_D],
    ]);
    expect(notificationCounts()).toEqual({ "firing|delivered": 1 });
  });

  test("a device unknown or unregistered at send time is discarded uncounted", async () => {
    const unregistered = device(3);
    const r = await openRig([unregistered, DEV_Y]);
    const ghost = { ...firing(r, DEV_Y, "1".repeat(16)), deviceId: "dev_Test000000z" };
    const none = { ...firing(r, DEV_Y, "2".repeat(16)), deviceId: unregistered.id };
    r.queues.enqueue([ghost, none]);
    await drain(r);
    await r.queues.idle();
    expect(r.client.sent).toEqual([]);
    expect(r.fates.map((f) => f.fate)).toEqual(["discarded", "discarded"]);
    expect(notificationCounts()).toEqual({});
    expect(logSpy.mock.calls).toHaveLength(0);
  });

  test("an unexpected exception logs push_internal_error {route: dispatch}, counts the head failed and continues", async () => {
    const r = await openRig([DEV_X]);
    const good = firing(r, DEV_X, "1".repeat(16));
    const bad = Object.defineProperty({ ...good, collapseId: "a-2222222222222222" }, "payload", {
      get: () => {
        throw new Error("boom");
      },
    }) as PlannedNotification;
    r.queues.enqueue([bad, good]);
    await drain(r);
    await r.queues.idle();
    expect(r.fates.map((f) => f.fate)).toEqual(["failed", "delivered"]);
    expect(events("push_internal_error")).toEqual([{ ts: expect.any(String), event: "push_internal_error", ok: false, route: "dispatch" }]);
    expect(notificationCounts()).toEqual({ "firing|failed": 1, "firing|delivered": 1 });
  });
});

describe("createDeviceQueues: auth-expired and close", () => {
  test("auth-expired from the client counts the attempt and invalidates the signer", async () => {
    let invalidated = 0;
    const r = await openRig([DEV_X], { signer: { current: () => "unused", invalidate: () => void invalidated++ } });
    r.client.script(TOKEN_A, status(403, "ExpiredProviderToken"));
    r.queues.enqueue([firing(r, DEV_X, "1".repeat(16))]);
    await drain(r);
    await r.queues.idle();
    expect(invalidated).toBe(1);
    expect(r.fates.map((f) => [f.fate, f.item.attempt])).toEqual([["delivered", 1]]);
  });

  test("close() empties the timer registry, changes no metric, and later enqueue is a no-op", async () => {
    const r = await openRig([DEV_X, DEV_Y]);
    r.client.script(TOKEN_A, status(500));
    r.client.script(TOKEN_B, "hang");
    r.queues.enqueue([firing(r, DEV_X, "1".repeat(16)), firing(r, DEV_Y, "2".repeat(16)), firing(r, DEV_Y, "3".repeat(16))]);
    await settle();
    expect(r.timers.pending()).toBe(1);
    const before = metricLines();
    r.queues.close();
    expect(r.timers.pending()).toBe(0);
    await r.queues.idle();
    r.client.release(OK);
    await settle();
    r.queues.enqueue([firing(r, DEV_X, "4".repeat(16))]);
    await settle();
    expect(r.client.sent).toHaveLength(2);
    expect(r.timers.pending()).toBe(0);
    expect(metricLines()).toEqual(before);
    expect(r.client.closed).toBe(0);
    expect(r.fates.every((f) => f.fate === "abandoned")).toBe(true);
    // The removal listener is unsubscribed.
    await removeDevice(r.store, DEV_X.id, "revoked");
    expect(r.dropped).toEqual([]);
  });
});

const tls = createTestTls();

describe.skipIf(tls === null)("createDeviceQueues with the real APNs client (requires openssl; skipped locally when missing)", () => {
  let fake: FakeApns | undefined;
  let client: ApnsClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await fake?.close();
    fake = undefined;
  });

  test("403 ExpiredProviderToken then 200 through the real client is delivered with attempt 0", async () => {
    if (tls === null) throw new Error("unreachable");
    const key = createTestApnsKey();
    const settings: ApnsSettings = Object.freeze({
      key: createPrivateKey(key.pem),
      keyId: "ABC123DEFG",
      teamId: "TEAM456XYZ",
      topic: TOPIC,
    });
    fake = await startFakeApns({ tls, providerPublicKey: key.publicKey });
    fake.script(TOKEN_A, { kind: "status", status: 403, reason: "ExpiredProviderToken" });
    const clientClock = createFakeClock(START);
    const signer = createProviderTokenSigner(settings.key, settings.keyId, settings.teamId, clientClock);
    let sends = 0;
    const real = createApnsClient(settings, signer, {
      origins: fake.origins,
      ca: fake.ca,
      clock: clientClock,
      timers: createFakeTimers(clientClock),
    });
    client = real;
    const counting: ApnsClient = {
      send: (env, token, req) => {
        sends++;
        return real.send(env, token, req);
      },
      close: () => real.close(),
    };
    const r = await openRig([DEV_X], { apns: counting, signer });
    r.queues.enqueue([firing(r, DEV_X, "1".repeat(16))]);
    await until(() => r.fates.length === 1, 5000);
    await r.queues.idle();
    expect(r.fates.map((f) => [f.fate, f.item.attempt])).toEqual([["delivered", 0]]);
    expect(sends).toBe(1);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.every((q) => q.jwtValid)).toBe(true);
    expect(r.timers.pending()).toBe(0);
    expect(notificationCounts()).toEqual({ "firing|delivered": 1 });
  });
});
