// Overview fixtures: typed `OverviewSnapshotV2` bodies the web validator must accept, plus the route's error bodies.

import { CONTRACT_LIMITS } from "@pulse/web-data/contract";
import { validateOverviewSnapshotV2 } from "@pulse/web-data/wire";
import type {
  CheckSummary,
  DataAvailability,
  HostStatus,
  LiveSignal,
  OverviewAlertSummary,
  OverviewCheckResult,
  OverviewSnapshotV2,
  ServiceStatus,
  SourceHealthCompat,
  TargetIdentity,
  TargetStatus,
  TargetStatusEvidence,
} from "@pulse/web-data/wire";

import { overviewRoute } from "../../../src/server/routes/overview.js";
import { ContractToolError } from "../errors.js";
import { bundleErrorBody, errorEnvelopeBody, responseBody, stubContext, stubRouteRequest } from "../stub-context.js";
import { APP_VERSION, PLACEHOLDER, jsonFixture, jsonObject, utf8OfBytes } from "./common.js";
import type { ScenarioContext, ScenarioModule } from "./index.js";

const LIMITS = CONTRACT_LIMITS.overview;

const ESTATE = { name: PLACEHOLDER.estateName, timezone: PLACEHOLDER.timezone, tzFallback: false } as const;

/** Rendered drilldown id of host `n`. */
function hostId(n: number): string {
  return `host:${PLACEHOLDER.hostName(n)}`;
}

/** Rendered drilldown id of service `name` on host `n`. */
function serviceId(n: number, name: string): string {
  return `svc:${PLACEHOLDER.hostName(n)}/${name}`;
}

/** Gatus endpoint key of service `name` on host `n`. */
function endpointKey(n: number, name: string): string {
  return `${PLACEHOLDER.hostName(n)}/${name}`;
}

/** Evidence from a source that succeeded at the fixed epoch. */
function current(ctx: ScenarioContext, source: DataAvailability["source"]): DataAvailability {
  return { state: "current", source, lastGoodAt: ctx.at(0), message: null };
}

/** A status paired with its governing evidence, so the two can never disagree. */
function evidence(status: TargetStatus, availability: DataAvailability): TargetStatusEvidence {
  return { status, availability };
}

/** A source that succeeded when the body was built. */
function healthy(ctx: ScenarioContext): SourceHealthCompat {
  return { ok: true, lastSuccess: ctx.at(0), error: null };
}

/** A 16-hex alert fingerprint derived from the alert's identity. */
async function fingerprint(ctx: ScenarioContext, name: string, target: TargetIdentity | null): Promise<string> {
  return (await ctx.hash({ alert: name, target })).slice("sha256:".length, "sha256:".length + 16);
}

/** Dashboard link for `boardUid` scoped to one variable value. */
function grafanaLink(boardUid: string, variable: string, value: string): { boardUid: string; url: string } {
  return { boardUid, url: `${PLACEHOLDER.grafanaUrl}/d/${boardUid}?var-${variable}=${encodeURIComponent(value)}` };
}

/** Assert the web validator accepts the body as a client would decode it. */
function assertValid(body: OverviewSnapshotV2, scenario: string): void {
  const decoded: unknown = JSON.parse(JSON.stringify(body));
  const result = validateOverviewSnapshotV2(decoded);
  if (!result.ok) {
    throw new ContractToolError("SCENARIO_INVALID", `overview/${scenario}`, `the overview validator rejects the body: ${result.message}`);
  }
}

