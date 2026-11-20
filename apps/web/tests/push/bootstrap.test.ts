// Push runtime bootstrap: the disabled, misconfigured and configured builds, capability and metrics providers,
// the partial-build catch-all and the close() order.
//
// Factories are observed through bun's mock.module. Every mock delegates to the real implementation and only
// records calls (or fails on request), so a leak into another suite in the same process changes nothing.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test, type Mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as contractModule from "@pulse/web-data/contract";
import { __resetCapabilityProvidersForTest, currentServerCapabilities } from "@pulse/web-data/contract";

import { loadServerConfig, type ServerConfig } from "../../src/server/config.js";
import * as storeAtomic from "../../src/server/mutations/stores/atomic-file.js";
import * as apnsModule from "../../src/server/push/apns/client.js";
import { PUSH_ENV } from "../../src/server/push/constants.js";
import { NODE_PUSH_FS, type PushFs } from "../../src/server/push/data-dir.js";
import * as queueModule from "../../src/server/push/dispatch/queue.js";
import * as intakeModule from "../../src/server/push/intake.js";
import * as memoryModule from "../../src/server/push/memory.js";
import type { DeviceRecord } from "../../src/server/push/registry/schema.js";
import * as storeModule from "../../src/server/push/registry/store.js";
import * as sweepModule from "../../src/server/push/sweep.js";
import * as routesMetricsModule from "../../src/server/routes/metrics.js";
import { __resetMetricsForTest, renderMetrics } from "../../src/server/routes/metrics.js";
import { getRuntimeStatus, type ServerRuntime } from "../../src/server/refresh.js";
import { amAlert, amNotification } from "./helpers/am-fixtures.js";
import { startFakeApns, type FakeApns } from "./helpers/fake-apns.js";
import { createTestTls } from "./helpers/tls.js";
import { createFakeClock, createFakeTimers, type FakeTimers } from "./helpers/fakes.js";
import { writeTestKeyFile } from "./helpers/keys.js";

// ---------------------------------------------------------------------------------------------------------------
// Delegating module mocks
// ---------------------------------------------------------------------------------------------------------------

/** Ordered record of the close-relevant calls. */
const events: string[] = [];

/** The mocks observe only while this suite runs; otherwise each is a plain passthrough to the real factory. */
let active = false;

const real = {
  createDeviceStore: storeModule.createDeviceStore,
  createNotifiedMemory: memoryModule.createNotifiedMemory,
  createDeviceQueues: queueModule.createDeviceQueues,
  createIntake: intakeModule.createIntake,
  createSweep: sweepModule.createSweep,
  createApnsClient: apnsModule.createApnsClient,
  unregisterCapabilityProvider: contractModule.unregisterCapabilityProvider,
  setPushMetricsProvider: routesMetricsModule.setPushMetricsProvider,
  writeFileAtomic: storeAtomic.writeFileAtomic,
};

/** Per-test controls for the store factory. */
const storeHook: {
  throwNext: boolean;
  failWrites: boolean;
  lastDeps: storeModule.DeviceStoreDeps | null;
  last: storeModule.RegistryStore | null;
  removalSubscribers: number;
} = { throwNext: false, failWrites: false, lastDeps: null, last: null, removalSubscribers: 0 };

/** Per-test controls for the queues. */
const queueHook: { throwOnClose: boolean; monitor: queueModule.DeliveryMonitor | null } = {
  throwOnClose: false,
  monitor: null,
};

/** The last non-null metrics provider installed while the suite is active. */
let lastProvider: (() => routesMetricsModule.PushMetricsSnapshot) | null = null;

/** Recorded memory.dropDevice ids. */
const droppedMemory: string[] = [];

