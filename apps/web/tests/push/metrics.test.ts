// apps/web/tests/push/metrics.test.ts — the pulse_web_push_* families of /metrics and the per-key log
// limiter. Drives the pure `renderMetrics` with the process-lifetime recorders and a hand-built snapshot
// provider; never builds a push runtime.

import { afterEach, describe, expect, test } from "bun:test";

import {
  PUSH_NOTIFICATION_KINDS,
  PUSH_NOTIFICATION_OUTCOMES,
  PUSH_PAIRING_EVENTS,
  PUSH_WEBHOOK_OUTCOMES,
  __resetMetricsForTest,
  recordPushAdminRefusal,
  recordPushNotification,
  recordPushPairingEvent,
  recordPushWebhook,
  renderMetrics,
  setPushMetricsProvider,
  type PushMetricsSnapshot,
  type PushNotificationOutcome,
  type PushPairingEvent,
  type PushWebhookOutcome,
} from "../../src/server/routes/metrics.js";
import { getRuntimeStatus } from "../../src/server/refresh.js";
import { createKeyedLogLimiter } from "../../src/server/log.js";
import type { NotificationKind } from "../../src/server/push/plan.js";
import { createSeededRandom } from "./helpers/fakes.js";

const DISABLED_LINES = [
  "# HELP pulse_web_push_state Push gateway state; 1 on the current state (disabled, configured, misconfigured).",
  "# TYPE pulse_web_push_state gauge",
  'pulse_web_push_state{state="disabled"} 1',
  'pulse_web_push_state{state="configured"} 0',
  'pulse_web_push_state{state="misconfigured"} 0',
];

const HELP = {
  pulse_web_push_state: [
    "Push gateway state; 1 on the current state (disabled, configured, misconfigured).",
    "gauge",
  ],
  pulse_web_push_devices: ["Devices in the push registry.", "gauge"],
  pulse_web_push_webhook_total: ["Alertmanager push webhook calls by outcome.", "counter"],
  pulse_web_push_notifications_total: ["Push notifications by kind and outcome.", "counter"],
  pulse_web_push_last_success_timestamp_seconds: ["Unix time of the last notification Apple accepted.", "gauge"],
  pulse_web_push_pairing_events_total: ["Pairing and device registry events.", "counter"],
  pulse_web_push_admin_refusals_total: ["Operator push API calls refused for the operator secret.", "counter"],
} as const;

/** Every push line (HELP, TYPE and samples) in render order. */
function pushLines(): string[] {
  return renderMetrics(getRuntimeStatus(), Date.now())
    .split("\n")
    .filter((l) => l.includes("pulse_web_push_"));
}

/** Only the push sample lines. */
function pushSamples(): string[] {
  return pushLines().filter((l) => !l.startsWith("#"));
}

function sample(name: string): number | undefined {
  const line = pushSamples().find((l) => l.startsWith(`${name} `));
  return line === undefined ? undefined : Number(line.slice(name.length + 1));
}

function provide(snap: PushMetricsSnapshot): void {
  setPushMetricsProvider(() => snap);
}

afterEach(() => {
  __resetMetricsForTest();
});

describe("push metrics: vocabularies", () => {
  test("closed arrays are frozen and in render order", () => {
    expect(PUSH_WEBHOOK_OUTCOMES).toEqual(["accepted", "unauthorized", "malformed", "too_large", "unavailable"]);
    expect(PUSH_NOTIFICATION_KINDS).toEqual(["firing", "resolved", "repeat", "summary", "test"]);
    expect(PUSH_NOTIFICATION_OUTCOMES).toEqual(["delivered", "failed", "dropped", "filtered", "token_removed"]);
    expect(PUSH_PAIRING_EVENTS).toEqual([
      "issued",
      "redeemed",
      "refused",
      "cap_reached",
      "rate_limited",
      "cancelled",
      "revoked",
      "expired",
      "removed_dead",
    ]);
    for (const a of [PUSH_WEBHOOK_OUTCOMES, PUSH_NOTIFICATION_KINDS, PUSH_NOTIFICATION_OUTCOMES, PUSH_PAIRING_EVENTS]) {
      expect(Object.isFrozen(a)).toBe(true);
    }
  });
});

