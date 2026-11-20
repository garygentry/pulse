// Push payload fixtures: the notification bodies a client receives, built by the server's payload builder from
// fixed inputs so every fixture is exactly what the gateway would send.

import { CONTRACT_LIMITS, PUSH_CATEGORIES } from "@pulse/web-data/contract";
import type { PushPayload, PushSeverity } from "@pulse/web-data/wire";

import { buildPushPayload, buildTestPayload, type PayloadDraft } from "../../../src/server/push/payload.js";
import { groupCollapseId, severityOf } from "../../../src/server/push/plan.js";
import type { AmAlert } from "../../../src/server/push/webhook.js";
import { ContractToolError } from "../errors.js";
import { atMs, jsonFixture, jsonObject, PLACEHOLDER } from "./common.js";
import type { ScenarioModule } from "./index.js";
import { FINGERPRINT } from "./push-common.js";

/** APNs topic for the request half of a build; it never reaches a fixture. */
const TOPIC = "com.example.pulse";
/** Build time of every payload. */
const NOW_MS = atMs(0);
/** APNs expiration for the request half of a build; it never reaches a fixture. */
const EXPIRATION = Math.floor(NOW_MS / 1000) + 3600;
/** Badge carried by the typical rows. */
const BADGE = 3;
/** The fixed Alertmanager group key every summary row is about. */
const GROUP_KEY = '{}:{alertname="ExampleHostDown"}';

const UTF8 = new TextEncoder();

/** One Alertmanager alert with placeholder labels. */
function alert(
  n: number,
  alertname: string,
  target: string,
  status: AmAlert["status"],
  severity: string,
): AmAlert {
  return {
    status,
    labels: { alertname, target, severity },
    annotations: {},
    startsAt: new Date(NOW_MS).toISOString(),
    fingerprint: FINGERPRINT(n),
  };
}

function alertDraft(item: AmAlert, audible: boolean, badge: number | null): PayloadDraft {
  return { kind: "alert", alert: item, severity: severityOf(item), audible, badge };
}

/** A summary draft over `alerts`, with `severity` the highest newly firing severity (null: quiet). */
function summaryDraft(alerts: readonly AmAlert[], severity: PushSeverity | null, badge: number | null): PayloadDraft {
  return {
    kind: "summary",
    group: groupCollapseId(GROUP_KEY),
    total: alerts.length,
    firing: alerts.filter((item) => item.status === "firing").length,
    resolved: alerts.filter((item) => item.status === "resolved").length,
    severity,
    firstAlertname: alerts[0]?.labels.alertname ?? null,
    badge,
  };
}

const build = (draft: PayloadDraft): PushPayload => buildPushPayload(draft, { expiration: EXPIRATION, topic: TOPIC }).payload;

const CRITICAL = alert(1, "ExampleHostDown", PLACEHOLDER.hostName(1), "firing", "critical");
const WARNING = alert(2, "ExampleDiskFull", PLACEHOLDER.hostName(2), "firing", "warning");
const INFO = alert(3, "ExampleCertExpiring", PLACEHOLDER.hostName(3), "firing", "info");
const UNKNOWN_SEVERITY = alert(4, "ExampleQueueBacklog", PLACEHOLDER.hostName(4), "firing", "page");
const LONG = alert(
  5,
  "A".repeat(300),
  Array.from({ length: 40 }, (_, i) => PLACEHOLDER.hostName(i + 1)).join(", "),
  "firing",
  "critical",
);

const MIXED: readonly AmAlert[] = [
  ...Array.from({ length: 9 }, (_, i) =>
    alert(10 + i, "ExampleHostDown", PLACEHOLDER.hostName(10 + i), "firing", i === 0 ? "critical" : "warning"),
  ),
  ...Array.from({ length: 3 }, (_, i) =>
    alert(20 + i, "ExampleHostDown", PLACEHOLDER.hostName(20 + i), "resolved", "warning"),
  ),
];
const RESOLVED_ONLY: readonly AmAlert[] = Array.from({ length: 6 }, (_, i) =>
  alert(30 + i, "ExampleHostDown", PLACEHOLDER.hostName(30 + i), "resolved", "warning"),
);

const ALERT_CATEGORY = { firing: "PULSE_ALERT_FIRING", resolved: "PULSE_ALERT_RESOLVED" } as const;

/**
 * Check the per-kind payload rules a client relies on before a fixture is emitted.
 *
 * @throws {ContractToolError} SCENARIO_INVALID naming the subject and the broken rule
 */
