// apps/web/tests/push/intake.test.ts — the serial webhook intake under fake timers, with a recording queue fake and a
// real notified memory.

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";

import type { DeviceQueues } from "../../src/server/push/dispatch/queue.js";
import { createIntake, type Intake } from "../../src/server/push/intake.js";
import { createNotifiedMemory, type NotifiedMemory } from "../../src/server/push/memory.js";
import type { PlannedNotification } from "../../src/server/push/plan.js";
import type { DeviceRecord } from "../../src/server/push/registry/schema.js";
import type { DeviceStore } from "../../src/server/push/registry/store.js";
import { getRuntimeStatus } from "../../src/server/refresh.js";
import { __resetMetricsForTest, renderMetrics, setPushMetricsProvider } from "../../src/server/routes/metrics.js";
import { amAlert, amNotification } from "./helpers/am-fixtures.js";
import { createFakeClock, createFakeTimers, type FakeClock, type FakeTimers } from "./helpers/fakes.js";

const START = Date.parse("2026-11-20T10:00:00.000Z");
const D = "dev_AAAAAAAAAAA";
const E = "dev_BBBBBBBBBBB";

function fp(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function device(id: string, prefs = { critical: true, warning: true, info: true }): DeviceRecord {
  return {
    id,
    displayName: "Example iPhone",
    credentialHash: "0".repeat(64),
    apnsToken: "ab".repeat(32),
    environment: "sandbox",
    preferences: prefs,
    pairedAt: "2026-01-01T00:00:00.000Z",
    seenAt: "2026-01-01T00:00:00.000Z",
    lastDelivery: null,
  };
}

interface Rig {
  readonly intake: Intake;
  readonly timers: FakeTimers;
  readonly clock: FakeClock;
  readonly memory: NotifiedMemory;
  /** Every enqueue call, in order, with the memory size per device at the time of the call. */
  readonly enqueued: PlannedNotification[][];
  /** Ordered trace of store reads and enqueue calls. */
  readonly trace: string[];
  devices: DeviceRecord[];
  badge: number | null;
  listThrows: boolean;
}

function rig(devices: DeviceRecord[] = [device(D)]): Rig {
  const clock = createFakeClock(START);
  const timers = createFakeTimers(clock);
  const memory = createNotifiedMemory();
  const enqueued: PlannedNotification[][] = [];
  const trace: string[] = [];
  const state = { devices, badge: 2 as number | null, listThrows: false };
  const store = {
    list: () => {
      trace.push("list");
      if (r.listThrows) throw new Error("store exploded");
      return r.devices;
    },
  } as unknown as DeviceStore;
  const queues: DeviceQueues = {
    enqueue: (items) => {
      trace.push(`enqueue:${items.length}`);
      enqueued.push([...items]);
    },
    drop: () => undefined,
    idle: async () => undefined,
    close: () => undefined,
  };
  const intake = createIntake({ store, memory, queues, badge: () => r.badge, clock, timers });
  const r: Rig = { intake, timers, clock, memory, enqueued, trace, ...state };
  return r;
}

let logSpy: Mock<typeof console.log>;

function events(name: string): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((args) => JSON.parse(String(args[0])) as Record<string, unknown>)
    .filter((e) => e.event === name);
}

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  setPushMetricsProvider(null);
  __resetMetricsForTest();
});