describe("push metrics: render", () => {
  test("no provider renders exactly the disabled state gauge", () => {
    expect(pushLines()).toEqual(DISABLED_LINES);
  });

  test("the push block is appended last", () => {
    const text = renderMetrics(getRuntimeStatus(), Date.now());
    expect(text.endsWith(`${DISABLED_LINES.join("\n")}\n`)).toBe(true);
  });

  test("a provider reporting disabled renders the same as no provider", () => {
    provide({ state: "disabled", devices: null, lastSuccessAtMs: null });
    expect(pushLines()).toEqual(DISABLED_LINES);
  });

  test("misconfigured renders every non-disabled family with zeros and no last-success", () => {
    provide({ state: "misconfigured", devices: 0, lastSuccessAtMs: null });
    recordPushWebhook("unavailable");
    const samples = pushSamples();
    expect(samples).toHaveLength(44);
    expect(samples.slice(0, 3)).toEqual([
      'pulse_web_push_state{state="disabled"} 0',
      'pulse_web_push_state{state="configured"} 0',
      'pulse_web_push_state{state="misconfigured"} 1',
    ]);
    expect(sample("pulse_web_push_devices")).toBe(0);
    expect(sample('pulse_web_push_webhook_total{outcome="unavailable"}')).toBe(1);
    expect(samples.some((l) => l.startsWith("pulse_web_push_last_success_timestamp_seconds"))).toBe(false);
    const nonZero = samples.filter((l) => !l.endsWith(" 0"));
    expect(nonZero).toEqual([
      'pulse_web_push_state{state="misconfigured"} 1',
      'pulse_web_push_webhook_total{outcome="unavailable"} 1',
    ]);
  });

  test("configured renders the sample output exactly, every family preceded by HELP and TYPE", () => {
    provide({ state: "configured", devices: 2, lastSuccessAtMs: 1_763_640_000_999 });
    for (let i = 0; i < 14; i++) recordPushWebhook("accepted");
    recordPushNotification("firing", "delivered", 9);
    recordPushNotification("firing", "filtered", 3);
    recordPushNotification("resolved", "delivered", 8);
    recordPushNotification("resolved", "filtered", 2);
    recordPushNotification("repeat", "delivered", 4);
    recordPushNotification("summary", "delivered");
    recordPushNotification("test", "delivered");
    recordPushNotification("test", "delivered");
    for (let i = 0; i < 3; i++) recordPushPairingEvent("issued");
    recordPushPairingEvent("redeemed");
    recordPushPairingEvent("redeemed");
    recordPushPairingEvent("refused");

    const counts: Record<string, number> = {
      "firing|delivered": 9,
      "firing|filtered": 3,
      "resolved|delivered": 8,
      "resolved|filtered": 2,
      "repeat|delivered": 4,
      "summary|delivered": 1,
      "test|delivered": 2,
    };
    const pairing: Record<string, number> = { issued: 3, redeemed: 2, refused: 1 };
    const expected = [
      ...["# HELP pulse_web_push_state " + HELP.pulse_web_push_state[0], "# TYPE pulse_web_push_state gauge"],
      'pulse_web_push_state{state="disabled"} 0',
      'pulse_web_push_state{state="configured"} 1',
      'pulse_web_push_state{state="misconfigured"} 0',
      "# HELP pulse_web_push_devices Devices in the push registry.",
      "# TYPE pulse_web_push_devices gauge",
      "pulse_web_push_devices 2",
      "# HELP pulse_web_push_webhook_total Alertmanager push webhook calls by outcome.",
      "# TYPE pulse_web_push_webhook_total counter",
      ...PUSH_WEBHOOK_OUTCOMES.map((o) => `pulse_web_push_webhook_total{outcome="${o}"} ${o === "accepted" ? 14 : 0}`),
      "# HELP pulse_web_push_notifications_total Push notifications by kind and outcome.",
      "# TYPE pulse_web_push_notifications_total counter",
      ...PUSH_NOTIFICATION_KINDS.flatMap((k) =>
        PUSH_NOTIFICATION_OUTCOMES.map(
          (o) => `pulse_web_push_notifications_total{kind="${k}",outcome="${o}"} ${counts[`${k}|${o}`] ?? 0}`,
        ),
      ),
      "# HELP pulse_web_push_last_success_timestamp_seconds Unix time of the last notification Apple accepted.",
      "# TYPE pulse_web_push_last_success_timestamp_seconds gauge",
      "pulse_web_push_last_success_timestamp_seconds 1763640000",
      "# HELP pulse_web_push_pairing_events_total Pairing and device registry events.",
      "# TYPE pulse_web_push_pairing_events_total counter",
      ...PUSH_PAIRING_EVENTS.map((e) => `pulse_web_push_pairing_events_total{event="${e}"} ${pairing[e] ?? 0}`),
      "# HELP pulse_web_push_admin_refusals_total Operator push API calls refused for the operator secret.",
      "# TYPE pulse_web_push_admin_refusals_total counter",
      "pulse_web_push_admin_refusals_total 0",
    ];
    expect(pushLines()).toEqual(expected);
    expect(pushSamples()).toHaveLength(45);

    // Each family: exactly one HELP then TYPE, directly before its first sample.
    const lines = pushLines();
    for (const [family, [help, type]] of Object.entries(HELP)) {
      const h = lines.indexOf(`# HELP ${family} ${help}`);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(lines[h + 1]).toBe(`# TYPE ${family} ${type}`);
      expect(lines[h + 2]?.startsWith(family)).toBe(true);
      expect(lines.filter((l) => l.startsWith(`# HELP ${family} `))).toHaveLength(1);
    }
  });

  test("last-success is absent until set, then reported in whole seconds", () => {
    let last: number | null = null;
    setPushMetricsProvider(() => ({ state: "configured", devices: 0, lastSuccessAtMs: last }));
    expect(pushSamples()).toHaveLength(44);
    expect(pushLines().some((l) => l.includes("last_success"))).toBe(false);
    last = 1_763_640_000_500;
    expect(pushSamples()).toHaveLength(45);
    expect(sample("pulse_web_push_last_success_timestamp_seconds")).toBe(1_763_640_000);
  });

  test("admin refusals count", () => {
    provide({ state: "configured", devices: 1, lastSuccessAtMs: null });
    recordPushAdminRefusal();
    recordPushAdminRefusal();
    expect(sample("pulse_web_push_admin_refusals_total")).toBe(2);
  });

  test("invalid device counts render as 0", () => {
    for (const devices of [-1, 1.5, Number.NaN, null]) {
      provide({ state: "configured", devices, lastSuccessAtMs: null });
      expect(sample("pulse_web_push_devices")).toBe(0);
    }
  });

  const BAD_PROVIDERS: ReadonlyArray<readonly [string, () => PushMetricsSnapshot]> = [
    [
      "throws",
      () => {
        throw new Error("boom");
      },
    ],
    ["returns null", () => null as unknown as PushMetricsSnapshot],
    ["returns a number", () => 7 as unknown as PushMetricsSnapshot],
    ["returns an unknown state", () => ({ state: "bogus", devices: 1, lastSuccessAtMs: null }) as unknown as PushMetricsSnapshot],
    ["returns no state", () => ({ devices: 1 }) as unknown as PushMetricsSnapshot],
  ];
  for (const [name, provider] of BAD_PROVIDERS) {
    test(`a provider that ${name} renders all three state series 0 and nothing else`, () => {
      setPushMetricsProvider(provider);
      recordPushWebhook("accepted");
      expect(pushLines()).toEqual([
        ...DISABLED_LINES.slice(0, 2),
        'pulse_web_push_state{state="disabled"} 0',
        'pulse_web_push_state{state="configured"} 0',
        'pulse_web_push_state{state="misconfigured"} 0',
      ]);
    });
  }

  test("setPushMetricsProvider(null) restores the disabled render", () => {
    provide({ state: "configured", devices: 1, lastSuccessAtMs: null });
    setPushMetricsProvider(null);
    expect(pushLines()).toEqual(DISABLED_LINES);
  });
});

