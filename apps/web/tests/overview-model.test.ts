// overview-model.test.ts — overview model.ts constants plus type-level shape pins.
// The typed literals below make `bun run typecheck` fail if an overview-owned shape drifts.
import { describe, expect, test } from "bun:test";
import type { DataAvailability, HistoryPayload } from "@pulse/web-data/wire";
import {
  DEFAULT_OVERVIEW_PREFERENCES,
  KIOSK_ALERT_NAME_LIMIT,
  MAX_COLLAPSED_GROUP_IDS,
  MAX_PREFERENCE_ID_LENGTH,
  OVERVIEW_COLLATOR,
  OVERVIEW_HISTORY_QUERY,
  OVERVIEW_HISTORY_RANGE,
  OVERVIEW_PREFERENCES_KEY,
  OVERVIEW_PREFERENCES_VERSION,
  OVERVIEW_STATUS_ORDER,
  type KioskPage,
  type OverviewModel,
  type OverviewPreferencesV1,
  type OverviewStats,
  type OverviewTarget,
  type TargetHistoryState,
} from "../src/client/views/overview/model.js";
import { NOW, hostStatus } from "./factories.js";
import { readFileSync } from "node:fs";
import type { CheckSummary, HostStatus, OverviewAlertSummary, OverviewSnapshotV2 } from "@pulse/web-data/wire";
import {
  alertTriagePath,
  buildCheckTimeline,
  buildKioskFiringSummary,
  compareFiringAlerts,
  deriveOverviewModel,
  deriveOverviewStats,
  deriveTargetDrawerModel,
  hostContentKey,
  resolveOverviewTarget,
  targetTriagePath,
} from "../src/client/views/overview/selectors.js";
import {
  makeEnvelopeOverviewSnapshot,
  makeOverviewSnapshot,
  withTargetStatus,
} from "./fixtures/overview/factory.js";
import {
  ENVELOPE_ALERT_COUNTS,
  ENVELOPE_COVERAGE,
  ENVELOPE_HOST_ROLLUP_COUNTS,
  ENVELOPE_SERVICE_STATUS_COUNTS,
  FIXTURE_IDS,
} from "./fixtures/overview/expected.js";

describe("overview model constants", () => {
  test("OVERVIEW_STATUS_ORDER is worst-first", () => {
    expect(OVERVIEW_STATUS_ORDER).toEqual(["critical", "warning", "unknown", "suppressed", "ok"]);
  });

  test("preference key, version and bounds", () => {
    expect(OVERVIEW_PREFERENCES_KEY).toBe("pulse.web.overview.v1");
    expect(OVERVIEW_PREFERENCES_VERSION).toBe(1);
    expect(MAX_COLLAPSED_GROUP_IDS).toBe(256);
    expect(MAX_PREFERENCE_ID_LENGTH).toBe(512);
  });

  test("DEFAULT_OVERVIEW_PREFERENCES", () => {
    expect(DEFAULT_OVERVIEW_PREFERENCES).toEqual({
      version: 1,
      groupBy: "class",
      sortBy: "status",
      collapsedGroupIds: [],
      selectedTargetId: null,
    });
  });

  test("ribbon and history constants", () => {
    expect(KIOSK_ALERT_NAME_LIMIT).toBe(5);
    expect(OVERVIEW_HISTORY_QUERY).toBe("estate.liveness");
    expect(OVERVIEW_HISTORY_RANGE).toBe("1h");
  });

  test("OVERVIEW_COLLATOR is numeric and case-insensitive", () => {
    expect(["web10", "web2", "Web1"].sort(OVERVIEW_COLLATOR.compare)).toEqual(["Web1", "web2", "web10"]);
    expect(OVERVIEW_COLLATOR.compare("WEB01", "web01")).toBe(0);
  });
});

