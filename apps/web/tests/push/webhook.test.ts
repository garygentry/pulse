// apps/web/tests/push/webhook.test.ts — the Alertmanager webhook parser and the webhook handler, called directly.

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";

import type { DeviceQueues } from "../../src/server/push/dispatch/queue.js";
import { handleWebhook, webhookOutcomeFor, type WebhookDeps } from "../../src/server/push/handlers/webhook.js";
import { createIntake, type Intake } from "../../src/server/push/intake.js";
import { createNotifiedMemory } from "../../src/server/push/memory.js";
import type { PlannedNotification } from "../../src/server/push/plan.js";
import type { DeviceRecord } from "../../src/server/push/registry/schema.js";
import type { DeviceStore } from "../../src/server/push/registry/store.js";
import { loadPushSecret, type PushSecret } from "../../src/server/push/secrets.js";
import { ownLabel, parseAlertmanagerWebhook, withinLabelBytes } from "../../src/server/push/webhook.js";
import { getRuntimeStatus } from "../../src/server/refresh.js";
import {
  PUSH_WEBHOOK_OUTCOMES,
  __resetMetricsForTest,
  renderMetrics,
  setPushMetricsProvider,
} from "../../src/server/routes/metrics.js";
import { createFakeClock, createFakeTimers, type FakeTimers } from "./helpers/fakes.js";
import { amAlert, amNotification } from "./helpers/am-fixtures.js";

const URL_PATH = "http://127.0.0.1/api/push/alertmanager";
const SECRET_TEXT = "webhook-secret-for-tests-0123456789-abcdef";
const UTF8 = new TextEncoder();

function encode(value: unknown): Uint8Array {
  return UTF8.encode(JSON.stringify(value));
}

function fp(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function parse(value: unknown): ReturnType<typeof parseAlertmanagerWebhook> {
  return parseAlertmanagerWebhook(encode(value));
}

/** A plain-object v4 body (no fixture-only members beyond what Alertmanager sends). */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(JSON.parse(JSON.stringify(amNotification())) as Record<string, unknown>), ...overrides };
}

function alertBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return body({ alerts: [{ ...(JSON.parse(JSON.stringify(amAlert())) as Record<string, unknown>), ...overrides }] });
}

