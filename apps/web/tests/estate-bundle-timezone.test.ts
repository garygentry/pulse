// apps/web/tests/estate-bundle-timezone.test.ts — model-timezone resolution + explicit override
// (06-reload-and-runtime-integration.md §7, 08-testing-strategy.md §8.9).
//
// Two layers:
//  • `resolveEstateTimezone` as a pure total function — model timezone is the default; a valid
//    explicit override wins and warns only on a real mismatch; defensive UTC only in error mode.
//  • Runtime semantics through `runRefreshCycle` — a valid mismatching override drives the snapshot
//    timezone and emits EXACTLY ONE structured `config_warning` per newly authoritative bundle, and
//    NONE for a matching override, an absent override, an invalid (→ absent) override, or a no-op.

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadServerConfig, resolveEstateTimezone } from "../src/server/config.js";
import { runRefreshCycle, type RuntimeState } from "../src/server/refresh.js";
import type { SourceResult } from "../src/server/sources/types.js";
import {
  makeEstateBundleFixture,
  makeWebCoverageArtifact,
  makeWebEstateModelV2,
  serializeArtifact,
  type EstateBundleFixture,
} from "./factories/estate-bundle.js";

// ── §7.1 pure resolution policy ────────────────────────────────────────────────────────────────────

describe("resolveEstateTimezone (§7.1)", () => {
  test("model timezone is the default when no override is configured", () => {
    expect(resolveEstateTimezone(null, "America/Chicago")).toEqual({
      timezone: "America/Chicago",
      fallback: false,
      warning: null,
    });
  });

  test("a matching explicit override wins with no warning", () => {
    expect(resolveEstateTimezone("America/Chicago", "America/Chicago")).toEqual({
      timezone: "America/Chicago",
      fallback: false,
      warning: null,
    });
  });

  test("a differing valid override wins and carries a structured mismatch warning", () => {
    expect(resolveEstateTimezone("America/New_York", "America/Chicago")).toEqual({
      timezone: "America/New_York",
      fallback: false,
      warning: { configured: "America/New_York", rendered: "America/Chicago" },
    });
  });

  test("an override with no model timezone wins without a warning", () => {
    expect(resolveEstateTimezone("America/New_York", null)).toEqual({
      timezone: "America/New_York",
      fallback: false,
      warning: null,
    });
  });

  test("no override and no model timezone is defensive UTC error mode", () => {
    expect(resolveEstateTimezone(null, null)).toEqual({
      timezone: "UTC",
      fallback: true,
      warning: null,
    });
  });

  test("an invalid override is normalized to absent by the config loader, so the model wins", () => {
    // loadServerConfig maps an invalid IANA zone to null; resolution then uses the model, not UTC.
    const estateTz = loadServerConfig({
      PULSE_VM_URL: "http://vm:8428",
      PULSE_ALERTMANAGER_URL: "http://am:9093",
      PULSE_GATUS_URL: "http://gatus:8080",
      PULSE_VMALERT_URL: "http://vmalert:8880",
      PULSE_ESTATE_TZ: "Not/AZone",
    }).estateTz;
    expect(estateTz).toBeNull();
    expect(resolveEstateTimezone(estateTz, "America/Chicago")).toEqual({
      timezone: "America/Chicago",
      fallback: false,
      warning: null,
    });
  });
});

// ── §7.2 runtime warning-per-authoritative-bundle semantics ────────────────────────────────────────

let dir: string;
let modelPath: string;
let mtimeSeq: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-tz-"));
  modelPath = join(dir, "web-estate-model.json");
  mtimeSeq = 2_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeGeneration(members: { model: string; coverage: string; findings: string }): void {
  const t = new Date(mtimeSeq++);
  writeFileSync(modelPath, members.model);
  writeFileSync(join(dir, "web-coverage.json"), members.coverage);
  writeFileSync(join(dir, "web-findings.json"), members.findings);
  for (const name of ["web-estate-model.json", "web-coverage.json", "web-findings.json"]) {
    utimesSync(join(dir, name), t, t);
  }
}

function writeValid(fixture: EstateBundleFixture): void {
  writeGeneration({
    model: fixture.files.model,
    coverage: fixture.files.coverage ?? "",
    findings: fixture.files.findings ?? "",
  });
}

function okSource<T>(data: T): () => Promise<SourceResult<T>> {
  return () => Promise.resolve({ ok: true, data });
}

function makeState(over: Record<string, string | undefined> = {}): RuntimeState {
  const config = loadServerConfig({
    PULSE_VM_URL: "http://vm:8428",
    PULSE_ALERTMANAGER_URL: "http://am:9093",
    PULSE_GATUS_URL: "http://gatus:8080",
    PULSE_VMALERT_URL: "http://vmalert:8880",
    PULSE_WEB_ESTATE_MODEL: modelPath,
    ...over,
  });
  return {
    config,
    sources: {
      vm: { queryLiveness: okSource([]) } as RuntimeState["sources"]["vm"],
      alertmanager: { activeAlerts: okSource([]) } as RuntimeState["sources"]["alertmanager"],
      gatus: { endpointStatuses: okSource([]) } as RuntimeState["sources"]["gatus"],
    },
    watcher: null,
    estate: null,
    snapshot: null,
    status: {
      sources: {
        metrics: { ok: false, lastSuccess: null, error: null },
        alerts: { ok: false, lastSuccess: null, error: null },
        checks: { ok: false, lastSuccess: null, error: null },
      },
      model: { loaded: false, formatVersion: null, error: null },
      lastSnapshotAt: null,
    },
  };
}

