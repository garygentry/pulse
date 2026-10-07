// src/client/views/timeline/model.ts — the timeline view's store readers, lane tree and host order.
//
// Module-graph ROOT (01 §4.4 rule 1): no relative runtime imports, only `import type` from the
// store. The ONLY module in views/timeline/** (outside history/) that reads `store.*.value`. Every
// export is pure and total — nothing here throws on any wire value (00 §8.1).

import type {
  CycleObservation,
  OverviewSnapshotV2,
  QueryId,
  RangeId,
  TargetIdentity,
  TimelineDomain,
  TimelinePayload,
  TimelineTarget,
  ViewDeliveryState,
} from "@pulse/web-data/wire";
import type { AppStore } from "../../store/index.js";
import type { ConnectionPhase } from "../../store/types.js";

// ---------------------------------------------------------------------------
// Lane tree types (00 §5.3)
// ---------------------------------------------------------------------------

/** One node in the lane tree (tech-spec §3.4, D1). */
export interface LaneNode {
  /** Canonical identity (drilldownId-based); the key for evidence, selection and links. */ readonly target: TargetIdentity;
  /** Display label (plain text). */ readonly label: string;
  /** Owning host name for services (for /estate links); null for hosts. */ readonly hostName: string | null;
  /** Host or service name (for /estate links). */ readonly name: string;
  /** Addressable Gatus endpoint keys (services only): endpoint targets whose index parent is this service, ∩ index.checkHistory.endpoints, sorted (09 §2). */ readonly endpoints: readonly string[];
  /** Curated query ids the timeline index advertises for this target; empty when absent from the index. */ readonly queryIds: readonly QueryId[];
  /** Server-resolved Grafana board URL for this target, or null. */ readonly grafanaUrl: string | null;
  /** Child service lanes (hosts only; empty for services). */ readonly children: readonly LaneNode[];
}

/** The whole lane hierarchy for the page. */
export interface LaneTree {
  /** Host lanes in model order (problem-first ordering is applied separately, REQ-LANE-05). */ readonly hosts: readonly LaneNode[];
  /** Estate-level DNS checks (09 §3): `index?.domains ?? []`, deduplicated by endpoint, in order. The Domains group is hidden when empty. */ readonly domains: readonly TimelineDomain[];
}

/** Stable string key for a TargetIdentity: `${kind}:${id}`. Used as Map keys and signal keys. */
export type TargetKey = `${TargetIdentity["kind"]}:${string}`;

// ---------------------------------------------------------------------------
// Store readers (05 §3.1)
// ---------------------------------------------------------------------------

/**
 * The current timeline index payload, or null before the first delivery. No re-validation
 * (the data tier owns wire validity; TS §3.1).
 * @param store - The application store.
 */
export function readTimeline(store: AppStore): TimelinePayload | null {
  return (store.timeline.value ?? null) as TimelinePayload | null;
}

/**
 * The timeline view's delivery state (`store.connection.value.views.timeline`); drives loading vs
 * not-current.
 * @param store - The application store.
 */
export function readTimelineDelivery(store: AppStore): ViewDeliveryState {
  return store.connection.value.views.timeline;
}

/**
 * The overview snapshot, read ONLY as model-structure data: hierarchy, Grafana URLs and estate zone
 * (TS §3.1).
 * @param store - The application store.
 */
export function readTimelineSnapshot(store: AppStore): OverviewSnapshotV2 | null {
  return (store.snapshot.value ?? null) as OverviewSnapshotV2 | null;
}

/**
 * Latest accepted cycle observation (`store.connection.value.observation`), or null before the
 * first. The view reads its `generation` as the `useHistory` key component (02 §7.2).
 * @param store - The application store.
 */
export function readTimelineObservation(store: AppStore): CycleObservation | null {
  return store.connection.value.observation ?? null;
}

/**
 * The control channel's live-data phase (`store.connection.value.phase`). Passed as a plain value
 * to `useNotCurrent` (02 §6.2), which may not read the store itself.
 * @param store - The application store.
 */
export function readTimelineConnectionPhase(store: AppStore): ConnectionPhase {
  return store.connection.value.phase;
}

// ---------------------------------------------------------------------------
// Identity and the lane tree (05 §3.2–§3.4)
// ---------------------------------------------------------------------------

/**
 * Stable string key for a target identity: `${kind}:${id}` (00 §5.3). Used as Map/Set keys and as
 * the `sel` URL value. Examples: {kind:"host", id:"host:web01"} → "host:host:web01";
 * {kind:"service", id:"svc:web01/nginx"} → "service:svc:web01/nginx".
 */
