import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createNotifiedMemory, type NotifiedMemory } from "../../src/server/push/memory.js";
import {
  buildPayload,
  fitText,
  notificationText,
  sanitizeText,
  serializePayload,
} from "../../src/server/push/payload.js";
import {
  AUDIBLE_LEVEL,
  alertCollapseId,
  groupCollapseId,
  planDeliveries,
  preferenceKey,
  SEVERITY_RANK,
  severityOf,
  type NotificationKind,
  type PlannedNotification,
  type PlanResult,
} from "../../src/server/push/plan.js";
import type { DeviceRecord } from "../../src/server/push/registry/schema.js";
import { amAlert, amNotification, type AmAlertFixture } from "./helpers/am-fixtures.js";

const D = "dev_AAAAAAAAAAA";
const E = "dev_BBBBBBBBBBB";
const GROUP_KEY = '{}:{alertname="HostDown"}';
const NOW_MS = 1_795_000_000_500;

const ALL_ON = { critical: true, warning: true, info: true } as const;
const ALL_OFF = { critical: false, warning: false, info: false } as const;
type Prefs = DeviceRecord["preferences"];

function fp(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function device(id: string, opts: { prefs?: Prefs; token?: string | null | undefined } = {}): DeviceRecord {
  return {
    id,
    displayName: "Example iPhone",
    credentialHash: "0".repeat(64),
    apnsToken: opts.token === undefined ? "ab".repeat(32) : opts.token,
    environment: "sandbox",
    preferences: opts.prefs ?? ALL_ON,
    pairedAt: "2026-01-01T00:00:00.000Z",
    seenAt: "2026-01-01T00:00:00.000Z",
    lastDelivery: null,
  };
}

function firing(n: number, severity: string | null = "critical"): AmAlertFixture {
  return amAlert({ fingerprint: fp(n), severity, name: `Alert${n}` });
}

function resolvedAlert(n: number, severity: string | null = "critical"): AmAlertFixture {
  return amAlert({ fingerprint: fp(n), severity, status: "resolved", name: `Alert${n}` });
}

const GROUP_ID = `g-${createHash("sha256").update(GROUP_KEY, "utf8").digest("hex").slice(0, 16)}`;

/** One planner call (or a direct memory action) in a row's sequence. */
type Step =
  | {
      readonly alerts: readonly AmAlertFixture[];
      /** Preferences for device D during this call (default all on). */
      readonly prefs?: Prefs;
      /** Whether this call's items and filtered counts are part of the row's expectation (default true). */
      readonly observe?: boolean;
    }
  | { readonly act: (memory: NotifiedMemory) => void };

interface Row {
  readonly name: string;
  readonly steps: readonly Step[];
  readonly memoryCap?: number;
  /** Device D's APNs token (default a valid token). */
  readonly token?: string | null;
  readonly expect: {
    readonly kinds: readonly NotificationKind[];
    readonly audible: readonly boolean[];
    /** Per item, the marks as `fingerprint#generation`. */
    readonly marks: readonly (readonly string[])[];
    readonly collapseIds: readonly string[];
    readonly filtered: Readonly<Partial<Record<NotificationKind, number>>>;
  };
  readonly extra?: (ctx: RowContext) => void;
}

interface RowContext {
  readonly items: readonly PlannedNotification[];
  readonly results: readonly PlanResult[];
  readonly memory: NotifiedMemory;
}

function runRow(row: Row): {
  items: PlannedNotification[];
  filtered: Partial<Record<NotificationKind, number>>;
  ctx: RowContext;
} {
  const memory = createNotifiedMemory(row.memoryCap);
  const items: PlannedNotification[] = [];
  const results: PlanResult[] = [];
  const filtered: Partial<Record<NotificationKind, number>> = {};
  for (const step of row.steps) {
    if ("act" in step) {
      step.act(memory);
      continue;
    }
    const devices = [device(D, { prefs: step.prefs ?? ALL_ON, token: row.token })];
    const result = planDeliveries(
      amNotification({ alerts: [...step.alerts], groupKey: GROUP_KEY }),
      devices,
      memory,
      { badge: 3, nowMs: NOW_MS },
    );
    if (step.observe === false) continue;
    results.push(result);
    items.push(...(result.perDevice.get(D) ?? []));
    for (const [kind, n] of result.filtered) filtered[kind] = (filtered[kind] ?? 0) + n;
  }
  return { items, filtered, ctx: { items, results, memory } };
}

const ROWS: readonly Row[] = [
  {
    name: "5 vs 6: five firing alerts give five per-alert items",
    steps: [{ alerts: [1, 2, 3, 4, 5].map((n) => firing(n)) }],
    expect: {
      kinds: ["firing", "firing", "firing", "firing", "firing"],
      audible: [true, true, true, true, true],
      marks: [[`${fp(1)}#1`], [`${fp(2)}#2`], [`${fp(3)}#3`], [`${fp(4)}#4`], [`${fp(5)}#5`]],
      collapseIds: [1, 2, 3, 4, 5].map((n) => `a-${fp(n)}`),
      filtered: {},
    },
  },
  {
    name: "5 vs 6: six firing alerts give one audible summary",
    steps: [{ alerts: [1, 2, 3, 4, 5, 6].map((n) => firing(n)) }],
    expect: {
      kinds: ["summary"],
      audible: [true],
      marks: [[1, 2, 3, 4, 5, 6].map((n) => `${fp(n)}#${n}`)],
      collapseIds: [GROUP_ID],
      filtered: {},
    },
    extra: ({ items }) => {
      const p = items[0]!.payload;
      expect(p.pulse.kind).toBe("summary");
      expect(p.pulse.target).toEqual({ screen: "alerts" });
      expect(p.pulse.summary).toEqual({ group: GROUP_ID, firing: 6, resolved: 0, severity: "critical" });
      expect(p.aps.category).toBe("PULSE_ALERT_SUMMARY");
      expect(p.aps.sound).toBe("default");
      expect(p.aps.alert.title).toBe("6 alerts changed");
      expect(p.aps.alert.body).toBe("6 firing, 0 resolved in Alert1…");
    },
  },
  {
    name: "unknown severity, warning on: firing with severity unknown at level active",
    steps: [{ alerts: [firing(1, "page")], prefs: { critical: false, warning: true, info: false } }],
    expect: {
      kinds: ["firing"],
      audible: [true],
      marks: [[`${fp(1)}#1`]],
      collapseIds: [`a-${fp(1)}`],
      filtered: {},
    },
    extra: ({ items }) => {
      const p = items[0]!.payload;
      expect(p.pulse.alert?.severity).toBe("unknown");
      expect(p.aps["interruption-level"]).toBe("active");
      expect(p.aps.category).toBe("PULSE_ALERT_FIRING");
    },
  },
  {
    name: "unknown severity, warning off: filtered as a firing alert",
    steps: [{ alerts: [firing(1, "page")], prefs: { critical: true, warning: false, info: true } }],
    expect: { kinds: [], audible: [], marks: [], collapseIds: [], filtered: { firing: 1 } },
    extra: ({ results, memory }) => {
      expect(results[0]!.perDevice.has(D)).toBe(false);
      expect(memory.isMarked(D, fp(1))).toBe(false);
    },
  },
  {
    name: "all muted: device absent, filtered per would-be kind",
    steps: [
      { alerts: [firing(1)], observe: false },
      { alerts: [firing(1), firing(2, "warning"), resolvedAlert(3, "info")], prefs: ALL_OFF },
    ],
    expect: { kinds: [], audible: [], marks: [], collapseIds: [], filtered: { repeat: 1, firing: 1, resolved: 1 } },
    extra: ({ results, memory }) => {
      expect(results[0]!.perDevice.has(D)).toBe(false);
      expect(results[0]!.perDevice.size).toBe(0);
      expect(memory.isMarked(D, fp(2))).toBe(false); // a filtered firing alert never marks
    },
  },
  {
    name: "filtered resolved: counted resolved and the fingerprint is unmarked",
    steps: [
      { alerts: [firing(1)], observe: false },
      { alerts: [resolvedAlert(1)], prefs: ALL_OFF },
    ],
    expect: { kinds: [], audible: [], marks: [], collapseIds: [], filtered: { resolved: 1 } },
    extra: ({ memory }) => expect(memory.isMarked(D, fp(1))).toBe(false),
  },
  {
    name: "repeat: a marked firing alert is quiet with no marks",
    steps: [{ alerts: [firing(1)], observe: false }, { alerts: [firing(1)] }],
    expect: { kinds: ["repeat"], audible: [false], marks: [[]], collapseIds: [`a-${fp(1)}`], filtered: {} },
    extra: ({ items }) => {
      const p = items[0]!.payload;
      expect(p.aps.sound).toBeUndefined();
      expect("sound" in p.aps).toBe(false);
      expect(p.aps["interruption-level"]).toBe("passive");
      expect(p.aps.category).toBe("PULSE_ALERT_FIRING");
    },
  },
  {
    name: "re-fire after resolve: firing, resolved, firing (audible again)",
    steps: [{ alerts: [firing(1)] }, { alerts: [resolvedAlert(1)] }, { alerts: [firing(1)] }],
    expect: {
      kinds: ["firing", "resolved", "firing"],
      audible: [true, false, true],
      marks: [[`${fp(1)}#1`], [], [`${fp(1)}#2`]],
      collapseIds: [`a-${fp(1)}`, `a-${fp(1)}`, `a-${fp(1)}`],
      filtered: {},
    },
    extra: ({ items }) => {
      expect(items[1]!.payload.aps.category).toBe("PULSE_ALERT_RESOLVED");
      expect(items[1]!.payload.aps.alert.body).toBe("Resolved on web-01.example.com");
    },
  },
  {
    name: "memory cap: the oldest mark is evicted and its next firing is audible",
    memoryCap: 3,
    steps: [{ alerts: [1, 2, 3, 4].map((n) => firing(n)) }, { alerts: [firing(1)] }],
    expect: {
      kinds: ["firing", "firing", "firing", "firing", "firing"],
      audible: [true, true, true, true, true],
      marks: [[`${fp(1)}#1`], [`${fp(2)}#2`], [`${fp(3)}#3`], [`${fp(4)}#4`], [`${fp(1)}#5`]],
      collapseIds: [1, 2, 3, 4, 1].map((n) => `a-${fp(n)}`),
      filtered: {},
    },
    extra: ({ memory }) => {
      expect(memory.size(D)).toBe(3);
      expect(memory.isMarked(D, fp(2))).toBe(false);
    },
  },
  {
    name: "V-020: summary severity is the highest newly firing severity",
    steps: [
      { alerts: [firing(3, "warning"), firing(4, "warning")], observe: false },
      {
        alerts: [
          firing(1, "info"),
          firing(2, "critical"),
          firing(3, "warning"),
          firing(4, "warning"),
          resolvedAlert(5),
          resolvedAlert(6),
        ],
      },
    ],
    expect: {
      kinds: ["summary"],
      audible: [true],
      marks: [[`${fp(1)}#3`, `${fp(2)}#4`]],
      collapseIds: [GROUP_ID],
      filtered: {},
    },
    extra: ({ items }) => {
      const p = items[0]!.payload;
      expect(p.pulse.summary).toEqual({ group: GROUP_ID, firing: 4, resolved: 2, severity: "critical" });
      expect(p.aps["interruption-level"]).toBe("time-sensitive");
      expect(p.aps.sound).toBe("default");
    },
  },
  {
    name: "V-020 quiet: every alert marked or resolved gives a passive summary with severity null",
    steps: [
      { alerts: [1, 2, 3, 4].map((n) => firing(n)), observe: false },
      { alerts: [firing(1), firing(2), firing(3), firing(4), resolvedAlert(5), resolvedAlert(6)] },
    ],
    expect: { kinds: ["summary"], audible: [false], marks: [[]], collapseIds: [GROUP_ID], filtered: {} },
    extra: ({ items }) => {
      const p = items[0]!.payload;
      expect(p.pulse.summary?.severity).toBeNull();
      expect(p.aps["interruption-level"]).toBe("passive");
      expect("sound" in p.aps).toBe(false);
    },
  },
  {
    name: "V-021 follow-up: a covered alert repeating after a summary is a quiet per-alert repeat",
    steps: [{ alerts: [1, 2, 3, 4, 5, 6].map((n) => firing(n)) }, { alerts: [firing(1)] }],
    expect: {
      kinds: ["summary", "repeat"],
      audible: [true, false],
      marks: [[1, 2, 3, 4, 5, 6].map((n) => `${fp(n)}#${n}`), []],
      collapseIds: [GROUP_ID, `a-${fp(1)}`],
      filtered: {},
    },
  },
  {
    name: "V-021 storm 2: a 7-alert call whose alerts are all covered is a quiet summary",
    steps: [
      { alerts: [firing(7)], observe: false },
      { alerts: [1, 2, 3, 4, 5, 6].map((n) => firing(n)) },
      { alerts: [1, 2, 3, 4, 5, 6, 7].map((n) => firing(n)) },
    ],
    expect: {
      kinds: ["summary", "summary"],
      audible: [true, false],
      marks: [[1, 2, 3, 4, 5, 6].map((n) => `${fp(n)}#${n + 1}`), []],
      collapseIds: [GROUP_ID, GROUP_ID],
      filtered: {},
    },
    extra: ({ items }) => expect(items[1]!.payload.pulse.summary?.severity).toBeNull(),
  },
  {
    name: "V-014 generation: dropping a stale item keeps the newer mark, so the next repeat is quiet",
    steps: [
      { alerts: [firing(0xa1)] },
      { alerts: [firing(0xa2), resolvedAlert(0xa1)] },
      { alerts: [firing(0xa1)] },
      { act: (memory) => memory.unmarkIfCurrent(D, [{ fingerprint: fp(0xa1), generation: 1 }]) },
      { alerts: [firing(0xa1)] },
    ],
    expect: {
      kinds: ["firing", "firing", "resolved", "firing", "repeat"],
      audible: [true, true, false, true, false],
      marks: [[`${fp(0xa1)}#1`], [`${fp(0xa2)}#2`], [], [`${fp(0xa1)}#3`], []],
      collapseIds: [0xa1, 0xa2, 0xa1, 0xa1, 0xa1].map((n) => `a-${fp(n)}`),
      filtered: {},
    },
    extra: ({ memory }) => {
      expect(memory.isMarked(D, fp(0xa1))).toBe(true);
      // Dropping the current item instead does remove the mark.
      memory.unmarkIfCurrent(D, [{ fingerprint: fp(0xa1), generation: 3 }]);
      expect(memory.isMarked(D, fp(0xa1))).toBe(false);
    },
  },
  {
    name: "no token: a device with apnsToken null is neither planned nor counted",
    token: null,
    steps: [{ alerts: [firing(1), firing(2, "page")], prefs: { critical: true, warning: false, info: true } }],
    expect: { kinds: [], audible: [], marks: [], collapseIds: [], filtered: {} },
    extra: ({ results, memory }) => {
      expect(results[0]!.perDevice.size).toBe(0);
      expect(results[0]!.filtered.size).toBe(0);
      expect(memory.size(D)).toBe(0);
    },
  },
  {
    name: "collapse ids: a-<fp> per alert and g- + 16 hex of sha256(groupKey) per summary",
    steps: [{ alerts: [firing(0x3f9a1c2b)] }, { alerts: [1, 2, 3, 4, 5, 6].map((n) => firing(n)) }],
    expect: {
      kinds: ["firing", "summary"],
      audible: [true, true],
      marks: [[`${fp(0x3f9a1c2b)}#1`], [1, 2, 3, 4, 5, 6].map((n) => `${fp(n)}#${n + 1}`)],
      collapseIds: [`a-${fp(0x3f9a1c2b)}`, GROUP_ID],
      filtered: {},
    },
    extra: ({ items }) => {
      expect(items[0]!.payload.pulse.collapseId).toBe(items[0]!.collapseId);
      expect(items[1]!.payload.pulse.collapseId).toBe(items[1]!.collapseId);
      expect(items[1]!.collapseId).toHaveLength(18);
      expect(items[1]!.collapseId).toMatch(/^g-[0-9a-f]{16}$/);
    },
  },
  {
    name: "expiration: floor(now / 1000) + 3600 on every item of a call",
    steps: [{ alerts: [firing(1), firing(2), resolvedAlert(3)] }],
    expect: {
      kinds: ["firing", "firing", "resolved"],
      audible: [true, true, false],
      marks: [[`${fp(1)}#1`], [`${fp(2)}#2`], []],
      collapseIds: [1, 2, 3].map((n) => `a-${fp(n)}`),
      filtered: {},
    },
    extra: ({ items }) => {
      for (const item of items) expect(item.expiration).toBe(1_795_003_600);
    },
  },
];

describe("planDeliveries", () => {
  for (const row of ROWS) {
    test(row.name, () => {
      const { items, filtered, ctx } = runRow(row);
      expect(items.map((i) => i.kind)).toEqual([...row.expect.kinds]);
      expect(items.map((i) => i.audible)).toEqual([...row.expect.audible]);
      expect(items.map((i) => i.marks.map((m) => `${m.fingerprint}#${m.generation}`))).toEqual(
        row.expect.marks.map((m) => [...m]),
      );
      expect(items.map((i) => i.collapseId)).toEqual([...row.expect.collapseIds]);
      expect(filtered).toEqual({ ...row.expect.filtered });
      for (const item of items) {
        expect(item.deviceId).toBe(D);
        expect(Object.isFrozen(item)).toBe(true);
        expect(Object.isFrozen(item.marks)).toBe(true);
        // Sound is present exactly when the item is audible.
        expect("sound" in item.payload.aps).toBe(item.audible);
        expect(item.payload.aps.badge).toBe(3);
      }
      row.extra?.(ctx);
    });
  }

  test("a device with apnsToken null is skipped while a device with a token is planned", () => {
    const memory = createNotifiedMemory();
    const result = planDeliveries(
      amNotification({ alerts: [firing(1)] }),
      [device(D, { token: null }), device(E)],
      memory,
      { badge: null, nowMs: NOW_MS },
    );
    expect([...result.perDevice.keys()]).toEqual([E]);
    expect(memory.size(D)).toBe(0);
    expect(memory.size(E)).toBe(1);
  });

  test("zero devices give an empty plan", () => {
    const result = planDeliveries(amNotification(), [], createNotifiedMemory(), { badge: 1, nowMs: NOW_MS });
    expect(result.perDevice.size).toBe(0);
    expect(result.filtered.size).toBe(0);
  });

  test("per-alert payloads are shared across devices within a call and badge null omits aps.badge", () => {
    const result = planDeliveries(
      amNotification({ alerts: [firing(1)] }),
      [device(D), device(E)],
      createNotifiedMemory(),
      { badge: null, nowMs: NOW_MS },
    );
    const a = result.perDevice.get(D)![0]!;
    const b = result.perDevice.get(E)![0]!;
    expect(a.payload).toBe(b.payload);
    expect("badge" in a.payload.aps).toBe(false);
  });

  test("devices are planned in the given order and each device has its own memory", () => {
    const memory = createNotifiedMemory();
    memory.mark(E, fp(1));
    const result = planDeliveries(amNotification({ alerts: [firing(1)] }), [device(E), device(D)], memory, {
      badge: 0,
      nowMs: NOW_MS,
    });
    expect([...result.perDevice.keys()]).toEqual([E, D]);
    expect(result.perDevice.get(E)![0]!.kind).toBe("repeat");
    expect(result.perDevice.get(D)![0]!.kind).toBe("firing");
  });
});

describe("plan helpers", () => {
  test("severityOf matches the three known values exactly, else unknown", () => {
    expect(severityOf(amAlert({ severity: "critical" }))).toBe("critical");
    expect(severityOf(amAlert({ severity: "warning" }))).toBe("warning");
    expect(severityOf(amAlert({ severity: "info" }))).toBe("info");
    expect(severityOf(amAlert({ severity: "Critical" }))).toBe("unknown");
    expect(severityOf(amAlert({ severity: null }))).toBe("unknown");
  });

  test("severityOf ignores a severity inherited through the prototype chain", () => {
    const labels = Object.create({ severity: "critical" }) as Record<string, string>;
    expect(severityOf({ ...amAlert(), labels })).toBe("unknown");
  });

  test("preferenceKey filters unknown as warning", () => {
    expect(preferenceKey("unknown")).toBe("warning");
    expect(preferenceKey("info")).toBe("info");
  });

  test("AUDIBLE_LEVEL and SEVERITY_RANK", () => {
    expect(AUDIBLE_LEVEL).toEqual({
      critical: "time-sensitive",
      warning: "active",
      info: "passive",
      unknown: "active",
    });
    expect(SEVERITY_RANK.critical > SEVERITY_RANK.warning).toBe(true);
    expect(SEVERITY_RANK.warning > SEVERITY_RANK.unknown).toBe(true);
    expect(SEVERITY_RANK.unknown > SEVERITY_RANK.info).toBe(true);
    expect(Object.isFrozen(AUDIBLE_LEVEL) && Object.isFrozen(SEVERITY_RANK)).toBe(true);
  });

  test("alertCollapseId and groupCollapseId", () => {
    expect(alertCollapseId("3f9a1c2b4d5e6f70")).toBe("a-3f9a1c2b4d5e6f70");
    const id = groupCollapseId(GROUP_KEY);
    expect(id).toBe(`g-${createHash("sha256").update(GROUP_KEY).digest("hex").slice(0, 16)}`);
    expect(id).toHaveLength(18);
  });
});

describe("buildPayload (core)", () => {
  const ALERT = amAlert({
    fingerprint: "3f9a1c2b4d5e6f70",
    severity: "critical",
    target: null,
    labels: { target: "web-01.example.com" },
  });

  test("firing example is byte-for-byte with fixed key order", () => {
    const p = buildPayload({ kind: "alert", alert: ALERT, severity: "critical", audible: true, badge: 3 });
    expect(new TextDecoder().decode(serializePayload(p))).toBe(
      '{"aps":{"alert":{"title":"HostDown","body":"Firing on web-01.example.com"},"category":"PULSE_ALERT_FIRING",' +
        '"interruption-level":"time-sensitive","sound":"default","badge":3},' +
        '"pulse":{"v":1,"kind":"alert","collapseId":"a-3f9a1c2b4d5e6f70",' +
        '"target":{"screen":"alert","fingerprint":"3f9a1c2b4d5e6f70"},' +
        '"alert":{"fingerprint":"3f9a1c2b4d5e6f70","status":"firing","severity":"critical"}}}',
    );
  });

  test("output is deeply frozen", () => {
    const p = buildPayload({ kind: "alert", alert: ALERT, severity: "critical", audible: true, badge: 0 });
    const walk = (v: unknown): void => {
      if (v === null || typeof v !== "object") return;
      expect(Object.isFrozen(v)).toBe(true);
      for (const child of Object.values(v)) walk(child);
    };
    walk(p);
    expect(p.aps.badge).toBe(0);
  });

  test("a resolved alert is never audible", () => {
    const resolved = amAlert({ status: "resolved", severity: "critical" });
    const p = buildPayload({ kind: "alert", alert: resolved, severity: "critical", audible: true, badge: null });
    expect(p.aps.category).toBe("PULSE_ALERT_RESOLVED");
    expect(p.aps["interruption-level"]).toBe("passive");
    expect("sound" in p.aps).toBe(false);
  });

  test("text: Unnamed alert fallback, target falls through empty target to instance", () => {
    const alert = amAlert({ name: "", target: "web-02.example.com", labels: { target: "" } });
    expect(notificationText({ kind: "alert", alert, severity: "critical", audible: true, badge: null })).toEqual({
      title: "Unnamed alert",
      body: "Firing on web-02.example.com",
    });
    const bare = amAlert({ target: null, status: "resolved" });
    expect(notificationText({ kind: "alert", alert: bare, severity: "critical", audible: false, badge: null }).body).toBe(
      "Resolved",
    );
  });

  test("summary suffix only when the whole body fits", () => {
    const draft = {
      kind: "summary" as const,
      group: GROUP_ID,
      total: 6,
      firing: 0,
      resolved: 6,
      severity: null,
      badge: 0,
    };
    expect(notificationText({ ...draft, firstAlertname: "HostDown" }).body).toBe("0 firing, 6 resolved in HostDown…");
    expect(notificationText({ ...draft, firstAlertname: "x".repeat(600) }).body).toBe("0 firing, 6 resolved");
    expect(notificationText({ ...draft, firstAlertname: null }).body).toBe("0 firing, 6 resolved");
  });

  test("sanitizeText and fitText", () => {
    expect(sanitizeText("a\u0000b\u007fc\ud800d")).toBe("a b c�d");
    expect(sanitizeText("ok 😀")).toBe("ok 😀");
    expect(fitText("short", 128)).toBe("short");
    expect(fitText("abcdef", 5)).toBe("ab…");
    expect(fitText("abcdef", 2)).toBe("");
  });

  test("a 1 MiB alertname stays within the caps", () => {
    const alert = amAlert({ name: "é".repeat(524_288), target: "t".repeat(1_048_576) });
    const p = buildPayload({ kind: "alert", alert, severity: "critical", audible: true, badge: 3 });
    const bytes = serializePayload(p);
    expect(bytes.length).toBeLessThanOrEqual(4096);
    expect(new TextEncoder().encode(p.aps.alert.title).length).toBeLessThanOrEqual(128);
    expect(p.aps.alert.title.endsWith("…")).toBe(true);
    expect(new TextEncoder().encode(p.aps.alert.body).length).toBeLessThanOrEqual(512);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).not.toThrow();
  });
});
