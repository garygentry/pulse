// src/client/views/engine/model.ts — the engine view's store readers and pure selectors.
//
// The ONLY module in views/engine/** that reads `store.*.value`. Every other engine module takes
// the narrowed wire values these readers return. This module imports no local runtime module: it
// is the root of the engine view's module graph (verdict.ts and labels.ts import from here).
// Every export is pure and total — no function throws on any wire value, in contract or not.

import type { AppStore } from "../../store/index.js";
import type { ConnectionPhase } from "../../store/types.js";
import type {
  AvailabilityState,
  CycleObservation,
  DataAvailability,
  EngineCapacityState,
  EngineComponent,
  EngineNotificationState,
  EnginePayload,
  OverviewSnapshotV2,
  RuleGroupState,
  RuleState,
  ScrapeJobState,
  ViewDeliveryState,
} from "@pulse/web-data/wire";

// ---------------------------------------------------------------------------
// Shared row types
// ---------------------------------------------------------------------------

/** Up/down/unknown target counts for one scrape job (REQ-SCRAPE-01). */
export interface ScrapeCounts {
  /** Targets with health "up". */ readonly up: number;
  /** Targets with health "down". */ readonly down: number;
  /** Targets with health "unknown". */ readonly unknown: number;
}

/** One scrape job prepared for rendering (REQ-SCRAPE-01..04). */
export interface ScrapeJobRow {
  /** The wire job. */ readonly job: ScrapeJobState;
  /** Target counts. */ readonly counts: ScrapeCounts;
  /** True when any target is not "up" or the job state is not "healthy" (problem-first, expanded). */ readonly problem: boolean;
  /** Effective health: "unknown" whenever discovery is not current (REQ-SCRAPE-04), else the wire state. */ readonly effectiveState: ScrapeJobState["state"];
}

/**
 * One scrape target, derived from the wire job type. `ScrapeTargetState` is not exported by
 * `@pulse/web-data/wire` (CON-01 freezes the barrel), so views name the element type locally.
 */
export type ScrapeTarget = ScrapeJobState["targets"][number];

/** One rule group prepared for rendering (REQ-RULE-01/02). */
export interface RuleGroupRow {
  /** The wire group. */ readonly group: RuleGroupState;
  /** True when `health !== "healthy"` (problem-first, expanded). */ readonly problem: boolean;
}

// ---------------------------------------------------------------------------
// Store readers (REQ-EFRESH-03)
// ---------------------------------------------------------------------------

/** Fallback delivery state when the `views` record lacks an `engine` entry (defensive). */
const INITIAL_DELIVERY: ViewDeliveryState = Object.freeze({ phase: "initial", identity: null, failure: null });

/**
 * Current engine payload, or null before the first accepted `/api/engine` body.
 * @param store - The application store.
 * @returns `store.engine.value` as the frozen wire type.
 */
export function readEngine(store: AppStore): EnginePayload | null {
  return store.engine.value;
}

/**
 * Engine view delivery state (`store.connection.value.views.engine`). Distinguishes Loading
 * (`phase: "initial"`) from Unknown in the verdict roll-up (REQ-EFRESH-03).
 * @param store - The application store.
 * @returns The engine view's delivery state; `{ phase: "initial", identity: null }` when the
 *   `views` record lacks an `engine` entry.
 */
export function readEngineDelivery(store: AppStore): ViewDeliveryState {
  return (store.connection.value.views as Partial<Record<string, ViewDeliveryState>>)["engine"] ?? INITIAL_DELIVERY;
}

/**
 * Current overview snapshot, or null before bootstrap. Model-structure data only (addresses,
 * Grafana URLs, estate zone), plus the same-cycle engine summary for the verdict guard.
 * @param store - The application store.
 */
export function readSnapshot(store: AppStore): OverviewSnapshotV2 | null {
  return store.snapshot.value;
}

/**
 * Latest accepted cycle observation, or null before the first. Supplies the per-source states for
 * the REQ-VERDICT-03 guard and scrape discovery.
 * @param store - The application store.
 */
export function readObservation(store: AppStore): CycleObservation | null {
  return store.connection.value.observation;
}

/**
 * Epoch ms of the transport's last valid 200/304 contact, for the Unknown banner's "since".
 * @param store - The application store.
 */
export function readLastGoodAt(store: AppStore): number | null {
  return store.connection.value.lastGoodAt;
}

/**
 * The control channel's live-data phase. Passed as a plain value to `useNotCurrent`, which may not
 * read the store itself.
 * @param store - The application store.
 */
export function readConnectionPhase(store: AppStore): ConnectionPhase {
  return store.connection.value.phase;
}

// ---------------------------------------------------------------------------
// Same-cycle overview engine summary (REQ-VERDICT-03)
// ---------------------------------------------------------------------------

