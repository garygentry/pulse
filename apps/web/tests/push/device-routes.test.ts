// apps/web/tests/push/device-routes.test.ts — the device handler bodies (register/refresh, self-removal, revoke,
// admin list) and the shared removeDevice API, called directly with already-validated input.

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";

import { PUSH_CACHE_CONTROL } from "../../src/server/push/constants.js";
import { handleRegisterDevice, handleRemoveSelf } from "../../src/server/push/handlers/device.js";
import { handleListAdminDevices, handleRevokeDevice } from "../../src/server/push/handlers/devices.js";
import { buildPushStatus, pushStatusResponse } from "../../src/server/push/handlers/status.js";
import type { PushHandlerDeps } from "../../src/server/push/handlers/redeem.js";
import { createPairingService } from "../../src/server/push/pairing.js";
import type { DeviceRecord, DeviceRemovalReason } from "../../src/server/push/registry/schema.js";
import { createDeviceStore, type RegistryStore } from "../../src/server/push/registry/store.js";
import { removeDevice, toDeviceSummary } from "../../src/server/push/registry/summary.js";
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
const TOKEN_A = "a1".repeat(32);
const TOKEN_B = "b2".repeat(32);
const SUMMARY_KEYS = [
  "displayName",
  "environment",
  "id",
  "lastDelivery",
  "pairedAt",
  "preferences",
  "seenAt",
  "tokenSuffix",
];

function device(n: number, overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: `dev_Test${n.toString(36).padStart(7, "0")}`,
    displayName: `Example iPhone ${n}`,
    credentialHash: n.toString(16).padStart(64, "0"),
    apnsToken: null,
    environment: null,
    preferences: { critical: true, warning: true, info: true },
    pairedAt: "2026-10-01T00:00:00.000Z",
    seenAt: "2026-10-01T00:00:00.000Z",
    lastDelivery: null,
    ...overrides,
  };
}

interface Rig {
  readonly fs: MemoryPushFs;
  readonly clock: FakeClock;
  readonly store: RegistryStore;
  readonly deps: PushHandlerDeps;
  readonly removed: Array<[string, DeviceRemovalReason]>;
}

async function rig(devices: readonly DeviceRecord[] = []): Promise<Rig> {
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
    random: createSeededRandom(7),
    maxDevices: 20,
    externalUrl: { state: "unset" },
  });
  const removed: Array<[string, DeviceRemovalReason]> = [];
  store.onRemoved((id, reason) => removed.push([id, reason]));
  return { fs, clock, store, deps: { pairing, store, clock }, removed };
}

function writes(fs: MemoryPushFs): number {
  return fs.calls.filter((c) => c.startsWith("storeWrite ")).length;
}

let logSpy: Mock<typeof console.log>;

function events(name: string): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((args) => JSON.parse(String(args[0])) as Record<string, unknown>)
    .filter((e) => e.event === name);
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

const SECRETS = [TOKEN_A, TOKEN_B, TOKEN_A.toUpperCase(), ...[1, 2, 3].map((n) => n.toString(16).padStart(64, "0"))];

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  // No captured line carries an APNs token or a credential hash.
  for (const args of logSpy.mock.calls) {
    const line = String(args[0]);
    for (const secret of SECRETS) expect(line.includes(secret)).toBe(false);
  }
  logSpy.mockRestore();
  setPushMetricsProvider(null);
  __resetMetricsForTest();
});

async function expectNoStoreJson(res: Response, status: number): Promise<unknown> {
  expect(res.status).toBe(status);
  expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  expect(res.headers.get("Cache-Control")).toBe(PUSH_CACHE_CONTROL);
  return JSON.parse(await res.text());
}

async function expectNoContent(res: Response): Promise<void> {
  expect(res.status).toBe(204);
  expect(res.headers.get("Cache-Control")).toBe(PUSH_CACHE_CONTROL);
  expect([...res.headers.keys()]).toEqual(["cache-control"]);
  expect(await res.text()).toBe("");
}

async function errorCode(res: Response, status: number): Promise<string> {
  const body = (await expectNoStoreJson(res, status)) as { code: string };
  return body.code;
}

