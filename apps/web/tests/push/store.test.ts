// apps/web/tests/push/store.test.ts — the device registry store: load table, serialised writes, rollback and the
// sticky degraded flag, coalesced soft fields, and removal events (logs, counters, onRemoved listeners).

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@pulse/web-data/cycle";

import {
  DEVICES_FILE_MAX_BYTES,
  createDeviceStore,
  type RegistryStore,
} from "../../src/server/push/registry/store.js";
import type { DeviceRecord, DeviceRemovalReason } from "../../src/server/push/registry/schema.js";
import { PushInvariantError } from "../../src/server/push/refusal.js";
import { PUSH_LIMITS } from "../../src/server/push/constants.js";
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

function device(n: number, overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  const suffix = n.toString(36).padStart(7, "0");
  return {
    id: `dev_Test${suffix}`,
    displayName: `Example iPhone ${n}`,
    credentialHash: n.toString(16).padStart(64, "0"),
    apnsToken: null,
    environment: null,
    preferences: { critical: true, warning: true, info: true },
    pairedAt: "2026-11-01T00:00:00.000Z",
    seenAt: "2026-11-01T00:00:00.000Z",
    lastDelivery: null,
    ...overrides,
  };
}

function fileText(devices: readonly unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ formatVersion: 1, devices, ...extra });
}

interface Rig {
  readonly fs: MemoryPushFs;
  readonly clock: FakeClock;
  readonly timers: FakeTimers;
  readonly store: RegistryStore;
}

async function rig(seed?: Uint8Array | string): Promise<Rig> {
  const fs = memoryPushFs();
  fs.seed("/data/push/.keep", "");
  fs.files.delete("/data/push/.keep");
  if (seed !== undefined) fs.seed(PATH, seed);
  const clock = createFakeClock(START);
  const timers = createFakeTimers(clock);
  const store = await createDeviceStore(PATH, {
    clock,
    timers,
    readFile: fs.storeReadFile,
    writeFile: fs.storeWriteFile,
  });
  return { fs, clock, timers, store };
}

function writes(fs: MemoryPushFs): number {
  return fs.calls.filter((c) => c.startsWith("storeWrite ")).length;
}

const add = (record: DeviceRecord) => (devices: readonly DeviceRecord[]) =>
  ({ kind: "commit", devices: [...devices, record], result: record.id }) as const;

const removeId = (id: string) => (devices: readonly DeviceRecord[]) =>
  ({ kind: "commit", devices: devices.filter((d) => d.id !== id), result: null }) as const;

let logSpy: Mock<typeof console.log>;

function events(): Array<Record<string, unknown>> {
  return logSpy.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
}

function eventsNamed(name: string): Array<Record<string, unknown>> {
  return events().filter((e) => e.event === name);
}

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  __resetMetricsForTest();
});