/** The typical overview body: three hosts with two services each, in mixed states. */
export async function typicalOverviewBody(ctx: ScenarioContext): Promise<OverviewSnapshotV2> {
  const liveness = current(ctx, "victoriametrics-signals");
  const rendered = current(ctx, "rendered-estate");
  const unavailable = {
    state: "unavailable",
    source: "victoriametrics-signals",
    lastGoodAt: null,
    message: "No current sample exists for this declared signal.",
  } satisfies DataAvailability;

  const dbTarget = { kind: "service", id: serviceId(1, "db") } satisfies TargetIdentity;
  const hostDownTarget = { kind: "host", id: hostId(2) } satisfies TargetIdentity;
  const backupLate = {
    fingerprint: await fingerprint(ctx, "BackupLate", dbTarget),
    name: "BackupLate",
    severity: "warning",
    startsAt: ctx.at(-1800),
    target: dbTarget,
    summary: "The latest backup is older than expected.",
  } satisfies OverviewAlertSummary;
  const hostDown = {
    fingerprint: await fingerprint(ctx, "HostDown", hostDownTarget),
    name: "HostDown",
    severity: "critical",
    startsAt: ctx.at(-600),
    target: hostDownTarget,
  } satisfies OverviewAlertSummary;

  const check = (n: number, name: string, success: boolean, responseTimeMs: number): OverviewCheckResult => ({
    endpoint: endpointKey(n, name),
    success,
    lastEvaluatedAt: ctx.at(-30),
    responseTimeMs,
  });
  const service = (
    n: number,
    name: string,
    status: TargetStatus,
    extra: Partial<Pick<ServiceStatus, "live" | "activeAlerts" | "checks" | "suppressed" | "deepHealth">> = {},
  ): ServiceStatus => ({
    name,
    host: PLACEHOLDER.hostName(n),
    managed: true,
    deepHealth: false,
    drilldownId: serviceId(n, name),
    suppressed: null,
    status,
    statusEvidence: evidence(status, status === "unknown" ? unavailable : status === "suppressed" ? rendered : liveness),
    live: true,
    activeAlerts: [],
    checks: [],
    grafana: null,
    ...extra,
  });

  const hosts = [
    {
      name: PLACEHOLDER.hostName(1),
      collectionClass: "managed-linux",
      addresses: [PLACEHOLDER.ipv4(1), PLACEHOLDER.ipv6(1)],
      drilldownId: hostId(1),
      suppressed: null,
      status: "ok",
      statusEvidence: evidence("ok", liveness),
      rollup: "warning",
      rollupEvidence: evidence("warning", liveness),
      live: true,
      activeAlerts: [],
      checks: [],
      grafana: grafanaLink("pulse-host", "instance", `${PLACEHOLDER.hostName(1)}:9100`),
      services: [
        service(1, "web", "ok", { checks: [check(1, "web", true, 42)] }),
        service(1, "db", "warning", { activeAlerts: [backupLate], deepHealth: true }),
      ],
    },
    {
      name: PLACEHOLDER.hostName(2),
      collectionClass: "managed-linux",
      addresses: [PLACEHOLDER.ipv4(2)],
      drilldownId: hostId(2),
      suppressed: null,
      status: "critical",
      statusEvidence: evidence("critical", liveness),
      rollup: "critical",
      rollupEvidence: evidence("critical", liveness),
      live: false,
      activeAlerts: [hostDown],
      checks: [],
      grafana: null,
      services: [
        service(2, "web", "unknown", { live: null, checks: [check(2, "web", false, 5000)] }),
        service(2, "backup", "ok"),
      ],
    },
    {
      name: PLACEHOLDER.hostName(3),
      collectionClass: "probe-only",
      addresses: [PLACEHOLDER.ipv4(3)],
      drilldownId: hostId(3),
      suppressed: null,
      status: "ok",
      statusEvidence: evidence("ok", liveness),
      rollup: "ok",
      rollupEvidence: evidence("ok", liveness),
      live: true,
      activeAlerts: [],
      checks: [],
      grafana: null,
      services: [
        service(3, "web", "ok", { checks: [check(3, "web", true, 87)] }),
        service(3, "legacy", "suppressed", {
          live: null,
          suppressed: { class: "known-expected", rationale: "Scheduled for removal; monitoring is paused." },
        }),
      ],
    },
  ] satisfies HostStatus[];

  const signals = [
    {
      target: { kind: "host", id: hostId(1) },
      id: `${hostId(1)}:liveness`,
      label: `${PLACEHOLDER.hostName(1)} liveness`,
      unit: "state",
      value: 1,
      availability: liveness,
    },
    {
      target: { kind: "host", id: hostId(2) },
      id: `${hostId(2)}:liveness`,
      label: `${PLACEHOLDER.hostName(2)} liveness`,
      unit: "state",
      value: 0,
      availability: liveness,
    },
    {
      target: { kind: "service", id: serviceId(1, "db") },
      id: `${serviceId(1, "db")}:backup-age`,
      label: "db backup age",
      unit: "seconds",
      value: 93600,
      availability: liveness,
    },
    {
      target: { kind: "service", id: serviceId(2, "web") },
      id: `${serviceId(2, "web")}:liveness`,
      label: `${endpointKey(2, "web")} liveness`,
      unit: "state",
      value: null,
      availability: unavailable,
    },
  ] satisfies LiveSignal[];

  const recentChecks = [
    {
      target: { kind: "service", id: serviceId(1, "web") },
      endpoint: endpointKey(1, "web"),
      success: true,
      observedAt: ctx.at(-30),
      durationMs: 42,
    },
    {
      target: { kind: "service", id: serviceId(2, "web") },
      endpoint: endpointKey(2, "web"),
      success: true,
      observedAt: ctx.at(-90),
      durationMs: 61,
    },
    {
      target: { kind: "service", id: serviceId(2, "web") },
      endpoint: endpointKey(2, "web"),
      success: false,
      observedAt: ctx.at(-30),
      durationMs: 5000,
    },
    {
      target: { kind: "service", id: serviceId(3, "web") },
      endpoint: endpointKey(3, "web"),
      success: true,
      observedAt: ctx.at(-30),
      durationMs: 87,
    },
  ] satisfies CheckSummary[];

  return {
    appVersion: APP_VERSION,
    generatedAt: ctx.at(0),
    estate: ESTATE,
    sources: { metrics: healthy(ctx), alerts: healthy(ctx), checks: healthy(ctx) },
    hosts,
    alerts: [hostDown, backupLate],
    signals,
    recentChecks,
    engine: { availability: current(ctx, "victoriametrics-buildinfo"), value: { ok: true } },
    alertCounts: { firing: 2, silenced: 1, inhibited: 0 },
    coverage: { availability: rendered, value: { covered: 9, gaps: 0, extras: 0 } },
  } satisfies OverviewSnapshotV2;
}

