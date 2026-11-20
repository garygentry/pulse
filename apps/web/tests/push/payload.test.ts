import { describe, expect, test } from "bun:test";

import { CONTRACT_LIMITS } from "@pulse/web-data/contract";
import type { PushPayload, PushSeverity } from "@pulse/web-data/wire";

import { PUSH_LIMITS } from "../../src/server/push/constants.js";
import {
  buildPayload,
  buildPushPayload,
  buildTestPayload,
  fitPayload,
  notificationText,
  serializePayload,
  toApnsRequest,
  type PayloadDraft,
} from "../../src/server/push/payload.js";
import { groupCollapseId, type PlannedNotification } from "../../src/server/push/plan.js";
import { amAlert, type AmAlertFixture } from "./helpers/am-fixtures.js";

const FP = "3f9a1c2b4d5e6f70";
const TOPIC = "com.example.pulse";
const GROUP = groupCollapseId('{}:{alertname="HostDown"}');
const NOW_MS = 1_795_000_000_500;
const EXPIRATION = Math.floor(NOW_MS / 1000) + PUSH_LIMITS.alertExpirationSeconds;
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true });
const UTF8 = new TextEncoder();

function hostDown(status: "firing" | "resolved" = "firing", extra: Record<string, string> = {}): AmAlertFixture {
  return amAlert({ status, fingerprint: FP, target: null, labels: { target: "web-01.example.com", ...extra } });
}

function alertDraft(
  alert: AmAlertFixture,
  audible: boolean,
  badge: number | null,
  severity: PushSeverity = "critical",
): PayloadDraft {
  return { kind: "alert", alert, severity, audible, badge };
}

function summaryDraft(over: Partial<Extract<PayloadDraft, { kind: "summary" }>> = {}): PayloadDraft {
  return {
    kind: "summary",
    group: GROUP,
    total: 12,
    firing: 9,
    resolved: 3,
    severity: "warning",
    firstAlertname: "HostDown",
    badge: 9,
    ...over,
  };
}

function text(bytes: Uint8Array): string {
  return FATAL_UTF8.decode(bytes);
}

function utf8Length(value: string): number {
  return UTF8.encode(value).length;
}

describe("example payloads (byte-for-byte)", () => {
  const alertPulse = (status: string): string =>
    `"pulse":{"v":1,"kind":"alert","collapseId":"a-${FP}","target":{"screen":"alert","fingerprint":"${FP}"},` +
    `"alert":{"fingerprint":"${FP}","status":"${status}","severity":"critical"}}}`;

  const cases: readonly (readonly [string, PayloadDraft, string, "10" | "5"])[] = [
    [
      "firing, audible, badge 3",
      alertDraft(hostDown(), true, 3),
      `{"aps":{"alert":{"title":"HostDown","body":"Firing on web-01.example.com"},"category":"PULSE_ALERT_FIRING",` +
        `"interruption-level":"time-sensitive","sound":"default","badge":3},${alertPulse("firing")}`,
      "10",
    ],
    [
      "repeat, quiet, badge 3",
      alertDraft(hostDown(), false, 3),
      `{"aps":{"alert":{"title":"HostDown","body":"Firing on web-01.example.com"},"category":"PULSE_ALERT_FIRING",` +
        `"interruption-level":"passive","badge":3},${alertPulse("firing")}`,
      "5",
    ],
    [
      "resolved, quiet, no badge",
      alertDraft(hostDown("resolved"), false, null),
      `{"aps":{"alert":{"title":"HostDown","body":"Resolved on web-01.example.com"},"category":"PULSE_ALERT_RESOLVED",` +
        `"interruption-level":"passive"},${alertPulse("resolved")}`,
      "5",
    ],
    [
      "summary, audible, badge 9",
      summaryDraft(),
      `{"aps":{"alert":{"title":"12 alerts changed","body":"9 firing, 3 resolved in HostDown…"},` +
        `"category":"PULSE_ALERT_SUMMARY","interruption-level":"active","sound":"default","badge":9},` +
        `"pulse":{"v":1,"kind":"summary","collapseId":"${GROUP}","target":{"screen":"alerts"},` +
        `"summary":{"group":"${GROUP}","firing":9,"resolved":3,"severity":"warning"}}}`,
      "10",
    ],
    [
      "resolved-only summary, quiet, badge 0",
      summaryDraft({ total: 6, firing: 0, resolved: 6, severity: null, badge: 0 }),
      `{"aps":{"alert":{"title":"6 alerts changed","body":"0 firing, 6 resolved in HostDown…"},` +
        `"category":"PULSE_ALERT_SUMMARY","interruption-level":"passive","badge":0},` +
        `"pulse":{"v":1,"kind":"summary","collapseId":"${GROUP}","target":{"screen":"alerts"},` +
        `"summary":{"group":"${GROUP}","firing":0,"resolved":6,"severity":null}}}`,
      "5",
    ],
  ];

  for (const [name, draft, expected, priority] of cases) {
    test(name, () => {
      const built = buildPushPayload(draft, { expiration: EXPIRATION, topic: TOPIC });
      expect(text(serializePayload(buildPayload(draft)))).toBe(expected);
      expect(text(built.request.body)).toBe(expected);
      expect(built.request.headers["apns-priority"]).toBe(priority);
      expect(built.request.headers["apns-collapse-id"]).toBe(built.payload.pulse.collapseId ?? "missing");
      expect(built.request.headers["apns-expiration"]).toBe(String(EXPIRATION));
      expect(built.request.headers["apns-topic"]).toBe(TOPIC);
      expect(built.request.headers["apns-push-type"]).toBe("alert");
    });
  }

  test("test, badge 3", () => {
    const built = buildTestPayload(3, NOW_MS, TOPIC);
    expect(text(built.request.body)).toBe(
      `{"aps":{"alert":{"title":"Pulse test notification","body":"Push delivery to this device works."},` +
        `"category":"PULSE_TEST","interruption-level":"active","sound":"default","badge":3},` +
        `"pulse":{"v":1,"kind":"test","collapseId":null,"target":{"screen":"home"}}}`,
    );
  });
});