describe("device store: load", () => {
  test("a missing file loads ok and empty; nothing is written until the first commit", async () => {
    const { fs, timers, store } = await rig();
    expect(store.loadStatus).toBe("ok");
    expect(store.list()).toEqual([]);
    expect(store.writeFailedSticky).toBe(false);
    await store.flushSoft();
    await store.mutate(() => ({ kind: "abort", result: null }));
    timers.runAll();
    expect(writes(fs)).toBe(0);
    expect(fs.files.has(PATH)).toBe(false);

    const result = await store.mutate(add(device(1)));
    expect(result).toEqual({ ok: true, result: device(1).id });
    expect(fs.text(PATH)).toBe(new TextDecoder().decode(canonicalJson({ formatVersion: 1, devices: [device(1)] })));
    expect(fs.files.get(PATH)?.mode).toBe(0o600);
    expect(events()).toEqual([]);
  });

  test("a valid file loads in order and indexes by id and credential hash", async () => {
    const a = device(1);
    const b = device(2, { apnsToken: "ab".repeat(32), environment: "production" });
    const { store } = await rig(fileText([a, b]));
    expect(store.loadStatus).toBe("ok");
    expect(store.list()).toEqual([a, b]);
    expect(store.get(b.id)).toEqual(b);
    expect(store.byCredentialHash(a.credentialHash)).toEqual(a);
    expect(store.get("dev_Unknown0000")).toBeUndefined();
    expect(Object.isFrozen(store.list())).toBe(true);
    expect(Object.isFrozen(store.list()[0])).toBe(true);
  });

  test("the real file is written with mode 0600 by the default writer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pulse-push-store-"));
    try {
      const path = join(dir, "devices.json");
      const clock = createFakeClock(START);
      const store = await createDeviceStore(path, { clock, timers: createFakeTimers(clock) });
      expect(store.loadStatus).toBe("ok");
      expect(existsSync(path)).toBe(false);
      expect((await store.mutate(add(device(1)))).ok).toBe(true);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const reloaded = await createDeviceStore(path, { clock, timers: createFakeTimers(clock) });
      expect(reloaded.list()).toEqual([device(1)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const valid = fileText([device(1)]);
  const CORRUPT: ReadonlyArray<readonly [string, Uint8Array | string | null]> = [
    ["invalid JSON", "{ not json"],
    ["schema failure", fileText([device(1)], { formatVersion: 2 })],
    ["unknown member", fileText([{ ...device(1), credential: "x" }])],
    ["duplicate id", fileText([device(1), device(2, { id: device(1).id })])],
    ["duplicate credentialHash", fileText([device(1), device(2, { credentialHash: device(1).credentialHash })])],
    ["oversize", valid + " ".repeat(DEVICES_FILE_MAX_BYTES)],
    ["invalid UTF-8", new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])],
    ["EACCES read error", null],
  ];

  test.each(CORRUPT)("%s → corrupt, logged, file untouched, mutate write-failed", async (_name, content) => {
    const fs = memoryPushFs();
    fs.seed(PATH, content ?? valid);
    const before = fs.files.get(PATH)?.bytes.slice();
    if (content === null) fs.failNext("readFile", { code: "EACCES" });
    const clock = createFakeClock(START);
    const timers = createFakeTimers(clock);
    const store = await createDeviceStore(PATH, {
      clock,
      timers,
      readFile: fs.storeReadFile,
      writeFile: fs.storeWriteFile,
    });

    expect(store.loadStatus).toBe("corrupt");
    expect(store.list()).toEqual([]);
    expect(store.writeFailedSticky).toBe(false);
    expect(eventsNamed("push_registry_corrupt")).toEqual([
      expect.objectContaining({ event: "push_registry_corrupt", ok: false, path: "devices.json" }),
    ]);

    expect(await store.mutate(add(device(9)))).toEqual({ ok: false, error: "write-failed" });
    store.touchSoft(device(1).id, { seenAt: "2026-11-02T00:00:00.000Z" });
    await store.flushSoft();
    timers.runAll();
    expect(timers.pending()).toBe(0);
    expect(writes(fs)).toBe(0);
    expect(fs.files.get(PATH)?.bytes).toEqual(before as Uint8Array);
    expect(store.writeFailedSticky).toBe(false);
  });

  test("any other read error (EISDIR) is corrupt, not empty", async () => {
    const fs = memoryPushFs();
    fs.failNext("readFile", { code: "EISDIR" });
    const clock = createFakeClock(START);
    const store = await createDeviceStore(PATH, {
      clock,
      timers: createFakeTimers(clock),
      readFile: fs.storeReadFile,
      writeFile: fs.storeWriteFile,
    });
    expect(store.loadStatus).toBe("corrupt");
  });
});

