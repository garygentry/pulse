// Log and metrics safety for the push gateway, plus metric-union coverage. One configured run drives every push path
// through the real router `dispatch()` against the fake APNs, with a fake clock and fake timers (so the 429 deadline,
// the token TTL and the 90-day sweep take no wall time) and known canary secrets. Every console.log line and the
// final /metrics body are then checked: no secret or derived form appears (not even an 8-character slice of one),
// every line is a known LogEvent, push events carry only allowlisted keys, the device store is the single emitter of
// removals, rate-limited delivery lines stay bounded, and every series of the closed push label sets was produced by
// a real call site. A second run with push disabled shows no push line at all and only the disabled state gauge.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test, type Mock } from "bun:test";
import { createHash, createPrivateKey } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetCapabilityProvidersForTest } from "@pulse/web-data/contract";

import type { StaticAssets } from "../../src/server/assets.js";
import { loadServerConfig, type ServerConfig } from "../../src/server/config.js";
import { buildPushRuntime, type ConfiguredPushServices, type PushRuntime } from "../../src/server/push/bootstrap.js";
import { PUSH_ENV, PUSH_LIMITS, PUSH_PATHS } from "../../src/server/push/constants.js";
import type { Timers } from "../../src/server/push/dispatch/queue.js";
import { createPushDispatcher } from "../../src/server/push/routes.js";
import { hashCredential, loadPushSecret, type PushSecret } from "../../src/server/push/secrets.js";
import { createServerRuntime, type ServerRuntime } from "../../src/server/refresh.js";
import { dispatch, dispatchMutation, type RequestServices } from "../../src/server/router.js";
import {
  __resetMetricsForTest,
  PUSH_NOTIFICATION_KINDS,
  PUSH_NOTIFICATION_OUTCOMES,
  PUSH_PAIRING_EVENTS,
  PUSH_WEBHOOK_OUTCOMES,
} from "../../src/server/routes/metrics.js";
import { makeEstateBundleFixture } from "../factories/estate-bundle.js";
import { amAlert, amNotification } from "./helpers/am-fixtures.js";
import { startFakeApns, type FakeApns } from "./helpers/fake-apns.js";
import { createFakeClock, createFakeTimers, createSeededRandom, type FakeClock, type FakeTimers } from "./helpers/fakes.js";
import { writeTestKeyFile } from "./helpers/keys.js";
import { createTestTls } from "./helpers/tls.js";

// ---------------------------------------------------------------------------------------------------------------
// Canaries and fixtures
// ---------------------------------------------------------------------------------------------------------------

const WEBHOOK_CANARY = "wh-canary-" + "A".repeat(40);
const OPERATOR_CANARY = "op-canary-" + "B".repeat(40);
const APNS_CANARY = "c0ffee".repeat(11) + "ab";
const START = Date.parse("2026-11-20T12:00:00.000Z");
/** Wall-clock bound of one pump wait. */
const PUMP_MS = 8_000;
/** Bound of the whole configured drive (well under the 30 s per-file budget). */
const DRIVE_TIMEOUT_MS = 25_000;

const ORIGIN = "http://localhost";
const JSON_TYPE = { "content-type": "application/json" } as const;
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" } as const;
const SERVICES: RequestServices = { peerIp: "127.0.0.1", disableTimeout() {} };
const STUB_ASSETS: StaticAssets = { get: () => undefined, shell: () => "<!doctype html><div id=app></div>" };

const tls = createTestTls();

/** Every engine answers 503: the server runtime is only needed for /metrics and the router context. */
const DOWN_FETCH = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;

/** Members of the LogEvent `event` union, read from the source so a new member never needs a second edit here. */
function logEventUnion(): ReadonlySet<string> {
  const src = readFileSync(join(import.meta.dir, "../../src/server/log.ts"), "utf8");
  const start = src.indexOf("event:", src.indexOf("export interface LogEvent"));
  const body = src.slice(start, src.indexOf(";", src.indexOf('"push_internal_error"', start)));
  const names = [...body.matchAll(/^\s*\|\s*"([a-z_]+)"/gm)].map((m) => m[1]!);
  return new Set(names);
}

