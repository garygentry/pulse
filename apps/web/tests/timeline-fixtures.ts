// apps/web/tests/timeline-fixtures.ts — timeline test fixtures and the /api/history fetch stub
// (08 §2.2, §2.3). Browser fixture pages bundle this module, so it uses only type imports from
// "@pulse/web-data/wire" and no Node/Bun API, and it imports nothing from views/timeline/**.
// Builders mirror foldTimeline (packages/web-data/src/cycle/fold-timeline.ts); every time is
// relative to TIMELINE_NOW_S.

import type {
  AlertHistoryLane, DataAvailability, EndpointHistoryPayload, ErrorEnvelope, HashId, HistoryPayload,
  HistorySeries, HostStatus, IntervalHistoryPayload, OverviewSnapshotV2, QueryId, RangeId, ServiceStatus,
  StatusInterval, TargetIdentity, TimelineDomain, TimelinePayload, TimelineTarget, Unit,
} from "@pulse/web-data/wire";

/** Fixed clock: 2026-09-24T12:00:00Z (epoch s 1790251200). */
export const TIMELINE_NOW_S = 1_790_251_200;

const NOW_ISO = isoAt(0);
const RANGES: readonly RangeId[] = ["1h", "6h", "24h", "7d"];
const RANGE_S: Readonly<Record<RangeId, number>> = { "1h": 3_600, "6h": 21_600, "24h": 86_400, "7d": 604_800 };
const HOST_QUERY_IDS: readonly QueryId[] = [
  "estate.liveness", "host.cpu.utilization", "host.memory.utilization", "host.disk.utilization", "host.load.1m",
];
const SERVICE_QUERY_IDS: readonly QueryId[] = ["estate.liveness"];
const ENDPOINT_QUERY_IDS: readonly QueryId[] = ["endpoint.check.latency"];
const SERVICE_NAMES = ["nginx", "postgres", "redis", "node-app", "backup", "cron"] as const;
const MAX_HOSTS = 100;
const MAX_SERVICES = 300;

/** Local QueryId → unit mirror (the catalog is not importable here). */
const QUERY_UNIT: Readonly<Record<QueryId, Unit>> = {
  "estate.liveness": "state",
  "alerts.firing": "state",
  "host.cpu.utilization": "percent",
  "host.memory.utilization": "percent",
  "host.disk.utilization": "percent",
  "host.load.1m": "scalar",
  "endpoint.check.latency": "milliseconds",
  "service.deep-health": "scalar",
  "service.backup-age": "seconds",
  "engine.ingestion-rate": "count",
  "engine.active-series": "count",
  "engine.disk-usage": "bytes",
  "engine.notification-failures": "count",
  "engine.notification-latency": "seconds",
};

function isoAt(offsetS: number): string {
  return new Date((TIMELINE_NOW_S + offsetS) * 1000).toISOString();
}

/** Default step for a range: max(60, ceil(R / 598)), the data tier's alerts.firing step. */
function stepFor(range: RangeId): number {
  return Math.max(60, Math.ceil(RANGE_S[range] / 598));
}

function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function current(source: DataAvailability["source"]): DataAvailability {
  return { state: "current", source, lastGoodAt: NOW_ISO, message: null };
}

function hostName(i: number): string {
  return `host-${String(i + 1).padStart(3, "0")}`;
}

function serviceName(j: number): string {
  return SERVICE_NAMES[j] ?? `svc-${j + 1}`;
}

// ---------------------------------------------------------------------------
// Snapshot and index builders
// ---------------------------------------------------------------------------

