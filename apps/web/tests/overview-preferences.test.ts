// overview-preferences.test.ts — guarded versioned persistence (08 §4.3 preferences list).
// Every case injects a spy or throwing OverviewPreferenceStorage; no browser storage is used.
import { describe, expect, test } from "bun:test";
import type { HostStatus, OverviewSnapshotV2 } from "@pulse/web-data/wire";
import {
  DEFAULT_OVERVIEW_PREFERENCES,
  MAX_COLLAPSED_GROUP_IDS,
  MAX_PREFERENCE_ID_LENGTH,
  OVERVIEW_PREFERENCES_KEY,
  type OverviewModel,
  type OverviewPreferenceStorage,
  type OverviewPreferencesV1,
  type OverviewTarget,
} from "../src/client/views/overview/model.js";
import {
  readOverviewPreferences,
  reconcileOverviewPreferences,
  writeOverviewPreferences,
} from "../src/client/views/overview/preferences.js";
import {
  FIXTURE_GRAFANA_ORIGIN,
  makeEnvelopeOverviewSnapshot,
  makeOverviewSnapshot,
} from "./fixtures/overview/factory.js";

interface SpyStorage extends OverviewPreferenceStorage {
  readonly data: Map<string, string>;
  readonly calls: { get: string[]; set: [string, string][]; remove: string[] };
}

function spyStorage(initial: Record<string, string> = {}): SpyStorage {
  const data = new Map(Object.entries(initial));
  const calls: SpyStorage["calls"] = { get: [], set: [], remove: [] };
  return {
    data,
    calls,
    get(key) {
      calls.get.push(key);
      return data.get(key) ?? null;
    },
    set(key, value) {
      calls.set.push([key, value]);
      data.set(key, value);
    },
    remove(key) {
      calls.remove.push(key);
      data.delete(key);
    },
  };
}

function throwingStorage(
  throwOn: { get?: boolean; set?: boolean; remove?: boolean },
  stored: string | null = null,
): OverviewPreferenceStorage & { removeCalls: number } {
  const storage = {
    removeCalls: 0,
    get(): string | null {
      if (throwOn.get) throw new DOMException("denied", "SecurityError");
      return stored;
    },
    set(): void {
      if (throwOn.set) throw new DOMException("full", "QuotaExceededError");
    },
    remove(): void {
      storage.removeCalls += 1;
      if (throwOn.remove) throw new DOMException("denied", "SecurityError");
    },
  };
  return storage;
}

function stored(value: unknown): SpyStorage {
  return spyStorage({ [OVERVIEW_PREFERENCES_KEY]: JSON.stringify(value) });
}

const VALID: OverviewPreferencesV1 = {
  version: 1,
  groupBy: "status",
  sortBy: "name",
  collapsedGroupIds: ["status:critical", "status:ok"],
  selectedTargetId: "host:host-001",
};

/** Test-side model builder (selectors.ts is a later item): class groups + canonical target index. */
function modelFrom(snapshot: OverviewSnapshotV2): OverviewModel {
  const byClass = new Map<string, HostStatus[]>();
  const targetById = new Map<string, OverviewTarget>();
  for (const host of snapshot.hosts) {
    const list = byClass.get(host.collectionClass) ?? [];
    list.push(host);
    byClass.set(host.collectionClass, list);
    targetById.set(host.drilldownId, {
      identity: { kind: "host", id: host.drilldownId },
      drilldownId: host.drilldownId,
      kind: "host",
      host,
      service: null,
    });
    for (const service of host.services) {
      targetById.set(service.drilldownId, {
        identity: { kind: "service", id: service.drilldownId },
        drilldownId: service.drilldownId,
        kind: "service",
        host,
        service,
      });
    }
  }
  const zero = { ok: 0, warning: 0, critical: 0, unknown: 0, suppressed: 0 } as const;
  const unavailable = { state: "unavailable", source: "victoriametrics-signals", lastGoodAt: null, message: null } as const;
  return {
    groups: [...byClass].map(([cls, hosts]) => ({ id: `class:${cls}`, label: cls, hosts })),
    targetById,
    stats: {
      hosts: zero,
      services: zero,
      firing: { critical: 0, warning: 0, info: 0 },
      silenced: 0,
      inhibited: 0,
      coverage: { status: "unavailable", availability: unavailable, message: "Coverage unavailable" },
      engine: { status: "unavailable", availability: unavailable },
    },
    firing: [],
  };
}

