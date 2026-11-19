// Timeline fixtures: typed `TimelinePayload` index bodies, plus the route's error bodies.

import { CONTRACT_LIMITS } from "@pulse/web-data/contract";
import type { QueryId, RangeId, TimelineDomain, TimelinePayload, TimelineTarget } from "@pulse/web-data/wire";

import { timelineRoute } from "../../../src/server/routes/current.js";
import { ContractToolError } from "../errors.js";
import { bundleErrorBody, errorEnvelopeBody, responseBody, stubContext, stubRouteRequest } from "../stub-context.js";
import { PLACEHOLDER, jsonFixture, pad3 } from "./common.js";
import type { ScenarioContext, ScenarioModule } from "./index.js";

const LIMITS = CONTRACT_LIMITS.timeline;

/** Every accepted range, in ascending duration order. */
const RANGES_7D = ["1h", "6h", "24h", "7d"] as const satisfies readonly RangeId[];
/** The ranges of a query whose longest range is 24 hours. */
const RANGES_24H = ["1h", "6h", "24h"] as const satisfies readonly RangeId[];

/** Host queries, in catalog order. */
const HOST_QUERIES = [
  "host.cpu.utilization",
  "host.memory.utilization",
  "host.disk.utilization",
  "host.load.1m",
] as const satisfies readonly QueryId[];

const ALERT_HISTORY = { ranges: RANGES_7D, provenance: "vmalert" } as const satisfies TimelinePayload["alertHistory"];

/** Rendered drilldown id of host `n`. */
function hostId(n: number): string {
  return `host:${PLACEHOLDER.hostName(n)}`;
}

/** Gatus endpoint key of service `name` on host `n`. */
function endpointKey(n: number, name: string): string {
  return `${PLACEHOLDER.hostName(n)}/${name}`;
}

/** Rendered drilldown id of service `name` on host `n`. */
function serviceId(n: number, name: string): string {
  return `svc:${endpointKey(n, name)}`;
}

function hostTarget(n: number): TimelineTarget {
  return {
    target: { kind: "host", id: hostId(n) },
    name: PLACEHOLDER.hostName(n),
    queryIds: HOST_QUERIES,
    ranges: RANGES_7D,
    parent: null,
  };
}

/** A service with a deep-health probe, and a backup when `backup` is set. */
function serviceTarget(n: number, name: string, backup = false): TimelineTarget {
  return {
    target: { kind: "service", id: serviceId(n, name) },
    name: endpointKey(n, name),
    queryIds: backup ? ["service.deep-health", "service.backup-age"] : ["service.deep-health"],
    ranges: backup ? RANGES_7D : RANGES_24H,
    parent: { kind: "host", id: hostId(n) },
  };
}

function endpointTarget(n: number, name: string): TimelineTarget {
  return {
    target: { kind: "endpoint", id: endpointKey(n, name) },
    name: endpointKey(n, name),
    queryIds: ["endpoint.check.latency"],
    ranges: RANGES_24H,
    parent: { kind: "service", id: serviceId(n, name) },
  };
}

function domain(name: string): TimelineDomain {
  return { domain: name, endpoint: `dns:${name}` };
}

/** The typical timeline body: three hosts, their six services, three service endpoints and two domains. */
export function typicalTimelineBody(ctx: ScenarioContext): Promise<TimelinePayload> {
  const domains = [domain("example.com"), domain("example.org")] satisfies TimelineDomain[];
  const body = {
    generatedAt: ctx.at(0),
    // Hosts, then services, then endpoints, each by id.
    targets: [
      hostTarget(1),
      hostTarget(2),
      hostTarget(3),
      serviceTarget(1, "db", true),
      serviceTarget(1, "web"),
      serviceTarget(2, "backup", true),
      serviceTarget(2, "web"),
      serviceTarget(3, "legacy"),
      serviceTarget(3, "web"),
      endpointTarget(1, "web"),
      endpointTarget(2, "web"),
      endpointTarget(3, "web"),
    ],
    alertHistory: ALERT_HISTORY,
    checkHistory: {
      endpoints: [...domains.map((d) => d.endpoint), endpointKey(1, "web"), endpointKey(2, "web"), endpointKey(3, "web")],
      provenance: "gatus",
    },
    domains,
  } satisfies TimelinePayload;
  return Promise.resolve(body);
}

/** No targets, endpoints or domains. The alert-history ranges come from the catalog, so they stay. */
function emptyBody(ctx: ScenarioContext): TimelinePayload {
  return {
    generatedAt: ctx.at(0),
    targets: [],
    alertHistory: ALERT_HISTORY,
    checkHistory: { endpoints: [], provenance: "gatus" },
    domains: [],
  } satisfies TimelinePayload;
}

/** The payload has no optional members; this body gives every target a parent. */
function allOptionalBody(ctx: ScenarioContext): TimelinePayload {
  const domains = [domain("example.com")] satisfies TimelineDomain[];
  return {
    generatedAt: ctx.at(0),
    targets: [serviceTarget(1, "db", true), serviceTarget(1, "web"), endpointTarget(1, "web")],
    alertHistory: ALERT_HISTORY,
    checkHistory: { endpoints: [...domains.map((d) => d.endpoint), endpointKey(1, "web")], provenance: "gatus" },
    domains,
  } satisfies TimelinePayload;
}

/** Every list at its cap with the smallest valid items. */
function maxSizeBody(ctx: ScenarioContext): TimelinePayload {
  const domains = Array.from({ length: LIMITS.domains }, (_, i) => domain(`d${pad3(i + 1)}.example.com`));
  // Domain endpoints in ascending order, cut at the endpoint cap.
  const endpoints = domains.map((d) => d.endpoint).slice(0, LIMITS.checkEndpoints);
  if (endpoints.length !== LIMITS.checkEndpoints) {
    throw new ContractToolError("SCENARIO_INVALID", "timeline/max-size", "the domains cap is below the check-endpoints cap");
  }
  return {
    generatedAt: ctx.at(0),
    targets: Array.from({ length: LIMITS.targets }, (_, i) => ({
      target: { kind: "host", id: `h${String(i).padStart(4, "0")}` },
      name: "a",
      queryIds: ["host.load.1m"],
      ranges: RANGES_24H,
      parent: null,
    })),
    alertHistory: ALERT_HISTORY,
    checkHistory: { endpoints, provenance: "gatus" },
    domains,
  } satisfies TimelinePayload;
}

export const timelineScenarios: ScenarioModule = {
  group: "timeline",
  operation: "GET /api/timeline",
  async build(ctx) {
    const notReady = await responseBody(await timelineRoute.handler(stubRouteRequest("/api/timeline"), stubContext()), 503);
    return [
      jsonFixture(this, "typical", "response", 200, await typicalTimelineBody(ctx)),
      jsonFixture(this, "empty", "response", 200, emptyBody(ctx)),
      jsonFixture(this, "all-optional", "response", 200, allOptionalBody(ctx)),
      jsonFixture(this, "max-size", "response", 200, maxSizeBody(ctx)),
      jsonFixture(this, "error-not-ready", "error", 503, notReady),
      jsonFixture(this, "error-invalid-request", "error", 400, await errorEnvelopeBody("INVALID_REQUEST", 400)),
      jsonFixture(this, "bundle-error", "error", 503, await bundleErrorBody("missing")),
    ];
  },
};
