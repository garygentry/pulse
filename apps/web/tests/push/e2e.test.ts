// End-to-end push delivery through the in-process server harness and the fake APNs, in real time with bounded waits.
// The first block walks success criterion 2 in order (pair, register, firing, repeat, resolution, muted severity,
// summary, dead token). The second walks criterion 4: each refusal is answered with its status and counted once.

import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import { __resetCapabilityProvidersForTest } from "@pulse/web-data/contract";

import { PUSH_LIMITS, PUSH_PATHS } from "../../src/server/push/constants.js";
import { __resetMetricsForTest } from "../../src/server/routes/metrics.js";
import { amAlert, amNotification } from "./helpers/am-fixtures.js";
import type { FakeApnsRequest } from "./helpers/fake-apns.js";
import { startPushTestServer, STUB_CYCLE_ALERTS, type PushTestServer } from "./helpers/push-server.js";
import { createTestTls } from "./helpers/tls.js";

const tls = createTestTls();
/** Per-test bound; the whole file stays well under 30 s. */
const TEST_TIMEOUT_MS = 12_000;
/** Bound on any single wait for an asynchronous delivery effect. */
const WAIT_MS = 4_000;
/** Quiet period used to show that nothing more is sent. */
const QUIET_MS = 200;

const JSON_TYPE = { "content-type": "application/json" } as const;

let server: PushTestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  __resetMetricsForTest();
  __resetCapabilityProvidersForTest();
});