describe("parseAlertmanagerWebhook", () => {
  test("a valid body with unknown members parses and drops them", () => {
    const raw = body({ futureField: 1 });
    (raw["alerts"] as Array<Record<string, unknown>>)[0]!["extra"] = { nested: true };
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const n = r.notification;
    expect(Object.keys(n).sort()).toEqual(["alerts", "groupKey", "status", "truncatedAlerts", "version"]);
    expect(Object.keys(n.alerts[0]!).sort()).toEqual(["annotations", "fingerprint", "labels", "startsAt", "status"]);
    expect(n.version).toBe("4");
    expect(n.alerts[0]!.labels).toEqual({
      alertname: "HostDown",
      severity: "critical",
      instance: "web-01.example.com",
    });
    expect(Object.isFrozen(n)).toBe(true);
    expect(Object.isFrozen(n.alerts)).toBe(true);
    expect(Object.isFrozen(n.alerts[0])).toBe(true);
    expect(Object.isFrozen(n.alerts[0]!.labels)).toBe(true);
  });

  test("a missing endsAt parses", () => {
    const raw = body();
    delete (raw["alerts"] as Array<Record<string, unknown>>)[0]!["endsAt"];
    expect(parse(raw).ok).toBe(true);
  });

  test("an empty alerts array parses", () => {
    const r = parse(body({ alerts: [] }));
    expect(r.ok && r.notification.alerts.length).toBe(0);
  });

  test("a missing truncatedAlerts defaults to 0; -1 is invalid-body", () => {
    const raw = body();
    delete raw["truncatedAlerts"];
    const r = parse(raw);
    expect(r.ok && r.notification.truncatedAlerts).toBe(0);
    const seven = parse(body({ truncatedAlerts: 7 }));
    expect(seven.ok && seven.notification.truncatedAlerts).toBe(7);
    const neg = parse(body({ truncatedAlerts: -1 }));
    expect(neg).toEqual({ ok: false, refusal: "invalid-body", fields: "truncatedAlerts" });
  });

  test("version \"3\" and 4 (number) are unsupported-version", () => {
    expect(parse(body({ version: "3" }))).toEqual({ ok: false, refusal: "unsupported-version" });
    expect(parse(body({ version: 4 }))).toEqual({ ok: false, refusal: "unsupported-version" });
  });

  test("a missing version is invalid-body with fields version", () => {
    const raw = body();
    delete raw["version"];
    expect(parse(raw)).toEqual({ ok: false, refusal: "invalid-body", fields: "version" });
  });

  test("2048 alerts parse; 2049 are body-too-large", () => {
    const alerts = (n: number) =>
      Array.from({ length: n }, (_, i) => JSON.parse(JSON.stringify(amAlert({ fingerprint: fp(i) }))) as unknown);
    const ok = parse(body({ alerts: alerts(2048) }));
    expect(ok.ok && ok.notification.alerts.length).toBe(2048);
    expect(parse(body({ alerts: alerts(2049) }))).toEqual({ ok: false, refusal: "body-too-large" });
  });

  test("a 1024-byte label value parses; 1025 bytes is body-too-large", () => {
    const at = "é".repeat(512);
    expect(UTF8.encode(at).length).toBe(1024);
    expect(withinLabelBytes(at)).toBe(true);
    expect(parse(alertBody({ labels: { alertname: "HostDown", target: at } })).ok).toBe(true);

    const over = `${at}a`;
    expect(withinLabelBytes(over)).toBe(false);
    expect(parse(alertBody({ labels: { alertname: "HostDown", target: over } }))).toEqual({
      ok: false,
      refusal: "body-too-large",
    });
    // A short ASCII value and an over-long ASCII value take the fast paths.
    expect(withinLabelBytes("a".repeat(341))).toBe(true);
    expect(withinLabelBytes("a".repeat(1025))).toBe(false);
  });

  test("an uppercase or 15-hex fingerprint is invalid-body", () => {
    for (const fingerprint of ["3F9A1C2B4D5E6F70", "3f9a1c2b4d5e6f7"]) {
      const r = parse(alertBody({ fingerprint }));
      expect(r).toEqual({ ok: false, refusal: "invalid-body", fields: "alerts.0.fingerprint" });
    }
  });

  test("a non-string label value and non-object annotations are invalid-body", () => {
    const label = parse(alertBody({ labels: { alertname: "HostDown", severity: 1 } }));
    expect(label.ok).toBe(false);
    if (!label.ok) {
      expect(label.refusal).toBe("invalid-body");
      expect(label.fields).toContain("alerts.0.labels");
    }
    const annotations = parse(alertBody({ annotations: "Host is down" }));
    expect(annotations).toEqual({ ok: false, refusal: "invalid-body", fields: "alerts.0.annotations" });
  });

  test("invalid UTF-8, bad JSON and non-object bodies are invalid-body", () => {
    expect(parseAlertmanagerWebhook(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))).toEqual({
      ok: false,
      refusal: "invalid-body",
    });
    expect(parseAlertmanagerWebhook(UTF8.encode("{not json"))).toEqual({ ok: false, refusal: "invalid-body" });
    for (const value of [null, [], "4", 4]) {
      expect(parse(value)).toEqual({ ok: false, refusal: "invalid-body", fields: "$" });
    }
  });

  test("a body over the byte cap is body-too-large before decoding", () => {
    expect(parseAlertmanagerWebhook(new Uint8Array(1_048_577))).toEqual({ ok: false, refusal: "body-too-large" });
  });

  test("a __proto__ label key does not affect ownLabel", () => {
    const text = JSON.stringify(alertBody({ labels: { alertname: "HostDown" } })).replace(
      '"labels":{"alertname":"HostDown"}',
      '"labels":{"__proto__":"critical","alertname":"HostDown"}',
    );
    expect(text).toContain('"__proto__":"critical"');
    const r = parseAlertmanagerWebhook(UTF8.encode(text));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const labels = r.notification.alerts[0]!.labels;
    expect(ownLabel(labels, "severity")).toBeUndefined();
    expect(ownLabel(labels, "alertname")).toBe("HostDown");
    expect(ownLabel(labels, "toString")).toBeUndefined();
    expect(Object.getPrototypeOf(labels)).toBe(Object.prototype);

    // Even a map carrying an own __proto__ key never aliases another label.
    const own = JSON.parse('{"__proto__":{"severity":"info"},"alertname":"HostDown"}') as Record<string, string>;
    expect(ownLabel(own, "severity")).toBeUndefined();
  });
});

