// Push route table and dispatcher through the real router: the seam and pre-feature compatibility, the dispatcher by
// state, check order, 405s, exceptions, response finishing, bundle-error mode, metric labels and the refusal
// vocabulary. No port is bound: `dispatch` and `createFetchHandler` are called directly.

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetCapabilityProvidersForTest, buildConnectLink } from "@pulse/web-data/contract";
import type { IdentityConfig } from "@pulse/web-data/identity";

import type { StaticAssets } from "../../src/server/assets.js";
import { loadServerConfig, UNSET_EXTERNAL_URL, type ExternalUrlState, type ServerConfig } from "../../src/server/config.js";
import { createMutationDispatcher } from "../../src/server/mutations/dispatcher.js";
import { createMutationRegistry } from "../../src/server/mutations/registry.js";
import { createProviderTokenSigner } from "../../src/server/push/apns/jwt.js";
import type { ApnsClient } from "../../src/server/push/apns/client.js";
import {
  buildPushRuntime,
  createDisabledPushRuntime,
  type ConfiguredPushServices,
  type MisconfiguredPushServices,
  type PushServices,
} from "../../src/server/push/bootstrap.js";
import { PUSH_ENV, PUSH_LIMITS } from "../../src/server/push/constants.js";
import { createDeliveryMonitor, type DeviceQueues } from "../../src/server/push/dispatch/queue.js";
import type { Intake } from "../../src/server/push/intake.js";
import { createNotifiedMemory } from "../../src/server/push/memory.js";
import { createPairingService, type PairingServiceDeps } from "../../src/server/push/pairing.js";
import { PUSH_REFUSAL_POLICY, type PushRefusal } from "../../src/server/push/refusal.js";
import type { DeviceRecord } from "../../src/server/push/registry/schema.js";
import { createDeviceStore, type RegistryStore } from "../../src/server/push/registry/store.js";
import { createPushDispatcher, isPushAnswer, PUSH_ROUTES } from "../../src/server/push/routes.js";
import { hashCredential, loadPushSecret, type PushSecret } from "../../src/server/push/secrets.js";
import type { ServerContext } from "../../src/shared/registry.js";
import type { RuntimeStatus, ServerRuntime } from "../../src/server/refresh.js";
import { getRuntimeStatus } from "../../src/server/refresh.js";
import {
  createFetchHandler,
  dispatch,
  dispatchMutation,
  type MutationDispatcher,
  type RequestServices,
} from "../../src/server/router.js";
import { errorFor } from "../../src/server/routes/respond.js";
import { __resetMetricsForTest, renderMetrics, setPushMetricsProvider } from "../../src/server/routes/metrics.js";
import { amAlert, amNotification } from "./helpers/am-fixtures.js";
import { createFakeClock, createFakeTimers, createSeededRandom, memoryPushFs } from "./helpers/fakes.js";
import { createTestApnsKey, writeTestKeyFile } from "./helpers/keys.js";

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

const START = Date.parse("2026-11-20T12:00:00.000Z");
const ORIGIN = "http://localhost";
const WEBHOOK_TEXT = "w".repeat(24) + "-webhook-secret-text";
const OPERATOR_TEXT = "o".repeat(24) + "-operator-secret-text";
const CREDENTIAL = "C".repeat(43);
const DEVICE_ID = "dev_AAAAAAAAAAA";
const APNS_TOKEN = "ab".repeat(32);

const NONE_IDENTITY: IdentityConfig = { mode: "none", headerName: "Remote-User", trustedProxies: [] };
/** Proxy-header mode whose trusted range excludes the loopback peer the tests use. */
const PROXY_UNTRUSTED: IdentityConfig = { mode: "proxy-header", headerName: "Remote-User", trustedProxies: ["10.0.0.0/8"] };
/** Proxy-header mode trusting the loopback peer. */
const PROXY_TRUSTED: IdentityConfig = { mode: "proxy-header", headerName: "Remote-User", trustedProxies: ["127.0.0.1/32"] };

const PEER = "127.0.0.1";
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };
const JSON_TYPE = { "content-type": "application/json" };

const stubAssets: StaticAssets = {
  get: () => undefined,
  shell: () => "<!doctype html><div id=app></div>",
};

function secret(text: string): PushSecret {
  const r = loadPushSecret({ S: text }, "S");
  if (!r.ok) throw new Error("test secret refused");
  return r.secret;
}

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: DEVICE_ID,
    displayName: "Example iPhone",
    credentialHash: hashCredential(CREDENTIAL),
    apnsToken: APNS_TOKEN,
    environment: "sandbox",
    preferences: { critical: true, warning: true, info: true },
    pairedAt: "2026-11-20T11:00:00.000Z",
    seenAt: "2026-11-20T11:00:00.000Z",
    lastDelivery: null,
    ...overrides,
  };
}

/** A runtime stub: identity config, a settable model error, no cycle. */
function fakeRuntime(identityConfig: IdentityConfig, modelError: unknown = null): ServerRuntime {
  const status = (): RuntimeStatus =>
    ({
      sources: {},
      model: { loaded: modelError === null, formatVersion: 1, error: modelError },
      lastSnapshotAt: null,
    }) as unknown as RuntimeStatus;
  const ctx = Object.freeze({ estate: null, cycle: null, identity: null, snapshot: null }) as unknown as ServerContext;
  return {
    getContext: () => ctx,
    identityConfig,
    getStatus: status,
    runOnce: async () => {},
    start: async () => {},
    close: () => {},
  } as unknown as ServerRuntime;
}

