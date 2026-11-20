// apps/web/tests/push/test-send.test.ts — the operator test send and its handler, with fake clock and timers, a
// scripted stub ApnsClient (no network), a real device store on the in-memory file seam and a real monitor.

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { readFileSync } from "node:fs";

import type { PushEnvironment, PushTestResult } from "@pulse/web-data/wire";
import type { ApnsClient, ApnsRequest, ApnsResult } from "../../src/server/push/apns/client.js";
import { PUSH_LIMITS } from "../../src/server/push/constants.js";
import { createDeliveryMonitor, type DeliveryMonitor, type Timers } from "../../src/server/push/dispatch/queue.js";
import { handleAdminTest } from "../../src/server/push/handlers/admin-test.js";
import type { DeviceRecord } from "../../src/server/push/registry/schema.js";
import { createDeviceStore, type RegistryStore } from "../../src/server/push/registry/store.js";
import { removeDevice } from "../../src/server/push/registry/summary.js";
import { runTestSend, type TestSendDeps } from "../../src/server/push/test-send.js";
import { __resetMetricsForTest, renderMetrics, setPushMetricsProvider } from "../../src/server/routes/metrics.js";
import { getRuntimeStatus } from "../../src/server/refresh.js";
import { createFakeClock, createFakeTimers, memoryPushFs, type FakeClock, type FakeTimers, type MemoryPushFs } from "./helpers/fakes.js";

const PATH = "/data/push/devices.json";
const START = Date.parse("2026-11-20T12:00:00.000Z");
const TOPIC = "com.example.pulse";
const TOKEN_A = "a1".repeat(32);
const TOKEN_B = "b2".repeat(32);
const TOKEN_C = "c3".repeat(32);
const SECRETS = [TOKEN_A, TOKEN_B, TOKEN_C];

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

const DEV_A = device(1, { apnsToken: TOKEN_A, environment: "sandbox" });
const DEV_B = device(2, { apnsToken: TOKEN_B, environment: "production" });
const DEV_C = device(3, { apnsToken: TOKEN_C, environment: "production" });
const DEV_NOTOKEN = device(4);

// ── Stub client ───────────────────────────────────────────────────────────────────────────────────────────────

type Reply = ApnsResult | "hang";

interface SentRecord {
  readonly environment: PushEnvironment;
  readonly token: string;
  readonly request: ApnsRequest;
}

interface StubClient extends ApnsClient {
  script(token: string, ...replies: Reply[]): void;
  readonly sent: SentRecord[];
  release(result: ApnsResult): void;
}

const OK: ApnsResult = { kind: "response", status: 200, reason: null };
const status = (s: number, reason: string | null = null): ApnsResult => ({ kind: "response", status: s, reason });
const TIMEOUT: ApnsResult = { kind: "error", error: "timeout" };

function createStubClient(): StubClient {
  const scripts = new Map<string, Reply[]>();
  const hanging: Array<(r: ApnsResult) => void> = [];
  const client: StubClient = {
    sent: [],
    script(token, ...replies) {
      scripts.set(token, [...(scripts.get(token) ?? []), ...replies]);
    },
    release(result) {
      for (const resolve of hanging.splice(0)) resolve(result);
    },
    send(environment, token, request) {
      client.sent.push({ environment, token, request });
      const reply = scripts.get(token)?.shift() ?? OK;
      if (reply === "hang") return new Promise((resolve) => hanging.push(resolve));
      return Promise.resolve(reply);
    },
    close: () => Promise.resolve(),
  };
  return client;
}

// ── Rig ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface Rig {
  readonly fs: MemoryPushFs;
  readonly clock: FakeClock;
  readonly timers: FakeTimers;
  /** Every setTimeout delay the test send asked for, in order. */
  readonly waits: number[];
  readonly store: RegistryStore;
  readonly client: StubClient;
  readonly monitor: DeliveryMonitor;
  readonly calls: string[];
  readonly invalidations: { n: number };
  readonly deps: TestSendDeps;
}