/** No hosts, alerts, signals or checks, and no engine or coverage value. */
function emptyBody(ctx: ScenarioContext): OverviewSnapshotV2 {
  const never = { ok: false, lastSuccess: null, error: null } satisfies SourceHealthCompat;
  return {
    appVersion: APP_VERSION,
    generatedAt: ctx.at(0),
    estate: ESTATE,
    sources: { metrics: never, alerts: never, checks: never },
    hosts: [],
    alerts: [],
    signals: [],
    recentChecks: [],
    engine: {
      availability: { state: "unavailable", source: "victoriametrics-buildinfo", lastGoodAt: null, message: null },
      value: null,
    },
    alertCounts: { firing: 0, silenced: 0, inhibited: 0 },
    coverage: {
      availability: { state: "not-configured", source: "rendered-estate", lastGoodAt: null, message: null },
      value: null,
    },
  } satisfies OverviewSnapshotV2;
}

/** Every optional member present and every nullable member non-null. */
async function allOptionalBody(ctx: ScenarioContext): Promise<OverviewSnapshotV2> {
  const stale = (source: DataAvailability["source"]): DataAvailability => ({
    state: "stale",
    source,
    lastGoodAt: ctx.at(-120),
    message: "The upstream source could not be reached.",
  });
  const degraded = {
    ok: false,
    lastSuccess: ctx.at(-120),
    error: "The upstream source could not be reached.",
  } satisfies SourceHealthCompat;
  const suppressed = { class: "known-expected", rationale: "Planned maintenance window." } as const;

  const alert = async (
    name: string,
    severity: OverviewAlertSummary["severity"],
    target: TargetIdentity,
  ): Promise<OverviewAlertSummary> => ({
    fingerprint: await fingerprint(ctx, name, target),
    name,
    severity,
    startsAt: ctx.at(-900),
    target,
    summary: `${name} is firing on ${target.id}.`,
    acked: true,
  });
  const check = (name: string, success: boolean, responseTimeMs: number): OverviewCheckResult => ({
    endpoint: endpointKey(1, name),
    success,
    lastEvaluatedAt: ctx.at(-30),
    responseTimeMs,
  });

  const hostTarget = { kind: "host", id: hostId(1) } satisfies TargetIdentity;
  const webTarget = { kind: "service", id: serviceId(1, "web") } satisfies TargetIdentity;
  const endpointTarget = { kind: "endpoint", id: endpointKey(1, "web") } satisfies TargetIdentity;
  const hostAlert = await alert("HostDiskFull", "critical", hostTarget);
  const serviceAlert = await alert("DeepHealthFailing", "warning", webTarget);
  const endpointAlert = await alert("EndpointSlow", "info", endpointTarget);

  const service = (name: string, ingressUrl: string, activeAlerts: readonly OverviewAlertSummary[]): ServiceStatus => ({
    name,
    host: PLACEHOLDER.hostName(1),
    managed: true,
    deepHealth: true,
    ingressUrl,
    drilldownId: serviceId(1, name),
    suppressed,
    status: "suppressed",
    statusEvidence: evidence("suppressed", stale("rendered-estate")),
    live: true,
    activeAlerts,
    checks: [check(name, true, 42)],
    grafana: grafanaLink("pulse-deephealth", "service", name),
  });

  const hosts = [
    {
      name: PLACEHOLDER.hostName(1),
      collectionClass: "managed-linux",
      addresses: [PLACEHOLDER.ipv4(1), PLACEHOLDER.ipv6(1)],
      drilldownId: hostId(1),
      suppressed,
      status: "suppressed",
      statusEvidence: evidence("suppressed", stale("rendered-estate")),
      rollup: "suppressed",
      rollupEvidence: evidence("suppressed", stale("rendered-estate")),
      live: true,
      activeAlerts: [hostAlert],
      checks: [check("web", true, 42)],
      grafana: grafanaLink("pulse-host", "instance", `${PLACEHOLDER.hostName(1)}:9100`),
      services: [
        service("web", `${PLACEHOLDER.baseUrl}/web`, [serviceAlert, endpointAlert]),
        service("grafana", PLACEHOLDER.grafanaUrl, []),
      ],
    },
  ] satisfies HostStatus[];

  const signals = [
    {
      target: hostTarget,
      id: `${hostId(1)}:liveness`,
      label: `${PLACEHOLDER.hostName(1)} liveness`,
      unit: "state",
      value: 1,
      availability: stale("victoriametrics-signals"),
    },
    {
      target: hostTarget,
      id: `${hostId(1)}:command:kernel`,
      label: "kernel",
      unit: "scalar",
      value: "6.8.0",
      availability: stale("victoriametrics-signals"),
    },
    {
      target: webTarget,
      id: `${serviceId(1, "web")}:liveness`,
      label: `${endpointKey(1, "web")} liveness`,
      unit: "state",
      value: true,
      availability: stale("victoriametrics-signals"),
    },
  ] satisfies LiveSignal[];

  const recentChecks = [
    { target: webTarget, endpoint: endpointKey(1, "web"), success: true, observedAt: ctx.at(-30), durationMs: 42 },
    { target: endpointTarget, endpoint: endpointKey(1, "web"), success: false, observedAt: ctx.at(-90), durationMs: 5000 },
  ] satisfies CheckSummary[];

  return {
    appVersion: APP_VERSION,
    generatedAt: ctx.at(0),
    estate: ESTATE,
    sources: { metrics: degraded, alerts: degraded, checks: degraded },
    hosts,
    alerts: [hostAlert, serviceAlert, endpointAlert],
    signals,
    recentChecks,
    engine: {
      availability: stale("victoriametrics-buildinfo"),
      value: { ok: false, problems: ["The upstream source could not be reached."] },
    },
    alertCounts: { firing: 3, silenced: 1, inhibited: 1 },
    coverage: { availability: stale("rendered-estate"), value: { covered: 3, gaps: 1, extras: 1 } },
  } satisfies OverviewSnapshotV2;
}