const BUNDLE_ERROR = Object.freeze({ code: "ESTATE_BUNDLE_INVALID", kind: "parse", path: "estate.json", message: "bad" });

/** The real mutation dispatcher in proxy-header mode with an empty registry (no push path is ever registered). */
function realMutationDispatcher(identityConfig: IdentityConfig): MutationDispatcher {
  return createMutationDispatcher({
    identityConfig,
    getRuntime: () => null,
    registry: createMutationRegistry("proxy-header"),
    audit: {} as never,
    writePath: {} as never,
    idempotency: {} as never,
  });
}

function usableExternalUrl(): ExternalUrlState {
  const built = buildConnectLink("https://pulse.example.com");
  if (!built.ok) throw new Error("placeholder address must build");
  return { state: "usable", baseUrl: built.baseUrl, link: built.link };
}

interface Rig {
  readonly services: ConfiguredPushServices;
  readonly store: RegistryStore;
  readonly submitted: unknown[];
  readonly flags: { throwIssue: boolean; throwSubmit: boolean };
  readonly apnsSends: string[];
}

interface RigOptions {
  readonly identity?: IdentityConfig;
  readonly webhook?: "on" | "off";
  readonly admin?: "on" | "off";
  readonly maxDevices?: number;
  readonly devices?: readonly DeviceRecord[];
  readonly externalUrl?: ExternalUrlState;
  readonly limits?: PairingServiceDeps["limits"];
}

async function rig(opts: RigOptions = {}): Promise<Rig> {
  const fs = memoryPushFs();
  const path = "/data/push/devices.json";
  fs.seed(path, JSON.stringify({ formatVersion: 1, devices: opts.devices ?? [] }));
  const clock = createFakeClock(START);
  const timers = createFakeTimers(clock);
  const random = createSeededRandom(11);
  const store = await createDeviceStore(path, { clock, timers, readFile: fs.storeReadFile, writeFile: fs.storeWriteFile });
  const flags = { throwIssue: false, throwSubmit: false };
  const realPairing = createPairingService({
    store,
    clock,
    random,
    maxDevices: opts.maxDevices ?? 20,
    externalUrl: opts.externalUrl ?? UNSET_EXTERNAL_URL,
    ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
  });
  const pairing = {
    ...realPairing,
    issue: (...args: Parameters<typeof realPairing.issue>) => {
      if (flags.throwIssue) throw new Error("sentinel handler failure text");
      return realPairing.issue(...args);
    },
    cancelWeb: () => realPairing.cancelWeb(),
    redeem: (b: Parameters<typeof realPairing.redeem>[0]) => realPairing.redeem(b),
    outstandingWeb: () => realPairing.outstandingWeb(),
    gc: () => realPairing.gc(),
  };
  const submitted: unknown[] = [];
  const intake: Intake = {
    submit: (n) => {
      if (flags.throwSubmit) throw new Error("sentinel intake failure text");
      submitted.push(n);
    },
    pending: () => 0,
    idle: async () => {},
    close: () => {},
  };
  const apnsSends: string[] = [];
  const apns: ApnsClient = {
    send: async (_env, token) => {
      apnsSends.push(token);
      return { kind: "response", status: 200, reason: null };
    },
    close: async () => {},
  };
  const key = createTestApnsKey();
  const { createPrivateKey } = await import("node:crypto");
  const signer = createProviderTokenSigner(createPrivateKey(key.pem), "ABCDE12345", "TEAM123456", clock);
  const externalUrl: ExternalUrlState = opts.externalUrl ?? UNSET_EXTERNAL_URL;
  const webhook = opts.webhook ?? "on";
  const admin = opts.admin ?? "on";
  const services: ConfiguredPushServices = Object.freeze({
    state: "configured",
    identity: opts.identity ?? NONE_IDENTITY,
    externalUrl,
    maxDevices: opts.maxDevices ?? 20,
    webhook,
    admin,
    webhookSecret: webhook === "on" ? secret(WEBHOOK_TEXT) : null,
    operatorSecret: admin === "on" ? secret(OPERATOR_TEXT) : null,
    topic: "com.example.pulse",
    store,
    pairing,
    memory: createNotifiedMemory(),
    queues: {} as DeviceQueues,
    apns,
    signer,
    monitor: createDeliveryMonitor({ clock }),
    intake,
    getRuntime: () => null,
    clock,
    random,
    timers,
  });
  return { services, store, submitted, flags, apnsSends };
}

const MISCONFIGURED: MisconfiguredPushServices = Object.freeze({
  state: "misconfigured",
  identity: NONE_IDENTITY,
  maxDevices: PUSH_LIMITS.defaultMaxDevices,
});

interface CallInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array;
}

function request(pathname: string, init: CallInit = {}): Request {
  const r: RequestInit = { method: init.method ?? "GET" };
  if (init.headers !== undefined) r.headers = init.headers;
  if (init.body !== undefined) r.body = init.body as BodyInit;
  return new Request(`${ORIGIN}${pathname}`, r);
}

/** Dispatch through the real router with a push dispatcher built from `services`. */
async function call(
  services: PushServices,
  pathname: string,
  init: CallInit = {},
  runtime: ServerRuntime = fakeRuntime(services.identity),
): Promise<Response> {
  const req = request(pathname, init);
  return dispatch(req, pathname, runtime, stubAssets, svc(), dispatchMutation, createPushDispatcher(services));
}

function svc(peerIp: string | null = PEER): RequestServices {
  return { peerIp, disableTimeout() {} };
}