describe("push metrics: recorders", () => {
  test("out-of-set values and non-positive n are dropped silently", () => {
    provide({ state: "configured", devices: 0, lastSuccessAtMs: null });
    const before = pushSamples();
    expect(() => {
      recordPushWebhook("nope" as PushWebhookOutcome);
      recordPushNotification("bogus" as NotificationKind, "delivered");
      recordPushNotification("firing", "bogus" as PushNotificationOutcome);
      recordPushPairingEvent("__proto__" as PushPairingEvent);
      for (const n of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        recordPushNotification("firing", "delivered", n);
      }
    }).not.toThrow();
    expect(pushSamples()).toEqual(before);
  });

  test("valid n increments by n; default is 1", () => {
    provide({ state: "configured", devices: 0, lastSuccessAtMs: null });
    recordPushNotification("summary", "filtered", 5);
    recordPushNotification("summary", "filtered");
    expect(sample('pulse_web_push_notifications_total{kind="summary",outcome="filtered"}')).toBe(6);
  });

  test("10 000 random cast values keep push sample lines ≤ 45", () => {
    provide({ state: "configured", devices: 3, lastSuccessAtMs: 1_763_640_000_000 });
    const rng = createSeededRandom(7);
    const pools = {
      webhook: [...PUSH_WEBHOOK_OUTCOMES, "x", "", "ACCEPTED", "accepted ", "toString"],
      kind: [...PUSH_NOTIFICATION_KINDS, "y", "", "Firing", "constructor"],
      outcome: [...PUSH_NOTIFICATION_OUTCOMES, "z", "", "token-removed"],
      event: [...PUSH_PAIRING_EVENTS, "w", "", "removed-dead", "hasOwnProperty"],
    };
    const pick = (pool: readonly string[]): string => {
      // Half from the pool (incl. near-misses), half random strings.
      if (rng.unit() < 0.5) return pool[Math.floor(rng.unit() * pool.length)] ?? "";
      const bytes = rng.bytes(1 + Math.floor(rng.unit() * 12));
      return Buffer.from(bytes).toString("latin1");
    };
    for (let i = 0; i < 10_000; i++) {
      recordPushWebhook(pick(pools.webhook) as PushWebhookOutcome);
      recordPushNotification(
        pick(pools.kind) as NotificationKind,
        pick(pools.outcome) as PushNotificationOutcome,
        Math.floor(rng.unit() * 5) - 1,
      );
      recordPushPairingEvent(pick(pools.event) as PushPairingEvent);
      recordPushAdminRefusal();
    }
    const samples = pushSamples();
    expect(samples.length).toBeLessThanOrEqual(45);
    expect(samples).toHaveLength(45);
    // Every label value is from a closed set.
    const allowed = new Set<string>([
      "disabled",
      "configured",
      "misconfigured",
      ...PUSH_WEBHOOK_OUTCOMES,
      ...PUSH_NOTIFICATION_KINDS,
      ...PUSH_NOTIFICATION_OUTCOMES,
      ...PUSH_PAIRING_EVENTS,
    ]);
    for (const l of samples) {
      for (const m of l.matchAll(/="([^"]*)"/g)) expect(allowed.has(m[1] ?? "")).toBe(true);
    }
  });

  test("__resetMetricsForTest clears every push counter and the provider", () => {
    provide({ state: "configured", devices: 4, lastSuccessAtMs: 1_763_640_000_000 });
    recordPushWebhook("accepted");
    recordPushNotification("firing", "delivered", 3);
    recordPushPairingEvent("issued");
    recordPushAdminRefusal();
    __resetMetricsForTest();
    expect(pushLines()).toEqual(DISABLED_LINES);
    provide({ state: "configured", devices: 0, lastSuccessAtMs: null });
    expect(pushSamples().filter((l) => !l.endsWith(" 0"))).toEqual(['pulse_web_push_state{state="configured"} 1']);
  });
});

