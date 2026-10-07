// apps/web/tests/mutations-perf.test.ts — mutation latency and publication-cadence budgets
// (10 §7.1, 03 §7.5, 04 §10.2; REQ-PERF-01, REQ-PERF-02).
//
// Only the heavy measurements are gated behind PULSE_REQUIRE_PERF=1 (`perfDescribe`). The structural
// PERF-02 (a) assertion — a never-settling slow-cycle hook does not stall publication — runs under
// plain `bun test`. This suite needs no browser and does not import browser/overview-browser.ts.
//
// Spec note: 10 §7.1 says reconcile is "never awaited on the publication path", but 06 §6.2
// (authoritative for refresh.ts) awaits reconcile before the fold so the same cycle publishes the
// post-clear state. Only the slow-cycle hook is fire-and-forget, so (a) proves that structurally and
// reconcile is bounded by the (b) latency budget instead.

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CycleState } from "@pulse/web-data/cycle";
import type { AlertmanagerAlert, SourceRecord } from "@pulse/web-data/sources";

import { loadServerConfig } from "../src/server/config.js";
import { createServerRuntime, type RuntimeDeps, type ServerRuntime } from "../src/server/refresh.js";
import { createAckStore, type AckFileV1, type AckRecord } from "../src/server/mutations/stores/ack-store.js";
import type { WritePath, WritePathSnapshot } from "../src/server/mutations/write-path.js";
import { resetWritePathProvider } from "../src/server/mutations/session-provider.js";
import { resetProposalStoreProvider } from "../src/server/mutations/stores/proposal-store.js";
import { __resetMetricsForTest } from "../src/server/routes/metrics.js";
import { makeEstateBundleFixture } from "./factories/estate-bundle.js";
import { FIXTURE_FINGERPRINTS, makeAlertsPayload } from "./alerts-fixtures.js";
import {
  fakeAlertmanagerFetch,
  trustedRequest,
  writeRuntimeFor,
  type WriteRuntimeHarness,
} from "./mutations-fixtures.js";

const perfDescribe = process.env.PULSE_REQUIRE_PERF === "1" ? describe : describe.skip;

/** PERF-01 per-request budget (ms). */
const MUTATION_P95_BUDGET_MS = 2_000;
/** PERF-02 (b) reconcile + foldView budget (ms). */
const RECONCILE_P95_BUDGET_MS = 50;

/** Nearest-rank p95 of a non-empty sample. */
function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

// Providers are process-global: every test resets them (10 §1).
afterEach(() => {
  resetWritePathProvider();
  resetProposalStoreProvider();
  __resetMetricsForTest();
});

// ── On-disk estate bundle + fake upstreams for createServerRuntime ───────────────────────────────

let bundleDir = "";
let modelPath = "";

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), "pulse-perf-bundle-"));
  modelPath = join(bundleDir, "web-estate-model.json");
  const files = makeEstateBundleFixture().files;
  const t = new Date(1_000_000);
  writeFileSync(modelPath, files.model);
  writeFileSync(join(bundleDir, "web-coverage.json"), files.coverage ?? "");
  writeFileSync(join(bundleDir, "web-findings.json"), files.findings ?? "");
  for (const name of ["web-estate-model.json", "web-coverage.json", "web-findings.json"]) {
    utimesSync(join(bundleDir, name), t, t);
  }
});

afterEach(() => {
  rmSync(bundleDir, { recursive: true, force: true });
});

function runtimeEnv(): Record<string, string | undefined> {
  return {
    PULSE_VM_URL: "http://victoriametrics:8428",
    PULSE_ALERTMANAGER_URL: "http://alertmanager:9093",
    PULSE_GATUS_URL: "http://gatus:8080",
    PULSE_VMALERT_URL: "http://vmalert:8880",
    PULSE_WEB_ESTATE_MODEL: modelPath,
  };
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** One Alertmanager data alert the source client parses. */
function amWireAlert(fingerprint: string): unknown {
  return {
    fingerprint,
    labels: { alertname: `Alert_${fingerprint}`, severity: "warning" },
    annotations: {},
    startsAt: "2026-01-01T00:00:00.000Z",
    endsAt: "2026-01-01T01:00:00.000Z",
    status: { state: "active", silencedBy: [], inhibitedBy: [] },
    receivers: [{ name: "default" }],
  };
}

/** Minimal valid bodies for every data + legacy upstream the cycle calls (no network). */
function upstreams(alerts: readonly string[] = ["fp-1", "fp-2"]): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const u = new URL(input.toString());
    const p = u.pathname;
    if (p === "/api/v1/query") return jsonOk({ status: "success", data: { resultType: "vector", result: [] } });
    if (p === "/api/v1/targets") return jsonOk({ status: "success", data: { activeTargets: [] } });
    if (p === "/api/v1/status/buildinfo") return jsonOk({ status: "success", data: { version: "1.102.1" } });
    if (p === "/api/v1/rules") return jsonOk({ status: "success", data: { groups: [] } });
    if (p === "/api/v2/status") return jsonOk({ versionInfo: { version: "0.27.0" }, cluster: { status: "ready" } });
    if (p === "/api/health") return jsonOk({ database: "ok", version: "11.4.0" });
    if (p === "/api/v2/alerts" && u.search.includes("silenced=true")) return jsonOk(alerts.map(amWireAlert));
    return jsonOk([]);
  };
  return impl as unknown as typeof fetch;
}