/** Allowed keys per push event (00 §6.2) besides the `ts`, `event` and `ok` envelope. Add new fields deliberately. */
const PUSH_EVENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  push_started: ["state", "webhook", "admin", "devices"],
  push_pairing: ["pairingEvent", "source", "deviceId", "displayName"],
  push_pairing_rate_limited: [],
  push_device_removed: ["deviceId", "reason"],
  push_delivery_failed: ["deviceId", "kind", "classification", "status", "reason"],
  push_delivery_dropped: ["deviceId", "kind", "cause"],
  push_apns_auth_failed: ["status", "reason"],
  push_registry_corrupt: ["path"],
  push_registry_write_failed: ["step", "code"],
  push_registry_degraded: [],
  push_registry_recovered: [],
  push_webhook_received: ["alerts", "truncatedAlerts", "devices"],
  push_internal_error: ["route"],
};
const ENVELOPE_KEYS = ["ts", "event", "ok"];

/**
 * Series of the closed sets that no call site can produce (07 §1.9), so the union check skips them:
 * - summary × filtered: the planner counts a filtered alert under its would-be per-alert kind (firing, repeat or
 *   resolved); a summary is only built from kept alerts, so nothing ever records `filtered` for `summary`.
 * - test × filtered: a test send ignores device preferences and is never planned, so it has no filtered outcome.
 */
const UNION_EXCLUSIONS: ReadonlySet<string> = new Set([
  'pulse_web_push_notifications_total{kind="summary",outcome="filtered"}',
  'pulse_web_push_notifications_total{kind="test",outcome="filtered"}',
]);

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------------------

let logSpy: Mock<(...args: unknown[]) => void> | null = null;
const lines: string[] = [];

function startCapture(): void {
  lines.length = 0;
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
}
function stopCapture(): void {
  logSpy?.mockRestore();
  logSpy = null;
}

interface Parsed {
  readonly event: string;
  readonly [key: string]: unknown;
}
function parsedLines(): Parsed[] {
  return lines.map((l) => JSON.parse(l) as Parsed);
}

/** A server env in `dir`: engine URLs on localhost, the estate model, the data dir, plus `extra`. */
function baseEnv(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  const f = makeEstateBundleFixture();
  const modelPath = join(dir, "web-estate-model.json");
  writeFileSync(modelPath, f.files.model);
  writeFileSync(join(dir, "web-coverage.json"), f.files.coverage ?? "");
  writeFileSync(join(dir, "web-findings.json"), f.files.findings ?? "");
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  return {
    PULSE_VM_URL: "http://localhost:8428",
    PULSE_ALERTMANAGER_URL: "http://localhost:9093",
    PULSE_GATUS_URL: "http://localhost:8080",
    PULSE_VMALERT_URL: "http://localhost:8880",
    PULSE_WEB_ESTATE_MODEL: modelPath,
    PULSE_WEB_EXTERNAL_URL: "https://pulse.example.com",
    [PUSH_ENV.dataDir]: dataDir,
    ...extra,
  };
}

interface Caller {
  (method: string, path: string, headers?: Record<string, string>, body?: unknown): Promise<Response>;
}
function caller(push: PushRuntime, runtime: ServerRuntime): Caller {
  return (method, path, headers = {}, body) => {
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const req = new Request(`${ORIGIN}${path}`, init);
    return dispatch(req, path, runtime, STUB_ASSETS, SERVICES, dispatchMutation, push.dispatcher);
  };
}