/**
 * Project the snapshot into the verdict's `overviewEngine` input shape. Only the roll-up decides
 * whether it is same-cycle (generatedAt equality).
 * @param snapshot - The overview snapshot, or null before bootstrap.
 * @returns `{ section, generatedAt }`, or null when the snapshot is null.
 */
export function overviewEngineOf(
  snapshot: OverviewSnapshotV2 | null,
): { readonly section: OverviewSnapshotV2["engine"]; readonly generatedAt: string } | null {
  if (snapshot === null) return null;
  return { section: snapshot.engine, generatedAt: snapshot.generatedAt };
}

// ---------------------------------------------------------------------------
// Scrape discovery and job rows (REQ-SCRAPE-01..04, REQ-EFRESH-02, REQ-DEGRADE-01)
// ---------------------------------------------------------------------------

/** Currency of VictoriaMetrics target discovery (REQ-SCRAPE-04). */
export interface ScrapeDiscovery {
  /** True only when discovery is current by both the observation and the job/component heuristic. */
  readonly current: boolean;
  /**
   * Discovery availability, synthesized for the section's source-named degraded badge
   * (REQ-DEGRADE-01). `source` is always "victoriametrics-targets"; `message` is always null.
   */
  readonly availability: DataAvailability;
}

function findComponent(engine: EnginePayload, id: EngineComponent["id"]): EngineComponent | undefined {
  return engine.components.find((c) => c.id === id);
}

/**
 * Decide whether scrape-target discovery is current. Not current when EITHER the observation's
 * `victoriametrics-targets` source is not current (a missing entry counts as "unavailable"), OR
 * some job reads unknown while the `victoriametrics` component is not current (a missing
 * component counts as not current). Conservative: it can only turn jobs unknown, never healthy.
 * @param engine - The current engine payload.
 * @param observation - The latest cycle observation, or null.
 * @returns Discovery currency and a synthesized availability.
 */
export function scrapeDiscovery(
  engine: EnginePayload,
  observation: CycleObservation | null,
): ScrapeDiscovery {
  const targetsObs = observation === null
    ? undefined
    : (observation.sources as Partial<CycleObservation["sources"]>)["victoriametrics-targets"];
  const observedState: AvailabilityState | undefined = observation === null
    ? undefined
    : targetsObs?.state ?? "unavailable";

  const vm = findComponent(engine, "victoriametrics");
  const vmState: AvailabilityState = vm?.availability.state ?? "unavailable";
  const heuristic = vmState !== "current" && engine.scrapeJobs.some((j) => j.state === "unknown");

  const candidates: readonly (AvailabilityState | undefined)[] = [observedState, heuristic ? vmState : "current"];
  const state: AvailabilityState = candidates.find((s): s is AvailabilityState => s !== undefined && s !== "current") ?? "current";

  const lastGoodAt = targetsObs?.lastSuccess ?? vm?.availability.lastGoodAt ?? null;
  return {
    current: state === "current",
    availability: { state, source: "victoriametrics-targets", lastGoodAt, message: null },
  };
}

/**
 * Count targets by health (REQ-SCRAPE-01). An out-of-contract `health` string counts as unknown.
 * @param targets - The job's targets.
 */
export function scrapeCounts(targets: readonly ScrapeTarget[]): ScrapeCounts {
  let up = 0;
  let down = 0;
  let unknown = 0;
  for (const t of targets) {
    if (t.health === "up") up += 1;
    else if (t.health === "down") down += 1;
    else unknown += 1;
  }
  return { up, down, unknown };
}

/** Stable problem-first partition: two filters and a concat, never `Array.prototype.sort`. */
function problemFirst<Row extends { readonly problem: boolean }>(rows: readonly Row[]): readonly Row[] {
  return [...rows.filter((r) => r.problem), ...rows.filter((r) => !r.problem)];
}

/**
 * Prepare scrape jobs for rendering: counts, effective state, problem flag, problem-first order.
 * `effectiveState` is "unknown" when discovery is not current (REQ-SCRAPE-04); `problem` is
 * evaluated on `effectiveState`, so a job forced unknown is expanded. Wire order is kept within
 * each partition (REQ-SCRAPE-02).
 * @param jobs - `engine.scrapeJobs`.
 * @param discovery - From `scrapeDiscovery`.
 * @returns A new array; the input is not mutated.
 */
export function scrapeJobRows(
  jobs: readonly ScrapeJobState[],
  discovery: ScrapeDiscovery,
): readonly ScrapeJobRow[] {
  const rows = jobs.map((job): ScrapeJobRow => {
    const counts = scrapeCounts(job.targets);
    const effectiveState: ScrapeJobState["state"] = discovery.current ? job.state : "unknown";
    const problem = counts.down + counts.unknown > 0 || effectiveState !== "healthy";
    return { job, counts, problem, effectiveState };
  });
  return problemFirst(rows);
}

