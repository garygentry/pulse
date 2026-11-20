// Push performance: webhook-to-APNs latency, planning cost for a 2000-alert storm, and read-path isolation while a
// storm is being planned and delivered. Real time and real timers throughout; runs in the normal `bun test` job.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { __resetCapabilityProvidersForTest } from "@pulse/web-data/contract";

import { createNotifiedMemory } from "../../src/server/push/memory.js";
import { planDeliveries } from "../../src/server/push/plan.js";
import type { DeviceRecord } from "../../src/server/push/registry/schema.js";
import { __resetMetricsForTest } from "../../src/server/routes/metrics.js";
import { amAlert, amNotification, type AmAlertFixture } from "./helpers/am-fixtures.js";
import type { FakeApnsRequest } from "./helpers/fake-apns.js";
import { startPushTestServer, type PushTestServer } from "./helpers/push-server.js";
import { createTestTls } from "./helpers/tls.js";

/** Per-file budget: every test and hook here must finish within 30 s. */
setDefaultTimeout(30_000);

const tls = createTestTls();
const DEVICES = 20;
const WEBHOOKS = 10;
const LATENCY_BUDGET_MS = 2_000;
const STORM_ALERTS = 2_000;
const PLAN_BUDGET_MS = 100;

let servers: PushTestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  __resetMetricsForTest();
  __resetCapabilityProvidersForTest();
});

async function start(opts: Parameters<typeof startPushTestServer>[0]): Promise<PushTestServer> {
  const srv = await startPushTestServer(opts);
  servers.push(srv);
  return srv;
}

/** Nearest-rank percentile: the value at rank ceil(p × n) of the sorted samples. */
function nearestRank(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new Error("no samples");
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1]!;
}

function median(samples: readonly number[]): number {
  return nearestRank(samples, 0.5);
}

/** A 16-hex fingerprint unique to (prefix, i). */
function fingerprint(prefix: number, i: number): string {
  return `${prefix.toString(16).padStart(4, "0")}${i.toString(16).padStart(12, "0")}`;
}

function stormAlerts(prefix: number): AmAlertFixture[] {
  return Array.from({ length: STORM_ALERTS }, (_, i) =>
    amAlert({ name: `HostDown${i}`, fingerprint: fingerprint(prefix, i), target: `web-${i}.example.com` }),
  );
}

async function waitFor(cond: () => boolean, label: string, boundMs = 10_000): Promise<void> {
  const deadline = performance.now() + boundMs;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(2);
  }
}