export function targetKey(target: TargetIdentity): TargetKey {
  return `${target.kind}:${target.id}` as TargetKey;
}

/**
 * Build the lane hierarchy from the overview snapshot (structure) and the timeline index
 * (query applicability and addressable check endpoints). Pure; never throws.
 *
 * - Hosts: one node per `snapshot.hosts[]`, in model order, including hosts absent from the index
 *   (`queryIds: []`).
 * - Services: nested under their host, in model order.
 * - Service endpoints (09 §2, REQ-ECR-C2): the ids of the index's endpoint targets whose `parent` is
 *   that service, also in `index.checkHistory.endpoints`, deduplicated and sorted ascending.
 * - Duplicate identities are skipped (first occurrence wins).
 * - Domains (09 §3, REQ-ECR-C3): `index.domains` deduplicated by endpoint (first wins), in order;
 *   [] with a null index.
 *
 * @param snapshot - The overview snapshot (model structure).
 * @param index - The timeline index, or null before its first delivery (then queryIds and endpoints are empty).
 * @returns The lane tree, hosts in model order.
 */
export function buildLaneTree(snapshot: OverviewSnapshotV2, index: TimelinePayload | null): LaneTree {
  const byKey = new Map<TargetKey, TimelineTarget>();
  for (const t of index?.targets ?? []) byKey.set(targetKey(t.target), t);
  const addressable = new Set<string>(index?.checkHistory.endpoints ?? []);
  const endpointsByService = new Map<string, Set<string>>();
  for (const t of index?.targets ?? []) {
    if (t.target.kind !== "endpoint" || t.parent?.kind !== "service" || !addressable.has(t.target.id)) continue;
    const set = endpointsByService.get(t.parent.id) ?? new Set<string>();
    set.add(t.target.id);
    endpointsByService.set(t.parent.id, set);
  }
  const seen = new Set<TargetKey>();
  const queryIdsOf = (target: TargetIdentity): readonly QueryId[] => byKey.get(targetKey(target))?.queryIds ?? [];

  const hosts: LaneNode[] = [];
  for (const host of snapshot.hosts) {
    const hostTarget: TargetIdentity = { kind: "host", id: host.drilldownId };
    const hostKey = targetKey(hostTarget);
    if (seen.has(hostKey)) continue; // defensive: first occurrence wins
    seen.add(hostKey);
    const children: LaneNode[] = [];
    for (const service of host.services) {
      const serviceTarget: TargetIdentity = { kind: "service", id: service.drilldownId };
      const serviceKey = targetKey(serviceTarget);
      if (seen.has(serviceKey)) continue;
      seen.add(serviceKey);
      const endpoints = [...(endpointsByService.get(service.drilldownId) ?? [])]
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      children.push({
        target: serviceTarget, label: service.name, hostName: service.host, name: service.name,
        endpoints, queryIds: queryIdsOf(serviceTarget), grafanaUrl: service.grafana?.url ?? null, children: [],
      });
    }
    hosts.push({
      target: hostTarget, label: host.name, hostName: null, name: host.name,
      endpoints: [], queryIds: queryIdsOf(hostTarget), grafanaUrl: host.grafana?.url ?? null, children,
    });
  }
  const domains: TimelineDomain[] = [];
  const seenEndpoints = new Set<string>();
  for (const d of index?.domains ?? []) {
    if (seenEndpoints.has(d.endpoint)) continue;
    seenEndpoints.add(d.endpoint);
    domains.push(d);
  }
  return { hosts, domains };
}

/** Per-tree TargetKey → LaneNode index; weakly held so a replaced tree is collected. */
const laneIndexCache = new WeakMap<LaneTree, ReadonlyMap<TargetKey, LaneNode>>();

/**
 * Find the node (host or service) with the given identity, or null. The first call per tree builds
 * a TargetKey → LaneNode index cached in a module-level WeakMap, so later calls are O(1). An
 * `endpoint` identity never matches. Never throws.
 */
export function findLane(tree: LaneTree, target: TargetIdentity): LaneNode | null {
  let index = laneIndexCache.get(tree);
  if (index === undefined) {
    const map = new Map<TargetKey, LaneNode>();
    for (const host of tree.hosts) {
      const hk = targetKey(host.target);
      if (!map.has(hk)) map.set(hk, host);
      for (const child of host.children) {
        const ck = targetKey(child.target);
        if (!map.has(ck)) map.set(ck, child);
      }
    }
    index = map;
    laneIndexCache.set(tree, index);
  }
  if (target.kind === "endpoint") return null;
  return index.get(targetKey(target)) ?? null;
}