/** Render state of a list section (scrape jobs, rule groups). */
export type EngineSectionState = "rows" | "empty" | "unavailable";

/** A prepared list section with its governing availability. */
export interface EngineSection<Row> {
  /**
   * "rows": render `rows`. "empty": explicit empty state ("No scrape jobs reported" /
   * "No rule groups reported"). "unavailable": source-named degraded state with last good.
   */
  readonly state: EngineSectionState;
  /** Prepared rows (problem-first); empty unless `state === "rows"`. */
  readonly rows: readonly Row[];
  /** Governing availability; when not "current", the view shows the degraded badge even with rows. */
  readonly availability: DataAvailability;
}

/**
 * Scrape section: "rows" when any row exists, else "unavailable" when discovery is not current,
 * else "empty" (REQ-SCRAPE-01, REQ-DEGRADE-01).
 * @param engine - The current engine payload.
 * @param observation - The latest cycle observation, or null.
 */
export function scrapeSection(
  engine: EnginePayload,
  observation: CycleObservation | null,
): EngineSection<ScrapeJobRow> {
  const discovery = scrapeDiscovery(engine, observation);
  const rows = scrapeJobRows(engine.scrapeJobs, discovery);
  const state: EngineSectionState = rows.length > 0 ? "rows" : discovery.current ? "empty" : "unavailable";
  return { state, rows, availability: discovery.availability };
}

// ---------------------------------------------------------------------------
// Rule groups and the canary rule (REQ-RULE-01..03, REQ-DEADMAN-01)
// ---------------------------------------------------------------------------

/**
 * Prepare rule groups: `problem = group.health !== "healthy"`; problem-first stable partition over
 * the wire order.
 * @param groups - `engine.ruleGroups`.
 * @returns A new array; the input is not mutated.
 */
export function ruleGroupRows(groups: readonly RuleGroupState[]): readonly RuleGroupRow[] {
  return problemFirst(groups.map((group): RuleGroupRow => ({ group, problem: group.health !== "healthy" })));
}

/** Governing availability when the payload has no `vmalert` component. */
const MISSING_VMALERT: DataAvailability = Object.freeze({
  state: "unavailable", source: "vmalert-rules", lastGoodAt: null, message: null,
});

/**
 * Rule section. The governing availability is the `vmalert` component's (source "vmalert-rules").
 * "rows" when any group exists; else "unavailable" when that availability is not current; else
 * "empty".
 * @param engine - The current engine payload.
 */
export function ruleSection(engine: EnginePayload): EngineSection<RuleGroupRow> {
  const availability = findComponent(engine, "vmalert")?.availability ?? MISSING_VMALERT;
  const rows = ruleGroupRows(engine.ruleGroups);
  const state: EngineSectionState = rows.length > 0 ? "rows" : availability.state === "current" ? "empty" : "unavailable";
  return { state, rows, availability };
}

/**
 * The first rule with `deadman === true`, scanning groups then rules in wire order, or null. Used
 * by the deadman panel for the canary's last evaluation and health (REQ-DEADMAN-01).
 * @param engine - The current engine payload.
 */
export function canaryRule(engine: EnginePayload): RuleState | null {
  for (const g of engine.ruleGroups) for (const r of g.rules) if (r.deadman === true) return r;
  return null;
}

// ---------------------------------------------------------------------------
// Notification rows (REQ-NOTIFY-01, REQ-DEGRADE-01)
// ---------------------------------------------------------------------------

/** One tile value. Zero is `{ kind: "value", value: 0 }` and only when the payload says 0. */
export type TileValue =
  | { readonly kind: "value"; readonly value: number }
  | { readonly kind: "not-reported" }
  | { readonly kind: "unavailable" };

/** One integration's current notification values. */
export interface NotificationRow {
  /** Alertmanager integration key (plain text, from the wire map keys). */
  readonly integration: string;
  /** Recent failures per second. */
  readonly failuresPerSecond: TileValue;
  /** Recent p95 notification latency in seconds. */
  readonly latencyP95Seconds: TileValue;
}

/** The notification region. */
export interface NotificationSection {
  /** "rows": render `rows`; "none-reported": explicit "No notification integrations reported";
   *  "unavailable": source-named degraded state (no rows to show). */
  readonly state: "rows" | "none-reported" | "unavailable";
  /** Rows sorted by integration key (code-point order). */
  readonly rows: readonly NotificationRow[];
  /** `notifications.availability` (source "victoriametrics-signals"). */
  readonly availability: DataAvailability;
}

const NOT_REPORTED_TILE: TileValue = Object.freeze({ kind: "not-reported" });
const UNAVAILABLE_TILE: TileValue = Object.freeze({ kind: "unavailable" });

const codePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A finite number → value tile; anything else → not-reported. */
function numberTile(v: unknown): TileValue {
  return typeof v === "number" && Number.isFinite(v) ? { kind: "value", value: v } : NOT_REPORTED_TILE;
}

function mapCell(map: Readonly<Record<string, number>> | null, key: string): TileValue {
  if (map === null || !Object.prototype.hasOwnProperty.call(map, key)) return NOT_REPORTED_TILE;
  return numberTile(map[key]);
}

/**
 * Derive per-integration notification rows: the code-point-sorted union of both maps' keys.
 * Availability not current → every cell "unavailable"; else null map / missing key / non-finite
 * value → "not-reported"; else the value (zero included).
 * @param notifications - `engine.notifications`.
 */
export function notificationSection(notifications: EngineNotificationState): NotificationSection {
  const { failuresPerSecond: f, latencyP95Seconds: l, availability } = notifications;
  const keys = new Set<string>([...(f === null ? [] : Object.keys(f)), ...(l === null ? [] : Object.keys(l))]);
  const current = availability.state === "current";
  const rows = [...keys].sort(codePoint).map((integration): NotificationRow => ({
    integration,
    failuresPerSecond: current ? mapCell(f, integration) : UNAVAILABLE_TILE,
    latencyP95Seconds: current ? mapCell(l, integration) : UNAVAILABLE_TILE,
  }));
  const state: NotificationSection["state"] = rows.length > 0 ? "rows" : current ? "none-reported" : "unavailable";
  return { state, rows, availability };
}

// ---------------------------------------------------------------------------
// Capacity tiles (REQ-CAP-01, REQ-VERDICT-04)
// ---------------------------------------------------------------------------

/** Capacity tile ids in display order (REQ-CAP-01). */
export type CapacityTileId = "ingestion-rate" | "active-series" | "data-size" | "free-disk";

/** One capacity stat tile. No threshold, no status: capacity never drives state (REQ-VERDICT-04). */
export interface CapacityTile {
  /** Tile id; the display label is `CAPACITY_TILE_LABEL[id]` (labels.ts). */
  readonly id: CapacityTileId;
  /** Current value. */
  readonly value: TileValue;
}

/**
 * The four capacity tiles in fixed order. Availability not current → every tile "unavailable";
 * else null or non-finite → "not-reported"; else "value". No gauge and no derived fraction.
 * @param capacity - `engine.capacity`.
 */
export function capacityTiles(capacity: EngineCapacityState): readonly CapacityTile[] {
  const current = capacity.availability.state === "current";
  const tile = (id: CapacityTileId, v: number | null): CapacityTile => ({
    id, value: current ? numberTile(v) : UNAVAILABLE_TILE,
  });
  return [
    tile("ingestion-rate", capacity.ingestionRowsPerSecond),
    tile("active-series", capacity.hourlyActiveSeries),
    tile("data-size", capacity.dataBytes),
    tile("free-disk", capacity.freeDiskBytes),
  ];
}

// ---------------------------------------------------------------------------
// Grafana base (REQ-ELINK-01, REQ-SEC-03)
// ---------------------------------------------------------------------------

type GrafanaLink = { readonly boardUid: string; readonly url: string } | null | undefined;

/** Check one candidate; the base (no trailing slash, no query/hash) or null to skip it. */
function grafanaBaseOf(link: GrafanaLink): string | null {
  if (link === null || link === undefined || typeof link.url !== "string") return null;
  let u: URL;
  try {
    u = new URL(link.url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username !== "" || u.password !== "") return null;
  const i = u.pathname.lastIndexOf("/d/");
  if (i < 0) return null;
  const uid = u.pathname.slice(i + 3).split("/")[0];
  if (uid !== link.boardUid) return null;
  return (u.origin + u.pathname.slice(0, i)).replace(/\/+$/, "");
}

/**
 * Derive the Grafana base URL (origin plus any path prefix, no trailing slash) from the first
 * usable snapshot Grafana URL: each host's own link, then its services' links, in order. A
 * candidate is skipped when it does not parse, is not http(s), carries credentials, has no
 * `/d/<uid>` path, or its uid differs from the entry's `boardUid`.
 * @param snapshot - The overview snapshot, or null.
 * @returns The base, or null when the snapshot is null or no candidate passes.
 */
export function deriveGrafanaBase(snapshot: OverviewSnapshotV2 | null): string | null {
  if (snapshot === null) return null;
  for (const host of snapshot.hosts) {
    const own = grafanaBaseOf(host.grafana);
    if (own !== null) return own;
    for (const svc of host.services) {
      const base = grafanaBaseOf(svc.grafana);
      if (base !== null) return base;
    }
  }
  return null;
}