function assertPushPayload(value: PushPayload, subject: string): void {
  const fail = (rule: string): never => {
    throw new ContractToolError("SCENARIO_INVALID", subject, `push payload breaks a contract rule: ${rule}`);
  };
  const { aps, pulse } = value;
  if (UTF8.encode(JSON.stringify(value)).length > CONTRACT_LIMITS.push.payloadBytes) fail("payload size");
  if (UTF8.encode(aps.alert.title).length > CONTRACT_LIMITS.push.titleBytes) fail("title size");
  if (UTF8.encode(aps.alert.body).length > CONTRACT_LIMITS.push.bodyBytes) fail("body size");
  if (pulse.v !== 1) fail("pulse.v is 1");
  if (!PUSH_CATEGORIES.includes(aps.category)) fail("known category");
  if (aps.badge !== undefined && (!Number.isInteger(aps.badge) || aps.badge < 0)) fail("badge");
  if (aps.sound === undefined && aps["interruption-level"] !== "passive") fail("quiet delivery is passive");
  if (("alert" in pulse) !== (pulse.kind === "alert")) fail("alert present iff kind alert");
  if (("summary" in pulse) !== (pulse.kind === "summary")) fail("summary present iff kind summary");
  if ((pulse.collapseId === null) !== (pulse.kind === "test")) fail("collapseId null iff kind test");
  switch (pulse.kind) {
    case "alert":
      if (pulse.alert === undefined || aps.category !== ALERT_CATEGORY[pulse.alert.status]) fail("alert category");
      if (pulse.target.screen !== "alert" || pulse.target.fingerprint !== pulse.alert?.fingerprint) fail("alert target");
      break;
    case "summary":
      if (aps.category !== "PULSE_ALERT_SUMMARY" || pulse.target.screen !== "alerts") fail("summary category and target");
      break;
    case "test":
      if (aps.category !== "PULSE_TEST" || pulse.target.screen !== "home") fail("test category and target");
      if (aps["interruption-level"] !== "active") fail("test is active");
      break;
  }
}

/** Every payload row, in table order. */
const ROWS: readonly (readonly [scenario: string, payload: () => PushPayload])[] = [
  ["firing-critical", () => build(alertDraft(CRITICAL, true, BADGE))],
  ["firing-warning", () => build(alertDraft(WARNING, true, BADGE))],
  ["firing-info", () => build(alertDraft(INFO, true, BADGE))],
  ["firing-unknown-severity", () => build(alertDraft(UNKNOWN_SEVERITY, true, BADGE))],
  ["repeat", () => build(alertDraft(CRITICAL, false, BADGE))],
  ["resolved", () => build(alertDraft({ ...CRITICAL, status: "resolved" }, false, BADGE))],
  ["summary-mixed", () => build(summaryDraft(MIXED, "critical", 9))],
  ["summary-resolved-only", () => build(summaryDraft(RESOLVED_ONLY, null, BADGE))],
  ["test", () => buildTestPayload(BADGE, NOW_MS, TOPIC).payload],
  ["no-badge", () => build(alertDraft(WARNING, true, null))],
  ["truncated-max-length", () => build(alertDraft(LONG, true, BADGE))],
];

/** Row-specific pins on top of the per-kind rules. */
function assertRowPins(scenario: string, payload: PushPayload): void {
  const fail = (rule: string): never => {
    throw new ContractToolError("SCENARIO_INVALID", `push-payload/${scenario}`, `fixture pin failed: ${rule}`);
  };
  const { aps, pulse } = payload;
  switch (scenario) {
    case "firing-critical":
      if (aps["interruption-level"] !== "time-sensitive" || aps.sound === undefined) fail("audible time-sensitive");
      break;
    case "firing-unknown-severity":
      if (pulse.alert?.severity !== "unknown" || aps["interruption-level"] !== "active") fail("unknown is active");
      break;
    case "repeat":
      if (aps.sound !== undefined || pulse.alert?.severity !== "critical") fail("quiet with the real severity");
      break;
    case "summary-mixed":
      if (pulse.summary?.severity !== "critical" || aps.sound === undefined) fail("audible critical summary");
      break;
    case "summary-resolved-only":
      if (pulse.summary?.severity !== null || aps.sound !== undefined) fail("quiet summary with null severity");
      break;
    case "no-badge":
      if ("badge" in aps) fail("no badge");
      break;
  }
}

export const pushPayloadScenarios: ScenarioModule = {
  group: "push-payload",
  operation: "push-payload",
  async build() {
    const fixtures = ROWS.map(([scenario, make]) => {
      const payload = make();
      assertPushPayload(payload, `push-payload/${scenario}`);
      assertRowPins(scenario, payload);
      return { scenario, payload };
    });
    const critical = fixtures.find(({ scenario }) => scenario === "firing-critical")!.payload;
    // Forward compatibility: unknown members in aps, in pulse and at the top level.
    const unknownField = jsonObject(structuredClone(critical), "push-payload/unknown-field");
    jsonObject(unknownField.aps, "push-payload/unknown-field")["future-field"] = "1";
    jsonObject(unknownField.pulse, "push-payload/unknown-field")["future-field"] = "1";
    unknownField["future-field"] = "1";
    return [
      ...fixtures.map(({ scenario, payload }) => jsonFixture(this, scenario, "payload", null, payload satisfies PushPayload)),
      jsonFixture(this, "unknown-field", "payload", null, unknownField),
    ];
  },
};