const operator = { authorization: `Bearer ${OPERATOR_TEXT}` };
const webhookAuth = { authorization: `Bearer ${WEBHOOK_TEXT}` };
const deviceAuth = { authorization: `Bearer ${CREDENTIAL}` };

async function bodyOf(res: Response): Promise<{ code: string; message: string; details?: Record<string, unknown> }> {
  return (await res.json()) as { code: string; message: string; details?: Record<string, unknown> };
}

/** Every refusal any test in this file produced, by code+status (filled through `expectRefusal`). */
const produced = new Set<PushRefusal>();

async function expectRefusal(res: Response, refusal: PushRefusal): Promise<void> {
  const policy = PUSH_REFUSAL_POLICY[refusal];
  expect(res.status).toBe(policy.status);
  const body = await bodyOf(res.clone());
  expect(body.code).toBe(policy.code);
  if (policy.exposeReason) expect(body.details?.reason).toBe(refusal);
  produced.add(refusal);
}

function metricLines(): string[] {
  setPushMetricsProvider(() => ({ state: "configured", devices: 0, lastSuccessAtMs: null }));
  return renderMetrics(getRuntimeStatus(), Date.now()).split("\n");
}
function counter(prefix: string): number {
  const line = metricLines().find((l) => l.startsWith(prefix));
  return line === undefined ? 0 : Number(line.slice(line.lastIndexOf(" ") + 1));
}

let logSpy: Mock<(...args: unknown[]) => void>;
let lines: string[];

beforeEach(() => {
  lines = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(String(args[0]));
  });
  __resetMetricsForTest();
});

afterEach(() => {
  logSpy.mockRestore();
  for (const line of lines) {
    for (const s of [WEBHOOK_TEXT, OPERATOR_TEXT, CREDENTIAL, APNS_TOKEN, "sentinel"]) expect(line.includes(s)).toBe(false);
  }
  __resetMetricsForTest();
  __resetCapabilityProvidersForTest();
});

// ---------------------------------------------------------------------------------------------------------------
// V-1 Seam and compatibility
// ---------------------------------------------------------------------------------------------------------------

const ROUTE_PATHS = [
  "/api/push/pairings/redeem",
  "/api/push/device",
  "/api/push/alertmanager",
  "/api/push/status",
  "/api/push/pairing-tokens",
  "/api/push/pairing-tokens/current",
  "/api/push/devices/dev_AAAAAAAAAAA",
  "/api/push/admin/pairing-tokens",
  "/api/push/admin/devices",
  "/api/push/admin/devices/dev_AAAAAAAAAAA",
  "/api/push/admin/test",
];
const COMPAT_PATHS = [...ROUTE_PATHS, "/api/push/", "/api/push/unknown", "/api/push/devices/x/y"];
const METHODS = ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"] as const;

async function snapshot(res: Response): Promise<{ status: number; headers: [string, string][]; body: string }> {
  return { status: res.status, headers: [...res.headers.entries()].sort(), body: await res.text() };
}