/** A new object whose properties delegate (live) to `target`, except `overrides`. */
function wrap<T extends object>(target: T, overrides: Partial<Record<keyof T, unknown>>): T {
  const out: Record<PropertyKey, unknown> = {};
  const keys = new Set<PropertyKey>([...Reflect.ownKeys(target), ...Object.keys(Object.getPrototypeOf(target) ?? {})]);
  for (const key of keys) {
    if (key in overrides) {
      out[key] = (overrides as Record<PropertyKey, unknown>)[key];
      continue;
    }
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () => {
        const v = Reflect.get(target, key) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }
  return out as T;
}

mock.module("../../src/server/push/registry/store.js", () => ({
  ...storeModule,
  createDeviceStore: async (path: string, deps: storeModule.DeviceStoreDeps) => {
    if (!active) return real.createDeviceStore(path, deps);
    if (storeHook.throwNext) {
      storeHook.throwNext = false;
      throw new Error("sentinel-bootstrap-failure-text");
    }
    storeHook.lastDeps = deps;
    const writeFile: NonNullable<storeModule.DeviceStoreDeps["writeFile"]> = async (p, bytes, options) =>
      storeHook.failWrites
        ? { ok: false, kind: "io", step: "rename", code: "ENOSPC" }
        : (deps.writeFile ?? real.writeFileAtomic)(p, bytes, options);
    const store = await real.createDeviceStore(path, { ...deps, writeFile });
    const wrapped = wrap(store, {
      flushSoft: async () => {
        events.push("flushSoft");
        await store.flushSoft();
      },
      onRemoved: (listener: Parameters<storeModule.RegistryStore["onRemoved"]>[0]) => {
        storeHook.removalSubscribers++;
        return store.onRemoved(listener);
      },
    });
    storeHook.last = wrapped;
    return wrapped;
  },
}));

mock.module("../../src/server/push/memory.js", () => ({
  ...memoryModule,
  createNotifiedMemory: (cap?: number) => {
    if (!active) return real.createNotifiedMemory(cap);
    const memory = real.createNotifiedMemory(cap);
    return wrap(memory, {
      dropDevice: (id: string) => {
        droppedMemory.push(id);
        memory.dropDevice(id);
      },
    });
  },
}));

mock.module("../../src/server/push/dispatch/queue.js", () => ({
  ...queueModule,
  createDeviceQueues: (deps: queueModule.DeviceQueuesDeps, hooks?: queueModule.DeviceQueuesHooks) => {
    const queues = real.createDeviceQueues(deps, hooks);
    if (!active) return queues;
    queueHook.monitor = deps.monitor;
    return wrap(queues, {
      close: () => {
        events.push("queues close");
        if (queueHook.throwOnClose) throw new Error("queues close failed");
        queues.close();
      },
    });
  },
}));

mock.module("../../src/server/push/intake.js", () => ({
  ...intakeModule,
  createIntake: (deps: intakeModule.IntakeDeps) => {
    const intake = real.createIntake(deps);
    if (!active) return intake;
    return wrap(intake, {
      close: () => {
        events.push("intake close");
        intake.close();
      },
    });
  },
}));

mock.module("../../src/server/push/sweep.js", () => ({
  ...sweepModule,
  createSweep: (deps: sweepModule.SweepDeps) => {
    const sweep = real.createSweep(deps);
    if (!active) return sweep;
    return wrap(sweep, {
      close: () => {
        events.push("sweep stop");
        sweep.close();
      },
    });
  },
}));

mock.module("../../src/server/push/apns/client.js", () => ({
  ...apnsModule,
  createApnsClient: (...args: Parameters<typeof apnsModule.createApnsClient>) => {
    const client = real.createApnsClient(...args);
    if (!active) return client;
    return wrap(client, {
      close: async () => {
        events.push("apns close");
        await client.close();
      },
    });
  },
}));

mock.module("@pulse/web-data/contract", () => ({
  ...contractModule,
  unregisterCapabilityProvider: (name: string) => {
    if (active) events.push("capability unregister");
    real.unregisterCapabilityProvider(name);
  },
}));

mock.module("../../src/server/routes/metrics.js", () => ({
  ...routesMetricsModule,
  setPushMetricsProvider: (provider: (() => routesMetricsModule.PushMetricsSnapshot) | null) => {
    if (active && provider === null) events.push("metrics null");
    if (active && provider !== null) lastProvider = provider;
    real.setPushMetricsProvider(provider);
  },
}));

// Imported after the mocks so its own imports bind to them.
const { buildPushRuntime, createDisabledPushRuntime } = await import("../../src/server/push/bootstrap.js");
type PushRuntime = Awaited<ReturnType<typeof buildPushRuntime>>;

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

const engines = {
  PULSE_VM_URL: "http://localhost:8428",
  PULSE_ALERTMANAGER_URL: "http://localhost:9093",
  PULSE_GATUS_URL: "http://localhost:8080",
  PULSE_VMALERT_URL: "http://localhost:8880",
};

const WEBHOOK_SECRET = "w".repeat(20) + "webhook-secret-value";
const OPERATOR_SECRET = "o".repeat(20) + "operator-secret-value";
const KEY_ID = "ABCDE12345";
const TEAM_ID = "TEAM123456";
const TOPIC = "com.example.pulse";

let root: string;
let keyPath: string;
let keyPem: string;
let keyPublic: import("node:crypto").KeyObject;
let caseNo = 0;

beforeAll(() => {
  active = true;
  root = mkdtempSync(join(tmpdir(), "push-bootstrap-"));
  const key = writeTestKeyFile(root);
  keyPath = key.path;
  keyPem = key.pem;
  keyPublic = key.publicKey;
});

afterAll(() => {
  active = false;
  rmSync(root, { recursive: true, force: true });
});

/** A fresh data directory per test. */
function freshDataDir(): string {
  caseNo++;
  return join(root, `data-${caseNo}`);
}

/** Push env with every variable valid, plus overrides (undefined removes). */
function pushEnv(dataDir: string, over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [PUSH_ENV.keyFile]: keyPath,
    [PUSH_ENV.keyId]: KEY_ID,
    [PUSH_ENV.teamId]: TEAM_ID,
    [PUSH_ENV.topic]: TOPIC,
    [PUSH_ENV.webhookSecret]: WEBHOOK_SECRET,
    [PUSH_ENV.operatorSecret]: OPERATOR_SECRET,
    [PUSH_ENV.dataDir]: dataDir,
    ...over,
  };
}