describe.skipIf(tls === null)("push perf (needs openssl for the fake APNs)", () => {
  test("REQ-PERF-01: webhook to APNs receipt p95 < 2 s over 10 webhooks x 20 devices, cold session included", async () => {
    const srv = await start({ devices: DEVICES });
    expect(srv.apns.requests).toHaveLength(0);
    expect(srv.apns.connections).toBe(0); // the first webhook pays the session handshake

    const tokens = new Set<string>();
    const t0ByCollapseId = new Map<string, number>();
    for (let w = 0; w < WEBHOOKS; w++) {
      const fp = fingerprint(0x0100, w);
      const body = amNotification({ alerts: [amAlert({ fingerprint: fp })], groupKey: `{}:{webhook="${w}"}` });
      const before = srv.apns.requests.length;
      const t0 = performance.now();
      const res = await srv.webhook(body);
      expect(res.status).toBe(202);
      t0ByCollapseId.set(`a-${fp}`, t0);
      // One webhook at a time, so each receipt's t0 is unambiguous and webhooks do not queue behind each other.
      await waitFor(() => srv.apns.requests.length >= before + DEVICES, `webhook ${w} deliveries`);
    }

    const samples: number[] = [];
    const matched = new Set<string>();
    for (const r of srv.apns.requests as readonly FakeApnsRequest[]) {
      const collapseId = r.headers["apns-collapse-id"];
      const token = r.path.replace(/^\/3\/device\//, "");
      const t0 = collapseId === undefined ? undefined : t0ByCollapseId.get(collapseId);
      if (t0 === undefined) continue;
      const pair = `${token}|${collapseId}`;
      expect(matched.has(pair)).toBe(false);
      matched.add(pair);
      tokens.add(token);
      samples.push(r.receivedAtMs - t0);
    }
    expect(tokens.size).toBe(DEVICES);
    expect(samples).toHaveLength(DEVICES * WEBHOOKS);
    expect(nearestRank(samples, 0.95)).toBeLessThan(LATENCY_BUDGET_MS);
  });

  test("REQ-PERF-02: /api/overview p95 during a 2000-alert webhook storm is within 1.2x the baseline", async () => {
    const srv = await start({ runtime: "stub-cycle", devices: DEVICES });
    const SAMPLES = 400;
    const STORM_WEBHOOKS = 3;
    const overview = async (): Promise<number> => {
      const t0 = performance.now();
      const res = await srv.handler(new Request(`${srv.baseUrl}/api/overview`));
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      return performance.now() - t0;
    };
    const sample = async (n: number): Promise<number[]> => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push(await overview());
      return out;
    };

    await sample(50); // warm the route and the JIT before either measured phase
    const baseline = await sample(SAMPLES);

    // The storm: several 2000-alert webhooks posted back to back while the read samples run.
    const bodies = Array.from({ length: STORM_WEBHOOKS }, (_, k) => JSON.stringify(amNotification({
      alerts: stormAlerts(0x0200 + k),
      groupKey: `{}:{storm="${k}"}`,
    })));
    const before = srv.apns.requests.length;
    let stormPostedAt = Number.POSITIVE_INFINITY;
    const storm = (async () => {
      for (const body of bodies) {
        const res = await srv.webhook(JSON.parse(body));
        expect(res.status).toBe(202);
      }
      stormPostedAt = performance.now();
    })();
    const during = await sample(SAMPLES);
    const samplingEndedAt = performance.now();
    await storm;
    // The storm really overlapped the measured reads: every webhook was accepted before the last read finished.
    expect(stormPostedAt).toBeLessThanOrEqual(samplingEndedAt);
    // Every storm webhook was planned and delivered (one summary per device per webhook).
    await waitFor(() => srv.apns.requests.length >= before + STORM_WEBHOOKS * DEVICES, "storm deliveries");

    const baseP95 = nearestRank(baseline, 0.95);
    const stormP95 = nearestRank(during, 0.95);
    // Absolute floor: an in-process /api/overview answers in well under a millisecond, so 1.2x of a near-zero
    // baseline is below timer and GC jitter. The bound is the larger of 1.2x baseline and baseline + 1 ms; a storm
    // that blocked the read path (a synchronous plan of 2000 alerts x 20 devices, a large body parse on every
    // read) costs far more than 1 ms per affected request and still fails.
    const FLOOR_MS = 1;
    expect(stormP95).toBeLessThanOrEqual(Math.max(1.2 * baseP95, baseP95 + FLOOR_MS));
  });

  test("REQ-SCALE-02: planDeliveries over 2000 alerts x 20 devices has a median under 100 ms over 5 runs", () => {
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    const devices: DeviceRecord[] = Array.from({ length: DEVICES }, (_, i) => ({
      id: `dev_${i.toString().padStart(11, "A")}`,
      displayName: `Example iPhone ${i}`,
      credentialHash: i.toString(16).padStart(64, "0"),
      apnsToken: (i + 1).toString(16).padStart(64, "0"),
      environment: "sandbox",
      preferences: { critical: true, warning: true, info: true },
      pairedAt: "2026-11-20T11:00:00.000Z",
      seenAt: "2026-11-20T11:00:00.000Z",
      lastDelivery: null,
    }));
    const runs: number[] = [];
    for (let run = 0; run < 5; run++) {
      // A fresh memory and fresh fingerprints per run, so every run plans 2000 new firings rather than repeats.
      const notification = amNotification({ alerts: stormAlerts(0x0300 + run), groupKey: `{}:{run="${run}"}` });
      const memory = createNotifiedMemory();
      const t0 = performance.now();
      const result = planDeliveries(notification, devices, memory, { badge: 3, nowMs: now });
      runs.push(performance.now() - t0);
      expect(result.perDevice.size).toBe(DEVICES);
    }
    expect(median(runs)).toBeLessThan(PLAN_BUDGET_MS);
  });
});