describe("device store: mutate", () => {
  test("abort leaves state untouched and returns the result; a throwing step keeps the chain alive", async () => {
    const { fs, store } = await rig(fileText([device(1)]));
    expect(await store.mutate(() => ({ kind: "abort", result: 7 }))).toEqual({ ok: true, result: 7 });
    await expect(
      store.mutate(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await store.mutate(add(device(2)))).ok).toBe(true);
    expect(store.list().map((d) => d.id)).toEqual([device(1).id, device(2).id]);
    expect(writes(fs)).toBe(1);
  });

  test("steps run one at a time in call order, each seeing the previous commit", async () => {
    const { store } = await rig();
    const seen: number[] = [];
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        store.mutate((devices) => {
          seen.push(devices.length);
          return { kind: "commit", devices: [...devices, device(n)], result: n };
        }),
      ),
    );
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(results.map((r) => (r.ok ? r.result : null))).toEqual([1, 2, 3, 4]);
    expect(store.list()).toHaveLength(4);
  });

  test("a failing writer rolls back, logs, goes sticky once; the next success recovers", async () => {
    const { fs, store } = await rig(fileText([device(1)]));
    const before = fs.files.get(PATH)?.bytes.slice();
    store.touchSoft(device(1).id, { seenAt: "2026-11-03T00:00:00.000Z" });
    fs.failNext("storeWrite", { code: "ENOSPC", step: "rename" });
    fs.failNext("storeWrite", { code: "EIO", step: "fsync" });

    expect(await store.mutate(add(device(2)))).toEqual({ ok: false, error: "write-failed" });
    expect(store.list().map((d) => d.id)).toEqual([device(1).id]);
    expect(store.get(device(2).id)).toBeUndefined();
    expect(store.byCredentialHash(device(2).credentialHash)).toBeUndefined();
    // The taken soft patch was merged back, so reads still show it.
    expect(store.get(device(1).id)?.seenAt).toBe("2026-11-03T00:00:00.000Z");
    expect(store.writeFailedSticky).toBe(true);

    expect(await store.mutate(add(device(3)))).toEqual({ ok: false, error: "write-failed" });
    expect(store.writeFailedSticky).toBe(true);
    expect(fs.files.get(PATH)?.bytes).toEqual(before as Uint8Array);

    const failed = eventsNamed("push_registry_write_failed");
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ ok: false, step: "rename", code: "ENOSPC" });
    expect(failed[1]).toMatchObject({ ok: false, step: "fsync", code: "EIO" });
    expect(eventsNamed("push_registry_degraded")).toHaveLength(1);
    expect(eventsNamed("push_registry_recovered")).toHaveLength(0);

    expect(await store.mutate(add(device(4)))).toEqual({ ok: true, result: device(4).id });
    expect(store.writeFailedSticky).toBe(false);
    expect(eventsNamed("push_registry_recovered")).toEqual([
      expect.objectContaining({ event: "push_registry_recovered", ok: true }),
    ]);
    const onDisk = JSON.parse(fs.text(PATH) ?? "") as { devices: DeviceRecord[] };
    expect(onDisk.devices.map((d) => d.id)).toEqual([device(1).id, device(4).id]);
    expect(onDisk.devices[0]?.seenAt).toBe("2026-11-03T00:00:00.000Z");

    // A further success logs nothing more.
    await store.mutate(add(device(5)));
    expect(eventsNamed("push_registry_recovered")).toHaveLength(1);
    expect(eventsNamed("push_registry_degraded")).toHaveLength(1);
  });

  test("a seeded 200-operation interleaving ends with the file equal to the committed state and no lost update", async () => {
    const { fs, clock, timers, store } = await rig();
    const rng = createSeededRandom(20261120);
    const pick = (n: number): number => Math.floor(rng.unit() * n);

    interface Model {
      regs: number;
      lastTouch: string | null;
    }
    const model = new Map<string, Model>(); // in mutate call order
    const removalScheduled = new Set<string>();
    let nextDevice = 1;
    let touchSeq = 0;
    let inFlight: Array<Promise<unknown>> = [];

    for (let op = 0; op < 200; op++) {
      const kind = pick(10);
      const known = [...model.keys()];
      if (kind < 3 || known.length === 0) {
        const record = device(nextDevice++);
        model.set(record.id, { regs: 0, lastTouch: null });
        inFlight.push(store.mutate(add(record)));
      } else if (kind < 6) {
        const id = known[pick(known.length)] as string;
        const entry = model.get(id) as Model;
        entry.regs += 1;
        inFlight.push(
          store.mutate((devices) => {
            const current = devices.find((d) => d.id === id);
            if (current === undefined) return { kind: "abort", result: "missing" };
            const seenAt = new Date(Date.parse(current.seenAt) + 1).toISOString();
            return {
              kind: "commit",
              devices: devices.map((d) => (d.id === id ? { ...d, seenAt, apnsToken: "cd".repeat(32) } : d)),
              result: "ok",
            };
          }),
        );
      } else if (kind < 7) {
        const id = known[pick(known.length)] as string;
        model.delete(id);
        removalScheduled.add(id);
        inFlight.push(store.mutate(removeId(id), "revoked"));
      } else {
        const live = store.list().filter((d) => !removalScheduled.has(d.id) && model.has(d.id));
        if (live.length > 0) {
          const target = live[pick(live.length)] as DeviceRecord;
          const at = new Date(START + ++touchSeq).toISOString();
          store.touchSoft(target.id, { lastDelivery: { outcome: "delivered", at, reason: null } });
          (model.get(target.id) as Model).lastTouch = at;
        }
      }
      if (pick(4) === 0) {
        await Promise.all(inFlight);
        inFlight = [];
      }
      if (pick(8) === 0) {
        clock.advance(PUSH_LIMITS.softFlushMs);
        timers.runDue();
      }
    }
    await Promise.all(inFlight);
    await store.flushSoft();

    const list = store.list();
    expect(list.map((d) => d.id)).toEqual([...model.keys()]);
    for (const d of list) {
      const entry = model.get(d.id) as Model;
      expect(Date.parse(d.seenAt) - Date.parse(d.pairedAt)).toBe(entry.regs);
      expect(d.lastDelivery?.at ?? null).toBe(entry.lastTouch);
    }
    expect(fs.files.get(PATH)?.bytes).toEqual(canonicalJson({ formatVersion: 1, devices: list }));
    expect(store.writeFailedSticky).toBe(false);
  });
});