/** Snapshot with `hosts` hosts × `servicesPerHost` services; services get endpoint keys "<host>/<svc>". */
export function makeHierarchySnapshot(opts: { readonly hosts: number; readonly servicesPerHost: number; readonly timezone?: string; readonly grafana?: boolean }): OverviewSnapshotV2 {
  const hostCount = Math.max(0, Math.trunc(opts.hosts));
  const perHost = Math.max(0, Math.trunc(opts.servicesPerHost));
  if (hostCount > MAX_HOSTS || hostCount * perHost > MAX_SERVICES) {
    throw new RangeError(`makeHierarchySnapshot: at most ${MAX_HOSTS} hosts and ${MAX_SERVICES} services`);
  }
  const hostEvidence = { status: "ok" as const, availability: current("victoriametrics-signals") };
  const serviceEvidence = { status: "ok" as const, availability: current("gatus-statuses") };
  const hosts: HostStatus[] = [];
  for (let i = 0; i < hostCount; i++) {
    const name = hostName(i);
    const services: ServiceStatus[] = [];
    for (let j = 0; j < perHost; j++) {
      const svc = serviceName(j);
      services.push({
        name: svc, host: name, managed: true, deepHealth: false, drilldownId: `svc:${name}/${svc}`,
        suppressed: null, status: "ok", statusEvidence: serviceEvidence, live: true, activeAlerts: [],
        checks: [{ endpoint: `${name}/${svc}`, success: true, lastEvaluatedAt: NOW_ISO, responseTimeMs: 42 }],
        grafana: null,
      });
    }
    hosts.push({
      name, collectionClass: "managed-linux", addresses: [`10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`],
      drilldownId: `host:${name}`, suppressed: null, status: "ok", statusEvidence: hostEvidence,
      rollup: "ok", rollupEvidence: hostEvidence, live: true, activeAlerts: [], checks: [],
      grafana: opts.grafana === true
        ? { boardUid: "pulse-host", url: `https://grafana.example.test/d/pulse-host?var-host=${encodeURIComponent(name)}` }
        : null,
      services,
    });
  }
  const sourceOk = { ok: true, lastSuccess: NOW_ISO, error: null };
  return {
    appVersion: "0.1.0",
    generatedAt: NOW_ISO,
    estate: { name: "Timeline estate", timezone: opts.timezone ?? "America/Chicago", tzFallback: false },
    sources: { metrics: sourceOk, alerts: sourceOk, checks: sourceOk },
    hosts,
    alerts: [],
    signals: [],
    recentChecks: [],
    engine: { availability: current("victoriametrics-signals"), value: { ok: true } },
    alertCounts: { firing: 0, silenced: 0, inhibited: 0 },
    coverage: { availability: current("rendered-estate"), value: { covered: hostCount, gaps: 0, extras: 0 } },
  };
}

const TARGET_KIND_RANK: Readonly<Record<TargetIdentity["kind"], number>> = { host: 0, service: 1, endpoint: 2 };

/** Timeline index shaped like `foldTimeline`: host targets advertise ['estate.liveness', ...HOST_CHART_QUERIES];
 *  service targets advertise ['estate.liveness']; each service's check endpoint key appears once in
 *  `checkHistory.endpoints` (ascending) and as a {kind:'endpoint'} target advertising endpoint.check.latency;
 *  `targets` sorted host < service < endpoint, then by id; `alertHistory.ranges` = all four ranges. */
export function makeTimelineIndex(snapshot: OverviewSnapshotV2, o?: {
  /** Host ids left out of the index entirely. */ readonly omitHosts?: readonly string[];
  /** Leave out every endpoint key and endpoint target. */ readonly omitEndpoints?: boolean;
  /** Endpoint key emitted twice in `checkHistory.endpoints` (dedupe tests). */ readonly duplicateEndpoint?: string;
  /** Declared estate domains: each becomes a `domains[]` entry with endpoint `dns:<domain>` (listed in `checkHistory.endpoints`, like foldTimeline). */
  readonly domains?: readonly string[];
}): TimelinePayload {
  // A host is omitted when either its drilldownId ("host:web01") or its name is listed.
  const omit = new Set(o?.omitHosts ?? []);
  const targets: TimelineTarget[] = [];
  const endpointCounts = new Map<string, number>();
  const endpointOwner = new Map<string, string>();

  for (const host of snapshot.hosts) {
    if (!omit.has(host.drilldownId) && !omit.has(host.name)) {
      targets.push({ target: { kind: "host", id: host.drilldownId }, name: host.name, queryIds: HOST_QUERY_IDS, ranges: RANGES, parent: null });
    }
    for (const service of host.services) {
      targets.push({
        target: { kind: "service", id: service.drilldownId }, name: `${service.host}/${service.name}`,
        queryIds: SERVICE_QUERY_IDS, ranges: ["1h", "6h", "24h"],
        parent: { kind: "host", id: host.drilldownId },
      });
      // foldTimeline counts each service's declared keys once; a key declared twice is ambiguous.
      for (const key of new Set(service.checks.map((c) => c.endpoint))) {
        endpointCounts.set(key, (endpointCounts.get(key) ?? 0) + 1);
        endpointOwner.set(key, service.drilldownId);
      }
    }
  }

  if (o?.omitEndpoints !== true) {
    for (const [key, count] of endpointCounts) {
      if (count !== 1) continue;
      targets.push({ target: { kind: "endpoint", id: key }, name: key, queryIds: ENDPOINT_QUERY_IDS, ranges: ["1h", "6h", "24h"],
        parent: { kind: "service", id: endpointOwner.get(key) ?? "" } });
    }
  }

  targets.sort((a, b) =>
    TARGET_KIND_RANK[a.target.kind] - TARGET_KIND_RANK[b.target.kind] || codePointCompare(a.target.id, b.target.id));

  const endpoints = targets.filter((t) => t.target.kind === "endpoint").map((t) => t.target.id);
  if (o?.duplicateEndpoint !== undefined) endpoints.push(o.duplicateEndpoint);
  const domains: TimelineDomain[] = [];
  for (const domain of new Set(o?.domains ?? [])) {
    domains.push({ domain, endpoint: `dns:${domain}` });
    endpoints.push(`dns:${domain}`);
  }
  endpoints.sort(codePointCompare);

  return {
    generatedAt: snapshot.generatedAt,
    targets,
    alertHistory: { ranges: RANGES, provenance: "vmalert" },
    checkHistory: { endpoints, provenance: "gatus" },
    domains,
  };
}