function configFor(env: Record<string, string | undefined>): ServerConfig {
  return loadServerConfig({ ...engines, ...env });
}

/** A PushFs that records every call and can fail one op. */
function recordingFs(fail: { op?: keyof PushFs; code?: string } = {}): PushFs & { calls: string[] } {
  const calls: string[] = [];
  const maybeFail = (op: keyof PushFs): void => {
    if (fail.op === op) {
      const err = new Error("simulated") as Error & { code?: string };
      err.code = fail.code ?? "EACCES";
      throw err;
    }
  };
  return {
    calls,
    mkdir: async (p, o) => {
      calls.push(`mkdir ${p}`);
      maybeFail("mkdir");
      return NODE_PUSH_FS.mkdir(p, o);
    },
    writeFile: async (p, d, o) => {
      calls.push(`writeFile ${p}`);
      maybeFail("writeFile");
      return NODE_PUSH_FS.writeFile(p, d, o);
    },
    unlink: async (p) => {
      calls.push(`unlink ${p}`);
      maybeFail("unlink");
      return NODE_PUSH_FS.unlink(p);
    },
    readFile: async (p) => {
      calls.push(`readFile ${p}`);
      maybeFail("readFile");
      return NODE_PUSH_FS.readFile(p);
    },
  };
}

/** Fake timers that also count every scheduling call by kind. */
function countingTimers(): FakeTimers & { counts: { timeout: number; interval: number } } {
  const clock = createFakeClock(Date.parse("2026-11-20T12:00:00Z"));
  const timers = createFakeTimers(clock);
  const counts = { timeout: 0, interval: 0 };
  return Object.assign(
    wrap(timers, {
      setTimeout: (fn: () => void, ms: number) => {
        counts.timeout++;
        return timers.setTimeout(fn, ms);
      },
      setInterval: (fn: () => void, ms: number) => {
        counts.interval++;
        return timers.setInterval(fn, ms);
      },
    }),
    { counts },
  );
}

function device(id: string, i: number): DeviceRecord {
  return {
    id,
    displayName: `Example iPhone ${i}`,
    credentialHash: i.toString(16).padStart(64, "0"),
    apnsToken: null,
    environment: null,
    preferences: { critical: true, warning: true, info: true },
    pairedAt: "2026-11-20T11:00:00.000Z",
    seenAt: "2026-11-20T11:00:00.000Z",
    lastDelivery: null,
  };
}