// ---------------------------------------------------------------------------
// Problem-first host order (05 §3.5–§3.6, REQ-LANE-05)
// ---------------------------------------------------------------------------

/**
 * Stable partition: hosts whose key is in `problems` first, then the rest. Model order is kept
 * within each group. Pure; O(H).
 *
 * @param hosts - Host nodes in model order (`LaneTree.hosts`).
 * @param problems - Keys of hosts with any non-ok alert evidence in the range (`problemHostKeys`).
 * @returns A new array; `hosts` is not mutated.
 */
export function orderHosts(hosts: readonly LaneNode[], problems: ReadonlySet<TargetKey>): readonly LaneNode[] {
  const first: LaneNode[] = [];
  const rest: LaneNode[] = [];
  for (const h of hosts) (problems.has(targetKey(h.target)) ? first : rest).push(h);
  return first.concat(rest);
}

/** Inputs to one host-order evaluation. */
export interface HostOrderInput {
  /** The current lane tree (hosts in model order). */ readonly tree: LaneTree;
  /** Selected range (freeze-key part 1). */ readonly range: RangeId;
  /** Pause anchor in epoch seconds, or null when live (freeze-key part 2). */ readonly end: number | null;
  /** `fetchedAt` of the current READY alerts payload, or null while alerts are loading or failed (freeze-key part 3). */ readonly alertsFetchedAt: string | null;
  /** Lazily computes the problem-host set from the current alerts payload. Called only when the order is (re)computed. */ readonly problems: () => ReadonlySet<TargetKey>;
}

/** Stateful, per-mount host-order memo. */
export interface HostOrder {
  /** Current display order of host lanes. Identity is stable while neither the frozen order nor the tree changes. */
  order(input: HostOrderInput): readonly LaneNode[];
}

interface HostOrderState {
  /** Freeze key `${range}|${end ?? "live"}`; a change resets the frozen order. */
  freezeKey: string | null;
  /** The alerts `fetchedAt` that produced `frozen`, or null before the first load after a key change. */
  anchorFetchedAt: string | null;
  /** Host keys in frozen order, or null while nothing is frozen. */
  frozen: readonly TargetKey[] | null;
  /** The tree used to compute `lastResult`, for result identity. */
  lastTree: LaneTree | null;
  /** The `frozen` array used to compute `lastResult`, for identity reuse. */
  lastFrozen: readonly TargetKey[] | null;
  /** Last returned order; reused while `frozen` and `tree` are unchanged. */
  lastResult: readonly LaneNode[] | null;
}

/**
 * Create a host-order memo (one per TimelineView mount). The order is computed on the first ready
 * alerts payload after a (range, end) change and frozen across live refreshes (05 §3.6).
 */
export function createHostOrder(): HostOrder {
  const state: HostOrderState = {
    freezeKey: null, anchorFetchedAt: null, frozen: null, lastTree: null, lastFrozen: null, lastResult: null,
  };
  return {
    order(input: HostOrderInput): readonly LaneNode[] {
      // 1. A range change, pause or resume resets the frozen order.
      const fk = `${input.range}|${input.end ?? "live"}`;
      if (fk !== state.freezeKey) {
        state.freezeKey = fk;
        state.anchorFetchedAt = null;
        state.frozen = null;
      }
      // 2. The first ready alerts payload after the key change decides the order.
      if (state.anchorFetchedAt === null && input.alertsFetchedAt !== null) {
        state.anchorFetchedAt = input.alertsFetchedAt;
        state.frozen = orderHosts(input.tree.hosts, input.problems()).map((h) => targetKey(h.target));
      }
      // 3. Nothing frozen yet: model order.
      const frozen = state.frozen;
      if (frozen === null) return input.tree.hosts;
      // 4. Frozen: reconcile with the current tree, reusing the last result when nothing changed.
      if (state.lastResult !== null && state.lastTree === input.tree && state.lastFrozen === frozen) {
        return state.lastResult;
      }
      const byKey = new Map<TargetKey, LaneNode>();
      for (const h of input.tree.hosts) {
        const k = targetKey(h.target);
        if (!byKey.has(k)) byKey.set(k, h);
      }
      const placed = new Set<TargetKey>();
      const result: LaneNode[] = [];
      for (const k of frozen) {
        const node = byKey.get(k);
        if (node === undefined || placed.has(k)) continue;
        placed.add(k);
        result.push(node);
      }
      for (const h of input.tree.hosts) {
        const k = targetKey(h.target);
        if (placed.has(k)) continue;
        placed.add(k);
        result.push(h);
      }
      state.lastTree = input.tree;
      state.lastFrozen = frozen;
      state.lastResult = result;
      return result;
    },
  };
}
