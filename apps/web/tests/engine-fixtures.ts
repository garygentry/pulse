// apps/web/tests/engine-fixtures.ts — shared engine fixtures (08 §2.1).
//
// Consumed by the engine model/verdict unit tests, the engine DOM tests and the browser fixture
// pages, which BUNDLE this file for Chromium. It therefore has type-only wire imports and no
// Node/Bun API, and no runtime import from @pulse/web-data.
//
// allGreen mirrors what the M1 fold emits for a healthy engine (00 §2.3, fold-engine.ts): vmalert
// and gatus carry `version: null`, grafana and web carry `uptimeSeconds: null`. It rolls up to
// `{ kind: "ok" }` under 03 §3.4.

import type {
  CycleObservation, DataAvailability, EngineComponent, EnginePayload, HealthState, HostStatus,
  OverviewSnapshotV2, RuleGroupState, RuleState, ScrapeJobState, SourceId, SourceObservation,
  ViewDeliveryState,
} from "@pulse/web-data/wire";

/** Deep-partial override helper; arrays replace, objects merge. */
export type Overrides<T> = { readonly [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? Overrides<T[K]> : T[K] };

/** Fixed clock for every engine fixture: 2026-09-24T12:00:00Z. */
export const ENGINE_NOW_ISO = "2026-09-24T12:00:00.000Z";

const NOW_MS = Date.parse(ENGINE_NOW_ISO);
/** Five minutes before ENGINE_NOW_ISO: the last-good time of every outage fixture. */
const FIVE_MIN_AGO_ISO = new Date(NOW_MS - 5 * 60_000).toISOString();
const SCRAPED_AT_ISO = new Date(NOW_MS - 15_000).toISOString();
const EVALUATED_AT_ISO = new Date(NOW_MS - 30_000).toISOString();

type ScrapeTarget = ScrapeJobState["targets"][number];
type ComponentId = EngineComponent["id"];

const SOURCE_IDS: readonly SourceId[] = [
  "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
  "alertmanager-alerts", "alertmanager-silences", "alertmanager-status",
  "alertmanager-receivers", "vmalert-rules", "gatus-statuses", "grafana-health",
];

/** Fixed display order of the six engine components (wire/engine.ts). */
const COMPONENT_IDS: readonly ComponentId[] = ["victoriametrics", "vmalert", "alertmanager", "gatus", "grafana", "web"];

/** Governing source of each component, as fold-engine.ts assigns it. */
const COMPONENT_SOURCE: Readonly<Record<ComponentId, DataAvailability["source"]>> = {
  victoriametrics: "victoriametrics-signals",
  vmalert: "vmalert-rules",
  alertmanager: "alertmanager-alerts",
  gatus: "gatus-statuses",
  grafana: "grafana-health",
  web: "rendered-estate",
};

/** Default version/uptime per component; nulls mirror the M1 fold (00 §2.3). */
const COMPONENT_DEFAULTS: Readonly<Record<ComponentId, { readonly version: string | null; readonly uptimeSeconds: number | null }>> = {
  victoriametrics: { version: "v1.102.1", uptimeSeconds: 864_000 },
  vmalert: { version: null, uptimeSeconds: 863_500 },
  alertmanager: { version: "0.27.0", uptimeSeconds: 432_000 },
  gatus: { version: null, uptimeSeconds: 250_000 },
  grafana: { version: "11.2.0", uptimeSeconds: null },
  web: { version: "0.1.0", uptimeSeconds: null },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Apply an Overrides<T>: plain objects merge recursively, everything else (arrays, null) replaces. */
function merge<T>(base: T, o: Overrides<T> | undefined): T {
  if (o === undefined) return base;
  if (!isPlainObject(base)) return o as unknown as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (v === undefined) continue;
    const b = out[k];
    out[k] = isPlainObject(v) && isPlainObject(b) ? merge(b, v as Overrides<typeof b>) : v;
  }
  return out as T;
}

function available(source: DataAvailability["source"], state: DataAvailability["state"] = "current"): DataAvailability {
  if (state === "current") return { state, source, lastGoodAt: ENGINE_NOW_ISO, message: null };
  if (state === "not-configured") return { state, source, lastGoodAt: null, message: null };
  return { state, source, lastGoodAt: FIVE_MIN_AGO_ISO, message: "The upstream source could not be reached." };
}

function target(job: string, instance: string, health: ScrapeTarget["health"] = "up", lastError: string | null = null): ScrapeTarget {
  return {
    job, instance, scrapeUrl: `http://${instance}/metrics`, health,
    lastScrapeAt: SCRAPED_AT_ISO, lastError: health === "down" && lastError === null ? "connection refused" : lastError,
  };
}

function scrapeJob(job: string, instances: readonly string[]): ScrapeJobState {
  return { job, targets: instances.map((i) => target(job, i)), state: "healthy" };
}

function rule(group: string, name: string, o: Partial<RuleState> = {}): RuleState {
  return {
    group, family: group, name, state: "inactive", health: "healthy",
    lastEvaluationAt: EVALUATED_AT_ISO, lastError: null, deadman: false, ...o,
  };
}

function ruleGroup(group: string, rules: readonly RuleState[]): RuleGroupState {
  return { group, health: "healthy", lastEvaluationAt: EVALUATED_AT_ISO, rules };
}

/** Default hosts of the all-green scrape jobs; also the default snapshot hosts (for scrape-match). */
const DEFAULT_HOSTS: readonly { readonly name: string; readonly address: string }[] = [
  { name: "web01", address: "10.0.0.11" },
  { name: "web02", address: "10.0.0.12" },
  { name: "db01", address: "10.0.0.21" },
  { name: "nas01", address: "10.0.0.31" },
];

/** One component in a given state; availability current unless overridden. */
export function makeComponent(id: ComponentId, o?: Overrides<EngineComponent>): EngineComponent {
  const d = COMPONENT_DEFAULTS[id] ?? { version: null, uptimeSeconds: null };
  const base: EngineComponent = {
    id, state: "healthy", version: d.version, uptimeSeconds: d.uptimeSeconds,
    availability: available(COMPONENT_SOURCE[id] ?? "rendered-estate"),
  };
  return merge(base, o);
}

/** A fully healthy engine payload: six components (Grafana configured), 3 jobs × 4 targets up,
 *  4 rule groups healthy incl. one deadman rule, zero notification failures, capacity populated. */
export function makeEnginePayload(o?: Overrides<EnginePayload>): EnginePayload {
  const hosts = DEFAULT_HOSTS;
  const base: EnginePayload = {
    generatedAt: ENGINE_NOW_ISO,
    components: COMPONENT_IDS.map((id) => makeComponent(id)),
    scrapeJobs: [
      scrapeJob("node", hosts.map((h) => `${h.name}:9100`)),
      scrapeJob("pulse-engine", ["vm:8428", "vmalert:8880", "alertmanager:9093", "gatus:8080"]),
      scrapeJob("smartctl", hosts.map((h) => `${h.address}:9633`)),
    ],
    ruleGroups: [
      ruleGroup("pulse-deadman", [rule("pulse-deadman", "DeadMansSwitch", { state: "firing", deadman: true })]),
      ruleGroup("pulse-engine", [rule("pulse-engine", "AlertmanagerDown"), rule("pulse-engine", "VmalertDown")]),
      ruleGroup("pulse-hosts", [rule("pulse-hosts", "HostDiskFull"), rule("pulse-hosts", "HostDown"), rule("pulse-hosts", "HostHighLoad")]),
      ruleGroup("pulse-services", [rule("pulse-services", "EndpointDown"), rule("pulse-services", "ServiceUnhealthy")]),
    ],
    notifications: {
      failuresPerSecond: { email: 0, slack: 0, webhook: 0 },
      latencyP95Seconds: { email: 0.42, slack: 0.18, webhook: 0.05 },
      availability: available("victoriametrics-signals"),
    },
    capacity: {
      ingestionRowsPerSecond: 1_250,
      hourlyActiveSeries: 48_000,
      dataBytes: 12_884_901_888,
      freeDiskBytes: 214_748_364_800,
      availability: available("victoriametrics-signals"),
    },
    cycle: { sequence: 4_321, durationMs: 180, degraded: false, buildFailure: null },
    deadman: {
      configured: true, state: "healthy", lastEvaluationAt: EVALUATED_AT_ISO,
      availability: available("vmalert-rules"),
    },
  };
  return merge(base, o);
}

/** A CycleObservation with every SourceId "current" (override per source). */
export function makeObservation(o?: { readonly sources?: Partial<Record<SourceId, CycleObservation["sources"][SourceId]["state"]>>; readonly generation?: string }): CycleObservation {
  const sources = {} as Record<SourceId, SourceObservation>;
  for (const id of SOURCE_IDS) {
    const state = o?.sources?.[id] ?? "current";
    sources[id] = {
      state,
      lastAttemptAt: state === "not-configured" ? null : ENGINE_NOW_ISO,
      lastSuccess: state === "current" ? ENGINE_NOW_ISO : state === "not-configured" ? null : FIVE_MIN_AGO_ISO,
    };
  }
  return {
    generation: o?.generation ?? "00000000-0000-4000-8000-00000000e001",
    seq: 4_321,
    observedAt: ENGINE_NOW_ISO,
    appVersion: "0.1.0",
    sources,
  };
}

function snapshotHost(name: string, address: string): HostStatus {
  const evidence = { status: "ok" as const, availability: available("rendered-estate") };
  return {
    name, collectionClass: "managed-linux", addresses: [address], drilldownId: `host:${name}`,
    suppressed: null, status: "ok", statusEvidence: evidence, rollup: "ok", rollupEvidence: evidence,
    live: true, activeAlerts: [], checks: [], grafana: null, services: [],
  };
}

/** A minimal OverviewSnapshotV2 whose engine summary and generatedAt are controllable. */
export function makeEngineSnapshot(o?: { readonly engineOk?: boolean | null; readonly generatedAt?: string; readonly hosts?: OverviewSnapshotV2["hosts"] }): OverviewSnapshotV2 {
  const engineOk = o?.engineOk === undefined ? true : o.engineOk;
  const engine: OverviewSnapshotV2["engine"] = engineOk === null
    ? { availability: available("victoriametrics-targets", "unavailable"), value: null }
    : { availability: available("victoriametrics-signals"), value: { ok: engineOk } };
  const sourceOk = { ok: true, lastSuccess: ENGINE_NOW_ISO, error: null };
  return {
    appVersion: "0.1.0",
    generatedAt: o?.generatedAt ?? ENGINE_NOW_ISO,
    estate: { name: "Test estate", timezone: "America/Chicago", tzFallback: false },
    sources: { metrics: sourceOk, alerts: sourceOk, checks: sourceOk },
    hosts: o?.hosts ?? DEFAULT_HOSTS.map((h) => snapshotHost(h.name, h.address)),
    alerts: [],
    signals: [],
    recentChecks: [],
    engine,
    alertCounts: { firing: 0, silenced: 0, inhibited: 0 },
    coverage: { availability: available("rendered-estate"), value: { covered: DEFAULT_HOSTS.length, gaps: 0, extras: 0 } },
  };
}

/** Delivery state helper. */
export function delivery(phase: ViewDeliveryState["phase"]): ViewDeliveryState {
  return { phase, identity: phase === "initial" ? null : "sha256:0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e", failure: null };
}

/** Parametric degraded payload (used by `04` §16). Defaults: vmalert "unhealthy", 2 down targets in
 *  one scrape job, deadman not configured. */
export function degradedEngine(o?: {
  /** State of the vmalert component. */ readonly vmalert?: HealthState;
  /** Down targets in one scrape job. */ readonly downTargets?: number;
  /** Whether a deadman rule is configured. */ readonly deadmanConfigured?: boolean;
}): EnginePayload {
  const vmalert = o?.vmalert ?? "unhealthy";
  const downTargets = Math.max(0, Math.trunc(o?.downTargets ?? 2));
  const deadmanConfigured = o?.deadmanConfigured ?? false;
  const base = makeEnginePayload();

  const components = base.components.map((c) => c.id === "vmalert" ? { ...c, state: vmalert } : c);

  // Down targets all land in the first job ("node"), grown when it has fewer targets than asked.
  const [first, ...rest] = base.scrapeJobs;
  const nodeTargets: ScrapeTarget[] = [...(first?.targets ?? [])];
  for (let i = nodeTargets.length; i < downTargets; i++) nodeTargets.push(target("node", `node-extra-${i + 1}:9100`));
  const degradedTargets = nodeTargets.map((t, i) => i < downTargets ? { ...t, health: "down" as const, lastError: "connection refused" } : t);
  const scrapeJobs: ScrapeJobState[] = [
    { job: first?.job ?? "node", targets: degradedTargets, state: downTargets > 0 ? "unhealthy" : "healthy" },
    ...rest,
  ];

  const ruleGroups = deadmanConfigured
    ? base.ruleGroups
    : base.ruleGroups.map((g) => ({ ...g, rules: g.rules.map((r) => ({ ...r, deadman: false })) }));
  const deadman: EnginePayload["deadman"] = deadmanConfigured
    ? base.deadman
    : { configured: false, state: "not-configured", lastEvaluationAt: null, availability: base.deadman.availability };

  return { ...base, components, scrapeJobs, ruleGroups, deadman };
}

/** Every availability "unavailable" with lastGoodAt 5 min ago; values last-known. The `web`
 *  component stays current: it is governed by the rendered estate, which the fold always emits
 *  current (fold-engine.ts). */
function sourceOutage(): EnginePayload {
  const base = makeEnginePayload();
  const down = (a: DataAvailability): DataAvailability => available(a.source, "unavailable");
  return {
    ...base,
    components: base.components.map((c) => c.id === "web" ? c : { ...c, state: "unhealthy", availability: down(c.availability) }),
    scrapeJobs: base.scrapeJobs.map((j) => ({ ...j, state: "unknown" })),
    ruleGroups: base.ruleGroups.map((g) => ({ ...g, health: "unknown" })),
    notifications: { ...base.notifications, availability: down(base.notifications.availability) },
    capacity: { ...base.capacity, availability: down(base.capacity.availability) },
    cycle: { ...base.cycle, degraded: true },
    deadman: { ...base.deadman, state: "unknown", availability: down(base.deadman.availability) },
  };
}

/** Envelope: 25 jobs × 20 targets = 500 targets, 60 rule groups × 5 rules (REQ-SCALE-02). */
function envelope(): EnginePayload {
  const scrapeJobs: ScrapeJobState[] = [];
  for (let j = 0; j < 25; j++) {
    const job = `job-${String(j + 1).padStart(2, "0")}`;
    const instances: string[] = [];
    for (let t = 0; t < 20; t++) instances.push(`host-${String(j * 20 + t + 1).padStart(3, "0")}:9100`);
    scrapeJobs.push(scrapeJob(job, instances));
  }
  const ruleGroups: RuleGroupState[] = [];
  for (let g = 0; g < 60; g++) {
    const group = `group-${String(g + 1).padStart(2, "0")}`;
    const rules: RuleState[] = [];
    for (let r = 0; r < 5; r++) {
      rules.push(rule(group, `Rule${String(r + 1).padStart(2, "0")}`, g === 0 && r === 0 ? { state: "firing", deadman: true } : {}));
    }
    ruleGroups.push(ruleGroup(group, rules));
  }
  return { ...makeEnginePayload(), scrapeJobs, ruleGroups };
}

/** Markup-bearing strings in lastError / rule names / job names (REQ-SEC-02). */
function hostileStrings(): EnginePayload {
  const img = "<img src=x onerror=alert(1)>";
  const bold = "<b>x</b>";
  const job = `node ${bold}`;
  const group = `group ${img}`;
  return makeEnginePayload({
    scrapeJobs: [{
      job,
      state: "unhealthy",
      targets: [
        { ...target(job, "web01:9100"), health: "down", lastError: `dial tcp: ${img} ${bold}` },
        target(job, "web02:9100"),
      ],
    }],
    ruleGroups: [
      ruleGroup("pulse-deadman", [rule("pulse-deadman", "DeadMansSwitch", { state: "firing", deadman: true })]),
      {
        group, health: "unhealthy", lastEvaluationAt: EVALUATED_AT_ISO,
        rules: [rule(group, `Rule ${bold}`, { health: "unhealthy", lastError: `eval failed: ${img}` }), rule(group, img)],
      },
    ],
  });
}

/** Named scenarios used by DOM and browser tests (Success Criteria 2, 3). */
export const ENGINE_SCENARIOS: {
  readonly allGreen: () => EnginePayload;
  /** `degradedEngine({ vmalert: "unhealthy", downTargets: 2, deadmanConfigured: false })`. */
  readonly degraded: () => EnginePayload;
  /** Every availability "unavailable" with lastGoodAt 5 min ago; values last-known. */
  readonly sourceOutage: () => EnginePayload;
  /** Envelope: 500 scrape targets across 25 jobs, 60 rule groups (REQ-SCALE-02). */
  readonly envelope: () => EnginePayload;
  /** Markup-bearing strings in lastError / rule names / job names (REQ-SEC-02). */
  readonly hostileStrings: () => EnginePayload;
} = {
  allGreen: () => makeEnginePayload(),
  degraded: () => degradedEngine({ vmalert: "unhealthy", downTargets: 2, deadmanConfigured: false }),
  sourceOutage,
  envelope,
  hostileStrings,
};

/** Aliases used by `03` §7 examples. */
export const okEngine = ENGINE_SCENARIOS.allGreen;
export const currentObservation = (): CycleObservation => makeObservation();

/** Build an out-of-contract payload from a loosely typed mutation of the all-green payload. */
function outOfContract(mutate: (p: Record<string, unknown> & EnginePayload) => unknown): EnginePayload {
  return mutate(makeEnginePayload() as Record<string, unknown> & EnginePayload) as unknown as EnginePayload;
}

/** Cast-built payloads outside the wire contract (03 §6 no-throw obligation). At least: empty
 *  `components`; missing component id; duplicate component id; unknown `HealthState` string;
 *  non-finite `uptimeSeconds`; NaN capacity values; negative counts; NaN in `failuresPerSecond`;
 *  unparseable `lastGoodAt`, `lastEvaluationAt` and `generatedAt`; a scrape job with zero targets. */
export const ENGINE_OUT_OF_CONTRACT: readonly { readonly name: string; readonly payload: EnginePayload }[] = [
  { name: "empty components", payload: outOfContract((p) => ({ ...p, components: [] })) },
  {
    name: "missing component id",
    payload: outOfContract((p) => ({ ...p, components: p.components.map((c, i) => {
      if (i !== 1) return c;
      const { id: _id, ...rest } = c;
      return rest;
    }) })),
  },
  {
    name: "duplicate component id",
    payload: outOfContract((p) => ({ ...p, components: [...p.components, makeComponent("vmalert", { state: "unhealthy" })] })),
  },
  {
    name: "unknown HealthState",
    payload: outOfContract((p) => ({
      ...p,
      components: p.components.map((c) => c.id === "alertmanager" ? { ...c, state: "exploded" } : c),
      scrapeJobs: p.scrapeJobs.map((j, i) => i === 0 ? { ...j, state: "sideways", targets: j.targets.map((t, k) => k === 0 ? { ...t, health: "wobbly" } : t) } : j),
      ruleGroups: p.ruleGroups.map((g, i) => i === 1 ? { ...g, health: "confused" } : g),
      deadman: { ...p.deadman, state: "zombie" },
    })),
  },
  {
    name: "non-finite uptimeSeconds",
    payload: outOfContract((p) => ({ ...p, components: p.components.map((c, i) => i === 0 ? { ...c, uptimeSeconds: Infinity } : i === 2 ? { ...c, uptimeSeconds: NaN } : i === 3 ? { ...c, uptimeSeconds: -Infinity } : c) })),
  },
  {
    name: "NaN capacity values",
    payload: outOfContract((p) => ({ ...p, capacity: { ...p.capacity, ingestionRowsPerSecond: NaN, hourlyActiveSeries: NaN, dataBytes: Infinity, freeDiskBytes: NaN } })),
  },
  {
    name: "negative counts",
    payload: outOfContract((p) => ({
      ...p,
      components: p.components.map((c, i) => i === 0 ? { ...c, uptimeSeconds: -5 } : c),
      capacity: { ...p.capacity, ingestionRowsPerSecond: -1, hourlyActiveSeries: -48_000, dataBytes: -1, freeDiskBytes: -1 },
      notifications: { ...p.notifications, failuresPerSecond: { email: -1, slack: -0.5 }, latencyP95Seconds: { email: -2 } },
      cycle: { ...p.cycle, sequence: -1, durationMs: -180 },
    })),
  },
  {
    name: "NaN failuresPerSecond",
    payload: outOfContract((p) => ({ ...p, notifications: { ...p.notifications, failuresPerSecond: { email: NaN, slack: Infinity, webhook: 0 }, latencyP95Seconds: { email: NaN } } })),
  },
  {
    name: "unparseable lastGoodAt",
    payload: outOfContract((p) => ({
      ...p,
      components: p.components.map((c) => ({ ...c, state: "unhealthy", availability: { ...c.availability, state: "stale", lastGoodAt: "not-a-date" } })),
      notifications: { ...p.notifications, availability: { ...p.notifications.availability, state: "stale", lastGoodAt: "yesterday-ish" } },
    })),
  },
  {
    name: "unparseable lastEvaluationAt",
    payload: outOfContract((p) => ({
      ...p,
      ruleGroups: p.ruleGroups.map((g) => ({ ...g, lastEvaluationAt: "not-a-date", rules: g.rules.map((r) => ({ ...r, lastEvaluationAt: "2026-13-45T99:99:99Z" })) })),
      deadman: { ...p.deadman, lastEvaluationAt: "garbage" },
      scrapeJobs: p.scrapeJobs.map((j) => ({ ...j, targets: j.targets.map((t) => ({ ...t, lastScrapeAt: "garbage" })) })),
    })),
  },
  { name: "unparseable generatedAt", payload: outOfContract((p) => ({ ...p, generatedAt: "not-a-date" })) },
  {
    name: "scrape job with zero targets",
    payload: outOfContract((p) => ({ ...p, scrapeJobs: [{ job: "empty-job", targets: [], state: "healthy" }, ...p.scrapeJobs] })),
  },
];