describe("device store: soft fields", () => {
  test("ten touchSoft calls within the window cause exactly one write after runDue", async () => {
    const { fs, clock, timers, store } = await rig(fileText([device(1)]));
    for (let i = 0; i < 10; i++) {
      const at = new Date(START + i).toISOString();
      store.touchSoft(device(1).id, { lastDelivery: { outcome: "delivered", at, reason: null } });
      expect(store.get(device(1).id)?.lastDelivery?.at).toBe(at);
      clock.advance(400);
      timers.runDue();
    }
    expect(writes(fs)).toBe(0);
    expect(timers.pending()).toBe(1);
    clock.advance(PUSH_LIMITS.softFlushMs);
    expect(timers.runDue()).toBe(1);
    await store.mutate(() => ({ kind: "abort", result: null }));
    expect(writes(fs)).toBe(1);
    const onDisk = JSON.parse(fs.text(PATH) ?? "") as { devices: DeviceRecord[] };
    expect(onDisk.devices[0]?.lastDelivery?.at).toBe(new Date(START + 9).toISOString());
    expect(timers.pending()).toBe(0);
  });

  test("a hard mutation in the window carries the soft fields; the timer then writes nothing", async () => {
    const { fs, clock, timers, store } = await rig(fileText([device(1)]));
    store.touchSoft(device(1).id, { seenAt: "2026-11-05T00:00:00.000Z" });
    store.touchSoft(device(1).id, { lastDelivery: { outcome: "failed", at: "2026-11-05T00:00:00.000Z", reason: "other" } });
    await store.mutate(add(device(2)));
    expect(writes(fs)).toBe(1);
    const onDisk = JSON.parse(fs.text(PATH) ?? "") as { devices: DeviceRecord[] };
    expect(onDisk.devices[0]).toMatchObject({
      seenAt: "2026-11-05T00:00:00.000Z",
      lastDelivery: { outcome: "failed", reason: "other" },
    });
    clock.advance(PUSH_LIMITS.softFlushMs);
    timers.runDue();
    await store.flushSoft();
    expect(writes(fs)).toBe(1);
  });

  test("flushSoft with nothing pending writes nothing; touching an unknown id is ignored", async () => {
    const { fs, timers, store } = await rig(fileText([device(1)]));
    await store.flushSoft();
    store.touchSoft("dev_Unknown0000", { seenAt: "2026-11-05T00:00:00.000Z" });
    expect(timers.pending()).toBe(0);
    await store.flushSoft();
    expect(writes(fs)).toBe(0);
  });

  test("a failed flush merges back, keeping a newer touch; the next touch re-arms", async () => {
    const { fs, clock, timers, store } = await rig(fileText([device(1)]));
    const id = device(1).id;
    store.touchSoft(id, { seenAt: "2026-11-05T00:00:00.000Z" });
    fs.failNext("storeWrite", { code: "ENOSPC" });
    const flushing = store.flushSoft();
    store.touchSoft(id, { seenAt: "2026-11-06T00:00:00.000Z" }); // newer, during the write
    await flushing;
    expect(store.writeFailedSticky).toBe(true);
    expect(store.get(id)?.seenAt).toBe("2026-11-06T00:00:00.000Z");
    expect(timers.pending()).toBe(1);
    clock.advance(PUSH_LIMITS.softFlushMs);
    timers.runDue();
    await store.mutate(() => ({ kind: "abort", result: null }));
    const onDisk = JSON.parse(fs.text(PATH) ?? "") as { devices: DeviceRecord[] };
    expect(onDisk.devices[0]?.seenAt).toBe("2026-11-06T00:00:00.000Z");
    expect(store.writeFailedSticky).toBe(false);
  });

  test("a touch during a hard write survives it", async () => {
    const { store } = await rig(fileText([device(1)]));
    const id = device(1).id;
    const writing = store.mutate(add(device(2)));
    store.touchSoft(id, { seenAt: "2026-11-07T00:00:00.000Z" });
    await writing;
    expect(store.get(id)?.seenAt).toBe("2026-11-07T00:00:00.000Z");
  });
});