/** Every collection at its cap with the smallest valid items; nested per-target caps on the first host and service only. */
function maxSizeBody(ctx: ScenarioContext): OverviewSnapshotV2 {
  if (LIMITS.servicesTotal % LIMITS.hosts !== 0) {
    throw new ContractToolError("SCENARIO_INVALID", "overview/max-size", "the services cap is not a multiple of the hosts cap");
  }
  const servicesPerHost = LIMITS.servicesTotal / LIMITS.hosts;
  const stamp = ctx.at(0);
  const bare = { state: "current", source: "rendered-estate", lastGoodAt: null, message: null } satisfies DataAvailability;
  const ok = evidence("ok", bare);
  const noSuccess = { ok: true, lastSuccess: null, error: null } satisfies SourceHealthCompat;
  const longText = utf8OfBytes(LIMITS.textBytes);

  const alerts = (prefix: string): OverviewAlertSummary[] =>
    Array.from({ length: LIMITS.alerts }, (_, i) => ({
      fingerprint: `${prefix}${i}`,
      name: "a",
      severity: "info",
      startsAt: stamp,
      target: null,
    }));
  const checks = (): OverviewCheckResult[] =>
    Array.from({ length: LIMITS.targetChecks }, (_, i) => ({ endpoint: `e${i}`, success: true, lastEvaluatedAt: stamp }));

  const hosts = Array.from({ length: LIMITS.hosts }, (_, h) => {
    const name = h === 0 ? longText : `h${h}`;
    const services = Array.from({ length: servicesPerHost }, (_, s) => {
      const first = h === 0 && s === 0;
      return {
        name: "s",
        host: name,
        managed: false,
        deepHealth: false,
        drilldownId: `s${h * servicesPerHost + s}`,
        suppressed: null,
        status: "ok",
        statusEvidence: ok,
        live: null,
        activeAlerts: first ? alerts("s") : [],
        checks: first ? checks() : [],
        grafana: null,
      } satisfies ServiceStatus;
    });
    return {
      name,
      collectionClass: "excluded",
      addresses: h === 0 ? Array.from({ length: LIMITS.hostAddresses }, (_, a) => PLACEHOLDER.ipv4(a + 1)) : [],
      drilldownId: name,
      suppressed: null,
      status: "ok",
      statusEvidence: ok,
      rollup: "ok",
      rollupEvidence: ok,
      live: null,
      activeAlerts: h === 0 ? alerts("h") : [],
      checks: h === 0 ? checks() : [],
      grafana: null,
      services,
    } satisfies HostStatus;
  });

  const stripAlerts = alerts("f");
  stripAlerts[0] = {
    fingerprint: "f0",
    name: longText,
    severity: "info",
    startsAt: stamp,
    target: null,
    summary: utf8OfBytes(LIMITS.messageBytes),
  };

  return {
    appVersion: APP_VERSION,
    generatedAt: stamp,
    estate: ESTATE,
    sources: { metrics: noSuccess, alerts: noSuccess, checks: noSuccess },
    hosts,
    alerts: stripAlerts,
    signals: Array.from({ length: LIMITS.signals }, (_, i) => ({
      target: { kind: "host", id: "h1" },
      id: `g${i}`,
      label: "a",
      unit: "state",
      value: null,
      availability: bare,
    })),
    recentChecks: Array.from({ length: LIMITS.recentChecks }, (_, i) => ({
      target: null,
      endpoint: `e${i}`,
      success: null,
      observedAt: null,
      durationMs: null,
    })),
    engine: {
      availability: bare,
      value: { ok: false, problems: Array.from({ length: LIMITS.engineProblems }, () => "a") },
    },
    alertCounts: { firing: LIMITS.alerts, silenced: 0, inhibited: 0 },
    coverage: { availability: bare, value: { covered: 0, gaps: 0, extras: 0 } },
  } satisfies OverviewSnapshotV2;
}