// ---------------------------------------------------------------------------
// History payload builders
// ---------------------------------------------------------------------------

/** Deterministic 64-hex pseudo-hash (FNV-1a variants), enough for a stable lane id. */
function fakeHash(text: string): HashId {
  let hex = "";
  for (let seed = 0; hex.length < 64; seed++) {
    let h = (0x811c9dc5 ^ seed) >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    hex += h.toString(16).padStart(8, "0");
  }
  return `sha256:${hex.slice(0, 64)}`;
}

/** host/service label values derived from a rendered target identity. */
function targetLabels(target: TargetIdentity | null): { readonly host: string | null; readonly service: string | null } {
  if (target === null) return { host: null, service: null };
  if (target.kind === "host") return { host: target.id.replace(/^host:/, ""), service: null };
  if (target.kind === "service") {
    const rest = target.id.replace(/^svc:/, "");
    const slash = rest.indexOf("/");
    return slash < 0 ? { host: null, service: rest } : { host: rest.slice(0, slash), service: rest.slice(slash + 1) };
  }
  return { host: null, service: null };
}

/** One alert lane with intervals given as [startOffsetS, endOffsetS] relative to TIMELINE_NOW_S. */
export function makeAlertLane(o: { readonly alertname: string; readonly severity: AlertHistoryLane["severity"]; readonly target: TargetIdentity | null; readonly intervals: readonly (readonly [number, number])[] }): AlertHistoryLane {
  const { host, service } = targetLabels(o.target);
  const identity = `${o.alertname}|${o.severity}|${o.target === null ? "" : `${o.target.kind}:${o.target.id}`}`;
  const intervals: StatusInterval[] = o.intervals.map(([s, e]) => ({
    start: isoAt(s), end: isoAt(e), state: "firing", provenance: "vmalert",
  }));
  return {
    id: fakeHash(identity),
    alertname: o.alertname,
    severity: o.severity,
    target: o.target,
    attribution: o.target === null ? "unmatched" : "matched",
    labels: {
      alertname: o.alertname,
      severity: o.severity === "unknown" ? null : o.severity,
      host,
      service,
      instance: null,
    },
    provenance: "vmalert",
    intervals,
  };
}

/** Interval payload for a range with the given lanes; fetchedAt = TIMELINE_NOW_S. */
export function makeAlertHistory(range: RangeId, lanes: readonly AlertHistoryLane[]): IntervalHistoryPayload {
  return {
    operation: "alert-intervals",
    target: null,
    range,
    fetchedAt: NOW_ISO,
    effectiveStepSeconds: stepFor(range),
    unit: "state",
    stale: false,
    lanes,
  };
}

/** Deterministic sample value for series `s` at point `i`, shaped by the unit. */
function sampleValue(unit: Unit, s: number, i: number): number {
  const wave = Math.sin(i / 12 + s);
  switch (unit) {
    case "state": return 1;
    case "percent": return Math.round((50 + 30 * wave + s * 3) * 100) / 100;
    case "milliseconds": return Math.round(120 + 60 * wave);
    case "seconds": return Math.round((0.5 + 0.25 * wave) * 1000) / 1000;
    case "bytes": return Math.round(1e9 * (5 + wave));
    case "count": return Math.round(1000 + 400 * wave + s * 10);
    case "scalar": return Math.round((1.5 + wave) * 100) / 100;
  }
}