describe("readOverviewPreferences", () => {
  test("null storage → defaults/unavailable", () => {
    const result = readOverviewPreferences(null);
    expect(result).toEqual({ status: "defaulted", value: DEFAULT_OVERVIEW_PREFERENCES, reason: "unavailable" });
  });

  test("missing record → defaults/missing without removal", () => {
    const storage = spyStorage();
    const result = readOverviewPreferences(storage);
    expect(result).toEqual({ status: "defaulted", value: DEFAULT_OVERVIEW_PREFERENCES, reason: "missing" });
    expect(storage.calls.get).toEqual([OVERVIEW_PREFERENCES_KEY]);
    expect(storage.calls.remove).toEqual([]);
  });

  test("valid v1 round-trip", () => {
    const storage = spyStorage();
    expect(writeOverviewPreferences(storage, VALID)).toBe(true);
    const result = readOverviewPreferences(storage);
    expect(result).toEqual({ status: "ok", value: VALID });
    expect(storage.calls.remove).toEqual([]);
    if (result.status === "ok") {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.collapsedGroupIds)).toBe(true);
    }
  });

  test("null selection and empty collapse list round-trip", () => {
    const storage = spyStorage();
    expect(writeOverviewPreferences(storage, DEFAULT_OVERVIEW_PREFERENCES)).toBe(true);
    expect(readOverviewPreferences(storage)).toEqual({ status: "ok", value: DEFAULT_OVERVIEW_PREFERENCES });
  });

  test("unknown keys are ignored and dropped from the returned value", () => {
    const result = readOverviewPreferences(stored({ ...VALID, density: "wallboard", snapshot: {} }));
    expect(result).toEqual({ status: "ok", value: VALID });
    if (result.status === "ok") expect(Object.keys(result.value).sort()).toEqual(Object.keys(VALID).sort());
  });

  test.each([
    ["not json", "{not json"],
    ["empty string", ""],
    ["json null", "null"],
    ["json number", "42"],
    ["json string", '"pulse"'],
    ["json array", JSON.stringify([VALID])],
  ])("malformed (%s) → defaults/malformed and record removed", (_label, raw) => {
    const storage = spyStorage({ [OVERVIEW_PREFERENCES_KEY]: raw });
    const result = readOverviewPreferences(storage);
    expect(result).toEqual({ status: "defaulted", value: DEFAULT_OVERVIEW_PREFERENCES, reason: "malformed" });
    expect(storage.calls.remove).toEqual([OVERVIEW_PREFERENCES_KEY]);
    expect(storage.data.has(OVERVIEW_PREFERENCES_KEY)).toBe(false);
  });

  test.each([
    ["future version", { ...VALID, version: 2 }],
    ["version zero", { ...VALID, version: 0 }],
    ["string version", { ...VALID, version: "1" }],
    ["missing version", { groupBy: "class", sortBy: "status", collapsedGroupIds: [], selectedTargetId: null }],
  ])("unsupported (%s) → defaults/unsupported and record removed", (_label, value) => {
    const storage = stored(value);
    const result = readOverviewPreferences(storage);
    expect(result).toEqual({ status: "defaulted", value: DEFAULT_OVERVIEW_PREFERENCES, reason: "unsupported" });
    expect(storage.calls.remove).toEqual([OVERVIEW_PREFERENCES_KEY]);
  });

  const tooLong = "x".repeat(MAX_PREFERENCE_ID_LENGTH + 1);
  const tooMany = Array.from({ length: MAX_COLLAPSED_GROUP_IDS + 1 }, (_, i) => `g${i}`);
  test.each([
    ["invalid groupBy", { ...VALID, groupBy: "severity" }],
    ["invalid sortBy", { ...VALID, sortBy: "random" }],
    ["groupBy wrong type", { ...VALID, groupBy: 1 }],
    ["sortBy missing", { version: 1, groupBy: "class", collapsedGroupIds: [], selectedTargetId: null }],
    ["collapsedGroupIds not array", { ...VALID, collapsedGroupIds: "class:a" }],
    ["collapsedGroupIds missing", { version: 1, groupBy: "class", sortBy: "status", selectedTargetId: null }],
    ["collapsed id wrong type", { ...VALID, collapsedGroupIds: ["a", 7] }],
    ["collapsed id empty", { ...VALID, collapsedGroupIds: [""] }],
    ["collapsed id oversize", { ...VALID, collapsedGroupIds: [tooLong] }],
    ["collapsed array oversize", { ...VALID, collapsedGroupIds: tooMany }],
    ["selectedTargetId wrong type", { ...VALID, selectedTargetId: 5 }],
    ["selectedTargetId empty", { ...VALID, selectedTargetId: "" }],
    ["selectedTargetId oversize", { ...VALID, selectedTargetId: tooLong }],
    ["selectedTargetId missing", { version: 1, groupBy: "class", sortBy: "status", collapsedGroupIds: [] }],
  ])("invalid (%s) → defaults/invalid and whole record removed", (_label, value) => {
    const storage = stored(value);
    const result = readOverviewPreferences(storage);
    expect(result).toEqual({ status: "defaulted", value: DEFAULT_OVERVIEW_PREFERENCES, reason: "invalid" });
    expect(storage.calls.remove).toEqual([OVERVIEW_PREFERENCES_KEY]);
    expect(storage.data.has(OVERVIEW_PREFERENCES_KEY)).toBe(false);
  });

  test("bounds are inclusive: exactly MAX ids of MAX length are accepted, never truncated", () => {
    const maxId = "y".repeat(MAX_PREFERENCE_ID_LENGTH);
    const ids = Array.from({ length: MAX_COLLAPSED_GROUP_IDS }, (_, i) => `${i}`.padEnd(MAX_PREFERENCE_ID_LENGTH, "z"));
    const result = readOverviewPreferences(stored({ ...VALID, collapsedGroupIds: ids, selectedTargetId: maxId }));
    expect(result.status).toBe("ok");
    expect(result.value.collapsedGroupIds).toEqual(ids);
    expect(result.value.selectedTargetId).toBe(maxId);
  });

  test("duplicate collapsed ids are deduplicated preserving first occurrence (02 §4.2 step 7)", () => {
    const storage = stored({ ...VALID, collapsedGroupIds: ["b", "a", "b", "c", "a"] });
    const result = readOverviewPreferences(storage);
    expect(result.status).toBe("ok");
    expect(result.value.collapsedGroupIds).toEqual(["b", "a", "c"]);
    expect(storage.calls.remove).toEqual([]);
  });

  test("duplicate ids beyond the cap are still rejected as oversized", () => {
    const storage = stored({ ...VALID, collapsedGroupIds: Array(MAX_COLLAPSED_GROUP_IDS + 1).fill("a") });
    expect(readOverviewPreferences(storage)).toEqual({
      status: "defaulted",
      value: DEFAULT_OVERVIEW_PREFERENCES,
      reason: "invalid",
    });
    expect(storage.calls.remove).toEqual([OVERVIEW_PREFERENCES_KEY]);
  });

  test("throwing get → defaults/unavailable, no removal attempted", () => {
    const storage = throwingStorage({ get: true });
    expect(() => readOverviewPreferences(storage)).not.toThrow();
    expect(readOverviewPreferences(storage)).toEqual({
      status: "defaulted",
      value: DEFAULT_OVERVIEW_PREFERENCES,
      reason: "unavailable",
    });
    expect(storage.removeCalls).toBe(0);
  });

  test("throwing remove during invalid-record cleanup is absorbed", () => {
    const storage = throwingStorage({ remove: true }, "{broken");
    let result: ReturnType<typeof readOverviewPreferences> | undefined;
    expect(() => {
      result = readOverviewPreferences(storage);
    }).not.toThrow();
    expect(result).toEqual({ status: "defaulted", value: DEFAULT_OVERVIEW_PREFERENCES, reason: "malformed" });
    expect(storage.removeCalls).toBe(1);
  });
});