describe("V-1 seam and compatibility", () => {
  for (const [mode, identity] of [
    ["none", NONE_IDENTITY],
    ["proxy-header", PROXY_TRUSTED],
  ] as const) {
    test(`V-1.1 ${mode}: no push argument and the disabled runtime give the pre-feature responses`, async () => {
      // The twelve route templates collapse to eleven distinct paths (device has PUT and DELETE).
      expect(new Set(PUSH_ROUTES.map((r) => r.template.replace(":id", DEVICE_ID))).size).toBe(ROUTE_PATHS.length);
      const runtime = fakeRuntime(identity);
      const mutation = mode === "none" ? dispatchMutation : realMutationDispatcher(identity);
      const disabled = createDisabledPushRuntime().dispatcher;
      for (const pathname of COMPAT_PATHS) {
        for (const method of METHODS) {
          const a = await dispatch(request(pathname, { method }), pathname, runtime, stubAssets, svc(), mutation);
          const b = await dispatch(request(pathname, { method }), pathname, runtime, stubAssets, svc(), mutation, disabled);
          const expected = method === "GET" ? errorFor("API_NOT_FOUND", 404) : errorFor("METHOD_NOT_ALLOWED", 405);
          const [sa, sb, se] = [await snapshot(a), await snapshot(b), await snapshot(expected)];
          expect(sa).toEqual(se);
          expect(sb).toEqual(se);
        }
      }
    });
  }

  test("V-1.2 disabled with a bundle error: GET /api/push/status is the 503 bundle body", async () => {
    const runtime = fakeRuntime(NONE_IDENTITY, BUNDLE_ERROR);
    const res = await dispatch(
      request("/api/push/status"),
      "/api/push/status",
      runtime,
      stubAssets,
      svc(),
      dispatchMutation,
      createDisabledPushRuntime().dispatcher,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(BUNDLE_ERROR);
  });

  test("V-1.4 a non-push path never calls the push dispatcher; a null answer leaves the body unread", async () => {
    let calls = 0;
    const spy = async (): Promise<Response | null> => {
      calls++;
      return null;
    };
    const runtime = fakeRuntime(NONE_IDENTITY);
    for (const p of ["/api/overview", "/api/nope", "/assets/x.js", "/", "/api/pushx", "/api/push"]) {
      await dispatch(request(p), p, runtime, stubAssets, svc(), dispatchMutation, spy);
    }
    expect(calls).toBe(0);

    const r = await rig();
    for (const dispatcher of [createDisabledPushRuntime().dispatcher, createPushDispatcher(r.services)]) {
      const req = request("/api/push/unknown", { method: "POST", headers: JSON_TYPE, body: "{}" });
      const res = await dispatch(req, "/api/push/unknown", runtime, stubAssets, svc(), dispatchMutation, dispatcher);
      expect(res.status).toBe(405);
      expect(req.bodyUsed).toBe(false);
    }
    const req = request("/api/push/device", { method: "PUT", headers: JSON_TYPE, body: "{}" });
    await dispatch(req, "/api/push/device", runtime, stubAssets, svc(), dispatchMutation, createDisabledPushRuntime().dispatcher);
    expect(req.bodyUsed).toBe(false);
  });
});

describe("V-1.3 metric labels", () => {
  function httpCount(route: string, status: number): number {
    return counter(`pulse_web_http_requests_total{route="${route}",status="${status}"}`);
  }

  test("disabled: api-notfound; configured: templates; unmatched: api-notfound", async () => {
    const runtime = fakeRuntime(NONE_IDENTITY);
    const disabled = createFetchHandler(runtime, stubAssets, dispatchMutation, createDisabledPushRuntime().dispatcher);
    await disabled(request("/api/push/status"));
    expect(httpCount("api-notfound", 404)).toBe(1);
    expect(httpCount("/api/push/status", 200)).toBe(0);

    const r = await rig();
    const configured = createFetchHandler(runtime, stubAssets, dispatchMutation, createPushDispatcher(r.services));
    await configured(request("/api/push/status"));
    await configured(request("/api/push/devices/x", { method: "DELETE", headers: SAME_ORIGIN }));
    await configured(request("/api/push/unknown"));
    await configured(request("/api/push/status", { method: "PUT" }));
    expect(httpCount("/api/push/status", 200)).toBe(1);
    expect(httpCount("/api/push/devices/:id", 404)).toBe(1);
    expect(httpCount("api-notfound", 404)).toBe(2);
    expect(httpCount("/api/push/status", 405)).toBe(1);
    expect(metricLines().some((l) => l.includes("/api/push/devices/x\""))).toBe(false);
  });

  test("the bootstrap close guard leaves the labels unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "push-routes-"));
    try {
      const key = writeTestKeyFile(dir);
      const config: ServerConfig = loadServerConfig({
        PULSE_VM_URL: "http://localhost:8428",
        PULSE_ALERTMANAGER_URL: "http://localhost:9093",
        PULSE_GATUS_URL: "http://localhost:8080",
        PULSE_VMALERT_URL: "http://localhost:8880",
        [PUSH_ENV.keyFile]: key.path,
        [PUSH_ENV.keyId]: "ABCDE12345",
        [PUSH_ENV.teamId]: "TEAM123456",
        [PUSH_ENV.topic]: "com.example.pulse",
        [PUSH_ENV.dataDir]: join(dir, "data"),
      });
      const clock = createFakeClock(START);
      const rt = await buildPushRuntime(config, { clock, timers: createFakeTimers(clock) });
      expect(rt.state).toBe("configured");
      const handler = createFetchHandler(fakeRuntime(NONE_IDENTITY), stubAssets, dispatchMutation, rt.dispatcher);
      await handler(request("/api/push/status"));
      await handler(request("/api/push/devices/x", { method: "DELETE", headers: SAME_ORIGIN }));
      await handler(request("/api/push/unknown"));
      expect(httpCount("/api/push/status", 200)).toBe(1);
      expect(httpCount("/api/push/devices/:id", 404)).toBe(1);
      expect(httpCount("api-notfound", 404)).toBe(1);
      await rt.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// V-2 Table and dispatcher
// ---------------------------------------------------------------------------------------------------------------

describe("V-2 dispatcher by state", () => {
  test("V-2.4 misconfigured: status 200, webhook 503 counted once, everything else 503 uncounted", async () => {
    const status = await call(MISCONFIGURED, "/api/push/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ state: "misconfigured", devices: [], outstanding: null, maxDevices: 20 });

    const before = counter('pulse_web_push_webhook_total{outcome="unavailable"}');
    const hook = await call(MISCONFIGURED, "/api/push/alertmanager", { method: "POST", headers: { ...webhookAuth, ...JSON_TYPE }, body: "{}" });
    await expectRefusal(hook, "unavailable");
    expect(counter('pulse_web_push_webhook_total{outcome="unavailable"}')).toBe(before + 1);

    const others = PUSH_ROUTES.filter((r) => r.handler !== "webhook" && r.handler !== "status");
    for (const route of others) {
      const pathname = route.template.replace(":id", DEVICE_ID);
      const res = await call(MISCONFIGURED, pathname, { method: route.method, headers: { ...operator, ...SAME_ORIGIN } });
      await expectRefusal(res, "unavailable");
    }
    expect(counter('pulse_web_push_webhook_total{outcome="unavailable"}')).toBe(before + 1);
    expect(counter("pulse_web_push_admin_refusals_total")).toBe(0);
  });

  test("V-2.5 admin off: the four admin routes 503 with no refusal counted, even without Authorization", async () => {
    const r = await rig({ admin: "off" });
    for (const route of PUSH_ROUTES.filter((x) => x.cls === "operator")) {
      for (const headers of [{}, operator, { authorization: "Bearer wrong" }]) {
        const res = await call(r.services, route.template.replace(":id", DEVICE_ID), { method: route.method, headers });
        await expectRefusal(res, "unavailable");
      }
    }
    expect(counter("pulse_web_push_admin_refusals_total")).toBe(0);
  });

  test("V-2.5 webhook off: 503, and only the handler counts (exactly one unavailable)", async () => {
    const r = await rig({ webhook: "off" });
    const res = await call(r.services, "/api/push/alertmanager", {
      method: "POST",
      headers: { ...webhookAuth, ...JSON_TYPE },
      body: JSON.stringify(amNotification()),
    });
    await expectRefusal(res, "unavailable");
    expect(counter('pulse_web_push_webhook_total{outcome="unavailable"}')).toBe(1);
    const total = metricLines()
      .filter((l) => l.startsWith("pulse_web_push_webhook_total{"))
      .reduce((n, l) => n + Number(l.slice(l.lastIndexOf(" ") + 1)), 0);
    expect(total).toBe(1);
    expect(r.submitted).toEqual([]);
  });

  test("V-2.6 405 with Allow, byte-identical to the router's 405 body, in both active states", async () => {
    const r = await rig();
    const expected = await errorFor("METHOD_NOT_ALLOWED", 405).text();
    for (const services of [r.services, MISCONFIGURED] as PushServices[]) {
      for (const [method, path, allow] of [
        ["PUT", "/api/push/status", "GET"],
        ["GET", "/api/push/device", "DELETE, PUT"],
        ["HEAD", "/api/push/status", "GET"],
        ["OPTIONS", "/api/push/admin/devices/x", "DELETE"],
        ["PATCH", "/api/push/pairing-tokens", "POST"],
      ] as const) {
        const res = await call(services, path, { method });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe(allow);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        // HEAD responses carry no body on the wire, but the Response object still holds it.
        expect(await res.text()).toBe(expected);
      }
    }
  });

  test("V-2.7 a throwing handler gives 500 and one push_internal_error {route}; other routes are unaffected", async () => {
    const r = await rig();
    r.flags.throwIssue = true;
    const res = await call(r.services, "/api/push/pairing-tokens", { method: "POST", headers: { ...SAME_ORIGIN, origin: "https://pulse.example.com" } });
    await expectRefusal(res, "internal");
    const internal = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "push_internal_error");
    expect(internal).toHaveLength(1);
    expect(Object.keys(internal[0] ?? {}).sort()).toEqual(["event", "ok", "route", "ts"]);
    expect(internal[0]?.route).toBe("/api/push/pairing-tokens");

    r.flags.throwSubmit = true;
    const hook = await call(r.services, "/api/push/alertmanager", {
      method: "POST",
      headers: { ...webhookAuth, ...JSON_TYPE },
      body: JSON.stringify(amNotification()),
    });
    await expectRefusal(hook, "internal");
    const second = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "push_internal_error");
    expect(second.map((l) => l.route)).toEqual(["/api/push/pairing-tokens", "/api/push/alertmanager"]);

    // The next request on another route still succeeds.
    const ok = await call(r.services, "/api/push/status");
    expect(ok.status).toBe(200);
    const runtime = fakeRuntime(NONE_IDENTITY);
    const overview = await dispatch(request("/api/overview"), "/api/overview", runtime, stubAssets, svc(), dispatchMutation, createPushDispatcher(r.services));
    expect(overview.status).not.toBe(500);
  });

  test("V-2.8 every matched response: no-store, isPushAnswer, and nosniff through createFetchHandler", async () => {
    const r = await rig({ devices: [record()] });
    const cases: Array<[string, CallInit]> = [
      ["/api/push/pairings/redeem", { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token: "", displayName: "Example iPhone" }) }],
      ["/api/push/device", { method: "PUT", headers: deviceAuth }],
      ["/api/push/device", { method: "GET" }],
      ["/api/push/alertmanager", { method: "POST" }],
      ["/api/push/status", {}],
      ["/api/push/pairing-tokens", { method: "POST" }],
      ["/api/push/pairing-tokens/current", { method: "DELETE", headers: SAME_ORIGIN }],
      ["/api/push/devices/x", { method: "DELETE", headers: SAME_ORIGIN }],
      ["/api/push/admin/pairing-tokens", { method: "POST", headers: operator }],
      ["/api/push/admin/devices", { headers: operator }],
      ["/api/push/admin/devices/dev_BBBBBBBBBBB", { method: "DELETE", headers: operator }],
      ["/api/push/admin/test", { method: "POST", headers: { ...operator, ...JSON_TYPE }, body: "{}" }],
      ["/api/push/admin/test", { method: "POST" }],
    ];
    const statuses = new Set<number>();
    const handler = createFetchHandler(fakeRuntime(NONE_IDENTITY), stubAssets, dispatchMutation, createPushDispatcher(r.services));
    for (const [path, init] of cases) {
      const res = await createPushDispatcher(r.services)({ request: request(path, init), pathname: path, peerIp: PEER });
      if (res === null) throw new Error(`no answer for ${path}`);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(isPushAnswer(res)).toBe(true);
      statuses.add(res.status);
      const viaHandler = await handler(request(path, init));
      expect(viaHandler.headers.get("x-content-type-options")).toBe("nosniff");
      expect(viaHandler.headers.get("cache-control")).toBe("private, no-store");
    }
    // A spread of statuses, not only successes.
    expect(statuses.size).toBeGreaterThanOrEqual(5);
    // An unmatched push path is not answered, so not marked.
    expect(await createPushDispatcher(r.services)({ request: request("/api/push/x"), pathname: "/api/push/x", peerIp: PEER })).toBeNull();
  });

  test("V-2.9 bundle-error mode still routes push: redeem, device, webhook, status and admin devices", async () => {
    const r = await rig();
    const runtime = fakeRuntime(NONE_IDENTITY, BUNDLE_ERROR);
    const redeem = await call(r.services, "/api/push/pairings/redeem", {
      method: "POST",
      headers: JSON_TYPE,
      body: JSON.stringify({ token: "", displayName: "Example iPhone" }),
    }, runtime);
    await expectRefusal(redeem, "pairing-refused");
    await expectRefusal(await call(r.services, "/api/push/device", { method: "PUT" }, runtime), "unauthorized");
    await expectRefusal(await call(r.services, "/api/push/alertmanager", { method: "POST" }, runtime), "unauthorized");
    const status = await call(r.services, "/api/push/status", {}, runtime);
    expect(status.status).toBe(200);
    expect(((await status.json()) as { state: string }).state).toBe("configured");
    const list = await call(r.services, "/api/push/admin/devices", { headers: operator }, runtime);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ devices: [] });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// V-3 Ordering
// ---------------------------------------------------------------------------------------------------------------

describe("V-3 ordering", () => {
  const registration = { apnsToken: "CD".repeat(32), environment: "production", preferences: { critical: true, warning: false, info: true } };

  test("V-3.1 PUT /device: 401 before the body, then 400 type, 413 size, 400 schema fields, then the handler", async () => {
    const r = await rig({ devices: [record()] });
    const big = new Uint8Array(1024 * 1024).fill(0x20);
    const noCred = request("/api/push/device", { method: "PUT", headers: JSON_TYPE, body: big });
    const res401 = await dispatch(noCred, "/api/push/device", fakeRuntime(NONE_IDENTITY), stubAssets, svc(), dispatchMutation, createPushDispatcher(r.services));
    await expectRefusal(res401, "unauthorized");
    expect(noCred.bodyUsed).toBe(false);

    await expectRefusal(
      await call(r.services, "/api/push/device", { method: "PUT", headers: { ...deviceAuth, "content-type": "text/plain" }, body: JSON.stringify(registration) }),
      "invalid-body",
    );
    const declared = new Request(`${ORIGIN}/api/push/device`, {
      method: "PUT",
      headers: { ...deviceAuth, ...JSON_TYPE, "content-length": "5000" },
      body: "{}",
    });
    const res413 = await createPushDispatcher(r.services)({ request: declared, pathname: "/api/push/device", peerIp: PEER });
    if (res413 === null) throw new Error("no answer");
    await expectRefusal(res413, "body-too-large");

    const bad = await call(r.services, "/api/push/device", {
      method: "PUT",
      headers: { ...deviceAuth, ...JSON_TYPE },
      body: JSON.stringify({ ...registration, preferences: { critical: true, warning: true } }),
    });
    await expectRefusal(bad.clone(), "invalid-body");
    expect((await bodyOf(bad)).details?.fields).toBe("preferences.info");

    const ok = await call(r.services, "/api/push/device", { method: "PUT", headers: { ...deviceAuth, ...JSON_TYPE }, body: JSON.stringify(registration) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { deviceId: string }).deviceId).toBe(DEVICE_ID);
    expect(r.store.get(DEVICE_ID)?.apnsToken).toBe("cd".repeat(32));
    expect(r.store.get(DEVICE_ID)?.environment).toBe("production");
  });

  test("V-3.2 DELETE /devices/x: the gate runs before the id check", async () => {
    const r = await rig({ devices: [record()] });
    await expectRefusal(await call(r.services, "/api/push/devices/x", { method: "DELETE" }), "cross-origin");
    await expectRefusal(await call(r.services, "/api/push/devices/x", { method: "DELETE", headers: SAME_ORIGIN }), "not-found");
    await expectRefusal(await call(r.services, "/api/push/devices/dev%5FAAAAAAAAAA", { method: "DELETE", headers: SAME_ORIGIN }), "not-found");
    expect(r.store.list()).toHaveLength(1);
  });

  test("V-3.3 bodiless routes ignore a text/plain body and never read it", async () => {
    const r = await rig({ devices: [record()], externalUrl: { state: "unset" } });
    const del = request("/api/push/device", { method: "DELETE", headers: { ...deviceAuth, "content-type": "text/plain" }, body: "ignored" });
    const resDel = await dispatch(del, "/api/push/device", fakeRuntime(NONE_IDENTITY), stubAssets, svc(), dispatchMutation, createPushDispatcher(r.services));
    expect(resDel.status).toBe(204);
    expect(del.bodyUsed).toBe(false);

    const issue = request("/api/push/pairing-tokens", {
      method: "POST",
      headers: { ...SAME_ORIGIN, origin: "https://pulse.example.com", "content-type": "text/plain" },
      body: "ignored",
    });
    const resIssue = await dispatch(issue, "/api/push/pairing-tokens", fakeRuntime(NONE_IDENTITY), stubAssets, svc(), dispatchMutation, createPushDispatcher(r.services));
    expect(resIssue.status).toBe(201);
    expect(issue.bodyUsed).toBe(false);
  });

  test("redeem: a body failure is answered before the token check", async () => {
    const r = await rig();
    await expectRefusal(await call(r.services, "/api/push/pairings/redeem", { method: "POST", headers: JSON_TYPE, body: "" }), "invalid-body");
    await expectRefusal(
      await call(r.services, "/api/push/pairings/redeem", { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token: "x".repeat(4100), displayName: "a" }) }),
      "body-too-large",
    );
    expect(counter('pulse_web_push_pairing_events_total{event="refused"}')).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// V-4.3 / V-5 authorisation through the dispatcher
// ---------------------------------------------------------------------------------------------------------------

describe("authorisation through the dispatcher", () => {
  test("V-4.3 an operator-secret refusal counts exactly one admin refusal; a device 401 counts none", async () => {
    const r = await rig({ devices: [record()] });
    await expectRefusal(await call(r.services, "/api/push/admin/devices", { headers: { authorization: `Bearer ${WEBHOOK_TEXT}` } }), "unauthorized");
    expect(counter("pulse_web_push_admin_refusals_total")).toBe(1);
    await expectRefusal(await call(r.services, "/api/push/admin/devices"), "unauthorized");
    expect(counter("pulse_web_push_admin_refusals_total")).toBe(2);
    await expectRefusal(await call(r.services, "/api/push/device", { method: "DELETE", headers: { authorization: `Bearer ${"D".repeat(43)}` } }), "unauthorized");
    // The webhook refuses the operator secret and counts it as a webhook outcome, not an admin refusal.
    await expectRefusal(await call(r.services, "/api/push/alertmanager", { method: "POST", headers: { ...operator, ...JSON_TYPE }, body: "{}" }), "unauthorized");
    expect(counter("pulse_web_push_admin_refusals_total")).toBe(2);
    const a = await call(r.services, "/api/push/admin/devices");
    const b = await call(r.services, "/api/push/device", { method: "PUT" });
    expect(await a.text()).toBe(await b.text());
  });

  test("V-5.1 no-auth mode: writes need same-origin, the status read is open", async () => {
    const r = await rig();
    await expectRefusal(await call(r.services, "/api/push/pairing-tokens", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }), "cross-origin");
    await expectRefusal(await call(r.services, "/api/push/pairing-tokens", { method: "POST" }), "cross-origin");
    const ok = await call(r.services, "/api/push/pairing-tokens", { method: "POST", headers: { origin: "http://localhost", host: "localhost" } });
    // Reached the handler: an http Origin with no external URL is the handler's no-usable-address.
    await expectRefusal(ok, "no-usable-address");
    expect((await call(r.services, "/api/push/status", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(200);
  });

  test("V-5.2 proxy-header mode: identity on the read, identity and same-origin on writes", async () => {
    const untrusted = await rig({ identity: PROXY_UNTRUSTED });
    await expectRefusal(await call(untrusted.services, "/api/push/status", { headers: { "remote-user": "alice" } }), "untrusted-identity");

    const trusted = await rig({ identity: PROXY_TRUSTED, devices: [record()] });
    expect((await call(trusted.services, "/api/push/status", { headers: { "remote-user": "alice" } })).status).toBe(200);
    await expectRefusal(
      await call(trusted.services, `/api/push/devices/${DEVICE_ID}`, { method: "DELETE", headers: { "remote-user": "alice", "sec-fetch-site": "cross-site" } }),
      "cross-origin",
    );
    expect(trusted.store.list()).toHaveLength(1);
    const revoked = await call(trusted.services, `/api/push/devices/${DEVICE_ID}`, { method: "DELETE", headers: { "remote-user": "alice", ...SAME_ORIGIN } });
    expect(revoked.status).toBe(204);
    expect(trusted.store.list()).toHaveLength(0);
  });

  test("V-5.3 proxy-header mode: contract, webhook and operator routes work from an untrusted cross-site peer", async () => {
    const r = await rig({ identity: PROXY_UNTRUSTED });
    const cross = { "sec-fetch-site": "cross-site" };
    const issued = await call(r.services, "/api/push/admin/pairing-tokens", {
      method: "POST",
      headers: { ...cross, ...operator, ...JSON_TYPE },
      body: JSON.stringify({ baseUrl: "https://pulse.example.com" }),
    });
    expect(issued.status).toBe(201);
    const { link } = (await issued.json()) as { link: string };
    const token = new URLSearchParams(link.slice(link.indexOf("?") + 1)).get("pair");

    const redeemed = await call(r.services, "/api/push/pairings/redeem", {
      method: "POST",
      headers: { ...cross, ...JSON_TYPE },
      body: JSON.stringify({ token, displayName: "Example iPhone" }),
    });
    expect(redeemed.status).toBe(201);
    const { credential, deviceId } = (await redeemed.json()) as { credential: string; deviceId: string };
    const auth = { authorization: `Bearer ${credential}` };

    const put = await call(r.services, "/api/push/device", {
      method: "PUT",
      headers: { ...cross, ...auth, ...JSON_TYPE },
      body: JSON.stringify({ apnsToken: APNS_TOKEN, environment: "sandbox", preferences: { critical: true, warning: true, info: true } }),
    });
    expect(put.status).toBe(200);

    const hook = await call(r.services, "/api/push/alertmanager", {
      method: "POST",
      headers: { ...cross, ...webhookAuth, ...JSON_TYPE },
      body: JSON.stringify(amNotification({ alerts: [amAlert()] })),
    });
    expect(hook.status).toBe(202);
    expect(r.submitted).toHaveLength(1);

    const list = await call(r.services, "/api/push/admin/devices", { headers: { ...cross, ...operator } });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { devices: { id: string }[] }).devices.map((d) => d.id)).toEqual([deviceId]);

    const test = await call(r.services, "/api/push/admin/test", { method: "POST", headers: { ...cross, ...operator, ...JSON_TYPE }, body: "{}" });
    expect(test.status).toBe(200);
    expect(r.apnsSends).toEqual([APNS_TOKEN]);

    const self = await call(r.services, "/api/push/device", { method: "DELETE", headers: { ...cross, ...auth } });
    expect(self.status).toBe(204);
    expect(r.store.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Bindings and refusal coverage
// ---------------------------------------------------------------------------------------------------------------

describe("bindings and refusals", () => {
  test("status reports configured devices and the outstanding web token", async () => {
    const r = await rig({ devices: [record()], externalUrl: usableExternalUrl() });
    const empty = (await (await call(r.services, "/api/push/status")).json()) as { outstanding: unknown; devices: unknown[]; maxDevices: number };
    expect(empty.outstanding).toBeNull();
    expect(empty.devices).toHaveLength(1);
    expect(empty.maxDevices).toBe(20);
    const issued = await call(r.services, "/api/push/pairing-tokens", { method: "POST", headers: SAME_ORIGIN });
    expect(issued.status).toBe(201);
    const { expiresAt } = (await issued.json()) as { expiresAt: string };
    const after = (await (await call(r.services, "/api/push/status")).json()) as { outstanding: { expiresAt: string } | null };
    expect(after.outstanding).toEqual({ expiresAt });
    expect((await call(r.services, "/api/push/pairing-tokens/current", { method: "DELETE", headers: SAME_ORIGIN })).status).toBe(204);
    const cancelled = (await (await call(r.services, "/api/push/status")).json()) as { outstanding: unknown };
    expect(cancelled.outstanding).toBeNull();
  });

  test("admin routes: issue without baseUrl, revoke unknown and known, test an unknown device", async () => {
    const r = await rig({ devices: [record()] });
    // No external URL and no baseUrl: the issue handler has no usable address.
    await expectRefusal(
      await call(r.services, "/api/push/admin/pairing-tokens", { method: "POST", headers: { ...operator, ...JSON_TYPE }, body: "{}" }),
      "no-usable-address",
    );
    await expectRefusal(
      await call(r.services, "/api/push/admin/pairing-tokens", {
        method: "POST",
        headers: { ...operator, ...JSON_TYPE },
        body: JSON.stringify({ baseUrl: `https://pulse.example.com/${"p".repeat(200)}` }),
      }),
      "address-too-long",
    );
    await expectRefusal(
      await call(r.services, "/api/push/admin/test", { method: "POST", headers: { ...operator, ...JSON_TYPE }, body: JSON.stringify({ deviceId: "dev_BBBBBBBBBBB" }) }),
      "not-found",
    );
    await expectRefusal(await call(r.services, "/api/push/admin/devices/dev_BBBBBBBBBBB", { method: "DELETE", headers: operator }), "not-found");
    expect((await call(r.services, `/api/push/admin/devices/${DEVICE_ID}`, { method: "DELETE", headers: operator })).status).toBe(204);
    expect(r.store.list()).toHaveLength(0);
  });

  test("redeem: cap reached and rate limited", async () => {
    const capped = await rig({ maxDevices: 1, devices: [record()] });
    const issued = await call(capped.services, "/api/push/admin/pairing-tokens", {
      method: "POST",
      headers: { ...operator, ...JSON_TYPE },
      body: JSON.stringify({ baseUrl: "https://pulse.example.com" }),
    });
    if (issued.status === 201) {
      const { link } = (await issued.json()) as { link: string };
      const token = new URLSearchParams(link.slice(link.indexOf("?") + 1)).get("pair");
      const res = await call(capped.services, "/api/push/pairings/redeem", {
        method: "POST",
        headers: JSON_TYPE,
        body: JSON.stringify({ token, displayName: "Example iPad" }),
      });
      await expectRefusal(res, "device-cap-reached");
    } else {
      await expectRefusal(issued, "device-cap-reached");
    }

    const limited = await rig();
    let last: Response | null = null;
    for (let i = 0; i <= PUSH_LIMITS.limiterMaxFailures + 1; i++) {
      last = await call(limited.services, "/api/push/pairings/redeem", {
        method: "POST",
        headers: JSON_TYPE,
        body: JSON.stringify({ token: "A".repeat(22), displayName: "Example iPhone" }),
      });
      if (last.status === 429) break;
    }
    if (last === null) throw new Error("no answer");
    await expectRefusal(last, "rate-limited");
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  test("webhook: unsupported version and an oversize body", async () => {
    const r = await rig();
    await expectRefusal(
      await call(r.services, "/api/push/alertmanager", {
        method: "POST",
        headers: { ...webhookAuth, ...JSON_TYPE },
        body: JSON.stringify({ ...amNotification(), version: "3" }),
      }),
      "unsupported-version",
    );
    const declared = new Request(`${ORIGIN}/api/push/alertmanager`, {
      method: "POST",
      headers: { ...webhookAuth, ...JSON_TYPE, "content-length": String(PUSH_LIMITS.webhookMaxBytes + 1) },
      body: "{}",
    });
    const res = await createPushDispatcher(r.services)({ request: declared, pathname: "/api/push/alertmanager", peerIp: PEER });
    if (res === null) throw new Error("no answer");
    await expectRefusal(res, "body-too-large");
    expect(r.submitted).toEqual([]);
  });

  test("every PushRefusal member is produced by at least one route case in this file", () => {
    // Runs last in file order; bun runs tests in declaration order within a file.
    expect([...produced].sort()).toEqual((Object.keys(PUSH_REFUSAL_POLICY) as PushRefusal[]).sort());
  });
});