interface Captured {
  logs: Record<string, unknown>[];
  restore: () => void;
}

function captureLogs(): Captured {
  const logs: Record<string, unknown>[] = [];
  const original = console.log;
  console.log = ((line: unknown) => {
    if (typeof line === "string") {
      try {
        logs.push(JSON.parse(line) as Record<string, unknown>);
        return;
      } catch {
        /* not JSON — pass through */
      }
    }
    original(line as string);
  }) as typeof console.log;
  return { logs, restore: () => void (console.log = original) };
}

/** The estate-timezone mismatch warnings among captured logs. */
function tzWarnings(logs: Record<string, unknown>[]): Record<string, unknown>[] {
  return logs.filter(
    (l) => l["event"] === "config_warning" && l["warning"] === "estate_timezone_override_mismatch",
  );
}

describe("timezone override runtime semantics (§7.2)", () => {
  test("a differing valid override drives the snapshot zone and warns exactly once per new bundle", async () => {
    const fixture = makeEstateBundleFixture(); // model timezone: America/Chicago
    writeValid(fixture);
    const state = makeState({ PULSE_ESTATE_TZ: "America/New_York" });

    const cap = captureLogs();
    try {
      await runRefreshCycle(state);
    } finally {
      cap.restore();
    }

    // Snapshot uses the override zone, not the model zone; not a fallback.
    expect(state.snapshot?.estate.timezone).toBe("America/New_York");
    expect(state.snapshot?.estate.tzFallback).toBe(false);

    const warnings = tzWarnings(cap.logs);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatchObject({
      event: "config_warning",
      ok: false,
      warning: "estate_timezone_override_mismatch",
      configured: "America/New_York",
      rendered: "America/Chicago",
      bundleId: fixture.model.bundleId,
    });
  });

  test("a metadata/no-op cycle after the warning emits no further warning", async () => {
    writeValid(makeEstateBundleFixture());
    const state = makeState({ PULSE_ESTATE_TZ: "America/New_York" });
    await runRefreshCycle(state); // initial (warns once)

    const cap = captureLogs();
    try {
      await runRefreshCycle(state); // no byte change → no-op
    } finally {
      cap.restore();
    }
    expect(tzWarnings(cap.logs).length).toBe(0);
  });

  test("each newly authoritative bundle warns again (once per bundle, not suppressed forever)", async () => {
    writeValid(makeEstateBundleFixture());
    const state = makeState({ PULSE_ESTATE_TZ: "America/New_York" });
    await runRefreshCycle(state); // initial warn

    // A byte-distinct coherent generation is a NEW authoritative bundle → one more warning.
    const model = makeWebEstateModelV2();
    const renamed = { ...model, estate: { ...model.estate, name: "second-gen" } };
    writeGeneration({
      model: serializeArtifact(renamed),
      coverage: serializeArtifact(makeWebCoverageArtifact(renamed)),
      findings: makeEstateBundleFixture().files.findings ?? "",
    });

    const cap = captureLogs();
    try {
      await runRefreshCycle(state);
    } finally {
      cap.restore();
    }
    expect(tzWarnings(cap.logs).length).toBe(1);
  });

  test("a matching override drives the model zone and emits no mismatch warning", async () => {
    const fixture = makeEstateBundleFixture(); // America/Chicago
    writeValid(fixture);
    const state = makeState({ PULSE_ESTATE_TZ: "America/Chicago" });

    const cap = captureLogs();
    try {
      await runRefreshCycle(state);
    } finally {
      cap.restore();
    }
    expect(state.snapshot?.estate.timezone).toBe("America/Chicago");
    expect(state.snapshot?.estate.tzFallback).toBe(false);
    expect(tzWarnings(cap.logs).length).toBe(0);
  });

  test("an absent override uses the model zone with no warning", async () => {
    const fixture = makeEstateBundleFixture();
    writeValid(fixture);
    const state = makeState(); // PULSE_ESTATE_TZ unset

    const cap = captureLogs();
    try {
      await runRefreshCycle(state);
    } finally {
      cap.restore();
    }
    expect(state.config.estateTz).toBeNull();
    expect(state.snapshot?.estate.timezone).toBe("America/Chicago");
    expect(state.snapshot?.estate.tzFallback).toBe(false);
    expect(tzWarnings(cap.logs).length).toBe(0);
  });

  test("an invalid override falls back to the model zone, not UTC, with no mismatch warning", async () => {
    const fixture = makeEstateBundleFixture();
    writeValid(fixture);
    const state = makeState({ PULSE_ESTATE_TZ: "Not/AZone" }); // invalid → estateTz null

    const cap = captureLogs();
    try {
      await runRefreshCycle(state);
    } finally {
      cap.restore();
    }
    expect(state.config.estateTz).toBeNull();
    expect(state.snapshot?.estate.timezone).toBe("America/Chicago"); // model, NOT UTC
    expect(state.snapshot?.estate.tzFallback).toBe(false);
    expect(tzWarnings(cap.logs).length).toBe(0);
  });
});