describe("presentation table", () => {
  interface Row {
    readonly name: string;
    readonly draft: PayloadDraft;
    readonly category: string;
    readonly level: string;
    readonly sound: boolean;
    readonly priority: "10" | "5";
    readonly target: PushPayload["pulse"]["target"];
    readonly collapse: string;
  }
  const alertTarget = { screen: "alert", fingerprint: FP } as const;
  const rows: readonly Row[] = [
    ...(["critical", "warning", "info", "unknown"] as const).map(
      (severity): Row => ({
        name: `firing ${severity}`,
        draft: alertDraft(hostDown(), true, 1, severity),
        category: "PULSE_ALERT_FIRING",
        level: { critical: "time-sensitive", warning: "active", info: "passive", unknown: "active" }[severity],
        sound: true,
        priority: "10",
        target: alertTarget,
        collapse: `a-${FP}`,
      }),
    ),
    {
      name: "repeat",
      draft: alertDraft(hostDown(), false, 1),
      category: "PULSE_ALERT_FIRING",
      level: "passive",
      sound: false,
      priority: "5",
      target: alertTarget,
      collapse: `a-${FP}`,
    },
    {
      name: "resolved (audible flag ignored)",
      draft: alertDraft(hostDown("resolved"), true, 1),
      category: "PULSE_ALERT_RESOLVED",
      level: "passive",
      sound: false,
      priority: "5",
      target: alertTarget,
      collapse: `a-${FP}`,
    },
    {
      name: "summary audible critical",
      draft: summaryDraft({ severity: "critical" }),
      category: "PULSE_ALERT_SUMMARY",
      level: "time-sensitive",
      sound: true,
      priority: "10",
      target: { screen: "alerts" },
      collapse: GROUP,
    },
    {
      name: "summary quiet",
      draft: summaryDraft({ severity: null }),
      category: "PULSE_ALERT_SUMMARY",
      level: "passive",
      sound: false,
      priority: "5",
      target: { screen: "alerts" },
      collapse: GROUP,
    },
  ];

  for (const row of rows) {
    test(row.name, () => {
      const { payload, request } = buildPushPayload(row.draft, { expiration: EXPIRATION, topic: TOPIC });
      expect(payload.aps.category).toBe(row.category as never);
      expect(payload.aps["interruption-level"]).toBe(row.level as never);
      expect("sound" in payload.aps).toBe(row.sound);
      expect(request.headers["apns-priority"]).toBe(row.priority);
      expect(payload.pulse.target).toEqual(row.target);
      expect(payload.pulse.collapseId).toBe(row.collapse);
      expect(request.headers["apns-collapse-id"]).toBe(row.collapse);
      expect(payload.pulse.kind).toBe(row.draft.kind);
      expect("alert" in payload.pulse).toBe(row.draft.kind === "alert");
      expect("summary" in payload.pulse).toBe(row.draft.kind === "summary");
      expect(Object.isFrozen(payload)).toBe(true);
      expect(Object.isFrozen(payload.aps)).toBe(true);
      expect(Object.isFrozen(payload.pulse)).toBe(true);
      expect(Object.isFrozen(request.headers)).toBe(true);
    });
  }

  test("test row", () => {
    const { payload, request } = buildTestPayload(null, NOW_MS, TOPIC);
    expect(payload.aps.category).toBe("PULSE_TEST");
    expect(payload.aps["interruption-level"]).toBe("active");
    expect(payload.aps.sound).toBe("default");
    expect(payload.pulse.target).toEqual({ screen: "home" });
    expect(payload.pulse.collapseId).toBeNull();
    expect(request.headers["apns-priority"]).toBe("10");
    expect("apns-collapse-id" in request.headers).toBe(false);
  });
});