describe("createKeyedLogLimiter", () => {
  function clock(start = 1_000_000): { now: () => number; set(ms: number): void; advance(ms: number): void } {
    let t = start;
    return {
      now: () => t,
      set(ms) {
        t = ms;
      },
      advance(ms) {
        t += ms;
      },
    };
  }

  test("a bad interval is a RangeError", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => createKeyedLogLimiter(bad)).toThrow(RangeError);
    }
    expect(() => createKeyedLogLimiter("60" as unknown as number)).toThrow(RangeError);
    expect(() => createKeyedLogLimiter(60_000)).not.toThrow();
  });

  test("one emission per key per interval, measured from the last allowed one", () => {
    const c = clock();
    const lim = createKeyedLogLimiter(60_000, c.now);
    expect(lim.allow("dev_a")).toBe(true);
    expect(lim.allow("dev_a")).toBe(false);
    expect(lim.allow("dev_b")).toBe(true);
    c.advance(59_999);
    expect(lim.allow("dev_a")).toBe(false);
    c.advance(1);
    expect(lim.allow("dev_a")).toBe(true);
    expect(lim.allow("dev_a")).toBe(false);
  });

  test("suppressed calls do not extend the window", () => {
    const c = clock();
    const lim = createKeyedLogLimiter(1_000, c.now);
    expect(lim.allow("k")).toBe(true);
    for (let i = 0; i < 9; i++) {
      c.advance(100);
      expect(lim.allow("k")).toBe(false);
    }
    c.advance(100);
    expect(lim.allow("k")).toBe(true);
  });

  test("a clock that steps backwards allows", () => {
    const c = clock(10_000);
    const lim = createKeyedLogLimiter(60_000, c.now);
    expect(lim.allow("k")).toBe(true);
    c.set(9_000);
    expect(lim.allow("k")).toBe(true);
    // The window restarts from the new (earlier) emission.
    c.set(9_500);
    expect(lim.allow("k")).toBe(false);
  });

  test("forget and size", () => {
    const c = clock();
    const lim = createKeyedLogLimiter(60_000, c.now);
    lim.allow("a");
    lim.allow("b");
    expect(lim.size()).toBe(2);
    lim.forget("a");
    lim.forget("missing");
    expect(lim.size()).toBe(1);
    expect(lim.allow("a")).toBe(true);
  });

  test("defaults to Date.now", () => {
    const lim = createKeyedLogLimiter(60_000);
    expect(lim.allow("k")).toBe(true);
    expect(lim.allow("k")).toBe(false);
  });

  test("when full, stale entries are pruned before any live one is evicted", () => {
    const c = clock();
    const lim = createKeyedLogLimiter(1_000, c.now, 3);
    lim.allow("old1");
    lim.allow("old2");
    c.advance(1_000);
    lim.allow("live");
    lim.allow("new"); // full: old1 and old2 are stale, so both are pruned
    expect(lim.size()).toBe(2);
    expect(lim.allow("live")).toBe(false); // still tracked and suppressed
    expect(lim.allow("new")).toBe(false);
  });

  test("when still full after pruning, the oldest entry is evicted", () => {
    const c = clock();
    const lim = createKeyedLogLimiter(60_000, c.now, 3);
    lim.allow("a");
    c.advance(1);
    lim.allow("b");
    c.advance(1);
    lim.allow("c");
    c.advance(1);
    expect(lim.allow("d")).toBe(true);
    expect(lim.size()).toBe(3);
    expect(lim.allow("a")).toBe(true); // a was evicted, so it is untracked again (evicts b)
    expect(lim.allow("c")).toBe(false);
    expect(lim.allow("d")).toBe(false);
    expect(lim.size()).toBe(3);
  });

  test("memory stays bounded under an unbounded key source", () => {
    const lim = createKeyedLogLimiter(60_000, () => 5, 16);
    for (let i = 0; i < 10_000; i++) lim.allow(`k${i}`);
    expect(lim.size()).toBe(16);
  });
});