/** Element 0 of a decoded JSON array, as a mutable object. */
function firstObject(value: unknown, subject: string): Record<string, unknown> {
  if (!Array.isArray(value)) throw new ContractToolError("SCENARIO_INVALID", subject, "expected a JSON array");
  const first: unknown = value[0];
  return jsonObject(first, subject);
}

/** The typical body with a member no current client knows, at the root and three nested levels. */
function unknownFieldsBody(typical: OverviewSnapshotV2): unknown {
  const subject = "overview/unknown-fields";
  const clone: unknown = structuredClone(typical);
  const root = jsonObject(clone, subject);
  const host = firstObject(root.hosts, subject);
  for (const node of [root, host, firstObject(host.services, subject), firstObject(root.alerts, subject)]) {
    node.futureField = { nested: true };
  }
  return clone;
}

export const overviewScenarios: ScenarioModule = {
  group: "overview",
  operation: "GET /api/overview",
  async build(ctx) {
    const typical = await typicalOverviewBody(ctx);
    const empty = emptyBody(ctx);
    const allOptional = await allOptionalBody(ctx);
    const maxSize = maxSizeBody(ctx);
    assertValid(typical, "typical");
    assertValid(empty, "empty");
    assertValid(allOptional, "all-optional");
    assertValid(maxSize, "max-size");

    const notReady = await responseBody(await overviewRoute.handler(stubRouteRequest("/api/overview"), stubContext()), 503);
    const validated = { webValidator: "overview" } as const;

    return [
      jsonFixture(this, "typical", "response", 200, typical, validated),
      jsonFixture(this, "empty", "response", 200, empty, validated),
      jsonFixture(this, "all-optional", "response", 200, allOptional, validated),
      jsonFixture(this, "max-size", "response", 200, maxSize, validated),
      jsonFixture(this, "error-not-ready", "error", 503, notReady),
      jsonFixture(this, "error-invalid-request", "error", 400, await errorEnvelopeBody("INVALID_REQUEST", 400)),
      jsonFixture(this, "bundle-error", "error", 503, await bundleErrorBody("missing")),
      jsonFixture(this, "unknown-fields", "response", 200, unknownFieldsBody(typical)),
    ];
  },
};