describe("text sourcing", () => {
  test("annotations and other labels never reach the bytes", () => {
    const sentinel = "SENTINEL-c0ffee";
    const alert = amAlert({
      fingerprint: FP,
      labels: { job: sentinel, severity: "critical" },
      annotations: { summary: sentinel, description: sentinel, runbook_url: `https://${sentinel}.example.com` },
    });
    for (const audible of [true, false]) {
      const bytes = text(serializePayload(buildPayload(alertDraft(alert, audible, 2))));
      expect(bytes).not.toContain(sentinel);
    }
  });

  test("first non-empty of target, instance, host", () => {
    const pick = (labels: Record<string, string>): string =>
      notificationText(alertDraft(amAlert({ target: null, labels }), true, null)).body;
    expect(pick({ target: "t.example.com", instance: "i.example.com", host: "h.example.com" })).toBe(
      "Firing on t.example.com",
    );
    expect(pick({ target: "", instance: "i.example.com", host: "h.example.com" })).toBe("Firing on i.example.com");
    expect(pick({ host: "h.example.com" })).toBe("Firing on h.example.com");
    expect(pick({})).toBe("Firing");
  });

  test("resolved without a target, and an unnamed alert", () => {
    const t = notificationText(
      alertDraft(amAlert({ status: "resolved", target: null, labels: { alertname: "" } }), false, null),
    );
    expect(t).toEqual({ title: "Unnamed alert", body: "Resolved" });
  });

  test("summary suffix present when it fits, absent when it would pass the body cap", () => {
    expect(notificationText(summaryDraft()).body).toBe("9 firing, 3 resolved in HostDown…");
    const base = "9 firing, 3 resolved";
    const fitting = "x".repeat(CONTRACT_LIMITS.push.bodyBytes - utf8Length(`${base} in …`));
    expect(notificationText(summaryDraft({ firstAlertname: fitting })).body).toBe(`${base} in ${fitting}…`);
    expect(notificationText(summaryDraft({ firstAlertname: `${fitting}x` })).body).toBe(base);
    expect(notificationText(summaryDraft({ firstAlertname: null })).body).toBe(base);
    expect(notificationText(summaryDraft({ firstAlertname: "" })).body).toBe(base);
  });
});

describe("size cap and UTF-8 validity", () => {
  const MIB = 1024 * 1024;
  const inputs: readonly (readonly [string, string])[] = [
    ["ascii", "a".repeat(MIB)],
    ["multi-byte", "é😀".repeat(MIB / 6)],
    ["lone surrogates", "\uD800x\uDC00".repeat(MIB / 3)],
    ["control chars", "\u0000\u0007\u001F\u007F\"\\".repeat(MIB / 6)],
  ];

  for (const [name, big] of inputs) {
    test(`1 MiB alertname and target (${name})`, () => {
      const alert = amAlert({ fingerprint: FP, target: null, labels: { alertname: big, target: big } });
      for (const draft of [alertDraft(alert, true, 1024), summaryDraft({ firstAlertname: big, total: 9999 })]) {
        const { payload, request } = buildPushPayload(draft, { expiration: EXPIRATION, topic: TOPIC });
        expect(request.body.length).toBeLessThanOrEqual(CONTRACT_LIMITS.push.payloadBytes);
        const decoded = text(request.body);
        expect(JSON.parse(decoded)).toEqual(JSON.parse(JSON.stringify(payload)));
        expect(utf8Length(payload.aps.alert.title)).toBeLessThanOrEqual(CONTRACT_LIMITS.push.titleBytes);
        expect(utf8Length(payload.aps.alert.body)).toBeLessThanOrEqual(CONTRACT_LIMITS.push.bodyBytes);
        expect(payload.aps.alert.title + payload.aps.alert.body).not.toMatch(/[\u0000-\u001F\u007F]/);
        if (draft.kind === "alert") {
          expect(payload.aps.alert.title.endsWith("…")).toBe(true);
          expect(payload.aps.alert.body.endsWith("…")).toBe(true);
        }
      }
    });
  }

  test("fitPayload with maxBytes 300 halves the body until it fits and keeps the full title", () => {
    const title = "T".repeat(64);
    const rawBody = "b".repeat(4000);
    const bodies: string[] = [];
    const assemble = (body: string): PushPayload => {
      bodies.push(body);
      return {
        aps: { alert: { title, body }, category: "PULSE_TEST", "interruption-level": "active" },
        pulse: { v: 1, kind: "test", collapseId: null, target: { screen: "home" } },
      };
    };
    const payload = fitPayload(assemble, rawBody, 300);
    expect(serializePayload(payload).length).toBeLessThanOrEqual(300);
    expect(payload.aps.alert.title).toBe(title);
    expect(bodies.length).toBeGreaterThan(2);
    for (let i = 1; i < bodies.length; i++) {
      const prev = utf8Length(bodies[i - 1] ?? "");
      expect(utf8Length(bodies[i] ?? "")).toBeLessThanOrEqual(Math.floor(prev / 2));
    }
    expect(payload.aps.alert.body.length).toBeGreaterThan(3);
    expect(payload.aps.alert.body.endsWith("…")).toBe(true);
  });

  test("fitPayload throws when even an empty body does not fit", () => {
    const assemble = (body: string): PushPayload => ({
      aps: { alert: { title: "T".repeat(500), body }, category: "PULSE_TEST", "interruption-level": "active" },
      pulse: { v: 1, kind: "test", collapseId: null, target: { screen: "home" } },
    });
    expect(() => fitPayload(assemble, "body", 300)).toThrow("push payload cannot fit");
  });
});