describe("device store: removals", () => {
  test("a removal without a reason rejects with PushInvariantError and writes nothing", async () => {
    const { fs, store } = await rig(fileText([device(1)]));
    store.touchSoft(device(1).id, { seenAt: "2026-11-05T00:00:00.000Z" });
    let caught: unknown;
    await store.mutate(removeId(device(1).id)).catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(PushInvariantError);
    expect(writes(fs)).toBe(0);
    expect(store.get(device(1).id)?.seenAt).toBe("2026-11-05T00:00:00.000Z");
    expect((await store.mutate(add(device(2)))).ok).toBe(true);
  });

  test("onRemoved listeners fire after commit with the reason; a throwing listener does not stop the next", async () => {
    const { fs, store } = await rig(fileText([device(1), device(2), device(3)]));
    const seen: Array<[string, DeviceRemovalReason, boolean, number]> = [];
    store.onRemoved(() => {
      throw new Error("listener failure");
    });
    store.onRemoved((id, reason) => {
      seen.push([id, reason, store.get(id) === undefined, writes(fs)]);
    });
    const removedIds = [device(1).id, device(3).id];
    const result = await store.mutate(
      (devices) => ({ kind: "commit", devices: devices.filter((d) => !removedIds.includes(d.id)), result: null }),
      "superseded",
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      [device(1).id, "superseded", true, 1],
      [device(3).id, "superseded", true, 1],
    ]);
    expect(eventsNamed("push_device_removed")).toEqual([
      expect.objectContaining({ ok: true, deviceId: device(1).id, reason: "superseded" }),
      expect.objectContaining({ ok: true, deviceId: device(3).id, reason: "superseded" }),
    ]);
    const internal = eventsNamed("push_internal_error");
    expect(internal).toHaveLength(2);
    expect(internal[0]).toEqual({ ts: expect.any(String), event: "push_internal_error", ok: false, route: "registry.onRemoved" });
  });

  test("listeners do not fire for a failed write, and unsubscribe is idempotent", async () => {
    const { fs, store } = await rig(fileText([device(1), device(2)]));
    const a: string[] = [];
    const b: string[] = [];
    const listener = (id: string): void => {
      a.push(id);
    };
    const offA = store.onRemoved(listener);
    store.onRemoved(listener); // the same function twice: two registrations
    store.onRemoved((id) => b.push(id));
    fs.failNext("storeWrite", { code: "ENOSPC" });
    expect(await store.mutate(removeId(device(1).id), "revoked")).toEqual({ ok: false, error: "write-failed" });
    expect(a).toEqual([]);
    expect(eventsNamed("push_device_removed")).toHaveLength(0);
    offA();
    offA();
    await store.mutate(removeId(device(1).id), "revoked");
    expect(a).toEqual([device(1).id]);
    expect(b).toEqual([device(1).id]);
  });

  test("removed devices' pending soft patches are discarded", async () => {
    const { fs, store } = await rig(fileText([device(1), device(2)]));
    store.touchSoft(device(1).id, { seenAt: "2026-11-05T00:00:00.000Z" });
    await store.mutate(removeId(device(1).id), "self");
    await store.flushSoft();
    expect(writes(fs)).toBe(1);
    expect(store.list().map((d) => d.id)).toEqual([device(2).id]);
  });

  function pairingCounts(): Record<string, number> {
    setPushMetricsProvider(() => ({ state: "configured", devices: 0, lastSuccessAtMs: null }));
    const out: Record<string, number> = {};
    for (const line of renderMetrics(getRuntimeStatus(), Date.now()).split("\n")) {
      const m = /^pulse_web_push_pairing_events_total\{event="([a-z_]+)"\} (\d+)$/.exec(line);
      if (m !== null) out[m[1] as string] = Number(m[2]);
    }
    return out;
  }

  test("removals count revoked, expired and removed_dead; self and superseded count nothing", async () => {
    const reasons: DeviceRemovalReason[] = ["revoked", "expired", "dead-token", "self", "superseded"];
    const { store } = await rig(fileText(reasons.map((_, i) => device(i + 1))));
    for (const [i, reason] of reasons.entries()) {
      expect((await store.mutate(removeId(device(i + 1).id), reason)).ok).toBe(true);
    }
    const counts = pairingCounts();
    const expected = Object.fromEntries(PUSH_PAIRING_EVENTS.map((e) => [e, 0]));
    expect(counts).toEqual({ ...expected, revoked: 1, expired: 1, removed_dead: 1 });
    expect(eventsNamed("push_device_removed").map((e) => e.reason)).toEqual(reasons);
  });
});