/** Numeric history payload; `points` generated every `stepS` over the range, with optional null gaps. */
export function makeSeriesHistory(queryId: QueryId, range: RangeId, o?: { readonly target?: TargetIdentity | null; readonly stepS?: number; readonly gaps?: readonly (readonly [number, number])[]; readonly series?: number }): HistoryPayload {
  const unit = QUERY_UNIT[queryId];
  const stepS = o?.stepS !== undefined && Number.isFinite(o.stepS) && o.stepS > 0 ? o.stepS : stepFor(range);
  const seriesCount = Math.max(0, Math.trunc(o?.series ?? 1));
  const gaps = o?.gaps ?? [];
  const startOffset = -RANGE_S[range];
  const series: HistorySeries[] = [];
  for (let s = 0; s < seriesCount; s++) {
    const points: [number, number | null][] = [];
    let i = 0;
    for (let off = startOffset; off <= 0; off += stepS, i++) {
      const inGap = gaps.some(([g0, g1]) => off >= g0 && off < g1);
      points.push([(TIMELINE_NOW_S + off) * 1000, inGap ? null : sampleValue(unit, s, i)]);
    }
    series.push({ labels: { instance: `series-${s + 1}` }, points });
  }
  return {
    queryId,
    target: o?.target ?? null,
    range,
    fetchedAt: NOW_ISO,
    effectiveStepSeconds: stepS,
    unit,
    stale: false,
    series,
  };
}

/** Gatus endpoint payload (reachable-gate tests exercise it directly; no route issues it in M1). */
export function makeEndpointHistory(endpoint: string, o?: { readonly results?: readonly (readonly [offsetS: number, success: boolean])[]; readonly incidents?: readonly (readonly [number, number])[] }): EndpointHistoryPayload {
  const results = o?.results ?? Array.from({ length: 60 }, (_, i) => [-3_600 + (i + 1) * 60, true] as const);
  return {
    operation: "endpoint-history",
    endpoint,
    target: { kind: "endpoint", id: endpoint },
    range: "1h",
    fetchedAt: NOW_ISO,
    effectiveStepSeconds: null,
    unit: "milliseconds",
    stale: false,
    provenance: "gatus",
    results: [...results]
      .sort((a, b) => a[0] - b[0])
      .map(([off, success]) => ({ timestamp: isoAt(off), success, durationMs: success ? 120 : null })),
    incidents: (o?.incidents ?? []).map(([s, e]) => ({ start: isoAt(s), end: isoAt(e), state: "failed", provenance: "gatus" })),
  };
}

/** Error envelope helper. */
export function envelope(code: string): ErrorEnvelope {
  return { code, message: `Stub failure: ${code}` } as ErrorEnvelope;
}

// ---------------------------------------------------------------------------
// Named scenarios
// ---------------------------------------------------------------------------

function hostTarget(i: number): TargetIdentity {
  return { kind: "host", id: `host:${hostName(i)}` };
}

function serviceTarget(i: number, j: number): TargetIdentity {
  return { kind: "service", id: `svc:${hostName(i)}/${serviceName(j)}` };
}

/** The 100-host / 300-service envelope (REQ-SCALE-01) with an incident across 12 hosts in the last 6 h. */
export const TIMELINE_ENVELOPE: { readonly snapshot: OverviewSnapshotV2; readonly index: TimelinePayload; readonly alerts: IntervalHistoryPayload } = (() => {
  const snapshot = makeHierarchySnapshot({ hosts: 100, servicesPerHost: 3, grafana: true });
  const lanes: AlertHistoryLane[] = [];
  for (let i = 0; i < 12; i++) {
    // Staggered cascade: host i goes down 20 min after host i-1, all inside the last 6 h.
    const start = -21_000 + i * 1_200;
    lanes.push(makeAlertLane({ alertname: "HostDown", severity: "critical", target: hostTarget(i), intervals: [[start, start + 2_400]] }));
    lanes.push(makeAlertLane({ alertname: "ServiceUnhealthy", severity: "warning", target: serviceTarget(i, i % 3), intervals: [[start + 300, start + 1_800], [start + 2_100, start + 3_000]] }));
  }
  return { snapshot, index: makeTimelineIndex(snapshot), alerts: makeAlertHistory("24h", lanes) };
})();