describe("PUT /api/push/device", () => {
  test("lower-cases the token, replaces environment and preferences, sets seenAt, returns 200", async () => {
    const d1 = device(1, { apnsToken: TOKEN_B, environment: "sandbox" });
    const { deps, store, clock } = await rig([d1]);
    clock.advance(12_345);
    const res = await handleRegisterDevice(deps, d1.id, {
      apnsToken: TOKEN_A.toUpperCase(),
      environment: "production",
      preferences: { critical: true, warning: false, info: false },
    });
    const seenAt = new Date(START + 12_345).toISOString();
    expect(await expectNoStoreJson(res, 200)).toEqual({
      deviceId: d1.id,
      environment: "production",
      preferences: { critical: true, warning: false, info: false },
      seenAt,
    });
    const stored = store.get(d1.id);
    expect(stored?.apnsToken).toBe(TOKEN_A);
    expect(stored?.environment).toBe("production");
    expect(stored?.preferences).toEqual({ critical: true, warning: false, info: false });
    expect(stored?.seenAt).toBe(seenAt);
    expect(stored?.credentialHash).toBe(d1.credentialHash);
  });

  test("a token failing the pattern after lower-casing is 400 fields apnsToken, no write", async () => {
    const d1 = device(1);
    const { deps, fs } = await rig([d1]);
    const res = await handleRegisterDevice(deps, d1.id, {
      apnsToken: "zz",
      environment: "sandbox",
      preferences: { critical: true, warning: true, info: true },
    });
    const body = (await expectNoStoreJson(res, 400)) as { code: string; details: unknown };
    expect(body.code).toBe("INVALID_REQUEST");
    expect(body.details).toEqual({ fields: "apnsToken" });
    expect(writes(fs)).toBe(0);
  });

  test("device B registering A's token removes A in the same write (superseded)", async () => {
    const a = device(1, { apnsToken: TOKEN_A, environment: "sandbox" });
    const b = device(2);
    const c = device(3, { apnsToken: TOKEN_B, environment: "sandbox" });
    const { deps, store, fs, removed } = await rig([a, b, c]);
    const res = await handleRegisterDevice(deps, b.id, {
      apnsToken: TOKEN_A,
      environment: "sandbox",
      preferences: { critical: true, warning: true, info: true },
    });
    expect(res.status).toBe(200);
    expect(writes(fs)).toBe(1);
    expect(store.list().map((d) => d.id)).toEqual([b.id, c.id]);
    expect(store.get(b.id)?.apnsToken).toBe(TOKEN_A);
    expect(removed).toEqual([[a.id, "superseded"]]);
    expect(events("push_device_removed")).toEqual([
      expect.objectContaining({ event: "push_device_removed", deviceId: a.id, reason: "superseded" }),
    ]);
    expect(pairingCounts()).toEqual(counts({}));
  });

  test("an unknown (already removed) device gets 401 and nothing is written", async () => {
    const { deps, fs } = await rig([device(1)]);
    const res = await handleRegisterDevice(deps, device(9).id, {
      apnsToken: TOKEN_A,
      environment: "sandbox",
      preferences: { critical: true, warning: true, info: true },
    });
    expect(await errorCode(res, 401)).toBe("UNAUTHORIZED");
    expect(writes(fs)).toBe(0);
  });

  test("a write failure gives 503 and leaves the record unchanged", async () => {
    const d1 = device(1);
    const { deps, fs, store } = await rig([d1]);
    fs.failNext("storeWrite", { code: "ENOSPC", step: "rename" });
    const res = await handleRegisterDevice(deps, d1.id, {
      apnsToken: TOKEN_A,
      environment: "sandbox",
      preferences: { critical: true, warning: true, info: true },
    });
    expect(await errorCode(res, 503)).toBe("PUSH_UNAVAILABLE");
    expect(store.get(d1.id)?.apnsToken).toBeNull();
  });
});