/** Sample lines of /metrics as series → value. */
function samples(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of text.split("\n")) {
    if (l === "" || l.startsWith("#")) continue;
    const i = l.lastIndexOf(" ");
    out.set(l.slice(0, i), Number(l.slice(i + 1)));
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function secretOf(text: string): PushSecret {
  const r = loadPushSecret({ S: text }, "S");
  if (!r.ok) throw new Error("canary secret refused");
  return r.secret;
}

// ---------------------------------------------------------------------------------------------------------------
// Configured run
// ---------------------------------------------------------------------------------------------------------------

interface RunResult {
  readonly lines: readonly string[];
  readonly metrics: string;
  readonly secrets: ReadonlySet<string>;
  readonly removedIds: ReadonlyMap<string, string>;
  readonly pairingDeltas: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly limitedDevice: string;
  readonly limitedElapsedMs: number;
  readonly limitedItems: number;
  readonly failDevice: string;
}

/** Fake timers that also report how many APNs request timeouts are armed (requests in flight). */
function trackingTimers(inner: FakeTimers): Timers & { inFlight(): number } {
  const armed = new Set<unknown>();
  return {
    setTimeout(fn, ms) {
      if (ms !== PUSH_LIMITS.apnsRequestTimeoutMs) return inner.setTimeout(fn, ms);
      const h: unknown = inner.setTimeout(() => {
        armed.delete(h);
        fn();
      }, ms);
      armed.add(h);
      return h;
    },
    clearTimeout(h) {
      armed.delete(h);
      inner.clearTimeout(h);
    },
    setInterval: (fn, ms) => inner.setInterval(fn, ms),
    clearInterval: (h) => inner.clearInterval(h),
    inFlight: () => armed.size,
  };
}

async function driveConfigured(): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), "pulse-push-logsafety-"));
  const secrets = new Set<string>([WEBHOOK_CANARY, OPERATOR_CANARY, APNS_CANARY]);
  const opened: { push: PushRuntime | null; runtime: ServerRuntime | null; apns: FakeApns | null } = {
    push: null,
    runtime: null,
    apns: null,
  };
  try {
    const key = writeTestKeyFile(dir);
    const der = createPrivateKey(key.pem).export({ format: "der", type: "pkcs8" });
    secrets.add(der.toString("base64"));
    secrets.add(der.toString("base64url"));
    secrets.add(key.pem);
    for (const s of [WEBHOOK_CANARY, OPERATOR_CANARY]) secrets.add(hex(secretOf(s).sha256()));
    for (const t of [APNS_CANARY]) {
      secrets.add(t.toUpperCase());
      secrets.add(t.slice(-6));
    }

    const apns = (opened.apns = await startFakeApns({ tls: tls!, providerPublicKey: key.publicKey }));
    const configuredEnv = (extra: Record<string, string> = {}): Record<string, string> =>
      baseEnv(mkdtempSync(join(dir, "env-")), {
        [PUSH_ENV.keyFile]: key.path,
        [PUSH_ENV.keyId]: "CANARYK001",
        [PUSH_ENV.teamId]: "CANARYT001",
        [PUSH_ENV.topic]: "com.example.pulse",
        [PUSH_ENV.webhookSecret]: WEBHOOK_CANARY,
        [PUSH_ENV.operatorSecret]: OPERATOR_CANARY,
        ...extra,
      });
    const apnsDeps = { origins: apns.origins, ca: apns.ca };

    // ── Side runtimes, before the main one installs its metrics provider ──────────────────────────────────────
    // Misconfigured (KEY_ID only): the webhook answers 503 and counts `unavailable`.
    {
      const env = baseEnv(mkdtempSync(join(dir, "env-")), { [PUSH_ENV.keyId]: "CANARYK001" });
      const cfg = loadServerConfig(env);
      const push = await buildPushRuntime(cfg, { apns: apnsDeps });
      const rt = createServerRuntime(cfg, { fetchImpl: DOWN_FETCH });
      const res = await caller(push, rt)("POST", PUSH_PATHS.webhook, { ...JSON_TYPE, authorization: `Bearer ${WEBHOOK_CANARY}` }, amNotification());
      expect(res.status).toBe(503);
      rt.close();
      await push.close();
    }
    // A corrupt devices.json: preserved, logged, misconfigured.
    {
      const env = configuredEnv();
      const pushDir = join(env[PUSH_ENV.dataDir]!, "push");
      mkdirSync(pushDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(pushDir, "devices.json"), `{"formatVersion":1,"devices":[{"credentialHash":"${OPERATOR_CANARY}"`);
      const push = await buildPushRuntime(loadServerConfig(env), { apns: apnsDeps });
      expect(push.state).toBe("misconfigured");
      await push.close();
    }

    // ── The main runtime: fake clock and timers, seeded randomness, 14 devices at most ───────────────────────────
    const clock: FakeClock = createFakeClock(START);
    const fakeTimers = createFakeTimers(clock);
    const timers = trackingTimers(fakeTimers);
    const env = configuredEnv({ [PUSH_ENV.maxDevices]: "14" });
    const dataDir = env[PUSH_ENV.dataDir]!;
    const cfg: ServerConfig = loadServerConfig(env);
    const push = (opened.push = await buildPushRuntime(cfg, {
      clock,
      timers,
      random: createSeededRandom(34),
      apns: apnsDeps,
    }));
    expect(push.state).toBe("configured");
    const runtime = (opened.runtime = createServerRuntime(cfg, { fetchImpl: DOWN_FETCH }));
    push.attachRuntime(runtime);
    const call = caller(push, runtime);
    const operator = { authorization: `Bearer ${OPERATOR_CANARY}` };
    const webhookAuth = { ...JSON_TYPE, authorization: `Bearer ${WEBHOOK_CANARY}` };

    const metricsText = async (): Promise<string> => (await call("GET", "/metrics")).text();
    const metric = async (series: string): Promise<number> => samples(await metricsText()).get(series) ?? 0;
    const pairingCounters = async (): Promise<Record<string, number>> => {
      const s = samples(await metricsText());
      return Object.fromEntries(
        PUSH_PAIRING_EVENTS.map((e) => [e, s.get(`pulse_web_push_pairing_events_total{event="${e}"}`) ?? 0]),
      );
    };
    const pairingDeltas: Record<string, Record<string, number>> = {};
    const measure = async (label: string, fn: () => Promise<void>): Promise<void> => {
      const before = await pairingCounters();
      await fn();
      const after = await pairingCounters();
      pairingDeltas[label] = Object.fromEntries(PUSH_PAIRING_EVENTS.map((e) => [e, after[e]! - before[e]!]));
    };

    /** Run due timers and yield to I/O until `cond`; with `step`, also advance to the next timer once quiet. */
    const pump = async (cond: () => Promise<boolean> | boolean, label: string, step = false): Promise<void> => {
      const deadline = performance.now() + PUMP_MS;
      let quiet = 0;
      let sig = "";
      for (;;) {
        fakeTimers.runDue();
        if (await cond()) return;
        if (performance.now() > deadline) throw new Error(`pump timed out: ${label}`);
        await Bun.sleep(2);
        const now = `${apns.requests.length}|${lines.length}`;
        quiet = now === sig ? quiet + 1 : 0;
        sig = now;
        // Never move the clock while an APNs request timeout is armed: that would fire it.
        if (step && quiet >= 3 && (timers.inFlight() === 0 || quiet >= 150)) {
          fakeTimers.step();
          quiet = 0;
        }
      }
    };

    const track = (link: string, credential?: string): void => {
      secrets.add(link);
      const token = new URL(link).searchParams.get("pair")!;
      secrets.add(token);
      secrets.add(hashCredential(token));
      if (credential !== undefined) {
        secrets.add(credential);
        secrets.add(hashCredential(credential));
      }
    };
    const adminIssue = async (): Promise<string> => {
      const res = await call("POST", PUSH_PATHS.adminPairingTokens, { ...JSON_TYPE, ...operator }, {});
      expect(res.status).toBe(201);
      const { link } = (await res.json()) as { link: string };
      track(link);
      return link;
    };
    const tokenOf = (link: string): string => new URL(link).searchParams.get("pair")!;
    const redeem = (token: string, name = "Example iPhone"): Promise<Response> =>
      call("POST", PUSH_PATHS.redeem, JSON_TYPE, { token, displayName: name });
    const put = (credential: string, apnsToken: string, critical = true): Promise<Response> =>
      call("PUT", PUSH_PATHS.device, { ...JSON_TYPE, authorization: `Bearer ${credential}` }, {
        apnsToken,
        environment: "sandbox",
        preferences: { critical, warning: true, info: true },
      });

    interface Dev {
      readonly id: string;
      readonly credential: string;
      readonly token: string;
    }
    let tokenSeq = 0;
    const freshToken = (): string => {
      tokenSeq++;
      const t = createHash("sha256").update(`device-${tokenSeq}`).digest("hex");
      secrets.add(t);
      secrets.add(t.toUpperCase());
      secrets.add(t.slice(-6));
      return t;
    };
    const enrol = async (link: string, name: string, apnsToken = freshToken()): Promise<Dev> => {
      const res = await redeem(tokenOf(link), name);
      expect(res.status).toBe(201);
      const { deviceId, credential } = (await res.json()) as { deviceId: string; credential: string };
      track(link, credential);
      expect((await put(credential, apnsToken)).status).toBe(200);
      return { id: deviceId, credential, token: apnsToken };
    };
    const removedIds = new Map<string, string>();

    // 1. Expiry: one device left unseen for 90 days + 1 ms is removed by the sweep (counted `expired` once).
    await measure("expired", async () => {
      const old = await enrol(await adminIssue(), "Example iPad");
      removedIds.set(old.id, "expired");
      clock.advance(PUSH_LIMITS.deviceExpiryMs + 1);
      await pump(async () => (await pairingCounters()).expired === 1, "sweep expiry");
    });

    // 2. Web issue and cancel; web issue, redeem and register (the canary APNs token).
    const webIssue = async (): Promise<string> => {
      const res = await call("POST", PUSH_PATHS.pairingTokens, { ...SAME_ORIGIN });
      expect(res.status).toBe(201);
      const { link } = (await res.json()) as { link: string };
      track(link);
      return link;
    };
    await webIssue();
    expect((await call("DELETE", PUSH_PATHS.pairingTokenCurrent, { ...SAME_ORIGIN })).status).toBe(204);
    const okLink = await webIssue();
    const dOk = await enrol(okLink, "Example iPhone", APNS_CANARY);
    // Refresh: the same registration again.
    expect((await put(dOk.credential, APNS_CANARY)).status).toBe(200);

    // 3. Admin-issued devices.
    const names = ["fail", "auth", "limited", "rmFiring", "rmRepeat", "rmResolved", "rmSummary", "rmTest", "muted", "self", "supA", "supB", "revoke"] as const;
    const devs: Record<(typeof names)[number], Dev> = {} as Record<(typeof names)[number], Dev>;
    for (const n of names) devs[n] = await enrol(await adminIssue(), `Example ${n}`);

    // 4. The cap: a 15th redemption is refused (409, cap_reached).
    const capRes = await redeem(tokenOf(await adminIssue()));
    expect(capRes.status).toBe(409);

    // 5. Revoke (web), self-removal and a superseded registration.
    await measure("revoke", async () => {
      const res = await call("DELETE", PUSH_PATHS.deviceById.replace(":id", devs.revoke.id), { ...SAME_ORIGIN });
      expect(res.status).toBe(204);
    });
    removedIds.set(devs.revoke.id, "revoked");
    await measure("self", async () => {
      const res = await call("DELETE", PUSH_PATHS.device, { authorization: `Bearer ${devs.self.credential}` });
      expect(res.status).toBe(204);
    });
    removedIds.set(devs.self.id, "self");
    await measure("superseded", async () => {
      expect((await put(devs.supB.credential, devs.supA.token)).status).toBe(200);
    });
    removedIds.set(devs.supA.id, "superseded");

    // 6. Refusals: reused token, expired token, wrong operator secret, webhook unauthorized/malformed/too large.
    expect((await redeem(tokenOf(okLink))).status).toBe(403);
    const staleLink = await adminIssue();
    clock.advance(PUSH_LIMITS.tokenTtlMs);
    expect((await redeem(tokenOf(staleLink))).status).toBe(403);
    expect((await call("GET", PUSH_PATHS.adminDevices, { authorization: `Bearer ${WEBHOOK_CANARY}` })).status).toBe(401);
    expect((await call("POST", PUSH_PATHS.webhook, { ...JSON_TYPE, authorization: `Bearer ${OPERATOR_CANARY}` }, amNotification())).status).toBe(401);
    expect((await call("POST", PUSH_PATHS.webhook, webhookAuth, `{"version":"4","credential":"${dOk.credential}"`)).status).toBe(400);
    const tooMany = Array.from({ length: PUSH_LIMITS.webhookMaxAlerts + 1 }, (_, i) =>
      amAlert({ fingerprint: (0xe000000000000000n + BigInt(i)).toString(16) }),
    );
    expect((await call("POST", PUSH_PATHS.webhook, webhookAuth, amNotification({ alerts: tooMany }))).status).toBe(413);

    // 7. The redemption limiter trips on failed redemptions (rate_limited once), then answers 429.
    for (let i = 0; i < PUSH_LIMITS.limiterMaxFailures && (await pairingCounters()).rate_limited === 0; i++) {
      await redeem(`${"Z".repeat(21)}${String.fromCharCode(65 + i)}`);
    }
    expect((await pairingCounters()).rate_limited).toBe(1);
    expect((await redeem("Z".repeat(22))).status).toBe(429);

    // 8. Deliveries. Scripts are FIFO per token; without a script the fake answers 200.
    const status = (s: number, reason: string) => ({ kind: "status" as const, status: s, reason });
    const ok = { kind: "status" as const, status: 200 };
    apns.script(devs.fail.token, ...Array.from({ length: 5 }, () => status(400, "BadDeviceToken")));
    apns.script(devs.auth.token, status(403, "InvalidProviderToken"));
    apns.script(devs.limited.token, ...Array.from({ length: 200 }, () => status(429, "TooManyRequests")));
    apns.script(devs.rmFiring.token, status(410, "Unregistered"));
    apns.script(devs.rmRepeat.token, ok, status(410, "Unregistered"));
    apns.script(devs.rmResolved.token, ok, ok, status(410, "Unregistered"));
    apns.script(devs.rmSummary.token, ok, ok, ok, status(410, "Unregistered"));
    apns.script(devs.rmTest.token, ok, ok, ok, ok, status(410, "Unregistered"));
    for (const n of ["rmFiring", "rmRepeat", "rmResolved", "rmSummary", "rmTest"] as const) removedIds.set(devs[n].id, "dead-token");

    const settled = async (kind: string): Promise<number> => {
      const s = samples(await metricsText());
      return ["delivered", "failed", "token_removed", "dropped"].reduce(
        (n, o) => n + (s.get(`pulse_web_push_notifications_total{kind="${kind}",outcome="${o}"}`) ?? 0),
        0,
      );
    };
    const fpA = "a000000000000001";
    const firingA = amNotification({ alerts: [amAlert({ fingerprint: fpA })] });
    const limitedStart = clock.nowMs();

    // N1 firing: 11 devices; all but the 429 device settle (the 410 device is removed: removed_dead +1).
    await measure("dead-token", async () => {
      expect((await call("POST", PUSH_PATHS.webhook, webhookAuth, firingA)).status).toBe(202);
      await pump(async () => (await settled("firing")) === 10 && (await pairingCounters()).removed_dead === 1, "N1");
    });
    // The muted device turns critical off: its repeat and resolution are filtered.
    expect((await put(devs.muted.credential, devs.muted.token, false)).status).toBe(200);
    // N2 repeat.
    expect((await call("POST", PUSH_PATHS.webhook, webhookAuth, firingA)).status).toBe(202);
    await pump(async () => (await settled("repeat")) === 8, "N2");
    // N3 resolved.
    const resolvedA = amNotification({ alerts: [amAlert({ fingerprint: fpA, status: "resolved" })] });
    expect((await call("POST", PUSH_PATHS.webhook, webhookAuth, resolvedA)).status).toBe(202);
    await pump(async () => (await settled("resolved")) === 7, "N3");
    // N4: six alerts give one summary per device (the muted device filters all six as firing).
    const six = Array.from({ length: PUSH_LIMITS.summaryThreshold + 1 }, (_, i) =>
      amAlert({ name: `HostDown${i}`, fingerprint: `d00000000000000${i}` }),
    );
    expect((await call("POST", PUSH_PATHS.webhook, webhookAuth, amNotification({ alerts: six, groupKey: "{}:{group=\"six\"}" }))).status).toBe(202);
    await pump(async () => (await settled("summary")) === 6, "N4");

    // Test send to every device; the 429 device exhausts its retries. Then let the 429 queue reach its deadline.
    let testDone = false;
    const testRes = call("POST", PUSH_PATHS.adminTest, { ...JSON_TYPE, ...operator }, {}).then(async (r) => {
      testDone = true;
      return r;
    });
    await pump(
      async () =>
        testDone &&
        (await Promise.all(["firing", "repeat", "resolved", "summary"].map(async (k) =>
          metric(`pulse_web_push_notifications_total{kind="${k}",outcome="dropped"}`),
        ))).every((n) => n === 1),
      "test send and 429 deadline",
      true,
    );
    expect((await testRes).status).toBe(200);
    const limitedElapsedMs = clock.nowMs() - limitedStart;

    // 9. A failed registry write (the push directory made read-only), then the recovery.
    const pushDir = join(dataDir, "push");
    chmodSync(pushDir, 0o500);
    try {
      expect((await put(dOk.credential, APNS_CANARY)).status).toBe(503);
    } finally {
      chmodSync(pushDir, 0o700);
    }
    expect((await put(dOk.credential, APNS_CANARY)).status).toBe(200);

    // 10. An internal error whose message quotes a credential: only the route is logged.
    {
      const thrower = (): never => {
        throw new Error(`store failure quoting ${dOk.credential} and ${OPERATOR_CANARY}`);
      };
      const services = {
        state: "configured",
        identity: cfg.identity,
        externalUrl: cfg.externalUrl,
        maxDevices: 14,
        webhook: "off",
        admin: "on",
        webhookSecret: null,
        operatorSecret: secretOf(OPERATOR_CANARY),
        topic: "com.example.pulse",
        store: { list: thrower, get: thrower, byCredentialHash: thrower },
        pairing: {},
        clock,
        timers,
        getRuntime: () => null,
      } as unknown as ConfiguredPushServices;
      const inner = createPushDispatcher(Object.freeze(services));
      const req = new Request(`${ORIGIN}${PUSH_PATHS.adminDevices}`, { headers: operator });
      const res = await dispatch(req, PUSH_PATHS.adminDevices, runtime, STUB_ASSETS, SERVICES, dispatchMutation, inner);
      expect(res.status).toBe(500);
    }

    // The JWTs the fake received are secrets too.
    for (const r of apns.requests) {
      const auth = r.headers.authorization;
      if (auth !== undefined) secrets.add(auth.replace(/^bearer /i, ""));
    }
    const metrics = await metricsText();
    return {
      lines: [...lines],
      metrics,
      secrets,
      removedIds,
      pairingDeltas,
      limitedDevice: devs.limited.id,
      limitedElapsedMs,
      limitedItems: 5,
      failDevice: devs.fail.id,
    };
  } finally {
    opened.runtime?.close();
    await opened.push?.close();
    await opened.apns?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(tls === null)(`push log safety: configured run${tls === null ? " (skipped: openssl missing)" : ""}`, () => {
  let run: RunResult;
  const events = logEventUnion();

  beforeAll(async () => {
    __resetMetricsForTest();
    __resetCapabilityProvidersForTest();
    startCapture();
    try {
      run = await driveConfigured();
    } finally {
      stopCapture();
    }
  }, DRIVE_TIMEOUT_MS);

  afterAll(() => {
    __resetMetricsForTest();
    __resetCapabilityProvidersForTest();
  });

  test("the capture saw the paths it drove", () => {
    const seen = new Set(run.lines.map((l) => (JSON.parse(l) as Parsed).event));
    for (const e of Object.keys(PUSH_EVENT_KEYS)) expect(seen.has(e)).toBe(true);
  });

  test("no log line or /metrics line contains a secret or any 8-character slice of one", () => {
    const haystack = [...run.lines, ...run.metrics.split("\n")];
    const needles = new Set<string>();
    for (const s of run.secrets) {
      needles.add(s);
      if (s.length >= 8) for (let i = 0; i + 8 <= s.length; i++) needles.add(s.slice(i, i + 8));
    }
    const hits: string[] = [];
    for (const line of haystack) for (const n of needles) if (line.includes(n)) hits.push(`${n} in ${line}`);
    expect(hits).toEqual([]);
    expect(run.secrets.size).toBeGreaterThan(40);
  });

  test("every line is JSON with a LogEvent event; push events carry only allowlisted keys", () => {
    expect(events.size).toBeGreaterThan(40);
    for (const line of run.lines) {
      const p = JSON.parse(line) as Parsed;
      expect(events.has(p.event)).toBe(true);
      if (!p.event.startsWith("push_")) continue;
      const allowed = PUSH_EVENT_KEYS[p.event];
      expect(allowed).toBeDefined();
      for (const k of Object.keys(p)) expect([...ENVELOPE_KEYS, ...allowed!]).toContain(k);
    }
  });

  test("push_internal_error lines carry exactly {ts, event, ok, route}", () => {
    const errors = run.lines.map((l) => JSON.parse(l) as Parsed).filter((p) => p.event === "push_internal_error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    for (const e of errors) expect(Object.keys(e).sort()).toEqual(["event", "ok", "route", "ts"]);
    expect(errors.map((e) => e.route)).toContain(PUSH_PATHS.adminDevices);
  });

  test("the store is the single emitter of removals and their counters", () => {
    const removed = run.lines.map((l) => JSON.parse(l) as Parsed).filter((p) => p.event === "push_device_removed");
    expect(removed).toHaveLength(run.removedIds.size);
    for (const [id, reason] of run.removedIds) {
      const mine = removed.filter((p) => p.deviceId === id);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.reason).toBe(reason);
    }
    const only = (event: string): Record<string, number> =>
      Object.fromEntries(PUSH_PAIRING_EVENTS.map((e) => [e, e === event ? 1 : 0]));
    expect(run.pairingDeltas.revoke).toEqual(only("revoked"));
    expect(run.pairingDeltas["dead-token"]!.removed_dead).toBe(1);
    expect(run.pairingDeltas.self).toEqual(only("__none__"));
    expect(run.pairingDeltas.superseded).toEqual(only("__none__"));
    // The expiry measure also covers one issue and one redemption.
    expect(run.pairingDeltas.expired).toEqual({ ...only("expired"), issued: 1, redeemed: 1 });
    const s = samples(run.metrics);
    expect(s.get('pulse_web_push_pairing_events_total{event="removed_dead"}')).toBe(5);
  });

  test("rate-limited delivery lines stay bounded while the counters count every item", () => {
    const parsed = run.lines.map((l) => JSON.parse(l) as Parsed);
    const limited = parsed.filter(
      (p) => (p.event === "push_delivery_failed" || p.event === "push_delivery_dropped") && p.deviceId === run.limitedDevice,
    );
    expect(limited.length).toBeGreaterThanOrEqual(1);
    expect(limited.length).toBeLessThanOrEqual(Math.ceil(run.limitedElapsedMs / PUSH_LIMITS.deliveryFailedLogIntervalMs));
    const s = samples(run.metrics);
    const dropped = PUSH_NOTIFICATION_KINDS.reduce(
      (n, k) => n + (s.get(`pulse_web_push_notifications_total{kind="${k}",outcome="dropped"}`) ?? 0),
      0,
    );
    expect(dropped).toBe(run.limitedItems);
    // The permanently failing device: five failures counted, one line inside the minute.
    const failLines = parsed.filter((p) => p.event === "push_delivery_failed" && p.deviceId === run.failDevice);
    expect(failLines).toHaveLength(1);
  });

  test("metric union: every series of the closed push label sets is > 0, except the justified exclusions", () => {
    const s = samples(run.metrics);
    const expected: string[] = [
      ...PUSH_WEBHOOK_OUTCOMES.map((o) => `pulse_web_push_webhook_total{outcome="${o}"}`),
      ...PUSH_PAIRING_EVENTS.map((e) => `pulse_web_push_pairing_events_total{event="${e}"}`),
      ...PUSH_NOTIFICATION_KINDS.flatMap((k) =>
        PUSH_NOTIFICATION_OUTCOMES.map((o) => `pulse_web_push_notifications_total{kind="${k}",outcome="${o}"}`),
      ),
      "pulse_web_push_admin_refusals_total",
    ];
    for (const ex of UNION_EXCLUSIONS) expect(expected).toContain(ex);
    const missing = expected.filter((series) => !UNION_EXCLUSIONS.has(series) && !((s.get(series) ?? 0) > 0));
    expect(missing).toEqual([]);
    // Every series of the closed sets is rendered (zero-initialised), excluded ones included.
    for (const series of expected) expect(s.has(series)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Disabled run
// ---------------------------------------------------------------------------------------------------------------

describe("push log safety: disabled run", () => {
  let dir: string | null = null;
  let push: PushRuntime | null = null;
  let runtime: ServerRuntime | null = null;

  afterEach(async () => {
    stopCapture();
    runtime?.close();
    await push?.close();
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
    push = null;
    runtime = null;
    __resetMetricsForTest();
    __resetCapabilityProvidersForTest();
  });

  test("no push line, no PULSE_PUSH_* warning, and only the 5 disabled metric lines", async () => {
    __resetMetricsForTest();
    startCapture();
    dir = mkdtempSync(join(tmpdir(), "pulse-push-logsafety-off-"));
    const env = baseEnv(dir);
    delete env[PUSH_ENV.dataDir];
    const cfg = loadServerConfig(env);
    push = await buildPushRuntime(cfg);
    runtime = createServerRuntime(cfg, { fetchImpl: DOWN_FETCH });
    push.attachRuntime(runtime);
    const call = caller(push, runtime);
    expect((await call("POST", PUSH_PATHS.webhook, JSON_TYPE, amNotification())).status).toBe(405);
    expect((await call("GET", PUSH_PATHS.status)).status).toBe(404);
    const metrics = await (await call("GET", "/metrics")).text();
    stopCapture();

    const parsed = parsedLines();
    expect(parsed.filter((p) => p.event.startsWith("push_"))).toEqual([]);
    expect(
      parsed.filter((p) => p.event === "config_warning" && JSON.stringify(p).includes("PULSE_PUSH_")),
    ).toEqual([]);
    expect(metrics.split("\n").filter((l) => l.includes("pulse_web_push_"))).toEqual([
      "# HELP pulse_web_push_state Push gateway state; 1 on the current state (disabled, configured, misconfigured).",
      "# TYPE pulse_web_push_state gauge",
      'pulse_web_push_state{state="disabled"} 1',
      'pulse_web_push_state{state="configured"} 0',
      'pulse_web_push_state{state="misconfigured"} 0',
    ]);
  });
});