/** Named incident scenario: overlapping criticals (>4 in one row), an unmatched lane, info-only lane, unknown severity. */
export const TIMELINE_INCIDENT: { readonly snapshot: OverviewSnapshotV2; readonly index: TimelinePayload; readonly alerts: IntervalHistoryPayload } = (() => {
  const snapshot = makeHierarchySnapshot({ hosts: 6, servicesPerHost: 2, grafana: true });
  const lanes: AlertHistoryLane[] = [];
  // Six criticals that all overlap at NOW − 2 h (-7 200 s).
  for (let i = 0; i < 6; i++) {
    lanes.push(makeAlertLane({ alertname: "HostDown", severity: "critical", target: hostTarget(i), intervals: [[-9_000 + i * 300, -6_000 + i * 120]] }));
  }
  lanes.push(makeAlertLane({ alertname: "DiskFilling", severity: "warning", target: serviceTarget(1, 0), intervals: [[-14_400, -10_800], [-5_400, -3_600]] }));
  lanes.push(makeAlertLane({ alertname: "DomainExpiring", severity: "warning", target: null, intervals: [[-43_200, -36_000]] }));
  lanes.push(makeAlertLane({ alertname: "BackupCompleted", severity: "info", target: serviceTarget(2, 1), intervals: [[-28_800, -27_000]] }));
  lanes.push(makeAlertLane({ alertname: "UnlabelledAlert", severity: "unknown", target: hostTarget(3), intervals: [[-3_000, -1_200]] }));
  return { snapshot, index: makeTimelineIndex(snapshot), alerts: makeAlertHistory("24h", lanes) };
})();

// ---------------------------------------------------------------------------
// History fetch stub (08 §2.3)
// ---------------------------------------------------------------------------

/** One stub route: match by path prefix; reply with a body+status or throw (network failure). */
export interface StubRoute {
  /** Path prefix after the origin, e.g. "/api/history/alerts". */ readonly path: string;
  /** Response body (success payload or ErrorEnvelope), HTTP status and optional Retry-After seconds. */
  readonly reply: { readonly status: number; readonly body: unknown; readonly retryAfter?: number } | { readonly network: true };
  /** Optional artificial delay in ms (supersession and perf tests). */ readonly delayMs?: number;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** Path + query of a fetch input, resolving relative URLs against a placeholder origin. */
function pathAndQuery(input: unknown): string {
  const raw = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : typeof input === "object" && input !== null && typeof (input as { url?: unknown }).url === "string"
        ? (input as { url: string }).url
        : String(input);
  const url = new URL(raw, "http://history-stub.invalid");
  return url.pathname + url.search;
}

/** Install a globalThis.fetch stub for /api/history/*; returns a recorder and a restore fn. Unknown paths reject with an Error naming the path. Honours AbortSignal. */
export function installHistoryStub(routes: readonly StubRoute[]): {
  /** Every requested URL (path + query), in order. */ readonly calls: readonly string[];
  /** Currently in-flight request count (queue-cap assertions). */ readonly inFlight: () => number;
  /** Restore the original fetch. Idempotent. */ restore(): void;
} {
  const original = globalThis.fetch;
  const calls: string[] = [];
  let pending = 0;
  let restored = false;

  const stub = (input: unknown, init?: { readonly signal?: AbortSignal | null }): Promise<Response> => {
    const target = pathAndQuery(input);
    calls.push(target);
    const path = target.split("?")[0] ?? target;
    const signal = init?.signal
      ?? (typeof input === "object" && input !== null ? (input as { signal?: AbortSignal | null }).signal ?? null : null);

    // Longest matching prefix wins, so a specific route can shadow a generic one.
    let route: StubRoute | undefined;
    for (const r of routes) {
      if (path.startsWith(r.path) && (route === undefined || r.path.length > route.path.length)) route = r;
    }

    if (signal?.aborted === true) return Promise.reject(abortError());
    if (route === undefined) return Promise.reject(new Error(`installHistoryStub: no route for ${target}`));

    const matched = route;
    pending++;
    return new Promise<Response>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let done = false;
      const settle = (fn: () => void): void => {
        if (done) return;
        done = true;
        pending--;
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = (): void => settle(() => reject(abortError()));
      const reply = (): void => settle(() => {
        const r = matched.reply;
        if ("network" in r) {
          reject(new TypeError(`installHistoryStub: network failure for ${target}`));
          return;
        }
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (r.retryAfter !== undefined) headers["retry-after"] = String(r.retryAfter);
        resolve(new Response(JSON.stringify(r.body), { status: r.status, headers }));
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (matched.delayMs !== undefined && matched.delayMs > 0) {
        timer = setTimeout(reply, matched.delayMs);
      } else {
        queueMicrotask(reply);
      }
    });
  };

  globalThis.fetch = stub as unknown as typeof fetch;

  return {
    calls,
    inFlight: () => pending,
    restore(): void {
      if (restored) return;
      restored = true;
      globalThis.fetch = original;
    },
  };
}