describe("webhookOutcomeFor", () => {
  test("maps the webhook refusals to their outcomes", () => {
    expect(webhookOutcomeFor("body-too-large")).toBe("too_large");
    expect(webhookOutcomeFor("invalid-body")).toBe("malformed");
    expect(webhookOutcomeFor("unsupported-version")).toBe("malformed");
    expect(webhookOutcomeFor("unavailable")).toBe("unavailable");
    expect(webhookOutcomeFor("unauthorized")).toBe("unauthorized");
    expect(webhookOutcomeFor("internal")).toBeNull();
    expect(webhookOutcomeFor("not-found")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Handler

function loadSecret(): PushSecret {
  const r = loadPushSecret({ PULSE_PUSH_WEBHOOK_SECRET: SECRET_TEXT }, "PULSE_PUSH_WEBHOOK_SECRET");
  if (!r.ok) throw new Error("test secret refused");
  return r.secret;
}

function device(n: number, token: string | null): DeviceRecord {
  return {
    id: `dev_Test${n.toString(36).padStart(7, "0")}`,
    displayName: `Example iPhone ${n}`,
    credentialHash: n.toString(16).padStart(64, "0"),
    apnsToken: token,
    environment: token === null ? null : "sandbox",
    preferences: { critical: true, warning: true, info: true },
    pairedAt: "2026-10-01T00:00:00.000Z",
    seenAt: "2026-10-01T00:00:00.000Z",
    lastDelivery: null,
  };
}

function stubStore(devices: readonly DeviceRecord[]): DeviceStore {
  return { list: () => devices } as unknown as DeviceStore;
}

interface HandlerRig {
  readonly deps: WebhookDeps & { available: true };
  readonly intake: Intake;
  readonly submits: unknown[];
  readonly enqueued: PlannedNotification[][];
  readonly timers: FakeTimers;
}

function handlerRig(devices: readonly DeviceRecord[] = []): HandlerRig {
  const clock = createFakeClock(Date.parse("2026-11-20T10:00:00.000Z"));
  const timers = createFakeTimers(clock);
  const enqueued: PlannedNotification[][] = [];
  const queues: DeviceQueues = {
    enqueue: (items) => void enqueued.push([...items]),
    drop: () => undefined,
    idle: async () => undefined,
    close: () => undefined,
  };
  const store = stubStore(devices);
  const real = createIntake({ store, memory: createNotifiedMemory(), queues, badge: () => 1, clock, timers });
  const submits: unknown[] = [];
  const intake: Intake = {
    submit: (n) => {
      submits.push(n);
      real.submit(n);
    },
    pending: () => real.pending(),
    idle: () => real.idle(),
    close: () => real.close(),
  };
  return { deps: { available: true, secret: loadSecret(), intake, store }, intake, submits, enqueued, timers };
}

interface RequestOpts {
  readonly auth?: string | null;
  readonly type?: string | null;
  readonly body?: BodyInit;
  readonly headers?: Record<string, string>;
}

function webhookRequest(opts: RequestOpts = {}): Request {
  const headers = new Headers(opts.headers ?? {});
  const auth = opts.auth === undefined ? `Bearer ${SECRET_TEXT}` : opts.auth;
  if (auth !== null) headers.set("Authorization", auth);
  const type = opts.type === undefined ? "application/json" : opts.type;
  if (type !== null) headers.set("Content-Type", type);
  return new Request(URL_PATH, {
    method: "POST",
    headers,
    body: opts.body ?? JSON.stringify(amNotification()),
  });
}

let logSpy: Mock<typeof console.log>;

function events(name: string): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((args) => JSON.parse(String(args[0])) as Record<string, unknown>)
    .filter((e) => e.event === name);
}

function webhookCounts(): Record<string, number> {
  setPushMetricsProvider(() => ({ state: "configured", devices: 0, lastSuccessAtMs: null }));
  const out: Record<string, number> = {};
  for (const line of renderMetrics(getRuntimeStatus(), Date.now()).split("\n")) {
    const m = /^pulse_web_push_webhook_total\{outcome="([a-z_]+)"\} (\d+)$/.exec(line);
    if (m !== null) out[m[1] as string] = Number(m[2]);
  }
  return out;
}

function onlyCount(outcome: string): Record<string, number> {
  return { ...Object.fromEntries(PUSH_WEBHOOK_OUTCOMES.map((o) => [o, 0])), [outcome]: 1 };
}

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const args of logSpy.mock.calls) expect(String(args[0]).includes(SECRET_TEXT)).toBe(false);
  logSpy.mockRestore();
  setPushMetricsProvider(null);
  __resetMetricsForTest();
});

interface Row {
  readonly name: string;
  readonly deps?: "unavailable";
  readonly request: () => Request;
  readonly status: number;
  readonly code: string;
  readonly outcome: string;
  readonly fields?: string;
}

const tooManyAlerts = (): string =>
  JSON.stringify(
    amNotification({ alerts: Array.from({ length: 2049 }, (_, i) => amAlert({ fingerprint: fp(i) })) }),
  );

const ROWS: readonly Row[] = [
  { name: "push unavailable", deps: "unavailable", request: () => webhookRequest(), status: 503, code: "PUSH_UNAVAILABLE", outcome: "unavailable" },
  { name: "missing secret", request: () => webhookRequest({ auth: null }), status: 401, code: "UNAUTHORIZED", outcome: "unauthorized" },
  { name: "wrong secret", request: () => webhookRequest({ auth: `Bearer ${SECRET_TEXT}x` }), status: 401, code: "UNAUTHORIZED", outcome: "unauthorized" },
  { name: "wrong media type", request: () => webhookRequest({ type: "text/plain" }), status: 400, code: "INVALID_REQUEST", outcome: "malformed" },
  { name: "missing media type", request: () => webhookRequest({ type: null }), status: 400, code: "INVALID_REQUEST", outcome: "malformed" },
  {
    name: "declared Content-Length over 1 MiB",
    request: () => webhookRequest({ headers: { "Content-Length": "1048577" } }),
    status: 413,
    code: "PAYLOAD_TOO_LARGE",
    outcome: "too_large",
  },
  {
    name: "streamed body over 1 MiB",
    request: () => webhookRequest({ body: " ".repeat(1_048_577) }),
    status: 413,
    code: "PAYLOAD_TOO_LARGE",
    outcome: "too_large",
  },
  {
    name: "malformed Content-Length",
    request: () => webhookRequest({ headers: { "Content-Length": "12abc" } }),
    status: 400,
    code: "INVALID_REQUEST",
    outcome: "malformed",
  },
  { name: "bad JSON", request: () => webhookRequest({ body: "{not json" }), status: 400, code: "INVALID_REQUEST", outcome: "malformed" },
  {
    name: "schema failure",
    request: () => webhookRequest({ body: JSON.stringify(alertBody({ fingerprint: "XYZ" })) }),
    status: 400,
    code: "INVALID_REQUEST",
    outcome: "malformed",
    fields: "alerts.0.fingerprint",
  },
  {
    name: "unsupported version",
    request: () => webhookRequest({ body: JSON.stringify(body({ version: "3" })) }),
    status: 400,
    code: "INVALID_REQUEST",
    outcome: "malformed",
  },
  { name: "2049 alerts", request: () => webhookRequest({ body: tooManyAlerts() }), status: 413, code: "PAYLOAD_TOO_LARGE", outcome: "too_large" },
  {
    name: "label value over 1024 bytes",
    request: () => webhookRequest({ body: JSON.stringify(alertBody({ labels: { target: "é".repeat(513) } })) }),
    status: 413,
    code: "PAYLOAD_TOO_LARGE",
    outcome: "too_large",
  },
];

describe("handleWebhook", () => {
  for (const row of ROWS) {
    test(`${row.name} → ${row.status} ${row.code}, one ${row.outcome}`, async () => {
      const rig = handlerRig([device(1, "ab".repeat(32))]);
      const deps: WebhookDeps = row.deps === "unavailable" ? { available: false } : rig.deps;
      const res = await handleWebhook({ request: row.request(), peerIp: "127.0.0.1" }, deps);
      expect(res.status).toBe(row.status);
      expect(res.status).not.toBe(415);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      const parsed = (await res.json()) as { code: string; details?: { fields?: string } };
      expect(parsed.code).toBe(row.code);
      if (row.fields !== undefined) expect(parsed.details?.fields).toBe(row.fields);
      if (row.outcome === "unauthorized") expect(parsed.details).toBeUndefined();
      expect(webhookCounts()).toEqual(onlyCount(row.outcome));
      // Refused calls never reach the intake and log no receipt.
      expect(rig.submits).toEqual([]);
      expect(rig.intake.pending()).toBe(0);
      expect(rig.timers.pending()).toBe(0);
      expect(events("push_webhook_received")).toEqual([]);
    });
  }

  test("accepted → 202 exactly {\"accepted\":true}, before any planning", async () => {
    const rig = handlerRig([device(1, "ab".repeat(32)), device(2, null), device(3, "cd".repeat(32))]);
    const res = await handleWebhook({ request: webhookRequest(), peerIp: null }, rig.deps);
    expect(res.status).toBe(202);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await res.text()).toBe('{"accepted":true}');
    // Returned while the call is still pending and nothing has been enqueued.
    expect(rig.intake.pending()).toBe(1);
    expect(rig.submits.length).toBe(1);
    expect(rig.enqueued).toEqual([]);
    expect(webhookCounts()).toEqual(onlyCount("accepted"));
    const received = events("push_webhook_received");
    expect(received.length).toBe(1);
    expect(received[0]).toMatchObject({ ok: true, alerts: 1, truncatedAlerts: 0, devices: 2 });

    rig.timers.runDue();
    expect(rig.intake.pending()).toBe(0);
    expect(rig.enqueued.length).toBe(1);
    expect(rig.enqueued[0]!.map((p) => p.deviceId).sort()).toEqual([device(1, null).id, device(3, null).id]);
  });

  test("zero devices → 202, accepted counted, devices: 0, nothing enqueued or filtered", async () => {
    const rig = handlerRig([]);
    const res = await handleWebhook(
      { request: webhookRequest({ body: JSON.stringify(amNotification({ truncatedAlerts: 3 })) }), peerIp: null },
      rig.deps,
    );
    expect(res.status).toBe(202);
    expect(webhookCounts()).toEqual(onlyCount("accepted"));
    const received = events("push_webhook_received");
    expect(received.length).toBe(1);
    expect(Object.keys(received[0]!).sort()).toEqual(["alerts", "devices", "event", "ok", "truncatedAlerts", "ts"]);
    expect(received[0]).toMatchObject({ alerts: 1, truncatedAlerts: 3, devices: 0 });

    rig.timers.runDue();
    expect(rig.enqueued).toEqual([]);
    setPushMetricsProvider(() => ({ state: "configured", devices: 0, lastSuccessAtMs: null }));
    const text = renderMetrics(getRuntimeStatus(), Date.now());
    expect(text).not.toMatch(/^pulse_web_push_notifications_total\{[^}]*\} [1-9]/m);
  });

  test("the receipt log carries no labels, group key, fingerprints or annotations", async () => {
    const rig = handlerRig([device(1, "ab".repeat(32))]);
    await handleWebhook({ request: webhookRequest(), peerIp: null }, rig.deps);
    for (const args of logSpy.mock.calls) {
      const line = String(args[0]);
      for (const leak of ["HostDown", "web-01.example.com", "0123456789abcdef", "alertname", "groupKey"]) {
        expect(line.includes(leak)).toBe(false);
      }
    }
  });
});