function req(method: string, pathname: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${pathname}`, { method, headers });
}

async function dispatch(rt: PushRuntime, method: string, pathname: string, headers?: Record<string, string>) {
  return rt.dispatcher({ request: req(method, pathname, headers), pathname, peerIp: "127.0.0.1" });
}

function metricsText(): string {
  return renderMetrics(getRuntimeStatus(), Date.now());
}

// ---------------------------------------------------------------------------------------------------------------
// Log capture and the shared no-secret assertion
// ---------------------------------------------------------------------------------------------------------------

let logSpy: Mock<(...args: unknown[]) => void>;
let lines: string[];
const runtimes: PushRuntime[] = [];
const onLine: Array<(line: string) => void> = [];

function logged(): Array<Record<string, unknown>> {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}
function eventsNamed(name: string): Array<Record<string, unknown>> {
  return logged().filter((l) => l.event === name);
}

async function build(config: ServerConfig, deps: Parameters<typeof buildPushRuntime>[1] = {}): Promise<PushRuntime> {
  const rt = await buildPushRuntime(config, deps);
  runtimes.push(rt);
  return rt;
}

beforeEach(() => {
  lines = [];
  events.length = 0;
  droppedMemory.length = 0;
  storeHook.throwNext = false;
  storeHook.failWrites = false;
  storeHook.lastDeps = null;
  storeHook.last = null;
  storeHook.removalSubscribers = 0;
  queueHook.throwOnClose = false;
  queueHook.monitor = null;
  lastProvider = null;
  onLine.length = 0;
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    const line = String(args[0]);
    lines.push(line);
    for (const f of onLine) f(line);
  });
});

afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.close();
  logSpy.mockRestore();
  const forbidden = [WEBHOOK_SECRET, OPERATOR_SECRET, keyPem, keyPath, KEY_ID, TEAM_ID, TOPIC, ...keyPem.split("\n").filter((l) => l.length > 16)];
  for (const line of lines) {
    for (const value of forbidden) expect(line.includes(value)).toBe(false);
  }
  __resetCapabilityProvidersForTest();
  __resetMetricsForTest();
});

// ---------------------------------------------------------------------------------------------------------------
// Disabled
// ---------------------------------------------------------------------------------------------------------------

describe("bootstrap: disabled", () => {
  test("returns the inert runtime with no global effect", async () => {
    const fs = recordingFs();
    const timers = countingTimers();
    const rt = await build(configFor({}), { fs, timers });

    expect(rt.state).toBe("disabled");
    expect(await dispatch(rt, "POST", "/api/push/alertmanager")).toBeNull();
    expect(await dispatch(rt, "GET", "/api/push/status")).toBeNull();
    expect(lines).toEqual([]);
    expect(currentServerCapabilities()).toEqual([]);
    expect(fs.calls).toEqual([]);
    expect(timers.counts).toEqual({ timeout: 0, interval: 0 });
    expect(timers.pending()).toBe(0);
    // No provider: the snapshot reads as disabled with no devices or last-success.
    const text = metricsText();
    expect(text).toContain('pulse_web_push_state{state="disabled"} 1');
    expect(text).not.toContain("pulse_web_push_devices");
    expect(text).not.toContain("pulse_web_push_last_success");

    await rt.close();
    expect(metricsText()).toContain('pulse_web_push_state{state="disabled"} 1');
  });

  test("createDisabledPushRuntime is frozen and touches nothing", async () => {
    const rt = createDisabledPushRuntime();
    expect(Object.isFrozen(rt)).toBe(true);
    rt.attachRuntime({} as never);
    await rt.close();
    expect(events).toEqual([]);
    expect(lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Misconfigured
// ---------------------------------------------------------------------------------------------------------------

describe("bootstrap: parse-misconfigured (KEY_ID only)", () => {
  test("warns per reason, serves only the status route, starts nothing", async () => {
    const fs = recordingFs();
    const timers = countingTimers();
    const config = configFor({ [PUSH_ENV.keyId]: KEY_ID });
    expect(config.push.state).toBe("misconfigured");
    const rt = await build(config, { fs, timers });

    expect(rt.state).toBe("misconfigured");
    const warnings = eventsNamed("config_warning").filter((w) => String(w.envVar).startsWith("PULSE_"));
    expect(warnings.map((w) => [w.envVar, w.reason])).toEqual([
      [PUSH_ENV.keyFile, "missing"],
      [PUSH_ENV.teamId, "missing"],
      [PUSH_ENV.topic, "missing"],
      [PUSH_ENV.dataDir, "data-dir-missing"],
    ]);
    for (const w of warnings) {
      expect(Object.keys(w).sort()).toEqual(["envVar", "error", "event", "ok", "reason", "ts"]);
      expect(w.ok).toBe(false);
    }
    expect(eventsNamed("push_started")).toEqual([
      expect.objectContaining({ ok: false, state: "misconfigured", webhook: "off", admin: "off", devices: 0 }),
    ]);

    const status = await dispatch(rt, "GET", "/api/push/status");
    expect(status?.status).toBe(200);
    expect(status?.headers.get("cache-control")).toBe("private, no-store");
    expect(await status?.json()).toEqual({ state: "misconfigured", devices: [], outstanding: null, maxDevices: 20 });

    const put = await dispatch(rt, "PUT", "/api/push/device");
    expect(put?.status).toBe(503);
    expect(((await put?.json()) as { code: string }).code).toBe("PUSH_UNAVAILABLE");

    const webhook = await dispatch(rt, "POST", "/api/push/alertmanager");
    expect(webhook?.status).toBe(503);
    expect(metricsText()).toContain('pulse_web_push_webhook_total{outcome="unavailable"} 1');

    expect(await dispatch(rt, "GET", "/api/overview")).toBeNull();
    expect(fs.calls).toEqual([]); // no probe
    expect(timers.counts).toEqual({ timeout: 0, interval: 0 });
    expect(currentServerCapabilities()).toEqual([]);
    expect(metricsText()).toContain('pulse_web_push_state{state="misconfigured"} 1');
    expect(metricsText()).toContain("pulse_web_push_devices 0");
  });

  test("the status route applies the browser read gate in proxy-header mode", async () => {
    const config = configFor({
      [PUSH_ENV.keyId]: KEY_ID,
      PULSE_WEB_AUTH_MODE: "proxy-header",
      PULSE_WEB_AUTH_HEADER: "X-Forwarded-User",
      PULSE_WEB_TRUSTED_PROXIES: "10.0.0.1/32",
    });
    const rt = await build(config);
    const res = await dispatch(rt, "GET", "/api/push/status");
    expect(res?.status).toBe(403);
  });

  test("dedupe: the same (envVar, reason) is logged once per call", async () => {
    const base = configFor({ [PUSH_ENV.keyId]: KEY_ID });
    const reason = { envVar: PUSH_ENV.keyFile, reason: "missing" as const };
    const config: ServerConfig = { ...base, push: { state: "misconfigured", reasons: [reason, reason, reason] } };
    await build(config);
    expect(eventsNamed("config_warning").filter((w) => w.envVar === PUSH_ENV.keyFile)).toHaveLength(1);
    await build(config);
    expect(eventsNamed("config_warning").filter((w) => w.envVar === PUSH_ENV.keyFile)).toHaveLength(2);
  });
});

describe("bootstrap: probe failure", () => {
  test("an unwritable data directory gives misconfigured with step and code, and no store file", async () => {
    const dataDir = freshDataDir();
    const fs = recordingFs({ op: "mkdir", code: "EACCES" });
    const timers = countingTimers();
    const rt = await build(configFor(pushEnv(dataDir)), { fs, timers });

    expect(rt.state).toBe("misconfigured");
    expect(eventsNamed("config_warning").filter((w) => w.reason === "data-dir-unwritable")).toEqual([
      expect.objectContaining({ envVar: "PULSE_WEB_DATA_DIR", reason: "data-dir-unwritable", step: "mkdir", code: "EACCES" }),
    ]);
    expect(fs.calls.some((c) => c.startsWith("readFile"))).toBe(false);
    expect(() => readFileSync(join(dataDir, "push", "devices.json"))).toThrow();
    expect(currentServerCapabilities()).toEqual([]);
    expect(timers.counts.interval).toBe(0);
  });
});

describe("bootstrap: corrupt registry", () => {
  test("the file is preserved byte for byte and push is misconfigured", async () => {
    const dataDir = freshDataDir();
    mkdirSync(join(dataDir, "push"), { recursive: true });
    const file = join(dataDir, "push", "devices.json");
    const bytes = '{"formatVersion": 1, "devices": [ not json';
    writeFileSync(file, bytes, { mode: 0o600 });
    const timers = countingTimers();

    const rt = await build(configFor(pushEnv(dataDir)), { timers });
    expect(rt.state).toBe("misconfigured");
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(eventsNamed("push_registry_corrupt")).toHaveLength(1);
    expect(eventsNamed("config_warning").filter((w) => w.envVar === "devices.json")).toEqual([
      expect.objectContaining({ envVar: "devices.json", reason: "registry-corrupt" }),
    ]);
    expect(currentServerCapabilities()).toEqual([]);
    expect(timers.counts).toEqual({ timeout: 0, interval: 0 });

    await rt.close();
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Configured
// ---------------------------------------------------------------------------------------------------------------

describe("bootstrap: configured", () => {
  test("advertises push, logs push_started after the providers, starts exactly one interval", async () => {
    const dataDir = freshDataDir();
    const fs = recordingFs();
    const timers = countingTimers();
    const atStart: { caps: readonly string[]; metrics: string } [] = [];
    onLine.push((line) => {
      if (line.includes('"push_started"')) atStart.push({ caps: currentServerCapabilities(), metrics: metricsText() });
    });

    const rt = await build(configFor(pushEnv(dataDir)), { fs, timers });
    expect(rt.state).toBe("configured");
    expect(currentServerCapabilities()).toEqual(["push"]);
    expect(eventsNamed("push_started")).toEqual([
      expect.objectContaining({ ok: true, state: "configured", webhook: "on", admin: "on", devices: 0 }),
    ]);
    expect(atStart).toHaveLength(1);
    expect(atStart[0]?.caps).toEqual(["push"]);
    expect(atStart[0]?.metrics).toContain('pulse_web_push_state{state="configured"} 1');
    expect(timers.counts.interval).toBe(1);
    expect(eventsNamed("config_warning").filter((w) => w.envVar !== undefined)).toEqual([]);

    // The store reads through the injected PushFs.
    await storeHook.lastDeps?.readFile?.(join(dataDir, "push", "devices.json")).catch(() => undefined);
    expect(fs.calls).toContain(`readFile ${join(dataDir, "push", "devices.json")}`);
    expect(fs.calls.filter((c) => c.startsWith("readFile"))).toHaveLength(2);

    expect(metricsText()).toContain("pulse_web_push_devices 0");
    // The configured routes serve push paths and resolve null elsewhere.
    expect((await dispatch(rt, "GET", "/api/push/status"))?.status).toBe(200);
    expect(await dispatch(rt, "GET", "/api/overview")).toBeNull();
  });

  test("row 27 style warnings: unset secrets are logged and the surfaces are off", async () => {
    const dataDir = freshDataDir();
    const config = configFor(
      pushEnv(dataDir, { [PUSH_ENV.webhookSecret]: undefined, [PUSH_ENV.operatorSecret]: "short" }),
    );
    const rt = await build(config, { timers: countingTimers() });
    expect(rt.state).toBe("configured");
    const warnings = eventsNamed("config_warning").filter((w) => String(w.envVar).startsWith("PULSE_PUSH"));
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.error)).toEqual([
      expect.stringContaining("the Alertmanager push webhook is off"),
      expect.stringContaining("remote operator commands (pulse push) are off"),
    ]);
    expect(eventsNamed("push_started")[0]).toMatchObject({ webhook: "off", admin: "off" });
    expect(currentServerCapabilities()).toEqual(["push"]);

    // The webhook surface is off: 503 PUSH_UNAVAILABLE, and push stays advertised.
    const res = await dispatch(rt, "POST", "/api/push/alertmanager", {
      authorization: `Bearer ${WEBHOOK_SECRET}`,
      "content-type": "application/json",
    });
    expect(res?.status).toBe(503);
    expect(((await res?.json()) as { code: string }).code).toBe("PUSH_UNAVAILABLE");
    expect(currentServerCapabilities()).toEqual(["push"]);
  });

  test("a registry write failure removes the capability until the next good write", async () => {
    const dataDir = freshDataDir();
    await build(configFor(pushEnv(dataDir)), { timers: countingTimers() });
    const store = storeHook.last;
    if (store === null) throw new Error("no store");
    expect(currentServerCapabilities()).toEqual(["push"]);

    storeHook.failWrites = true;
    const failed = await store.mutate((d) => ({ kind: "commit", devices: [...d, device("dev_AAAAAAAAAAA", 1)], result: null }));
    expect(failed.ok).toBe(false);
    expect(currentServerCapabilities()).toEqual([]);

    storeHook.failWrites = false;
    const good = await store.mutate((d) => ({ kind: "commit", devices: [...d, device("dev_AAAAAAAAAAA", 1)], result: null }));
    expect(good.ok).toBe(true);
    expect(currentServerCapabilities()).toEqual(["push"]);
    expect(metricsText()).toContain("pulse_web_push_devices 1");
    // Only the store's own lines: one failure, one degraded, one recovered.
    expect(eventsNamed("push_registry_write_failed")).toHaveLength(1);
    expect(eventsNamed("push_registry_degraded")).toHaveLength(1);
    expect(eventsNamed("push_registry_recovered")).toHaveLength(1);
  });

  test("removal wiring: a removed device's queue and memory are dropped exactly once", async () => {
    const dataDir = freshDataDir();
    await build(configFor(pushEnv(dataDir)), { timers: countingTimers() });
    const store = storeHook.last;
    if (store === null) throw new Error("no store");
    // One subscriber: the queues, which drop the FIFO and the notified memory together.
    expect(storeHook.removalSubscribers).toBe(1);

    const id = "dev_BBBBBBBBBBB";
    await store.mutate((d) => ({ kind: "commit", devices: [...d, device(id, 2)], result: null }));
    const removed = await store.mutate((d) => ({ kind: "commit", devices: d.filter((x) => x.id !== id), result: null }), "revoked");
    expect(removed.ok).toBe(true);
    expect(droppedMemory).toEqual([id]);
  });

  test("a throwing store factory gives misconfigured with no capability, timer or message text", async () => {
    const dataDir = freshDataDir();
    const timers = countingTimers();
    storeHook.throwNext = true;
    const rt = await build(configFor(pushEnv(dataDir)), { timers });

    expect(rt.state).toBe("misconfigured");
    const errors = eventsNamed("push_internal_error");
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0] ?? {}).sort()).toEqual(["event", "ok", "route", "ts"]);
    expect(errors[0]?.route).toBe("bootstrap");
    expect(lines.some((l) => l.includes("sentinel-bootstrap-failure-text"))).toBe(false);
    expect(currentServerCapabilities()).toEqual([]);
    expect(timers.pending()).toBe(0);
    expect(timers.counts.interval).toBe(0);
    expect((await dispatch(rt, "GET", "/api/push/status"))?.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------------------------------------------

describe("bootstrap: close()", () => {
  const ORDER = [
    "sweep stop",
    "intake close",
    "queues close",
    "apns close",
    "flushSoft",
    "capability unregister",
    "metrics null",
  ];

  test("runs the steps in the binding order, once", async () => {
    const timers = countingTimers();
    const rt = await build(configFor(pushEnv(freshDataDir())), { timers });
    events.length = 0;

    const first = rt.close();
    const second = rt.close();
    expect(second).toBe(first);
    await first;
    expect(events).toEqual(ORDER);
    expect(currentServerCapabilities()).toEqual([]);
    expect(metricsText()).toContain('pulse_web_push_state{state="disabled"} 1');
    expect(timers.pending()).toBe(0);

    await rt.close();
    expect(events).toEqual(ORDER);

    const status = await dispatch(rt, "GET", "/api/push/status");
    expect(status?.status).toBe(503);
    expect(((await status?.json()) as { code: string }).code).toBe("PUSH_UNAVAILABLE");
    expect(await dispatch(rt, "GET", "/api/overview")).toBeNull();
  });

  test("a throwing queues.close does not stop later steps", async () => {
    const rt = await build(configFor(pushEnv(freshDataDir())), { timers: countingTimers() });
    events.length = 0;
    queueHook.throwOnClose = true;
    await expect(rt.close()).resolves.toBeUndefined();
    expect(events).toEqual(ORDER);
  });

  test("closing an older runtime does not clear a newer runtime's metrics provider", async () => {
    const older = await build(configFor(pushEnv(freshDataDir())), { timers: countingTimers() });
    __resetCapabilityProvidersForTest();
    const newer = await build(configFor({ [PUSH_ENV.keyId]: KEY_ID }));
    await older.close();
    expect(metricsText()).toContain('pulse_web_push_state{state="misconfigured"} 1');
    await newer.close();
    expect(metricsText()).toContain('pulse_web_push_state{state="disabled"} 1');
  });

  test("the misconfigured runtime's close only unregisters the providers", async () => {
    const rt = await build(configFor({ [PUSH_ENV.keyId]: KEY_ID }));
    events.length = 0;
    await rt.close();
    expect(events).toEqual(["capability unregister", "metrics null"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Configured routes end to end (real clock and timers, fake APNs)
// ---------------------------------------------------------------------------------------------------------------

const tls = createTestTls();
const APNS_TOKEN = "ab".repeat(32);

describe.skipIf(tls === null)(`bootstrap: configured routes${tls === null ? " (skipped: openssl missing)" : ""}`, () => {
  let fake: FakeApns | null = null;

  afterEach(async () => {
    await fake?.close();
    fake = null;
  });

  async function call(rt: PushRuntime, method: string, pathname: string, headers: Record<string, string>, body?: unknown) {
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await rt.dispatcher({ request: new Request(`http://localhost${pathname}`, init), pathname, peerIp: "127.0.0.1" });
    if (res === null) throw new Error(`no push answer for ${method} ${pathname}`);
    return res;
  }

  const JSON_TYPE = { "content-type": "application/json" };

  /** Start the fake, build a configured runtime against it, pair and register one device. */
  async function pairedRuntime(): Promise<{ rt: PushRuntime; fake: FakeApns }> {
    if (tls === null) throw new Error("unreachable");
    const started = await startFakeApns({ tls, providerPublicKey: keyPublic });
    fake = started;
    const rt = await build(configFor(pushEnv(freshDataDir())), { apns: { origins: started.origins, ca: started.ca } });
    expect(rt.state).toBe("configured");

    const issued = await call(rt, "POST", "/api/push/admin/pairing-tokens", {
      ...JSON_TYPE,
      authorization: `Bearer ${OPERATOR_SECRET}`,
    }, { baseUrl: "https://pulse.example.com" });
    expect(issued.status).toBe(201);
    const { link } = (await issued.json()) as { link: string };
    const token = new URLSearchParams(link.slice(link.indexOf("?") + 1)).get("pair");
    if (token === null) throw new Error("no pair token");

    const redeemed = await call(rt, "POST", "/api/push/pairings/redeem", JSON_TYPE, { token, displayName: "Example iPhone" });
    expect(redeemed.status).toBe(201);
    const { credential } = (await redeemed.json()) as { credential: string };

    const registered = await call(rt, "PUT", "/api/push/device", { ...JSON_TYPE, authorization: `Bearer ${credential}` }, {
      apnsToken: APNS_TOKEN,
      environment: "sandbox",
      preferences: { critical: true, warning: true, info: true },
    });
    expect(registered.status).toBe(200);
    return { rt, fake: started };
  }

  async function sendWebhook(rt: PushRuntime): Promise<void> {
    const res = await call(rt, "POST", "/api/push/alertmanager", {
      ...JSON_TYPE,
      authorization: `Bearer ${WEBHOOK_SECRET}`,
    }, amNotification({ alerts: [amAlert({ severity: "critical" })] }));
    expect(res.status).toBe(202);
  }

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await Bun.sleep(10);
    }
  }

  test("metrics snapshot: devices follows the redeem, lastSuccessAtMs follows a fake-APNs delivery", async () => {
    const { rt, fake: apns } = await pairedRuntime();
    const provider = lastProvider;
    if (provider === null || queueHook.monitor === null) throw new Error("no provider or monitor");
    expect(provider()).toMatchObject({ state: "configured", devices: 1, lastSuccessAtMs: null });

    await sendWebhook(rt);
    const monitor = queueHook.monitor;
    await waitFor(() => apns.requests.length === 1 && monitor.lastSuccessAtMs() !== null, "delivery");
    const snapshot = provider();
    expect(snapshot.lastSuccessAtMs).not.toBeNull();
    expect(snapshot.lastSuccessAtMs).toBe(monitor.lastSuccessAtMs());
    expect(snapshot.devices).toBe(1);
    expect(metricsText()).toContain("pulse_web_push_last_success_timestamp_seconds");
  }, 15_000);

  test("attachRuntime: a notification planned after attachRuntime carries the badge; before, none", async () => {
    const { rt, fake: apns } = await pairedRuntime();

    await sendWebhook(rt);
    await waitFor(() => apns.requests.length === 1, "first delivery");
    const before = apns.requests[0]?.body as { aps: Record<string, unknown> };
    expect("badge" in before.aps).toBe(false);

    rt.attachRuntime(badgeRuntime(4));
    // A resolution for the same alert is a new notification that is always sent.
    const res = await call(rt, "POST", "/api/push/alertmanager", {
      ...JSON_TYPE,
      authorization: `Bearer ${WEBHOOK_SECRET}`,
    }, amNotification({ alerts: [amAlert({ severity: "critical", status: "resolved" })] }));
    expect(res.status).toBe(202);
    await waitFor(() => apns.requests.length === 2, "second delivery");
    const after = apns.requests[1]?.body as { aps: Record<string, unknown> };
    expect(after.aps.badge).toBe(4);
  }, 15_000);
});