/** A fake chained timer + monotonic clock (the scheduler keeps exactly one pending timer). */
function fakeScheduler() {
  let clock = 0;
  let pending: (() => void) | null = null;
  const delays: number[] = [];
  const setTimer = ((cb: () => void, delay?: number) => {
    delays.push(delay ?? 0);
    pending = cb;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimer = (() => {
    pending = null;
  }) as unknown as typeof clearTimeout;
  return {
    delays,
    monotonicNow: () => clock,
    wallNow: () => new Date(1_700_000_000_000 + clock),
    setTimer,
    clearTimer,
    /** Advance the clock to the pending deadline, fire it, and yield until the scheduler re-arms. */
    async tick(stepMs: number): Promise<void> {
      clock += stepMs;
      const cb = pending;
      pending = null;
      if (cb === null) throw new Error("no pending timer");
      cb();
      for (let i = 0; i < 1_000 && pending === null; i++) await new Promise((r) => setTimeout(r, 0));
      if (pending === null) throw new Error("scheduler did not re-arm (publication stalled)");
    },
  };
}

interface Cadence {
  readonly delays: readonly number[];
  readonly published: ReadonlyArray<{ seq: number; observedAt: string }>;
}

/** Start a runtime on a fake scheduler, run `ticks` 10 s ticks, and record every publication. */
async function runCadence(ticks: number, extra: Pick<RuntimeDeps, "ackStore" | "onSlowCycle">): Promise<Cadence> {
  const sch = fakeScheduler();
  const runtime: ServerRuntime = createServerRuntime(loadServerConfig(runtimeEnv()), {
    fetchImpl: upstreams(),
    monotonicNow: sch.monotonicNow,
    wallNow: sch.wallNow,
    setTimer: sch.setTimer,
    clearTimer: sch.clearTimer,
    ...extra,
  });
  const published: Array<{ seq: number; observedAt: string }> = [];
  const record = (): void => {
    const obs = runtime.getContext(null).cycle?.observation;
    if (obs !== undefined) published.push({ seq: obs.seq, observedAt: obs.observedAt });
  };
  try {
    await runtime.start();
    record();
    for (let i = 0; i < ticks; i++) {
      await sch.tick(10_000);
      record();
    }
  } finally {
    runtime.close();
  }
  return { delays: [...sch.delays], published };
}

// ── PERF-02 (a): structural, unconditional ───────────────────────────────────────────────────────

describe("REQ-PERF-02 (a): the slow-cycle hook is never awaited on the publication path", () => {
  test("a never-resolving onSlowCycle does not stall publication: every tick publishes and slow-due cycles keep firing the hook (REQ-PERF-02)", async () => {
    let hookCalls = 0;
    const never = new Promise<void>(() => undefined);
    const cadence = await runCadence(13, {
      onSlowCycle: () => {
        hookCalls++;
        return never;
      },
    });

    // Prime + 13 ticks → 14 publications with strictly increasing seq, one per tick.
    expect(cadence.published.map((p) => p.seq)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    // The chained deadline series never slipped: every re-arm is a clean 10 s delay.
    expect(cadence.delays).toEqual(Array.from({ length: 14 }, () => 10_000));
    // Slow-due at t = 0, 60 s, 120 s: the hook ran on each while earlier invocations never settled.
    expect(hookCalls).toBe(3);
  });
});

// ── PERF-01: per-request mutation latency (gated) ────────────────────────────────────────────────

perfDescribe("REQ-PERF-01: mutation p95 latency through the real buildWriteRuntime dispatcher", () => {
  let h: WriteRuntimeHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  test(
    "200 sequential ack.set dispatches over a temp data dir (fsync on) have p95 < 2000 ms (REQ-PERF-01)",
    async () => {
      h = await writeRuntimeFor({
        context: { cycle: { alerts: { value: makeAlertsPayload({ scenario: "mixed" }) } } as unknown as CycleState },
      });
      const samples: number[] = [];
      for (let i = 0; i < 200; i++) {
        const req = trustedRequest(
          "/api/mutations/acks",
          { fingerprint: FIXTURE_FINGERPRINTS.hostDown, note: `perf note ${i}` },
          { idempotencyKey: `perf-ack-${String(i).padStart(6, "0")}` },
        );
        const t0 = performance.now();
        const res = await h.dispatch(req);
        samples.push(performance.now() - t0);
        expect(res.status).toBe(200);
      }
      expect(h.am.calls).toHaveLength(0); // fake AM not involved
      expect((await h.auditEvents()).length).toBe(400); // attempted + final per request, all persisted
      expect(p95(samples)).toBeLessThan(MUTATION_P95_BUDGET_MS);
    },
    120_000,
  );

  test(
    "200 sequential silence.create dispatches with a zero-latency fake Alertmanager have p95 < 2000 ms (REQ-PERF-01)",
    async () => {
      h = await writeRuntimeFor({
        am: fakeAlertmanagerFetch([{ kind: "json", status: 200, body: { silenceID: "3f1c9a2e-0000-4000-8000-0000000000aa" } }]),
        context: { cycle: { alerts: { value: makeAlertsPayload({ scenario: "mixed" }) } } as unknown as CycleState },
      });
      const samples: number[] = [];
      for (let i = 0; i < 200; i++) {
        const req = trustedRequest(
          "/api/mutations/silences",
          {
            fingerprint: FIXTURE_FINGERPRINTS.hostDown,
            matchers: [{ name: "alertname", value: "HostDown" }, { name: "host", value: `web-${i}` }],
            endsAt: new Date(Date.now() + 3_600_000).toISOString(),
            rationale: "Planned maintenance window for perf",
          },
          { idempotencyKey: `perf-silence-${String(i).padStart(6, "0")}` },
        );
        const t0 = performance.now();
        const res = await h.dispatch(req);
        samples.push(performance.now() - t0);
        expect(res.status).toBe(201);
      }
      expect(h.am.calls).toHaveLength(200);
      expect(p95(samples)).toBeLessThan(MUTATION_P95_BUDGET_MS);
    },
    120_000,
  );
});

// ── PERF-02 (b), (c): reconcile budget and cadence equality (gated) ──────────────────────────────

/** A WritePath stub for a directly constructed AckStore (records nothing; never degrades). */
function inertWritePath(): WritePath {
  return {
    snapshot: () => ({}) as WritePathSnapshot,
    markFailed: () => undefined,
    probe: async () => ({}) as WritePathSnapshot,
  };
}

function ackRecord(i: number): AckRecord {
  return {
    actor: { subject: `user-${i}`, displayName: `User ${i}` },
    at: "2026-09-28T14:03:11.000Z",
    note: i % 2 === 0 ? `note for ack ${i}` : null,
  };
}

/** Seed a valid pulse-acks/v1 file with `n` acks keyed `fp-<i>` (one write, not n). */
function seedAcks(path: string, n: number): string[] {
  const fps = Array.from({ length: n }, (_, i) => `fp-${String(i).padStart(4, "0")}`);
  const file: AckFileV1 = { format: "pulse-acks/v1", acks: Object.fromEntries(fps.map((fp, i) => [fp, ackRecord(i)])) };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return fps;
}

function okAlertsRecord(fps: readonly string[]): SourceRecord<readonly AlertmanagerAlert[]> {
  const alerts = fps.map(
    (fingerprint) =>
      ({
        fingerprint,
        state: "firing",
        name: "DiskFull",
        severity: "critical",
        startsAt: "2026-09-28T13:00:00.000Z",
        endsAt: "2026-09-28T15:00:00.000Z",
        labels: { alertname: "DiskFull" },
        annotations: {},
        receivers: [],
        silencedBy: [],
        inhibitedBy: [],
        group: null,
      }) as unknown as AlertmanagerAlert,
  );
  return {
    latest: { attemptedAt: "2026-09-28T14:10:00.000Z", result: { ok: true, data: alerts } },
    lastGood: { at: "2026-09-28T14:10:00.000Z", data: alerts },
  };
}

perfDescribe("REQ-PERF-02 (b), (c): ack reconcile budget and unchanged publication cadence", () => {
  let dataDir = "";
  let h: WriteRuntimeHarness | null = null;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pulse-perf-acks-"));
  });
  afterEach(async () => {
    await h?.cleanup();
    h = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("reconcile + foldView over 500 acks has p95 < 50 ms (REQ-PERF-02)", async () => {
    const path = join(dataDir, "acks.json");
    const fps = seedAcks(path, 500);
    const store = await createAckStore(path, { writePath: inertWritePath() });
    expect(store.loadStatus).toEqual({ ok: true, reason: null });
    expect(store.foldView().size).toBe(500);

    const record = okAlertsRecord(fps); // every acked alert still firing: the steady state
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      const cleared = await store.reconcile(record);
      const view = store.foldView();
      samples.push(performance.now() - t0);
      expect(cleared).toBe(0);
      expect(view.size).toBe(500);
    }
    expect(p95(samples)).toBeLessThan(RECONCILE_P95_BUDGET_MS);
  });

  test(
    "with a fake clock the publication cadence with the write path active (ackStore + onSlowCycle) equals the cadence without it (REQ-PERF-02)",
    async () => {
      const without = await runCadence(13, {});

      h = await writeRuntimeFor();
      await h.write.writePath.probe();
      const { ackStore, onSlowCycle } = h.write.runtimeDeps;
      expect(ackStore).toBeDefined();
      expect(onSlowCycle).toBeDefined();
      let hookCalls = 0;
      const withWrite = await runCadence(13, {
        ...(ackStore !== undefined ? { ackStore } : {}),
        onSlowCycle: async () => {
          hookCalls++;
          await onSlowCycle?.();
        },
      });

      expect(without.published).toHaveLength(14);
      expect(withWrite.published).toEqual(without.published);
      expect(withWrite.delays).toEqual(without.delays);
      expect(hookCalls).toBe(3);
    },
    60_000,
  );
});
