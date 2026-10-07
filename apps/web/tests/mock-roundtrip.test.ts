// apps/web/tests/mock-roundtrip.test.ts — item 014 / REQ-MOCK-06 / SC-12.
//
// Drives each of the three shipped scenarios through the REAL `createServerRuntime` with the
// mock engine's `fetchImpl` injected, calls one `runOnce`, and asserts the resulting snapshot's
// broad shape matches the scenario's intent:
//   - all-green:      no `warning`/`critical`, no alerts, sources all healthy
//   - degraded-mix:   at least one degraded target + at least one firing alert
//   - source-outage:  at least one source phase is `down` (`SourceHealth.ok === false`)
//
// This is the round-trip proof that the injected-fetch seam of `refresh.ts:122` (item 012), the
// mock engine (item 014), the scenario fixtures (item 013) and the snapshot fold all agree.

import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  MOCK_ENV,
  SCENARIO_NAMES,
  createMockEngine,
} from "../src/server/dev/mock-engine.js";
import { loadServerConfig } from "../src/server/config.js";
import { createServerRuntime } from "../src/server/refresh.js";
import type { OverviewSnapshot } from "../src/shared/snapshot.js";

const REFERENCE_MODEL = resolve(
  import.meta.dir,
  "../../../examples/reference/rendered/web-estate-model.json",
);
const FIXED_START = Date.parse("2026-01-01T00:00:00.000Z");

async function snapshotAt(scenarioName: string, elapsedMs: number): Promise<OverviewSnapshot> {
  const engine = await createMockEngine({
    scenario: scenarioName,
    now: () => FIXED_START + elapsedMs,
    startedAt: FIXED_START,
  });
  const config = loadServerConfig({
    ...process.env,
    ...MOCK_ENV,
    PULSE_WEB_ESTATE_MODEL: REFERENCE_MODEL,
  });
  const runtime = createServerRuntime(config, { fetchImpl: engine.fetchImpl });
  await runtime.runOnce();
  const snap = runtime.getContext(null).snapshot;
  if (snap === null) throw new Error(`no snapshot for ${scenarioName}`);
  return snap;
}

describe("REQ-MOCK-06 — mock scenarios round-trip through createServerRuntime", () => {
  test("every shipped scenario has a fixture", () => {
    // Guard: the round-trip cases below assume the three shipped scenarios exist.
    expect([...SCENARIO_NAMES]).toEqual(["all-green", "degraded-mix", "source-outage"]);
  });

  test("all-green: no warning/critical target, no alerts, sources all healthy", async () => {
    const snap = await snapshotAt("all-green", 0);

    expect(snap.sources.metrics.ok).toBe(true);
    expect(snap.sources.alerts.ok).toBe(true);
    expect(snap.sources.checks.ok).toBe(true);

    expect(snap.alerts).toEqual([]);

    const statuses = new Set<string>();
    for (const host of snap.hosts) {
      statuses.add(host.status);
      for (const svc of host.services) statuses.add(svc.status);
    }
    expect(statuses.has("warning")).toBe(false);
    expect(statuses.has("critical")).toBe(false);
  });

  test("degraded-mix (t=0): at least one degraded target and at least one firing alert", async () => {
    const snap = await snapshotAt("degraded-mix", 0);

    expect(snap.alerts.length).toBeGreaterThan(0);
    const severities = new Set(snap.alerts.map((a) => a.severity));
    expect(severities.has("critical") || severities.has("warning")).toBe(true);

    const anyDegraded = snap.hosts.some((h) => {
      if (h.status === "critical" || h.status === "warning") return true;
      return h.services.some((s) => s.status === "critical" || s.status === "warning");
    });
    expect(anyDegraded).toBe(true);
  });

  test("source-outage: at least one source phase is down (ok === false)", async () => {
    // Advance past the atMs:0 outage-begin step (Math.max(0, elapsed) still triggers at exactly 0).
    const snap = await snapshotAt("source-outage", 1_000);

    const downSources = [
      snap.sources.metrics.ok,
      snap.sources.alerts.ok,
      snap.sources.checks.ok,
    ].filter((ok) => ok === false);
    expect(downSources.length).toBeGreaterThan(0);

    // Specifically, the source-outage scenario turns off `gatus`.
    expect(snap.sources.checks.ok).toBe(false);
    expect(snap.sources.checks.error).toContain("fetch failed: mock outage");
  });
});