/** A ServerRuntime stub exposing only what the badge source reads, with `alerts` current alerts. */
function badgeRuntime(alerts: number): ServerRuntime {
  const cycle = {
    observation: { sources: { "alertmanager-alerts": { state: "current" } } },
    overview: { value: { alerts: Array.from({ length: alerts }, (_, i) => ({ fingerprint: String(i) })) } },
  };
  const stub = {
    getContext: () => ({ cycle }),
    getStatus: () => ({ model: { loaded: true, formatVersion: 2, error: null } }),
  };
  return stub as unknown as ServerRuntime;
}

// ---------------------------------------------------------------------------------------------------------------
// In-process server harness self-test (the composition the CLI smoke and e2e suites build on)
// ---------------------------------------------------------------------------------------------------------------

describe.skipIf(tls === null)(`push server harness${tls === null ? " (skipped: openssl missing)" : ""}`, () => {
  test("pair → register → webhook gives one fake-APNs receipt; close() stops the listener", async () => {
    // Loaded lazily so the module mocks above are in place before the bootstrap module graph is evaluated.
    const { startPushTestServer } = await import("./helpers/push-server.js");
    const server = await startPushTestServer();
    let closed = false;
    try {
      expect(server.runtime.state).toBe("configured");
      expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const { link, token } = await server.pair();
      expect(new URL(link).searchParams.get("url")).toBe("https://pulse.example.com");
      expect(link).toContain(token);
      const { deviceId, credential } = await server.register(link);
      expect(deviceId).toMatch(/^dev_/);
      expect(credential.length).toBe(43);

      const res = await server.webhook(amNotification({ alerts: [amAlert({ severity: "critical" })] }));
      expect(res.status).toBe(202);
      const deadline = Date.now() + 5000;
      while (server.apns.requests.length === 0 && Date.now() < deadline) await Bun.sleep(10);
      await Bun.sleep(50);
      expect(server.apns.requests).toHaveLength(1);
      expect(server.apns.requests[0]?.jwtValid).toBe(true);
      expect(server.apns.requests[0]?.environment).toBe("sandbox");

      // The real listener serves the same handler.
      const status = await fetch(`${server.baseUrl}/api/push/status`);
      expect(status.status).toBe(200);
      expect(((await status.json()) as { devices: unknown[] }).devices).toHaveLength(1);

      const baseUrl = server.baseUrl;
      await server.close();
      closed = true;
      let refused = false;
      try {
        await fetch(`${baseUrl}/healthz`);
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    } finally {
      if (!closed) await server.close();
    }
  }, 20_000);
});