describe("revoke racing register", () => {
  const body = {
    apnsToken: TOKEN_A,
    environment: "production" as const,
    preferences: { critical: true, warning: true, info: true },
  };

  test("revoke first: register loses with 401 and the device stays gone", async () => {
    const d1 = device(1);
    const { deps, store } = await rig([d1]);
    const [revoke, register] = await Promise.all([
      handleRevokeDevice(deps, d1.id),
      handleRegisterDevice(deps, d1.id, body),
    ]);
    expect(revoke.status).toBe(204);
    expect(await errorCode(register, 401)).toBe("UNAUTHORIZED");
    expect(store.get(d1.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  test("register first: register succeeds, then revoke removes the device", async () => {
    const d1 = device(1);
    const { deps, store, removed } = await rig([d1]);
    const [register, revoke] = await Promise.all([
      handleRegisterDevice(deps, d1.id, body),
      handleRevokeDevice(deps, d1.id),
    ]);
    expect(register.status).toBe(200);
    expect(revoke.status).toBe(204);
    expect(store.get(d1.id)).toBeUndefined();
    expect(removed).toEqual([[d1.id, "revoked"]]);
  });
});

describe("DELETE /api/push/device", () => {
  test("204, removes the device and fires every onRemoved listener; repeating is still 204", async () => {
    const d1 = device(1, { apnsToken: TOKEN_A, environment: "sandbox" });
    const { deps, store, removed } = await rig([d1, device(2)]);
    const second: string[] = [];
    store.onRemoved((id) => second.push(id));
    await expectNoContent(await handleRemoveSelf(deps, d1.id));
    expect(store.get(d1.id)).toBeUndefined();
    expect(removed).toEqual([[d1.id, "self"]]);
    expect(second).toEqual([d1.id]);
    expect(events("push_device_removed")).toEqual([
      expect.objectContaining({ deviceId: d1.id, reason: "self" }),
    ]);
    expect(pairingCounts()).toEqual(counts({}));
    await expectNoContent(await handleRemoveSelf(deps, d1.id));
    expect(removed.length).toBe(1);
  });

  test("a write failure gives 503 and keeps the device", async () => {
    const d1 = device(1);
    const { deps, fs, store } = await rig([d1]);
    fs.failNext("storeWrite", { code: "EIO", step: "write" });
    expect(await errorCode(await handleRemoveSelf(deps, d1.id), 503)).toBe("PUSH_UNAVAILABLE");
    expect(store.get(d1.id)).toBeDefined();
  });
});

describe("DELETE /api/push/devices/:id and /api/push/admin/devices/:id", () => {
  test("an unknown id and a malformed id give 404 API_NOT_FOUND with no write", async () => {
    const { deps, fs } = await rig([device(1)]);
    const unknown = await handleRevokeDevice(deps, device(9).id);
    const malformed = await handleRevokeDevice(deps, "not-an-id");
    expect(await errorCode(unknown, 404)).toBe("API_NOT_FOUND");
    expect(await errorCode(malformed, 404)).toBe("API_NOT_FOUND");
    expect(writes(fs)).toBe(0);
    expect(pairingCounts()).toEqual(counts({}));
  });

  test("a known id gives 204, logs reason revoked and counts revoked", async () => {
    const d1 = device(1);
    const { deps, store } = await rig([d1, device(2)]);
    await expectNoContent(await handleRevokeDevice(deps, d1.id));
    expect(store.get(d1.id)).toBeUndefined();
    expect(events("push_device_removed")).toEqual([
      expect.objectContaining({ event: "push_device_removed", deviceId: d1.id, reason: "revoked" }),
    ]);
    expect(pairingCounts()).toEqual(counts({ revoked: 1 }));
  });

  test("a write failure gives 503", async () => {
    const d1 = device(1);
    const { deps, fs } = await rig([d1]);
    fs.failNext("storeWrite", { code: "ENOSPC" });
    expect(await errorCode(await handleRevokeDevice(deps, d1.id), 503)).toBe("PUSH_UNAVAILABLE");
  });
});

describe("GET /api/push/admin/devices", () => {
  test("items have exactly the eight DeviceSummary keys, tokenSuffix the last 6 chars or null, in order", async () => {
    const a = device(1, { apnsToken: TOKEN_A, environment: "sandbox" });
    const b = device(2);
    const { deps } = await rig([a, b]);
    const body = (await expectNoStoreJson(handleListAdminDevices(deps), 200)) as {
      devices: Array<Record<string, unknown>>;
    };
    expect(Object.keys(body)).toEqual(["devices"]);
    expect(body.devices.map((d) => d.id)).toEqual([a.id, b.id]);
    for (const item of body.devices) expect(Object.keys(item).sort()).toEqual(SUMMARY_KEYS);
    expect(body.devices[0]?.tokenSuffix).toBe(TOKEN_A.slice(-6));
    expect(body.devices[1]?.tokenSuffix).toBeNull();
    const text = JSON.stringify(body);
    expect(text.includes(TOKEN_A)).toBe(false);
    expect(text.includes(a.credentialHash)).toBe(false);
  });

  test("an empty registry gives {devices: []}", async () => {
    const { deps } = await rig();
    expect(await expectNoStoreJson(handleListAdminDevices(deps), 200)).toEqual({ devices: [] });
  });
});

describe("removeDevice", () => {
  test("dead-token with the matching expectedApnsToken removes and counts removed_dead once", async () => {
    const d1 = device(1, { apnsToken: TOKEN_A, environment: "production" });
    const { store, removed } = await rig([d1]);
    expect(await removeDevice(store, d1.id, "dead-token", { expectedApnsToken: TOKEN_A })).toBe("removed");
    expect(store.get(d1.id)).toBeUndefined();
    expect(removed).toEqual([[d1.id, "dead-token"]]);
    expect(pairingCounts()).toEqual(counts({ removed_dead: 1 }));
    expect(await removeDevice(store, d1.id, "dead-token", { expectedApnsToken: TOKEN_A })).toBe("not-found");
    expect(pairingCounts()).toEqual(counts({ removed_dead: 1 }));
  });

  test("a token that no longer matches gives not-found without writing", async () => {
    const d1 = device(1, { apnsToken: TOKEN_B, environment: "production" });
    const { store, fs } = await rig([d1]);
    expect(await removeDevice(store, d1.id, "dead-token", { expectedApnsToken: TOKEN_A })).toBe("not-found");
    expect(writes(fs)).toBe(0);
    expect(store.get(d1.id)).toBeDefined();
    expect(pairingCounts()).toEqual(counts({}));
  });

  test("without a token guard an unknown id is not-found and a write failure is write-failed", async () => {
    const d1 = device(1);
    const { store, fs } = await rig([d1]);
    expect(await removeDevice(store, "dev_Unknown0000", "revoked")).toBe("not-found");
    fs.failNext("storeWrite", { code: "ENOSPC" });
    expect(await removeDevice(store, d1.id, "revoked")).toBe("write-failed");
    expect(store.get(d1.id)).toBeDefined();
  });
});

describe("buildPushStatus", () => {
  const early = device(1, { pairedAt: "2026-09-01T00:00:00.000Z", apnsToken: TOKEN_A, environment: "production" });
  const late = device(2, { pairedAt: "2026-10-15T12:00:00.000Z" });

  test("configured: devices come back pairedAt ascending as DeviceSummary objects", () => {
    const payload = buildPushStatus({
      state: "configured",
      devices: [late, early].map(toDeviceSummary),
      outstandingExpiresAt: null,
      maxDevices: 20,
    });
    expect(payload.state).toBe("configured");
    expect(payload.devices.map((d) => d.id)).toEqual([early.id, late.id]);
    for (const d of payload.devices) expect(Object.keys(d).sort()).toEqual(SUMMARY_KEYS);
    expect(payload.devices[0]).toEqual(toDeviceSummary(early));
    expect(payload.devices[0]?.tokenSuffix).toBe(TOKEN_A.slice(-6));
    expect(payload.outstanding).toBeNull();
    expect(payload.maxDevices).toBe(20);
  });

  test("configured: outstanding carries only the expiry", () => {
    const expiresAt = "2026-11-01T00:10:00.000Z";
    const payload = buildPushStatus({ state: "configured", devices: [], outstandingExpiresAt: expiresAt, maxDevices: 5 });
    expect(payload.outstanding).toEqual({ expiresAt });
    expect(Object.keys(payload.outstanding ?? {})).toEqual(["expiresAt"]);
  });

  test("misconfigured yields exactly the empty body whatever the inputs", () => {
    const payload = buildPushStatus({
      state: "misconfigured",
      devices: [toDeviceSummary(early)],
      outstandingExpiresAt: "2026-11-01T00:10:00.000Z",
      maxDevices: 20,
    });
    expect(payload).toStrictEqual({ state: "misconfigured", devices: [], outstanding: null, maxDevices: 20 });
  });

  test("pushStatusResponse: 200 JSON with no-store, body parses back to the payload", async () => {
    const payload = buildPushStatus({
      state: "configured",
      devices: [late, early].map(toDeviceSummary),
      outstandingExpiresAt: "2026-11-01T00:10:00.000Z",
      maxDevices: 20,
    });
    const res = pushStatusResponse(payload);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("cache-control")).toBe(PUSH_CACHE_CONTROL);
    expect(JSON.parse(await res.text())).toEqual(JSON.parse(JSON.stringify(payload)));
  });
});
