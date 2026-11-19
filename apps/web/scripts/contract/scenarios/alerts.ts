// Alerts fixtures: typed `AlertsPayload` literals, plus the real handler's not-ready body.

import { CONTRACT_LIMITS } from "@pulse/web-data/contract";
import type {
  ActiveAlert,
  ActiveSilence,
  AlertsPayload,
  DataAvailability,
  RuleState,
  SilenceMatcher,
} from "@pulse/web-data/wire";

import { alertsRoute } from "../../../src/server/routes/current.js";
import { bundleErrorBody, errorEnvelopeBody, responseBody, stubContext, stubRouteRequest } from "../stub-context.js";
import { jsonFixture, PLACEHOLDER } from "./common.js";
import type { ScenarioContext, ScenarioModule } from "./index.js";

const HOST_1 = PLACEHOLDER.hostName(1);
const HOST_2 = PLACEHOLDER.hostName(2);
const HOST_1_ID = `host:${HOST_1}`;
const SERVICE_1_ID = `svc:${HOST_1}/svc-001`;
const ENDPOINT_1_ID = `${HOST_1}/svc-001`;
const RECEIVER = "ops-chat";
const OPERATOR = "Example Operator";

/** Alertmanager-style fingerprint: 16 lower-case hex digits. */
function fingerprint(n: number): string {
  return n.toString(16).padStart(16, "0");
}

/** Silence id in UUID form. */
function silenceId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** A source that answered in the current cycle. */
function current(ctx: ScenarioContext, source: DataAvailability["source"]): DataAvailability {
  return { state: "current", source, lastGoodAt: ctx.at(0), message: null };
}

/** Equality matcher on one label. */
function equals(name: string, value: string): SilenceMatcher {
  return { name, value, isRegex: false, isEqual: true };
}

/** A few alerts in every delivery state, with rules and silences, both sources current. */
export function typicalAlertsBody(ctx: ScenarioContext): Promise<AlertsPayload> {
  const body = {
    generatedAt: ctx.at(0),
    alertmanager: current(ctx, "alertmanager-alerts"),
    vmalert: current(ctx, "vmalert-rules"),
    alerts: [
      {
        fingerprint: fingerprint(1),
        state: "firing",
        severity: "critical",
        name: "HostDown",
        target: { kind: "host", id: HOST_1_ID },
        startsAt: ctx.at(-900),
        labels: { alertname: "HostDown", host: HOST_1, instance: `${PLACEHOLDER.ipv4(1)}:9100`, severity: "critical" },
        annotations: { summary: `${HOST_1} has not reported for 5 minutes` },
        receivers: [RECEIVER],
        silencedBy: [],
        inhibitedBy: [],
        group: "pulse-hosts",
        historyRef: { queryId: "alerts.firing", target: { kind: "host", id: HOST_1_ID } },
      },
      {
        fingerprint: fingerprint(2),
        state: "firing",
        severity: "warning",
        name: "ScrapeTargetUnknown",
        target: null,
        startsAt: ctx.at(-300),
        labels: { alertname: "ScrapeTargetUnknown", instance: `${PLACEHOLDER.ipv4(9)}:9100`, severity: "warning" },
        annotations: {},
        receivers: [RECEIVER],
        silencedBy: [],
        inhibitedBy: [],
        group: null,
        historyRef: { queryId: "alerts.firing", target: null },
      },
      {
        fingerprint: fingerprint(3),
        state: "silenced",
        severity: "warning",
        name: "ServiceCheckFailing",
        target: { kind: "service", id: SERVICE_1_ID },
        startsAt: ctx.at(-3600),
        labels: { alertname: "ServiceCheckFailing", host: HOST_1, service: "svc-001", severity: "warning" },
        annotations: { summary: "svc-001 failed 3 consecutive checks" },
        receivers: [RECEIVER],
        silencedBy: [silenceId(1)],
        inhibitedBy: [],
        group: "pulse-services",
        historyRef: { queryId: "alerts.firing", target: { kind: "service", id: SERVICE_1_ID } },
      },
      {
        fingerprint: fingerprint(4),
        state: "inhibited",
        severity: "warning",
        name: "HostDiskFilling",
        target: { kind: "host", id: HOST_1_ID },
        startsAt: ctx.at(-1800),
        labels: { alertname: "HostDiskFilling", host: HOST_1, severity: "warning" },
        annotations: { summary: `${HOST_1} disk is 90% full` },
        receivers: [RECEIVER],
        silencedBy: [],
        inhibitedBy: [fingerprint(1)],
        group: "pulse-hosts",
        historyRef: { queryId: "alerts.firing", target: { kind: "host", id: HOST_1_ID } },
      },
    ],
    rules: [
      {
        group: "pulse-deadman",
        family: "deadman",
        name: "PulseDeadman",
        state: "firing",
        health: "healthy",
        lastEvaluationAt: ctx.at(-15),
        lastError: null,
        deadman: true,
      },
      {
        group: "pulse-hosts",
        family: "hosts",
        name: "HostDiskFilling",
        state: "firing",
        health: "healthy",
        lastEvaluationAt: ctx.at(-15),
        lastError: null,
        deadman: false,
      },
      {
        group: "pulse-hosts",
        family: "hosts",
        name: "HostDown",
        state: "firing",
        health: "healthy",
        lastEvaluationAt: ctx.at(-15),
        lastError: null,
        deadman: false,
      },
      {
        group: "pulse-services",
        family: "services",
        name: "ServiceBackupStale",
        state: "inactive",
        health: "unknown",
        lastEvaluationAt: null,
        lastError: null,
        deadman: false,
      },
      {
        group: "pulse-services",
        family: "services",
        name: "ServiceCheckFailing",
        state: "firing",
        health: "healthy",
        lastEvaluationAt: ctx.at(-30),
        lastError: null,
        deadman: false,
      },
    ],
    silences: [
      {
        id: silenceId(1),
        matchers: [equals("alertname", "ServiceCheckFailing"), equals("service", "svc-001")],
        createdBy: OPERATOR,
        comment: "Planned maintenance on svc-001",
        startsAt: ctx.at(-3000),
        endsAt: ctx.at(4200),
        state: "active",
      },
      {
        id: silenceId(2),
        matchers: [{ name: "host", value: "host-00[23]\\.example\\.net", isRegex: true, isEqual: true }],
        createdBy: OPERATOR,
        comment: "Upcoming host patching window",
        startsAt: ctx.at(3600),
        endsAt: ctx.at(7200),
        state: "pending",
      },
    ],
  } satisfies AlertsPayload;
  return Promise.resolve(body);
}