async function rig(devices: readonly DeviceRecord[], badge: number | null = 3): Promise<Rig> {
  const fs = memoryPushFs();
  fs.seed(PATH, JSON.stringify({ formatVersion: 1, devices }));
  const clock = createFakeClock(START);
  const timers = createFakeTimers(clock);
  const waits: number[] = [];
  const recordingTimers: Timers = {
    setTimeout: (fn, ms) => {
      waits.push(ms);
      return timers.setTimeout(fn, ms);
    },
    clearTimeout: (h) => timers.clearTimeout(h),
    setInterval: (fn, ms) => timers.setInterval(fn, ms),
    clearInterval: (h) => timers.clearInterval(h),
  };
  const store = await createDeviceStore(PATH, {
    clock,
    timers: createFakeTimers(clock),
    readFile: fs.storeReadFile,
    writeFile: fs.storeWriteFile,
  });
  const client = createStubClient();
  const real = createDeliveryMonitor({ clock });
  const calls: string[] = [];
  const monitor: DeliveryMonitor = {
    ...real,
    noteSuccess(nowMs) {
      calls.push("noteSuccess");
      real.noteSuccess(nowMs);
    },
    noteAuthFailed(s, reason) {
      calls.push(`noteAuthFailed ${s} ${reason}`);
      real.noteAuthFailed(s, reason);
    },
    logFailed(id, kind, classification, s, reason) {
      calls.push(`logFailed ${kind} ${classification} ${s} ${reason}`);
      real.logFailed(id, kind, classification, s, reason);
    },
  };
  const invalidations = { n: 0 };
  const deps: TestSendDeps = {
    apns: client,
    store,
    signer: { current: () => "jwt", invalidate: () => void (invalidations.n += 1) },
    monitor,
    clock,
    timers: recordingTimers,
    badge: () => badge,
    topic: TOPIC,
  };
  return { fs, clock, timers, waits, store, client, monitor, calls, invalidations, deps };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Bun.sleep(0);
}

/** Await `p` while stepping fake timers one at a time. */
async function drive<T>(r: Rig, p: Promise<T>, maxSteps = 100): Promise<T> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  await settle();
  for (let i = 0; i < maxSteps && !done; i++) {
    if (!r.timers.step()) break;
    await settle();
  }
  return p;
}

function results(res: Awaited<ReturnType<typeof runTestSend>>): PushTestResult["results"] {
  if (!res.ok) throw new Error("expected ok");
  return res.result.results;
}

// ── Logs and metrics ──────────────────────────────────────────────────────────────────────────────────────────

let logSpy: Mock<typeof console.log>;

function notificationCounts(): Record<string, number> {
  setPushMetricsProvider(() => ({ state: "configured", devices: 0, lastSuccessAtMs: null }));
  const out: Record<string, number> = {};
  for (const line of renderMetrics(getRuntimeStatus(), Date.now()).split("\n")) {
    const m = /^pulse_web_push_notifications_total\{kind="([a-z]+)",outcome="([a-z_]+)"\} (\d+)$/.exec(line);
    if (m !== null && Number(m[3]) > 0) out[`${m[1]}|${m[2]}`] = Number(m[3]);
  }
  return out;
}