describe("badge", () => {
  test("null omits aps.badge; 0 emits badge 0", () => {
    const none = buildPayload(alertDraft(hostDown(), true, null));
    expect("badge" in none.aps).toBe(false);
    expect(text(serializePayload(none))).not.toContain("badge");
    const zero = buildPayload(alertDraft(hostDown(), true, 0));
    expect(text(serializePayload(zero))).toContain('"badge":0');
    expect("badge" in buildTestPayload(null, NOW_MS, TOPIC).payload.aps).toBe(false);
    expect(text(buildTestPayload(0, NOW_MS, TOPIC).request.body)).toContain('"badge":0');
  });
});

describe("buildTestPayload", () => {
  test("headers, identity and expiration", () => {
    const { payload, request } = buildTestPayload(3, NOW_MS, TOPIC);
    expect(request.headers).toEqual({
      "apns-push-type": "alert",
      "apns-topic": TOPIC,
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(NOW_MS / 1000) + 300),
    });
    expect(payload.pulse.kind).toBe("test");
    expect(payload.pulse.collapseId).toBeNull();
    expect("alert" in payload.pulse).toBe(false);
    expect("summary" in payload.pulse).toBe(false);
    expect(Object.isFrozen(payload.pulse.target)).toBe(true);
  });

  test("deterministic for the same inputs", () => {
    const a = buildTestPayload(2, NOW_MS, TOPIC);
    const b = buildTestPayload(2, NOW_MS, TOPIC);
    expect(a.request.body).toEqual(b.request.body);
    expect(a.request.headers).toEqual(b.request.headers);
  });
});

describe("toApnsRequest", () => {
  function planned(draft: PayloadDraft, kind: PlannedNotification["kind"], audible: boolean): PlannedNotification {
    const payload = buildPayload(draft);
    return {
      deviceId: "dev_AAAAAAAAAAA",
      kind,
      audible,
      collapseId: payload.pulse.collapseId,
      payload,
      marks: [],
      expiration: EXPIRATION,
    };
  }

  test("body equals serializePayload and headers follow the planned item", () => {
    const items = [
      planned(alertDraft(hostDown(), true, 3), "firing", true),
      planned(alertDraft(hostDown(), false, 3), "repeat", false),
      planned(summaryDraft({ severity: null }), "summary", false),
    ];
    for (const item of items) {
      const request = toApnsRequest(item, TOPIC);
      expect(request.body).toEqual(serializePayload(item.payload));
      expect(request.headers["apns-collapse-id"]).toBe(item.collapseId ?? "missing");
      expect(request.headers["apns-priority"]).toBe(item.audible ? "10" : "5");
      expect(request.headers["apns-expiration"]).toBe(String(EXPIRATION));
      expect(request.headers["apns-topic"]).toBe(TOPIC);
      expect(request.headers["apns-push-type"]).toBe("alert");
    }
  });

  test("a null collapse id omits the header", () => {
    const test = buildTestPayload(null, NOW_MS, TOPIC);
    const request = toApnsRequest(
      { deviceId: "dev_AAAAAAAAAAA", kind: "test", audible: true, collapseId: null, payload: test.payload, marks: [], expiration: EXPIRATION },
      TOPIC,
    );
    expect("apns-collapse-id" in request.headers).toBe(false);
  });
});