/** Both sources answered and reported nothing. */
function emptyBody(ctx: ScenarioContext): AlertsPayload {
  return {
    generatedAt: ctx.at(0),
    alertmanager: current(ctx, "alertmanager-alerts"),
    vmalert: current(ctx, "vmalert-rules"),
    alerts: [],
    rules: [],
    silences: [],
  } satisfies AlertsPayload;
}

/** Every optional member present and every nullable member set, on every item. */
function allOptionalBody(ctx: ScenarioContext): AlertsPayload {
  return {
    generatedAt: ctx.at(0),
    alertmanager: {
      state: "stale",
      source: "alertmanager-alerts",
      lastGoodAt: ctx.at(-120),
      message: "Alertmanager did not answer; showing the last good result.",
    },
    vmalert: {
      state: "stale",
      source: "vmalert-rules",
      lastGoodAt: ctx.at(-120),
      message: "vmalert did not answer; showing the last good result.",
    },
    alerts: [
      {
        fingerprint: fingerprint(1),
        state: "firing",
        severity: "critical",
        name: "HostDown",
        target: { kind: "host", id: HOST_1_ID },
        startsAt: ctx.at(-900),
        labels: { alertname: "HostDown", host: HOST_1, severity: "critical" },
        annotations: { summary: `${HOST_1} has not reported for 5 minutes`, description: "No heartbeat was received." },
        receivers: [RECEIVER],
        silencedBy: [],
        inhibitedBy: [],
        group: "pulse-hosts",
        historyRef: { queryId: "alerts.firing", target: { kind: "host", id: HOST_1_ID } },
        ack: { by: OPERATOR, at: ctx.at(-600), note: "Investigating the power feed." },
      },
      {
        fingerprint: fingerprint(2),
        state: "silenced",
        severity: "warning",
        name: "ServiceCheckFailing",
        target: { kind: "service", id: SERVICE_1_ID },
        startsAt: ctx.at(-3600),
        labels: { alertname: "ServiceCheckFailing", host: HOST_1, service: "svc-001", severity: "warning" },
        annotations: { summary: "svc-001 failed 3 consecutive checks" },
        receivers: [RECEIVER],
        silencedBy: [silenceId(1)],
        inhibitedBy: [],
        group: "pulse-services",
        historyRef: { queryId: "alerts.firing", target: { kind: "service", id: SERVICE_1_ID } },
        ack: { by: OPERATOR, at: ctx.at(-3000), note: "Covered by the maintenance silence." },
      },
      {
        fingerprint: fingerprint(3),
        state: "inhibited",
        severity: "warning",
        name: "EndpointSlow",
        target: { kind: "endpoint", id: ENDPOINT_1_ID },
        startsAt: ctx.at(-1800),
        labels: { alertname: "EndpointSlow", endpoint: ENDPOINT_1_ID, severity: "warning" },
        annotations: { summary: "svc-001 responds slower than 2 seconds" },
        receivers: [RECEIVER],
        silencedBy: [silenceId(2)],
        inhibitedBy: [fingerprint(1)],
        group: "pulse-services",
        historyRef: { queryId: "alerts.firing", target: { kind: "endpoint", id: ENDPOINT_1_ID } },
        ack: { by: OPERATOR, at: ctx.at(-1200), note: "Follows from the host outage." },
      },
    ],
    rules: [
      {
        group: "pulse-deadman",
        family: "deadman",
        name: "PulseDeadman",
        state: "firing",
        health: "unhealthy",
        lastEvaluationAt: ctx.at(-15),
        lastError: "evaluation timed out after 10s",
        deadman: true,
      },
      {
        group: "pulse-hosts",
        family: "hosts",
        name: "HostDown",
        state: "pending",
        health: "unhealthy",
        lastEvaluationAt: ctx.at(-15),
        lastError: "query returned no data",
        deadman: false,
      },
    ],
    silences: [
      {
        id: silenceId(1),
        matchers: [
          equals("alertname", "ServiceCheckFailing"),
          { name: "host", value: "host-00[12]\\.example\\.net", isRegex: true, isEqual: false },
        ],
        createdBy: OPERATOR,
        comment: "Planned maintenance on svc-001",
        startsAt: ctx.at(-3000),
        endsAt: ctx.at(4200),
        state: "active",
      },
      {
        id: silenceId(2),
        matchers: [equals("host", HOST_2)],
        createdBy: OPERATOR,
        comment: "Upcoming host patching window",
        startsAt: ctx.at(3600),
        endsAt: ctx.at(7200),
        state: "pending",
      },
    ],
  } satisfies AlertsPayload;
}