describe("writeOverviewPreferences", () => {
  test("null storage → false", () => {
    expect(writeOverviewPreferences(null, VALID)).toBe(false);
  });

  test("throwing set (quota/security) → false without throwing", () => {
    const storage = throwingStorage({ set: true });
    expect(() => writeOverviewPreferences(storage, VALID)).not.toThrow();
    expect(writeOverviewPreferences(storage, VALID)).toBe(false);
  });

  test("forged invalid values are rejected before storage", () => {
    const storage = spyStorage();
    const forged: unknown[] = [
      { ...VALID, version: 2 },
      { ...VALID, groupBy: "severity" },
      { ...VALID, sortBy: null },
      { ...VALID, collapsedGroupIds: [""] },
      { ...VALID, collapsedGroupIds: Array.from({ length: MAX_COLLAPSED_GROUP_IDS + 1 }, (_, i) => `g${i}`) },
      { ...VALID, selectedTargetId: "x".repeat(MAX_PREFERENCE_ID_LENGTH + 1) },
      null,
    ];
    for (const value of forged) {
      expect(writeOverviewPreferences(storage, value as OverviewPreferencesV1)).toBe(false);
    }
    expect(storage.calls.set).toEqual([]);
  });

  test("writes exactly one key with exactly the five known fields in declaration order", () => {
    const storage = spyStorage();
    expect(writeOverviewPreferences(storage, VALID)).toBe(true);
    expect(storage.calls.set.map(([key]) => key)).toEqual([OVERVIEW_PREFERENCES_KEY]);
    const [, raw] = storage.calls.set[0]!;
    expect(Object.keys(JSON.parse(raw))).toEqual(["version", "groupBy", "sortBy", "collapsedGroupIds", "selectedTargetId"]);
  });

  test("serialized value never carries snapshot, health, signal, alert, secret or Grafana data", () => {
    const snapshot = makeOverviewSnapshot({ grafana: true, signals: true, alerts: true });
    const model = modelFrom(snapshot);
    const host = snapshot.hosts[0]!;
    // A forged in-memory value smuggling snapshot-derived content alongside the real fields.
    const forged = {
      ...VALID,
      collapsedGroupIds: [model.groups[0]!.id],
      selectedTargetId: host.drilldownId,
      snapshot,
      host,
      health: host.status,
      signals: snapshot.signals,
      alerts: snapshot.alerts,
      secretRef: "secret://grafana/token",
      grafanaUrl: `${FIXTURE_GRAFANA_ORIGIN}/d/abc`,
      density: "wallboard",
    } as unknown as OverviewPreferencesV1;
    const storage = spyStorage();
    expect(writeOverviewPreferences(storage, forged)).toBe(true);
    expect(storage.calls.set.map(([key]) => key)).toEqual([OVERVIEW_PREFERENCES_KEY]);
    const [, raw] = storage.calls.set[0]!;
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      groupBy: VALID.groupBy,
      sortBy: VALID.sortBy,
      collapsedGroupIds: [model.groups[0]!.id],
      selectedTargetId: host.drilldownId,
    });
    for (const forbidden of ["snapshot", "health", "signal", "alert", "secret", "grafana", "http", "density"]) {
      expect(raw.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe("reconcileOverviewPreferences", () => {
  const model = modelFrom(makeEnvelopeOverviewSnapshot());
  const groupIds = model.groups.map((group) => group.id);
  const [hostId] = [...model.targetById.keys()];

  test("returns the identical object when every id still exists", () => {
    const prefs: OverviewPreferencesV1 = { ...VALID, collapsedGroupIds: groupIds.slice(0, 2), selectedTargetId: hostId! };
    expect(reconcileOverviewPreferences(prefs, model)).toBe(prefs);
    expect(reconcileOverviewPreferences(DEFAULT_OVERVIEW_PREFERENCES, model)).toBe(DEFAULT_OVERVIEW_PREFERENCES);
  });

  test("drops collapsed group ids absent from the model, preserving order", () => {
    const prefs: OverviewPreferencesV1 = {
      ...VALID,
      collapsedGroupIds: ["status:gone", groupIds[1]!, "name:x", groupIds[0]!],
      selectedTargetId: hostId!,
    };
    const next = reconcileOverviewPreferences(prefs, model);
    expect(next).not.toBe(prefs);
    expect(next).toEqual({ ...prefs, collapsedGroupIds: [groupIds[1]!, groupIds[0]!] });
    expect(prefs.collapsedGroupIds).toHaveLength(4);
  });

  test("clears a selected target absent from the model (no same-name fallback)", () => {
    const serviceId = [...model.targetById.values()].find((t) => t.kind === "service")!.drilldownId;
    const prefs: OverviewPreferencesV1 = { ...DEFAULT_OVERVIEW_PREFERENCES, selectedTargetId: `${serviceId}-renamed` };
    const next = reconcileOverviewPreferences(prefs, model);
    expect(next.selectedTargetId).toBeNull();
    expect(next.collapsedGroupIds).toBe(prefs.collapsedGroupIds);
    expect(reconcileOverviewPreferences(next, model)).toBe(next);
  });

  test("reconciles against a changed model: removed target and group are dropped", () => {
    const before = makeOverviewSnapshot({ hostCount: 4 });
    const after: OverviewSnapshotV2 = { ...before, hosts: before.hosts.slice(1) };
    const removedHost = before.hosts[0]!;
    const beforeModel = modelFrom(before);
    const prefs: OverviewPreferencesV1 = {
      ...VALID,
      collapsedGroupIds: beforeModel.groups.map((group) => group.id),
      selectedTargetId: removedHost.services[0]?.drilldownId ?? removedHost.drilldownId,
    };
    expect(reconcileOverviewPreferences(prefs, beforeModel)).toBe(prefs);
    const afterModel = modelFrom(after);
    const next = reconcileOverviewPreferences(prefs, afterModel);
    expect(next.selectedTargetId).toBeNull();
    expect(next.collapsedGroupIds).toEqual(afterModel.groups.map((group) => group.id));
    const storage = spyStorage();
    expect(writeOverviewPreferences(storage, next)).toBe(true);
    expect(readOverviewPreferences(storage)).toEqual({ status: "ok", value: next });
  });

  test("empty model clears every id", () => {
    const empty = modelFrom(makeOverviewSnapshot({ hostCount: 0 }));
    const next = reconcileOverviewPreferences({ ...VALID }, empty);
    expect(next).toEqual({ ...VALID, collapsedGroupIds: [], selectedTargetId: null });
  });
});

describe("preferences.ts boundaries", () => {
  test("density stays store-owned; module touches no browser storage global", async () => {
    const source = await Bun.file(new URL("../src/client/views/overview/preferences.ts", import.meta.url)).text();
    expect(source).not.toMatch(/localStorage/);
    expect(source).not.toMatch(/density/i);
    expect(source).not.toMatch(/\bwindow\b|\bdocument\b/);
    expect(source).not.toMatch(/from\s+["'](react|@preact\/signals)/);
    expect(Object.keys(DEFAULT_OVERVIEW_PREFERENCES)).not.toContain("density");
  });
});