function pairingCount(event: string): number {
  setPushMetricsProvider(() => ({ state: "configured", devices: 0, lastSuccessAtMs: null }));
  for (const line of renderMetrics(getRuntimeStatus(), Date.now()).split("\n")) {
    const m = /^pulse_web_push_pairing_events_total\{event="([a-z_]+)"\} (\d+)$/.exec(line);
    if (m !== null && m[1] === event) return Number(m[2]);
  }
  return 0;
}

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const args of logSpy.mock.calls) {
    const line = String(args[0]);
    for (const secret of SECRETS) expect(line.includes(secret)).toBe(false);
  }
  logSpy.mockRestore();
  setPushMetricsProvider(null);
  __resetMetricsForTest();
});

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("runTestSend: outcome mapping", () => {
  test("200 → delivered, noteSuccess, lastDelivery delivered, counted delivered under kind=test", async () => {
    const r = await rig([DEV_A]);
    const res = await runTestSend({}, r.deps);
    expect(results(res)).toEqual([{ deviceId: DEV_A.id, displayName: DEV_A.displayName, outcome: "delivered" }]);
    expect(r.calls).toEqual(["noteSuccess"]);
    expect(r.monitor.lastSuccessAtMs()).toBe(START);
    expect(r.store.get(DEV_A.id)?.lastDelivery).toEqual({ outcome: "delivered", at: new Date(START).toISOString(), reason: null });
    expect(notificationCounts()).toEqual({ "test|delivered": 1 });
  });

  test("the request is the test payload: no collapse id, priority 10, badge, sent to the device's environment", async () => {
    const r = await rig([DEV_A, DEV_B], 7);
    await runTestSend({}, r.deps);
    expect(r.client.sent.map((s) => [s.environment, s.token])).toEqual([
      ["sandbox", TOKEN_A],
      ["production", TOKEN_B],
    ]);
    const req = r.client.sent[0]?.request;
    expect(req?.headers["apns-collapse-id"]).toBeUndefined();
    expect(req?.headers["apns-priority"]).toBe("10");
    expect(req?.headers["apns-topic"]).toBe(TOPIC);
    expect(req?.headers["apns-expiration"]).toBe(String(Math.floor(START / 1000) + PUSH_LIMITS.testExpirationSeconds));
    const body = JSON.parse(new TextDecoder().decode(req?.body)) as { aps: { badge?: number; category: string } };
    expect(body.aps.badge).toBe(7);
    expect(body.aps.category).toBe("PULSE_TEST");
    // The same request object is shared by every target.
    expect(r.client.sent[1]?.request).toBe(req as ApnsRequest);
  });

  test("410 Unregistered → token-removed; the device is removed with expectedApnsToken", async () => {
    const r = await rig([DEV_A]);
    r.client.script(TOKEN_A, status(410, "Unregistered"));
    const res = await runTestSend({}, r.deps);
    expect(results(res)).toEqual([
      { deviceId: DEV_A.id, displayName: DEV_A.displayName, outcome: "token-removed", reason: "Unregistered" },
    ]);
    expect(r.store.get(DEV_A.id)).toBeUndefined();
    expect(notificationCounts()).toEqual({ "test|token_removed": 1 });
    expect(pairingCount("removed_dead")).toBe(1);
    const removed = logSpy.mock.calls
      .map((a) => JSON.parse(String(a[0])) as Record<string, unknown>)
      .filter((e) => e.event === "push_device_removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.reason).toBe("dead-token");
  });

  test("410 for a token replaced before removal removes nothing and reports rejected/failed", async () => {
    const r = await rig([DEV_A]);
    // The device registers a new token while the send is in flight.
    const apns: ApnsClient = {
      close: () => Promise.resolve(),
      async send() {
        await r.store.mutate((devices) => ({
          kind: "commit",
          devices: devices.map((d) => (d.id === DEV_A.id ? { ...d, apnsToken: TOKEN_C } : d)),
          result: null,
        }));
        return status(410, "Unregistered");
      },
    };
    const res = await runTestSend({}, { ...r.deps, apns });
    expect(results(res)[0]?.outcome).toBe("rejected");
    expect(r.store.get(DEV_A.id)?.apnsToken).toBe(TOKEN_C);
    expect(notificationCounts()).toEqual({ "test|failed": 1 });
  });

  test("410 with a registry write failure → rejected/failed, lastDelivery failed, logFailed dead-token-unremoved", async () => {
    const r = await rig([DEV_A]);
    r.client.script(TOKEN_A, status(410, "Unregistered"));
    r.fs.failNext("storeWrite", { code: "ENOSPC", step: "write" });
    const res = await runTestSend({}, r.deps);
    expect(results(res)).toEqual([
      { deviceId: DEV_A.id, displayName: DEV_A.displayName, outcome: "rejected", reason: "Unregistered" },
    ]);
    expect(r.store.get(DEV_A.id)).toBeDefined();
    expect(r.store.get(DEV_A.id)?.lastDelivery?.outcome).toBe("failed");
    expect(r.calls).toEqual(["logFailed test dead-token-unremoved 410 Unregistered"]);
    expect(notificationCounts()).toEqual({ "test|failed": 1 });
  });

  test("400 BadDeviceToken → rejected, lastDelivery failed, logFailed permanent", async () => {
    const r = await rig([DEV_A]);
    r.client.script(TOKEN_A, status(400, "BadDeviceToken"));
    const res = await runTestSend({}, r.deps);
    expect(results(res)).toEqual([
      { deviceId: DEV_A.id, displayName: DEV_A.displayName, outcome: "rejected", reason: "BadDeviceToken" },
    ]);
    expect(r.store.get(DEV_A.id)?.lastDelivery).toEqual({
      outcome: "failed",
      at: new Date(START).toISOString(),
      reason: "BadDeviceToken",
    });
    expect(r.calls).toEqual(["logFailed test permanent 400 BadDeviceToken"]);
    expect(r.store.get(DEV_A.id)?.apnsToken).toBe(TOKEN_A);
    expect(notificationCounts()).toEqual({ "test|failed": 1 });
  });

  test("403 InvalidProviderToken → rejected with noteAuthFailed and no retry", async () => {
    const r = await rig([DEV_A]);
    r.client.script(TOKEN_A, status(403, "InvalidProviderToken"));
    const res = await runTestSend({}, r.deps);
    expect(results(res)).toEqual([
      { deviceId: DEV_A.id, displayName: DEV_A.displayName, outcome: "rejected", reason: "InvalidProviderToken" },
    ]);
    expect(r.calls).toEqual([
      "noteAuthFailed 403 InvalidProviderToken",
      "logFailed test auth-failed 403 InvalidProviderToken",
    ]);
    expect(r.client.sent).toHaveLength(1);
    expect(r.store.get(DEV_A.id)?.lastDelivery?.outcome).toBe("failed");
    expect(notificationCounts()).toEqual({ "test|failed": 1 });
  });
});

describe("runTestSend: retries", () => {
  test("500 ×4 → unreachable after fake-timer waits of 1000, 2000 and 4000 ms", async () => {
    const r = await rig([DEV_A]);
    const s500 = status(500, "InternalServerError");
    r.client.script(TOKEN_A, s500, s500, s500, s500);
    const sentAt: number[] = [];
    const send = r.client.send;
    r.client.send = (env, token, req) => {
      sentAt.push(r.clock.nowMs() - START);
      return send(env, token, req);
    };
    const res = await drive(r, runTestSend({}, r.deps));
    expect(results(res)).toEqual([
      { deviceId: DEV_A.id, displayName: DEV_A.displayName, outcome: "unreachable", reason: "InternalServerError" },
    ]);
    expect(r.waits).toEqual([1000, 2000, 4000]);
    expect(sentAt).toEqual([0, 1000, 3000, 7000]);
    expect(r.store.get(DEV_A.id)?.lastDelivery?.outcome).toBe("dropped");
    expect(r.calls).toEqual(["logFailed test transient-exhausted 500 InternalServerError"]);
    expect(notificationCounts()).toEqual({ "test|dropped": 1 });
  });

  test("500 then 200 → delivered after one 1000 ms wait", async () => {
    const r = await rig([DEV_A]);
    r.client.script(TOKEN_A, status(503, "ServiceUnavailable"), OK);
    const res = await drive(r, runTestSend({}, r.deps));
    expect(results(res)[0]?.outcome).toBe("delivered");
    expect(r.waits).toEqual([1000]);
    expect(notificationCounts()).toEqual({ "test|delivered": 1 });
  });

  test("a timeout ×4 gives reason \"timeout\"; a session error ×4 gives \"connection\"", async () => {
    const r = await rig([DEV_A, DEV_B]);
    r.client.script(TOKEN_A, TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT);
    const session: ApnsResult = { kind: "error", error: "session" };
    r.client.script(TOKEN_B, session, session, session, session);
    const res = await drive(r, runTestSend({}, r.deps));
    expect(results(res).map((e) => [e.outcome, e.reason])).toEqual([
      ["unreachable", "timeout"],
      ["unreachable", "connection"],
    ]);
    expect(r.calls).toContain("logFailed test transient-exhausted null timeout");
    expect(notificationCounts()).toEqual({ "test|dropped": 2 });
  });

  test("403 ExpiredProviderToken invalidates the signer and retries; ×4 gives ExpiredProviderToken", async () => {
    const r = await rig([DEV_A]);
    const expired = status(403, "ExpiredProviderToken");
    r.client.script(TOKEN_A, expired, expired, expired, expired);
    const res = await drive(r, runTestSend({}, r.deps));
    expect(results(res)[0]).toEqual({
      deviceId: DEV_A.id,
      displayName: DEV_A.displayName,
      outcome: "unreachable",
      reason: "ExpiredProviderToken",
    });
    expect(r.invalidations.n).toBe(3);
    expect(r.client.sent).toHaveLength(4);
  });

  test("a device removed during a retry wait gives unreachable/unregistered with no further send", async () => {
    const r = await rig([DEV_A]);
    r.client.script(TOKEN_A, status(500, "InternalServerError"));
    const p = runTestSend({}, r.deps);
    await settle();
    expect(r.client.sent).toHaveLength(1);
    expect(await removeDevice(r.store, DEV_A.id, "revoked")).toBe("removed");
    const res = await drive(r, p);
    expect(results(res)).toEqual([
      { deviceId: DEV_A.id, displayName: DEV_A.displayName, outcome: "unreachable", reason: "unregistered" },
    ]);
    expect(r.client.sent).toHaveLength(1);
    expect(notificationCounts()).toEqual({});
  });

  test("the retry re-reads the device and uses its current token and environment", async () => {
    const r = await rig([DEV_A]);
    r.client.script(TOKEN_A, status(500, "InternalServerError"));
    const p = runTestSend({}, r.deps);
    await settle();
    await r.store.mutate((devices) => ({
      kind: "commit",
      devices: devices.map((d) => (d.id === DEV_A.id ? { ...d, apnsToken: TOKEN_C, environment: "production" as const } : d)),
      result: null,
    }));
    const res = await drive(r, p);
    expect(results(res)[0]?.outcome).toBe("delivered");
    expect(r.client.sent.map((s) => [s.environment, s.token])).toEqual([
      ["sandbox", TOKEN_A],
      ["production", TOKEN_C],
    ]);
  });
});

describe("runTestSend: targets", () => {
  test("unknown deviceId → {ok:false, refusal:\"not-found\"} with no send", async () => {
    const r = await rig([DEV_A]);
    expect(await runTestSend({ deviceId: "dev_Unknown0000" }, r.deps)).toEqual({ ok: false, refusal: "not-found" });
    expect(r.client.sent).toHaveLength(0);
  });

  test("no devices → empty results", async () => {
    const r = await rig([]);
    expect(await runTestSend({}, r.deps)).toEqual({ ok: true, result: { results: [] } });
    expect(r.client.sent).toHaveLength(0);
  });

  test("an explicit device with null apnsToken gets unreachable/unregistered and zero sends, no metric", async () => {
    const r = await rig([DEV_NOTOKEN]);
    const res = await runTestSend({ deviceId: DEV_NOTOKEN.id }, r.deps);
    expect(results(res)).toEqual([
      { deviceId: DEV_NOTOKEN.id, displayName: DEV_NOTOKEN.displayName, outcome: "unreachable", reason: "unregistered" },
    ]);
    expect(r.client.sent).toHaveLength(0);
    expect(r.store.get(DEV_NOTOKEN.id)?.lastDelivery).toBeNull();
    expect(notificationCounts()).toEqual({});
  });

  test("all devices: tokenless devices are skipped and results keep store.list() order", async () => {
    const r = await rig([DEV_B, DEV_NOTOKEN, DEV_A]);
    r.client.script(TOKEN_B, status(400, "BadDeviceToken"));
    const res = await runTestSend({}, r.deps);
    expect(results(res).map((e) => [e.deviceId, e.outcome])).toEqual([
      [DEV_B.id, "rejected"],
      [DEV_A.id, "delivered"],
    ]);
  });

  test("an explicit device is the only target", async () => {
    const r = await rig([DEV_A, DEV_B]);
    const res = await runTestSend({ deviceId: DEV_B.id }, r.deps);
    expect(results(res).map((e) => e.deviceId)).toEqual([DEV_B.id]);
    expect(r.client.sent.map((s) => s.token)).toEqual([TOKEN_B]);
  });

  test("all first attempts are sent before any stub response resolves", async () => {
    const r = await rig([DEV_A, DEV_B, DEV_C]);
    r.client.script(TOKEN_A, "hang");
    r.client.script(TOKEN_B, "hang");
    r.client.script(TOKEN_C, "hang");
    const p = runTestSend({}, r.deps);
    await settle();
    expect(r.client.sent.map((s) => s.token)).toEqual([TOKEN_A, TOKEN_B, TOKEN_C]);
    r.client.release(OK);
    const res = await p;
    expect(results(res).map((e) => [e.deviceId, e.outcome])).toEqual([
      [DEV_A.id, "delivered"],
      [DEV_B.id, "delivered"],
      [DEV_C.id, "delivered"],
    ]);
    expect(notificationCounts()).toEqual({ "test|delivered": 3 });
  });

  test("the badge is read once per call", async () => {
    const r = await rig([DEV_A, DEV_B]);
    let reads = 0;
    await runTestSend({}, { ...r.deps, badge: () => ((reads += 1), 2) });
    expect(reads).toBe(1);
  });

  test("the test send never uses the notified memory (no memory dependency or import)", () => {
    const source = readFileSync(new URL("../../src/server/push/test-send.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/memory\.js|NotifiedMemory|\bunmark|dropDevice|\.memory\b/);
  });
});

describe("handleAdminTest", () => {
  test("unknown deviceId → 404 API_NOT_FOUND", async () => {
    const r = await rig([DEV_A]);
    const res = await handleAdminTest(r.deps, { deviceId: "dev_Unknown0000" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("API_NOT_FOUND");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("no devices → 200 {\"results\":[]} with content-type json and cache-control private, no-store", async () => {
    const r = await rig([]);
    const res = await handleAdminTest(r.deps, {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"results":[]}');
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("a device → 200 PushTestResult body", async () => {
    const r = await rig([DEV_A]);
    const res = await handleAdminTest(r.deps, { deviceId: DEV_A.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [{ deviceId: DEV_A.id, displayName: DEV_A.displayName, outcome: "delivered" }],
    });
  });
});