/** Every capped collection exactly at its cap, each item as small as the type allows. */
function maxSizeBody(ctx: ScenarioContext): AlertsPayload {
  const limits = CONTRACT_LIMITS.alerts;
  const startsAt = ctx.at(0);
  const endsAt = ctx.at(3600);
  const alerts = Array.from(
    { length: limits.alerts },
    (_, i) =>
      ({
        fingerprint: i.toString(36),
        state: "firing",
        severity: "critical",
        name: "a",
        target: null,
        startsAt,
        labels: {},
        annotations: {},
        receivers: [],
        silencedBy: [],
        inhibitedBy: [],
        group: null,
        historyRef: null,
      }) satisfies ActiveAlert,
  );
  const rules = Array.from(
    { length: limits.rules },
    (_, i) =>
      ({
        group: "a",
        family: "a",
        name: i.toString(36),
        state: "inactive",
        health: "unknown",
        lastEvaluationAt: null,
        lastError: null,
        deadman: false,
      }) satisfies RuleState,
  );
  const silences = Array.from(
    { length: limits.silences },
    (_, i) =>
      ({
        id: i.toString(36),
        matchers: [equals("a", "a")],
        createdBy: "a",
        comment: "a",
        startsAt,
        endsAt,
        state: "active",
      }) satisfies ActiveSilence,
  );
  return {
    generatedAt: ctx.at(0),
    alertmanager: current(ctx, "alertmanager-alerts"),
    vmalert: current(ctx, "vmalert-rules"),
    alerts,
    rules,
    silences,
  } satisfies AlertsPayload;
}

export const alertsScenarios: ScenarioModule = {
  group: "alerts",
  operation: "GET /api/alerts",
  async build(ctx) {
    const notReady = await responseBody(await alertsRoute.handler(stubRouteRequest("/api/alerts"), stubContext()), 503);
    return [
      jsonFixture(this, "typical", "response", 200, await typicalAlertsBody(ctx)),
      jsonFixture(this, "empty", "response", 200, emptyBody(ctx)),
      jsonFixture(this, "all-optional", "response", 200, allOptionalBody(ctx)),
      jsonFixture(this, "max-size", "response", 200, maxSizeBody(ctx)),
      jsonFixture(this, "error-not-ready", "error", 503, notReady),
      jsonFixture(this, "error-invalid-request", "error", 400, await errorEnvelopeBody("INVALID_REQUEST", 400)),
      jsonFixture(this, "bundle-error", "error", 503, await bundleErrorBody("missing")),
    ];
  },
};