describe("createIntake", () => {
  test("submit schedules one zero-delay drain and never plans", () => {
    const r = rig();
    r.intake.submit(amNotification());
    r.intake.submit(amNotification());
    expect(r.intake.pending()).toBe(2);
    expect(r.timers.pending()).toBe(1);
    expect(r.trace).toEqual([]);
  });

  test("three submits are planned in order, one per timer step, each enqueued before the next is planned", () => {
    const r = rig();
    const calls = [1, 2, 3].map((n) => amNotification({ alerts: [amAlert({ fingerprint: fp(n), name: `Alert${n}` })] }));
    for (const n of calls) r.intake.submit(n);

    for (let step = 1; step <= 3; step += 1) {
      expect(r.timers.step()).toBe(true);
      expect(r.intake.pending()).toBe(3 - step);
      expect(r.enqueued.length).toBe(step);
      expect(r.timers.pending()).toBe(step < 3 ? 1 : 0);
    }
    expect(r.trace).toEqual(["list", "enqueue:1", "list", "enqueue:1", "list", "enqueue:1"]);
    expect(r.enqueued.map((items) => items[0]!.collapseId)).toEqual([`a-${fp(1)}`, `a-${fp(2)}`, `a-${fp(3)}`]);
  });

  test("a firing in call 1 precedes the resolution in call 2 for the same device", () => {
    const r = rig([device(D), device(E)]);
    r.intake.submit(amNotification({ alerts: [amAlert({ fingerprint: fp(7) })] }));
    r.intake.submit(amNotification({ alerts: [amAlert({ fingerprint: fp(7), status: "resolved" })] }));
    r.timers.runAll();
    const flat = r.enqueued.flat();
    for (const id of [D, E]) {
      const kinds = flat.filter((p) => p.deviceId === id).map((p) => p.kind);
      expect(kinds).toEqual(["firing", "resolved"]);
    }
    expect(r.enqueued.length).toBe(2);
  });

  test("devices, badge and clock are read at plan time, not at submit time", () => {
    const r = rig([device(D)]);
    r.intake.submit(amNotification({ alerts: [amAlert({ fingerprint: fp(1) })] }));
    // Change everything between submit and drain.
    r.devices = [device(E)];
    r.badge = 9;
    r.clock.advance(60_000);
    r.timers.runDue();
    const items = r.enqueued.flat();
    expect(items.map((p) => p.deviceId)).toEqual([E]);
    expect(items[0]!.payload.aps.badge).toBe(9);
    expect(r.memory.isMarked(E, fp(1))).toBe(true);
    expect(r.memory.isMarked(D, fp(1))).toBe(false);
    expect(items[0]!.expiration).toBeGreaterThan(Math.floor((START + 60_000) / 1000));
  });

  test("filtered alerts are counted per kind and nothing is enqueued for an all-muted device", () => {
    const r = rig([device(D, { critical: false, warning: false, info: false })]);
    r.intake.submit(amNotification({ alerts: [amAlert({ fingerprint: fp(1) }), amAlert({ fingerprint: fp(2) })] }));
    r.timers.runDue();
    expect(r.enqueued).toEqual([]);
    setPushMetricsProvider(() => ({ state: "configured", devices: 1, lastSuccessAtMs: null }));
    const text = renderMetrics(getRuntimeStatus(), Date.now());
    expect(text).toContain('pulse_web_push_notifications_total{kind="firing",outcome="filtered"} 2');
  });

  test("a throwing planner logs push_internal_error {route: intake} and the next call is still planned", () => {
    const r = rig();
    r.intake.submit(amNotification({ alerts: [amAlert({ fingerprint: fp(1) })] }));
    r.intake.submit(amNotification({ alerts: [amAlert({ fingerprint: fp(2) })] }));
    r.listThrows = true;
    r.timers.step();
    expect(r.enqueued).toEqual([]);
    const errors = events("push_internal_error");
    expect(errors.length).toBe(1);
    expect(Object.keys(errors[0]!).sort()).toEqual(["event", "ok", "route", "ts"]);
    expect(errors[0]).toMatchObject({ ok: false, route: "intake" });
    expect(String(logSpy.mock.calls[0]?.[0])).not.toContain("store exploded");

    r.listThrows = false;
    expect(r.timers.pending()).toBe(1);
    r.timers.step();
    expect(r.enqueued.flat().map((p) => p.collapseId)).toEqual([`a-${fp(2)}`]);
  });

  test("idle resolves once the FIFO is drained", async () => {
    const r = rig();
    await r.intake.idle();
    r.intake.submit(amNotification());
    let done = false;
    const wait = r.intake.idle().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    r.timers.runAll();
    await wait;
    expect(done).toBe(true);
  });

  test("close cancels the scheduled drain, discards pending calls and makes submit a no-op", async () => {
    const r = rig();
    r.intake.submit(amNotification());
    r.intake.submit(amNotification());
    expect(r.timers.pending()).toBe(1);
    r.intake.close();
    expect(r.timers.pending()).toBe(0);
    expect(r.intake.pending()).toBe(0);
    await r.intake.idle();

    r.intake.submit(amNotification());
    expect(r.intake.pending()).toBe(0);
    expect(r.timers.pending()).toBe(0);
    r.timers.runAll();
    expect(r.trace).toEqual([]);
    expect(r.enqueued).toEqual([]);
    r.intake.close();
  });
});