describe("overview model shapes (type-level pins)", () => {
  const availability: DataAvailability = {
    state: "current",
    source: "victoriametrics-signals",
    lastGoodAt: NOW,
    message: null,
  };
  const host = hostStatus();
  const target: OverviewTarget = {
    identity: { kind: "host", id: host.drilldownId },
    drilldownId: host.drilldownId,
    kind: "host",
    host,
    service: null,
  };
  const zero = { ok: 0, warning: 0, critical: 0, unknown: 0, suppressed: 0 } as const;

  test("OverviewStats, OverviewModel, OverviewPreferencesV1", () => {
    const stats: OverviewStats = {
      hosts: { ...zero, ok: 1 },
      services: zero,
      firing: { critical: 0, warning: 0, info: 0 },
      silenced: 0,
      inhibited: 0,
      coverage: { status: "available", covered: 1, gaps: 0, extras: 0, availability },
      engine: { status: "unavailable", availability: { ...availability, state: "unavailable" } },
    };
    const model: OverviewModel = {
      groups: [{ id: "class:managed-linux", label: "managed-linux", hosts: [host] }],
      targetById: new Map([[target.drilldownId, target]]),
      stats,
      firing: [],
    };
    const prefs: OverviewPreferencesV1 = {
      version: 1,
      groupBy: "name",
      sortBy: "class",
      collapsedGroupIds: ["class:managed-linux"],
      selectedTargetId: host.drilldownId,
    };
    expect(model.targetById.get(host.drilldownId)).toBe(target);
    expect(model.stats.coverage.status).toBe("available");
    expect(prefs.groupBy).toBe("name");
  });

  test("TargetHistoryState and KioskPage", () => {
    const payload: HistoryPayload = {
      queryId: "estate.liveness",
      target: { kind: "host", id: host.drilldownId },
      range: "1h",
      fetchedAt: NOW,
      effectiveStepSeconds: 60,
      unit: "state",
      stale: false,
      series: [],
    };
    const states: readonly TargetHistoryState[] = [
      { status: "idle" },
      { status: "loading", targetId: host.drilldownId },
      { status: "ready", targetId: host.drilldownId, payload, receivedAt: 0 },
      {
        status: "error",
        targetId: host.drilldownId,
        code: "SOURCE_UNAVAILABLE",
        message: "History unavailable",
        retryable: true,
      },
    ];
    const page: KioskPage = {
      index: 0,
      hosts: [host],
      groupStarts: [{ groupId: "class:managed-linux", label: "managed-linux", hostOffset: 0 }],
    };
    expect(states.map((s) => s.status)).toEqual(["idle", "loading", "ready", "error"]);
    expect(page.groupStarts[0]?.hostOffset).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// selectors.ts (08-testing-strategy.md §4.1)
// ---------------------------------------------------------------------------------------------

const PREFS = DEFAULT_OVERVIEW_PREFERENCES;
const prefs = (groupBy: OverviewPreferencesV1["groupBy"], sortBy: OverviewPreferencesV1["sortBy"]): OverviewPreferencesV1 => ({
  ...PREFS,
  groupBy,
  sortBy,
});

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const groupIds = (model: OverviewModel): string[] => model.groups.map((g) => g.id);
const hostIds = (model: OverviewModel): string[][] => model.groups.map((g) => g.hosts.map((h) => h.drilldownId));

const STALE: DataAvailability = {
  state: "stale",
  source: "victoriametrics-signals",
  lastGoodAt: "2026-09-01T11:00:00.000Z",
  message: "Signals are stale.",
};

/** A copy of fixture host `base` with overridden identity/name/class (services dropped). */
function variantHost(base: HostStatus, overrides: Partial<Pick<HostStatus, "name" | "drilldownId" | "collectionClass">>): HostStatus {
  return { ...base, ...overrides, services: [] };
}

describe("resolveOverviewTarget / targetById — canonical identity", () => {
  const snapshot = deepFreeze(makeOverviewSnapshot());

  test.each([
    ["host", FIXTURE_IDS.okHost, "host-001", null],
    ["service", "svc:host-002/api", "host-002", "api"],
    ["same-name service on another host", "svc:host-003/api", "host-003", "api"],
  ])("%s resolves by exact id", (_label, id, hostName, serviceName) => {
    const target = resolveOverviewTarget(snapshot, id);
    expect(target).not.toBeNull();
    expect(target!.drilldownId).toBe(id);
    expect(target!.identity.id).toBe(id);
    expect(target!.host.name).toBe(hostName);
    expect(target!.service?.name ?? null).toBe(serviceName);
    expect(target!.kind).toBe(serviceName === null ? "host" : "service");
  });

  test("names, partial ids, empty ids and absent ids never resolve", () => {
    for (const id of ["host-001", "api", "", "svc:host-001", "host:host-999"]) {
      expect(resolveOverviewTarget(snapshot, id)).toBeNull();
    }
  });

  test("every targetById key equals its TargetIdentity.id and covers every host and service", () => {
    const model = deriveOverviewModel(snapshot, PREFS);
    expect(model.targetById.size).toBe(4 + 12);
    for (const [key, target] of model.targetById) {
      expect(key).toBe(target.identity.id);
      expect(key).toBe(target.drilldownId);
      expect(target.identity.kind).toBe(target.kind);
    }
    const sameName = [...model.targetById.values()].filter((t) => t.service?.name === "api");
    expect(sameName.map((t) => t.drilldownId)).toEqual([
      "svc:host-001/api", "svc:host-002/api", "svc:host-003/api", "svc:host-004/api",
    ]);
  });

  test("duplicate ids are ambiguous: absent from targetById and unresolvable", () => {
    const base = makeOverviewSnapshot();
    const dup = deepFreeze({ ...base, hosts: [...base.hosts, base.hosts[0]!] });
    const model = deriveOverviewModel(dup, PREFS);
    expect(model.targetById.has(FIXTURE_IDS.okHost)).toBe(false);
    expect(model.targetById.has(FIXTURE_IDS.okService)).toBe(false);
    expect(model.targetById.has(FIXTURE_IDS.warningHost)).toBe(true);
    expect(resolveOverviewTarget(dup, FIXTURE_IDS.okHost)).toBeNull();
    expect(resolveOverviewTarget(dup, FIXTURE_IDS.okService)).toBeNull();
    // A host id colliding with a service id is equally ambiguous.
    const collide = deepFreeze({ ...base, hosts: [...base.hosts, variantHost(base.hosts[1]!, { drilldownId: FIXTURE_IDS.okService })] });
    expect(resolveOverviewTarget(collide, FIXTURE_IDS.okService)).toBeNull();
    expect(deriveOverviewModel(collide, PREFS).targetById.has(FIXTURE_IDS.okService)).toBe(false);
  });

  test("target disappearance: a removed host and its services leave the index", () => {
    const before = deriveOverviewModel(makeOverviewSnapshot({ hostCount: 4 }), PREFS);
    const smaller = makeOverviewSnapshot({ hostCount: 3, serviceCount: 12 });
    const after = deriveOverviewModel(smaller, PREFS, before);
    expect(before.targetById.has(FIXTURE_IDS.unknownHost)).toBe(true);
    expect(after.targetById.has(FIXTURE_IDS.unknownHost)).toBe(false);
    expect(after.targetById.has("svc:host-004/api")).toBe(false);
    expect(resolveOverviewTarget(smaller, FIXTURE_IDS.unknownHost)).toBeNull();
    expect(hostIds(after).flat()).not.toContain(FIXTURE_IDS.unknownHost);
  });
});

describe("deriveOverviewModel — grouping and ordering", () => {
  const snapshot = deepFreeze(makeOverviewSnapshot());

  test("defaults: class groups (collator order), status-first hosts, every group present", () => {
    const model = deriveOverviewModel(snapshot, PREFS);
    expect(groupIds(model)).toEqual([
      "class:hypervisor-api", "class:managed-linux", "class:nas-api", "class:probe-only",
    ]);
    expect(model.groups.map((g) => g.label)).toEqual(["hypervisor-api", "managed-linux", "nas-api", "probe-only"]);
    expect(PREFS.collapsedGroupIds).toEqual([]);
  });

  test.each([
    ["class", "status", ["class:managed-linux"], [["host:host-003", "host:host-002", "host:host-004", "host:host-001"]]],
    ["class", "name", ["class:managed-linux"], [["host:host-001", "host:host-002", "host:host-003", "host:host-004"]]],
    ["status", "name", ["status:critical", "status:warning", "status:unknown", "status:ok"],
      [["host:host-003"], ["host:host-002"], ["host:host-004"], ["host:host-001"]]],
    ["name", "status", ["name:host:host-001", "name:host:host-002", "name:host:host-003", "name:host:host-004"],
      [["host:host-001"], ["host:host-002"], ["host:host-003"], ["host:host-004"]]],
  ] as const)("groupBy=%s sortBy=%s", (groupBy, sortBy, groups, hosts) => {
    const snap = makeOverviewSnapshot({ classes: ["managed-linux"] });
    const model = deriveOverviewModel(snap, prefs(groupBy, sortBy));
    expect(groupIds(model)).toEqual([...groups]);
    expect(hostIds(model)).toEqual(hosts.map((h) => [...h]));
  });

  test("status groups use shared labels and OVERVIEW_STATUS_ORDER", () => {
    const envelope = makeEnvelopeOverviewSnapshot();
    const model = deriveOverviewModel(envelope, prefs("status", "name"));
    expect(groupIds(model)).toEqual(OVERVIEW_STATUS_ORDER.map((s) => `status:${s}`));
    expect(model.groups.map((g) => g.label)).toEqual(["critical", "warning", "unknown", "suppressed", "OK"]);
    expect(model.groups.map((g) => g.hosts.length)).toEqual([20, 20, 20, 20, 20]);
  });

  test("sortBy=class falls back to status then name within each class group", () => {
    const snap = makeOverviewSnapshot({ hostCount: 4, classes: ["probe-only", "managed-linux"] });
    const model = deriveOverviewModel(snap, prefs("class", "class"));
    expect(hostIds(model)).toEqual([["host:host-002", "host:host-004"], ["host:host-003", "host:host-001"]]);
  });

  test("ties: collator, then code-unit order, then exact drilldownId", () => {
    const base = makeOverviewSnapshot({ hostCount: 1, statuses: ["ok"], classes: ["managed-linux"] }).hosts[0]!;
    const hosts = [
      variantHost(base, { name: "web1", drilldownId: "host:z" }),
      variantHost(base, { name: "web10", drilldownId: "host:a" }),
      variantHost(base, { name: "Web1", drilldownId: "host:y" }),
      variantHost(base, { name: "web2", drilldownId: "host:b" }),
      variantHost(base, { name: "web1", drilldownId: "host:m" }),
    ];
    const snap = { ...makeOverviewSnapshot({ hostCount: 0 }), hosts };
    const expected = ["host:y", "host:m", "host:z", "host:b", "host:a"];
    for (const sortBy of ["class", "status", "name"] as const) {
      expect(hostIds(deriveOverviewModel(snap, prefs("class", sortBy)))).toEqual([expected]);
    }
    const byName = deriveOverviewModel(snap, prefs("name", "name"));
    expect(groupIds(byName)).toEqual(expected.map((id) => `name:${id}`));
  });

  test("reordered input yields identical output and reuses the previous model", () => {
    const first = deriveOverviewModel(snapshot, PREFS);
    const reversed = deepFreeze({ ...structuredClone(snapshot), hosts: structuredClone([...snapshot.hosts].reverse()) });
    const fresh = deriveOverviewModel(reversed, PREFS);
    expect(hostIds(fresh)).toEqual(hostIds(first));
    expect(deriveOverviewModel(reversed, PREFS, first)).toBe(first);
  });

  test("zero hosts → empty groups, empty index, all-zero counts", () => {
    const model = deriveOverviewModel(makeOverviewSnapshot({ hostCount: 0 }), PREFS);
    expect(model.groups).toEqual([]);
    expect(model.targetById.size).toBe(0);
    expect(model.stats.hosts).toEqual({ ok: 0, warning: 0, critical: 0, unknown: 0, suppressed: 0 });
    expect(model.stats.services).toEqual({ ok: 0, warning: 0, critical: 0, unknown: 0, suppressed: 0 });
  });

  test("zero services → host-only targets and zero service counts", () => {
    const model = deriveOverviewModel(makeOverviewSnapshot({ serviceCount: 0 }), PREFS);
    expect(model.targetById.size).toBe(4);
    expect([...model.targetById.values()].every((t) => t.kind === "host" && t.service === null)).toBe(true);
    expect(model.stats.services).toEqual({ ok: 0, warning: 0, critical: 0, unknown: 0, suppressed: 0 });
    expect(model.groups.flatMap((g) => g.hosts).every((h) => h.services.length === 0)).toBe(true);
  });
});

describe("effective status in grouping and counts", () => {
  test("nominal ok with stale/unavailable evidence groups and counts as unknown", () => {
    const snap = deepFreeze(makeOverviewSnapshot({
      hostCount: 2,
      statuses: ["ok"],
      classes: ["managed-linux"],
      targetAvailability: {
        "host:host-001": STALE,
        "svc:host-001/api": { ...STALE, state: "unavailable", lastGoodAt: null },
      },
    }));
    expect(snap.hosts[0]!.rollup).toBe("ok");
    expect(snap.hosts[0]!.services[0]!.status).toBe("ok");
    const model = deriveOverviewModel(snap, prefs("status", "name"));
    expect(groupIds(model)).toEqual(["status:unknown", "status:ok"]);
    expect(hostIds(model)).toEqual([["host:host-001"], ["host:host-002"]]);
    expect(model.stats.hosts).toEqual({ ok: 1, warning: 0, critical: 0, unknown: 1, suppressed: 0 });
    expect(model.stats.services).toEqual({ ok: 5, warning: 0, critical: 0, unknown: 1, suppressed: 0 });
    // Status sort also uses effective status: the stale host sorts before the healthy one.
    expect(hostIds(deriveOverviewModel(snap, prefs("class", "status")))).toEqual([["host:host-001", "host:host-002"]]);
  });

  test("declared suppressed stays suppressed even with stale evidence", () => {
    const snap = deepFreeze(makeOverviewSnapshot({ hostCount: 1, serviceCount: 2, statuses: ["suppressed"], availability: STALE }));
    const model = deriveOverviewModel(snap, prefs("status", "name"));
    expect(groupIds(model)).toEqual(["status:suppressed"]);
    expect(model.stats.hosts.suppressed).toBe(1);
    expect(model.stats.services.suppressed).toBe(2);
    expect(model.stats.hosts.unknown + model.stats.services.unknown).toBe(0);
  });
});

describe("deriveOverviewStats", () => {
  test("envelope totals from one cycle", () => {
    const envelope = deepFreeze(makeEnvelopeOverviewSnapshot());
    const stats = deriveOverviewStats(envelope);
    expect(stats.hosts).toEqual({ ...ENVELOPE_HOST_ROLLUP_COUNTS });
    expect(stats.services).toEqual({ ...ENVELOPE_SERVICE_STATUS_COUNTS });
    expect(stats.firing).toEqual({
      critical: ENVELOPE_ALERT_COUNTS.critical,
      warning: ENVELOPE_ALERT_COUNTS.warning,
      info: ENVELOPE_ALERT_COUNTS.info,
    });
    expect(stats.silenced).toBe(2);
    expect(stats.inhibited).toBe(1);
    expect(stats.coverage).toEqual({ status: "available", ...ENVELOPE_COVERAGE, availability: envelope.coverage.availability });
    expect(stats.engine).toEqual({ status: "available", ok: true, availability: envelope.engine.availability });
    expect(deriveOverviewModel(envelope, PREFS).stats).toEqual(stats);
  });

  test("unavailable coverage and engine are explicit unavailable members, never 0 or OK", () => {
    const snap = deepFreeze(makeOverviewSnapshot({ includeCoverage: false, engineAvailable: false }));
    const stats = deriveOverviewStats(snap);
    expect(stats.coverage).toEqual({
      status: "unavailable",
      availability: snap.coverage.availability,
      message: "Coverage comparison is unavailable.",
    });
    expect(stats.coverage).not.toHaveProperty("gaps");
    expect(stats.engine).toEqual({ status: "unavailable", availability: snap.engine.availability });
    expect(stats.engine).not.toHaveProperty("ok");
  });

  test("null coverage without a message uses the fixed copy", () => {
    const base = makeOverviewSnapshot();
    const snap: OverviewSnapshotV2 = {
      ...base,
      coverage: { availability: { state: "not-configured", source: "rendered-estate", lastGoodAt: null, message: null }, value: null },
    };
    expect(deriveOverviewStats(snap).coverage).toEqual({
      status: "unavailable",
      availability: snap.coverage.availability,
      message: "Coverage unavailable.",
    });
  });

  test("retained coverage keeps its counts with the exact stale/unavailable evidence and lastGoodAt", () => {
    const base = makeOverviewSnapshot();
    for (const state of ["stale", "unavailable"] as const) {
      const availability: DataAvailability = {
        state,
        source: "rendered-estate",
        lastGoodAt: "2026-09-01T11:30:00.000Z",
        message: `Coverage is ${state}.`,
      };
      const snap = deepFreeze({ ...base, coverage: { availability, value: { covered: 14, gaps: 0, extras: 0 } } });
      const coverage = deriveOverviewStats(snap).coverage;
      expect(coverage).toEqual({ status: "available", covered: 14, gaps: 0, extras: 0, availability });
      expect(coverage.availability.state).not.toBe("current");
      expect(coverage.availability.lastGoodAt).toBe("2026-09-01T11:30:00.000Z");
    }
  });

  test("retained engine value keeps its non-current evidence", () => {
    const base = makeOverviewSnapshot();
    const availability: DataAvailability = { ...STALE, source: "victoriametrics-buildinfo" };
    const snap = { ...base, engine: { availability, value: { ok: true } } };
    expect(deriveOverviewStats(snap).engine).toEqual({ status: "available", ok: true, availability });
  });

  test("malformed coverage counts / engine value fail closed to unavailable", () => {
    const base = makeOverviewSnapshot();
    const snap = {
      ...base,
      coverage: { ...base.coverage, value: { covered: -1, gaps: Number.NaN, extras: 0.5 } },
      engine: { ...base.engine, value: { ok: "yes" as unknown as boolean } },
    };
    const stats = deriveOverviewStats(snap);
    expect(stats.coverage.status).toBe("unavailable");
    expect(stats.engine.status).toBe("unavailable");
  });
});

describe("deriveOverviewModel — structural sharing", () => {
  test("a no-op cycle with fresh objects returns the identical model", () => {
    const snap = makeEnvelopeOverviewSnapshot();
    const first = deriveOverviewModel(deepFreeze(snap), PREFS);
    const again = deriveOverviewModel(deepFreeze(structuredClone(snap)), PREFS, first);
    expect(again).toBe(first);
    expect(again.groups).toBe(first.groups);
    expect(again.targetById).toBe(first.targetById);
    expect(again.stats).toBe(first.stats);
    expect(again.firing).toBe(first.firing);
  });

  test("next cycle with only timestamps advanced reuses groups, hosts, targets, counts and firing", () => {
    const first = deriveOverviewModel(makeOverviewSnapshot({ cycle: 1 }), PREFS);
    const next = deriveOverviewModel(makeOverviewSnapshot({ cycle: 2 }), PREFS, first);
    expect(next.groups).toBe(first.groups);
    next.groups.forEach((group, i) => {
      expect(group).toBe(first.groups[i]!);
      group.hosts.forEach((host, j) => expect(host).toBe(first.groups[i]!.hosts[j]!));
    });
    expect(next.targetById).toBe(first.targetById);
    expect(next.firing).toBe(first.firing);
    expect(next.stats.hosts).toBe(first.stats.hosts);
    expect(next.stats.services).toBe(first.stats.services);
    expect(next.stats.firing).toBe(first.stats.firing);
    // Coverage/engine evidence carries the new cycle's lastGoodAt, so those members are new values.
    expect(next.stats.coverage).not.toBe(first.stats.coverage);
    expect(next.stats.coverage.availability.lastGoodAt).toBe("2026-09-01T12:00:10.000Z");
  });

  test("one service change preserves unrelated host, group and target references", () => {
    const base = makeEnvelopeOverviewSnapshot();
    const first = deriveOverviewModel(deepFreeze(base), PREFS);
    const changedId = "svc:host-006/db";
    const changed = deepFreeze(structuredClone(withTargetStatus(base, changedId, "critical", 2)));
    const next = deriveOverviewModel(changed, PREFS, first);

    expect(next).not.toBe(first);
    const ownerId = "host:host-006";
    const oldOwner = first.targetById.get(ownerId)!.host;
    const newOwner = next.targetById.get(ownerId)!.host;
    expect(newOwner).not.toBe(oldOwner);
    expect(next.targetById.get(changedId)!.service).not.toBe(first.targetById.get(changedId)!.service);
    expect(next.targetById.get(changedId)!.service!.status).toBe("critical");
    // Sibling services of the owner keep their references.
    newOwner.services.forEach((service, i) => {
      if (service.drilldownId !== changedId) expect(service).toBe(oldOwner.services[i]!);
    });
    // Every unrelated host and target keeps its reference.
    for (const [id, target] of next.targetById) {
      if (target.host.drilldownId === ownerId) continue;
      expect(target).toBe(first.targetById.get(id)!);
      expect(target.host).toBe(first.targetById.get(id)!.host);
    }
    // Only the owner's group changes; the other groups are the same objects.
    const ownerGroup = next.groups.find((g) => g.hosts.includes(newOwner))!;
    for (const [i, group] of next.groups.entries()) {
      if (group === ownerGroup) expect(group).not.toBe(first.groups[i]!);
      else expect(group).toBe(first.groups[i]!);
    }
    expect(next.firing).toBe(first.firing);
  });

  test("a host-only change keeps every service reference", () => {
    const base = makeOverviewSnapshot();
    const first = deriveOverviewModel(base, PREFS);
    const next = deriveOverviewModel(structuredClone(withTargetStatus(base, FIXTURE_IDS.okHost, "warning", 2)), PREFS, first);
    for (const [id, target] of first.targetById) {
      if (target.service !== null) expect(next.targetById.get(id)!.service).toBe(target.service);
    }
  });

  test("a pure preference reorder keeps every host content reference", () => {
    const snap = makeEnvelopeOverviewSnapshot();
    const first = deriveOverviewModel(snap, PREFS);
    const regrouped = deriveOverviewModel(snap, prefs("status", "name"), first);
    expect(regrouped.targetById).toBe(first.targetById);
    expect(regrouped.stats).toBe(first.stats);
    for (const host of regrouped.groups.flatMap((g) => g.hosts)) {
      expect(host).toBe(first.targetById.get(host.drilldownId)!.host);
    }
  });

  test("hostContentKey is deterministic and sensitive to nested service content", () => {
    const snap = makeOverviewSnapshot();
    const host = snap.hosts[0]!;
    expect(hostContentKey(structuredClone(host))).toBe(hostContentKey(host));
    const changed = withTargetStatus(snap, FIXTURE_IDS.okServiceNoBoard, "warning", 1).hosts[0]!;
    expect(hostContentKey(changed)).not.toBe(hostContentKey(host));
    expect(hostContentKey(snap.hosts[1]!)).not.toBe(hostContentKey(host));
  });
});

describe("selectors never mutate their inputs", () => {
  test("deep-frozen snapshot, preferences and previous model are left untouched", () => {
    const snap = makeEnvelopeOverviewSnapshot();
    const before = JSON.stringify(snap);
    const frozen = deepFreeze(structuredClone(snap));
    const frozenPrefs = deepFreeze(prefs("status", "class"));
    const first = deriveOverviewModel(frozen, frozenPrefs);
    const changed = deepFreeze(structuredClone(withTargetStatus(snap, "svc:host-010/api", "ok", 2)));
    expect(() => deriveOverviewModel(changed, frozenPrefs, deepFreeze(first))).not.toThrow();
    expect(() => deriveOverviewStats(frozen)).not.toThrow();
    expect(() => buildKioskFiringSummary(frozen.alerts)).not.toThrow();
    const target = resolveOverviewTarget(frozen, FIXTURE_IDS.okService)!;
    expect(() => deriveTargetDrawerModel(frozen, target)).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(before);
    expect(frozen.hosts.map((h) => h.drilldownId)).toEqual(snap.hosts.map((h) => h.drilldownId));
  });

  test("selectors.ts imports no React or component module", () => {
    const source = readFileSync(new URL("../src/client/views/overview/selectors.ts", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/^react|^@preact|\.tsx$|\/ui\/|\/shell\/|\/grid\/|\/drawer\/|\/ribbon\/|\/stats\//);
    }
    expect(source).not.toMatch(/localStorage|Date\.now|fetch\(/);
  });
});

function alert(fingerprint: string, name: string, severity: OverviewAlertSummary["severity"], startsAt: string): OverviewAlertSummary {
  return { fingerprint, name, severity, startsAt, target: null };
}

describe("firing ribbon helpers", () => {
  test("compareFiringAlerts: severity, oldest valid start (invalid last), name, fingerprint", () => {
    const alerts = deepFreeze([
      alert("f9", "Info", "info", "2026-09-01T09:00:00.000Z"),
      alert("f8", "Warn", "warning", "2026-09-01T11:00:00.000Z"),
      alert("f7", "Late", "critical", "2026-09-01T11:00:00.000Z"),
      alert("f6", "NoTime", "critical", "not-a-time"),
      alert("f5", "Early", "critical", "2026-09-01T10:00:00.000Z"),
      alert("f4", "beta", "critical", "2026-09-01T10:30:00.000Z"),
      alert("f3", "Alpha", "critical", "2026-09-01T10:30:00.000Z"),
      alert("f2", "Same", "critical", "2026-09-01T10:45:00.000Z"),
      alert("f1", "Same", "critical", "2026-09-01T10:45:00.000Z"),
    ]);
    const sorted = [...alerts].sort(compareFiringAlerts).map((a) => a.fingerprint);
    expect(sorted).toEqual(["f5", "f3", "f4", "f1", "f2", "f7", "f6", "f8", "f9"]);
    expect(alerts[0]!.fingerprint).toBe("f9");
  });

  test.each([
    [0, 0],
    [3, 0],
    [5, 0],
    [6, 1],
    [12, 7],
  ])("kiosk summary with %i alerts names at most five and overflows by %i", (count, overflow) => {
    const alerts = deepFreeze(Array.from({ length: count }, (_, i) =>
      alert(`fp-${i}`, `Alert${String(count - i).padStart(2, "0")}`, i % 3 === 0 ? "critical" : "warning", "2026-09-01T10:00:00.000Z")));
    const summary = buildKioskFiringSummary(alerts);
    expect(summary.names.length).toBe(Math.min(count, KIOSK_ALERT_NAME_LIMIT));
    expect(summary.overflow).toBe(overflow);
    expect(summary.counts.critical + summary.counts.warning + summary.counts.info).toBe(count);
    expect(summary.names).toEqual([...alerts].sort(compareFiringAlerts).slice(0, 5).map((a) => a.name));
    if (overflow > 0) expect(`+${summary.overflow} more`).toBe(`+${overflow} more`);
  });

  test("kiosk summary over the envelope: complete counts, first five ordered names, exact overflow", () => {
    const envelope = makeEnvelopeOverviewSnapshot();
    const summary = buildKioskFiringSummary(envelope.alerts);
    expect(summary.counts).toEqual({ critical: 40, warning: 60, info: 1 });
    expect(summary.names).toHaveLength(5);
    expect(summary.overflow).toBe(ENVELOPE_ALERT_COUNTS.firing - 5);
    expect(`+${summary.overflow} more`).toBe("+96 more");
    expect(summary.names.every((n) => n === "HostDown" || n === "ServiceDown")).toBe(true);
  });

  test("missing alert name is shown as 'Unnamed alert'", () => {
    const summary = buildKioskFiringSummary([alert("fp", "", "critical", "2026-09-01T10:00:00.000Z")]);
    expect(summary.names).toEqual(["Unnamed alert"]);
  });

  test("triage paths encode fingerprint and TargetIdentity.id exactly", () => {
    expect(alertTriagePath(alert("a/b c?", "X", "info", NOW))).toBe("/alerts/a%2Fb%20c%3F");
    expect(targetTriagePath({ kind: "service", id: "svc:host-001/api" })).toBe("/alerts?target=svc%3Ahost-001%2Fapi");
    expect(targetTriagePath({ kind: "host", id: "host:a&b=c" })).toBe("/alerts?target=host%3Aa%26b%3Dc");
  });

  test("model.firing is exactly the snapshot's alert list (no client filtering)", () => {
    const snap = makeOverviewSnapshot();
    expect(deriveOverviewModel(snap, PREFS).firing).toBe(snap.alerts);
  });
});

describe("drawer helpers", () => {
  test("deriveTargetDrawerModel filters signals/alerts/checks by exact kind+id in server order", () => {
    const base = makeOverviewSnapshot();
    const id = "svc:host-003/api";
    const snap = deepFreeze({
      ...base,
      signals: [
        ...base.signals,
        // Same id under the wrong kind must not be attributed.
        { ...base.signals[0]!, target: { kind: "host" as const, id }, id: "decoy" },
        { ...base.signals.find((s) => s.target.id === id)!, id: "second", label: "Second" },
      ],
    });
    const target = resolveOverviewTarget(snap, id)!;
    const drawer = deriveTargetDrawerModel(snap, target);
    expect(drawer.target).toBe(target);
    expect(drawer.signals.map((s) => s.id)).toEqual(["service.up", "second"]);
    expect(drawer.alerts.map((a) => a.target?.id)).toEqual([id]);
    expect(drawer.alerts[0]!.name).toBe("ServiceDown");
    expect(drawer.checks.map((c) => c.observedAt)).toEqual(["2026-09-01T11:59:00.000Z", "2026-09-01T12:00:00.000Z"]);
    expect(drawer.checks.every((c) => c.target?.kind === "service" && c.target.id === id)).toBe(true);
    expect(drawer.checkLanes).toHaveLength(1);
    expect(drawer.status).toBe("critical");
    expect(drawer.grafana).toEqual(target.service!.grafana);
  });

  test("host drawer uses the host's own evidence and handles a missing board", () => {
    const snap = makeOverviewSnapshot({ grafana: false, targetAvailability: { [FIXTURE_IDS.okHost]: STALE } });
    const drawer = deriveTargetDrawerModel(snap, resolveOverviewTarget(snap, FIXTURE_IDS.okHost)!);
    expect(drawer.status).toBe("unknown");
    expect(drawer.availability).toEqual(STALE);
    expect(drawer.grafana).toBeNull();
    expect(drawer.signals.map((s) => s.target)).toEqual([{ kind: "host", id: FIXTURE_IDS.okHost }]);
    expect(drawer.checks).toEqual([]);
    expect(drawer.checkLanes).toEqual([]);
  });

  test("buildCheckTimeline: lanes by endpoint, outcomes, median interval, invalid times dropped", () => {
    const t = (min: number): string => new Date(Date.parse("2026-09-01T12:00:00.000Z") + min * 60_000).toISOString();
    const check = (endpoint: string, success: boolean | null, observedAt: string | null): CheckSummary =>
      ({ target: null, endpoint, success, observedAt, durationMs: null });
    const lanes = buildCheckTimeline(deepFreeze([
      check("b", true, t(2)),
      check("b", false, t(0)),
      check("b", null, t(4)),
      check("a", true, t(1)),
      check("a", false, t(1)), // equal timestamp: last input wins
      check("a", true, null),
      check("a", true, "garbage"),
    ]));
    const at = (min: number): number => Date.parse(t(min));
    expect(lanes.map((l) => l.id)).toEqual(["a", "b"]);
    expect(lanes[0]!.label).toBe("a");
    // Deltas across lanes: [2 min, 2 min] → median 2 min; domainEnd = newest (4) + 2 = 6.
    expect(lanes[0]!.segments).toEqual([{ status: "critical", start: at(1), end: at(6) }]);
    expect(lanes[1]!.segments).toEqual([
      { status: "critical", start: at(0), end: at(2) },
      { status: "ok", start: at(2), end: at(4) },
      { status: "unknown", start: at(4), end: at(6) },
    ]);
  });

  test("buildCheckTimeline: one point gets a 1 ms domain; no usable times gives no lanes", () => {
    const one = buildCheckTimeline([{ target: null, endpoint: "x", success: true, observedAt: NOW, durationMs: 5 }]);
    expect(one).toEqual([{ id: "x", label: "x", segments: [{ status: "ok", start: Date.parse(NOW), end: Date.parse(NOW) + 1 }] }]);
    expect(buildCheckTimeline([{ target: null, endpoint: "x", success: null, observedAt: null, durationMs: null }])).toEqual([]);
    expect(buildCheckTimeline([])).toEqual([]);
  });
});