async function waitFor(cond: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = performance.now() + WAIT_MS;
  while (!(await cond())) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

function requestsFor(srv: PushTestServer, token: string): FakeApnsRequest[] {
  return srv.apns.requests.filter((r) => r.path === `/3/device/${token}`);
}

interface Aps {
  readonly category: string;
  readonly "interruption-level": string;
  readonly sound?: string;
  readonly badge?: number;
}
function apsOf(r: FakeApnsRequest): Aps {
  return (r.body as { aps: Aps }).aps;
}

async function metric(srv: PushTestServer, series: string): Promise<number> {
  const res = await srv.handler(new Request(`${srv.baseUrl}/metrics`));
  const line = (await res.text()).split("\n").find((l) => l.startsWith(`${series} `));
  return line === undefined ? 0 : Number(line.slice(series.length + 1));
}

function call(srv: PushTestServer, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return srv.handler(new Request(`${srv.baseUrl}${path}`, init));
}

function putDevice(srv: PushTestServer, credential: string, apnsToken: string, warning = true) {
  return call(srv, "PUT", PUSH_PATHS.device, { ...JSON_TYPE, authorization: `Bearer ${credential}` }, {
    apnsToken,
    environment: "sandbox",
    preferences: { critical: true, warning, info: true },
  });
}

function redeem(srv: PushTestServer, token: string) {
  return call(srv, "POST", PUSH_PATHS.redeem, JSON_TYPE, { token, displayName: "Example iPad" });
}

async function adminDeviceIds(srv: PushTestServer): Promise<string[]> {
  const res = await call(srv, "GET", PUSH_PATHS.adminDevices, { authorization: `Bearer ${srv.secrets.operator}` });
  expect(res.status).toBe(200);
  return ((await res.json()) as { devices: { id: string }[] }).devices.map((d) => d.id);
}

const FP_A = "a000000000000001";
const FP_W = "b000000000000001";
const FP_B = "c000000000000001";

describe.skipIf(tls === null)(`push end to end: criterion 2${tls === null ? " (skipped: openssl missing)" : ""}`, () => {
  test(
    "pair, register, firing, repeat, resolution, muted, summary and a dead token, in order",
    async () => {
      const srv = (server = await startPushTestServer({ runtime: "stub-cycle" }));
      const apnsToken = randomBytes(32).toString("hex");

      // 1. Issue a token, take it from the link, redeem, register.
      const { link, token } = await srv.pair();
      expect(new URL(link).searchParams.get("pair")).toBe(token);
      const { deviceId, credential } = await srv.register(link, { apnsToken });
      expect(await adminDeviceIds(srv)).toEqual([deviceId]);

      // 2. A firing critical alert: time-sensitive, a sound and the badge.
      const firing = amNotification({ alerts: [amAlert({ fingerprint: FP_A })] });
      expect((await srv.webhook(firing)).status).toBe(202);
      await waitFor(() => requestsFor(srv, apnsToken).length === 1, "the firing delivery");
      const first = requestsFor(srv, apnsToken)[0]!;
      expect(first.jwtValid).toBe(true);
      expect(apsOf(first)["interruption-level"]).toBe("time-sensitive");
      expect(apsOf(first).sound).toBe("default");
      expect(apsOf(first).badge).toBe(STUB_CYCLE_ALERTS);
      expect(apsOf(first).category).toBe("PULSE_ALERT_FIRING");
      expect(first.headers["apns-priority"]).toBe("10");
      const collapseId = first.headers["apns-collapse-id"];
      expect(collapseId).toBe(`a-${FP_A}`);

      // 3. The repeat is quiet.
      expect((await srv.webhook(firing)).status).toBe(202);
      await waitFor(() => requestsFor(srv, apnsToken).length === 2, "the repeat delivery");
      const repeat = requestsFor(srv, apnsToken)[1]!;
      expect(apsOf(repeat).sound).toBeUndefined();
      expect(repeat.headers["apns-priority"]).toBe("5");
      expect(repeat.headers["apns-collapse-id"]).toBe(collapseId);

      // 4. The resolution replaces it under the same collapse id.
      const resolved = amNotification({ alerts: [amAlert({ fingerprint: FP_A, status: "resolved" })] });
      expect((await srv.webhook(resolved)).status).toBe(202);
      await waitFor(() => requestsFor(srv, apnsToken).length === 3, "the resolution delivery");
      const resolution = requestsFor(srv, apnsToken)[2]!;
      expect(apsOf(resolution).category).toBe("PULSE_ALERT_RESOLVED");
      expect(apsOf(resolution).sound).toBeUndefined();
      expect(resolution.headers["apns-collapse-id"]).toBe(collapseId);

      // 5. A muted severity is not sent (counted as filtered instead).
      expect((await putDevice(srv, credential, apnsToken, false)).status).toBe(200);
      const filteredBefore = await metric(srv, 'pulse_web_push_notifications_total{kind="firing",outcome="filtered"}');
      const warning = amNotification({ alerts: [amAlert({ fingerprint: FP_W, severity: "warning" })] });
      expect((await srv.webhook(warning)).status).toBe(202);
      await waitFor(
        async () =>
          (await metric(srv, 'pulse_web_push_notifications_total{kind="firing",outcome="filtered"}')) ===
          filteredBefore + 1,
        "the filtered count",
      );
      await Bun.sleep(QUIET_MS);
      expect(requestsFor(srv, apnsToken)).toHaveLength(3);

      // 6. A group of 6 alerts produces exactly one summary.
      const six = Array.from({ length: PUSH_LIMITS.summaryThreshold + 1 }, (_, i) =>
        amAlert({ name: `HostDown${i}`, fingerprint: `d00000000000000${i}` }),
      );
      expect((await srv.webhook(amNotification({ alerts: six, groupKey: '{}:{alertname=~"HostDown.*"}' }))).status).toBe(
        202,
      );
      await waitFor(() => requestsFor(srv, apnsToken).length === 4, "the summary delivery");
      await Bun.sleep(QUIET_MS);
      expect(requestsFor(srv, apnsToken)).toHaveLength(4);
      const summary = requestsFor(srv, apnsToken)[3]!;
      expect(apsOf(summary).category).toBe("PULSE_ALERT_SUMMARY");
      expect(summary.headers["apns-collapse-id"]).toMatch(/^g-[0-9a-f]{16}$/);

      // 7. A 410 removes the device.
      const deadBefore = await metric(srv, 'pulse_web_push_pairing_events_total{event="removed_dead"}');
      const removedBefore = await metric(srv, 'pulse_web_push_notifications_total{kind="firing",outcome="token_removed"}');
      srv.apns.script(apnsToken, { kind: "status", status: 410, reason: "Unregistered" });
      expect((await srv.webhook(amNotification({ alerts: [amAlert({ fingerprint: FP_B })] }))).status).toBe(202);
      await waitFor(async () => (await adminDeviceIds(srv)).length === 0, "the dead-token removal");
      expect(requestsFor(srv, apnsToken)).toHaveLength(5);
      expect(await metric(srv, 'pulse_web_push_pairing_events_total{event="removed_dead"}')).toBe(deadBefore + 1);
      expect(
        await metric(srv, 'pulse_web_push_notifications_total{kind="firing",outcome="token_removed"}'),
      ).toBe(removedBefore + 1);
      // The removed credential no longer authenticates.
      expect((await putDevice(srv, credential, apnsToken)).status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );
});

describe.skipIf(tls === null)(`push end to end: criterion 4${tls === null ? " (skipped: openssl missing)" : ""}`, () => {
  test(
    "a webhook without the secret, a reused token, an expired token and a revoked credential are refused and counted",
    async () => {
      let skewMs = 0;
      const srv = (server = await startPushTestServer({ clock: { nowMs: () => Date.now() + skewMs } }));
      const unauthorized = 'pulse_web_push_webhook_total{outcome="unauthorized"}';
      const refused = 'pulse_web_push_pairing_events_total{event="refused"}';
      const revoked = 'pulse_web_push_pairing_events_total{event="revoked"}';

      // Webhook without the secret: 401, unauthorized +1.
      const before = await metric(srv, unauthorized);
      const noSecret = await call(srv, "POST", PUSH_PATHS.webhook, JSON_TYPE, amNotification());
      expect(noSecret.status).toBe(401);
      expect(((await noSecret.json()) as { code: string }).code).toBe("UNAUTHORIZED");
      expect(await metric(srv, unauthorized)).toBe(before + 1);

      // Reused token: the second redemption is 403, refused +1.
      const used = await srv.pair();
      await srv.register(used.link);
      const refusedBefore = await metric(srv, refused);
      const reused = await redeem(srv, used.token);
      expect(reused.status).toBe(403);
      const reusedBody = await reused.text();
      expect(await metric(srv, refused)).toBe(refusedBefore + 1);

      // Expired token: redeemed at issuedAt + ttl is 403 with the same body, refused +1.
      const stale = await srv.pair();
      skewMs += PUSH_LIMITS.tokenTtlMs;
      const expired = await redeem(srv, stale.token);
      expect(expired.status).toBe(403);
      expect(await expired.text()).toBe(reusedBody);
      expect(await metric(srv, refused)).toBe(refusedBefore + 2);

      // Revoked credential: the admin revoke counts revoked +1; the credential is then refused with 401.
      const fresh = await srv.pair();
      const device = await srv.register(fresh.link);
      const revokedBefore = await metric(srv, revoked);
      const revoke = await call(srv, "DELETE", PUSH_PATHS.adminDeviceById.replace(":id", device.deviceId), {
        authorization: `Bearer ${srv.secrets.operator}`,
      });
      expect(revoke.status).toBe(204);
      expect(await metric(srv, revoked)).toBe(revokedBefore + 1);
      const afterRevoke = await putDevice(srv, device.credential, randomBytes(32).toString("hex"));
      expect(afterRevoke.status).toBe(401);
      expect(((await afterRevoke.json()) as { code: string }).code).toBe("UNAUTHORIZED");
      expect(await metric(srv, revoked)).toBe(revokedBefore + 1);
      expect(await adminDeviceIds(srv)).not.toContain(device.deviceId);
    },
    TEST_TIMEOUT_MS,
  );
});
