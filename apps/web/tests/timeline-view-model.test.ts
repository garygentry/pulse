// Unit tests for views/timeline/model.ts: store readers, buildLaneTree, findLane, orderHosts and the
// frozen host-order memo (05 §3, 08 §3.3). Pure: no DOM.

import { describe, expect, test } from "bun:test";
import { signal } from "@preact/signals-core";

import type {
  CycleObservation,
  HostStatus,
  OverviewSnapshotV2,
  TimelinePayload,
  TimelineTarget,
  ViewDeliveryState,
} from "@pulse/web-data/wire";
import type { AppStore } from "../src/client/store/index.js";
import {
  buildLaneTree,
  createHostOrder,
  findLane,
  orderHosts,
  readTimeline,
  readTimelineConnectionPhase,
  readTimelineDelivery,
  readTimelineObservation,
  readTimelineSnapshot,
  targetKey,
} from "../src/client/views/timeline/model.js";
import type { HostOrderInput, LaneNode, LaneTree, TargetKey } from "../src/client/views/timeline/model.js";
import { makeHierarchySnapshot, makeTimelineIndex } from "./timeline-fixtures.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The 05 §3.3 worked-example snapshot, built over a valid fixture snapshot. */
function workedSnapshot(): OverviewSnapshotV2 {
  const base = makeHierarchySnapshot({ hosts: 2, servicesPerHost: 1 });
  const [h0, h1] = base.hosts as [HostStatus, HostStatus];
  const svc = h0.services[0]!;
  const web01: HostStatus = {
    ...h0,
    name: "web01",
    drilldownId: "host:web01",
    grafana: { boardUid: "pulse-host", url: "https://g/d/pulse-host?var-host=web01" },
    services: [{
      ...svc, name: "nginx", host: "web01", drilldownId: "svc:web01/nginx", grafana: null,
      checks: [{ endpoint: "web01/nginx", success: true, lastEvaluatedAt: "2026-09-24T12:00:00.000Z" }],
    }],
  };
  const db01: HostStatus = { ...h1, name: "db01", drilldownId: "host:db01", grafana: null, services: [] };
  return { ...base, hosts: [web01, db01] };
}

/** The 05 §3.3 worked-example index. */
function workedIndex(): TimelinePayload {
  return {
    generatedAt: "2026-09-24T12:00:00.000Z",
    targets: [{
      target: { kind: "host", id: "host:web01" }, name: "web01",
      queryIds: ["estate.liveness", "host.cpu.utilization", "host.memory.utilization"], ranges: ["1h", "6h", "24h", "7d"],
      parent: null,
    }, {
      target: { kind: "endpoint", id: "web01/nginx" }, name: "web01/nginx",
      queryIds: ["endpoint.check.latency"], ranges: ["1h", "6h", "24h"],
      parent: { kind: "service", id: "svc:web01/nginx" },
    }],
    alertHistory: { ranges: ["1h", "6h", "24h", "7d"], provenance: "vmalert" },
    checkHistory: { endpoints: ["web01/nginx"], provenance: "gatus" },
    domains: [],
  };
}

function hostKeys(nodes: readonly LaneNode[]): string[] {
  return nodes.map((n) => targetKey(n.target));
}

// ---------------------------------------------------------------------------
// Store readers
// ---------------------------------------------------------------------------

describe("store readers (05 §3.1)", () => {
  test("return the store values unchanged", () => {
    const snapshot = makeHierarchySnapshot({ hosts: 1, servicesPerHost: 1 });
    const index = makeTimelineIndex(snapshot);
    const delivery: ViewDeliveryState = { phase: "current", identity: null, failure: null };
    const observation = { generation: "g1" } as unknown as CycleObservation;
    const store = {
      timeline: signal<TimelinePayload | null>(index),
      snapshot: signal<OverviewSnapshotV2 | null>(snapshot),
      connection: signal({ phase: "live", observation, views: { timeline: delivery } }),
    } as unknown as AppStore;
    expect(readTimeline(store)).toBe(index);
    expect(readTimelineSnapshot(store)).toBe(snapshot);
    expect(readTimelineDelivery(store)).toBe(delivery);
    expect(readTimelineObservation(store)).toBe(observation);
    expect(readTimelineConnectionPhase(store)).toBe("live");
  });

  test("null payloads and a missing observation read as null", () => {
    const store = {
      timeline: signal(null),
      snapshot: signal(null),
      connection: signal({ phase: "initial", observation: null, views: { timeline: { phase: "initial", identity: null } } }),
    } as unknown as AppStore;
    expect(readTimeline(store)).toBeNull();
    expect(readTimelineSnapshot(store)).toBeNull();
    expect(readTimelineObservation(store)).toBeNull();
    expect(readTimelineConnectionPhase(store)).toBe("initial");
  });
});

// ---------------------------------------------------------------------------
// targetKey / buildLaneTree
// ---------------------------------------------------------------------------

describe("targetKey (05 §3.2)", () => {
  test("formats `${kind}:${id}`", () => {
    expect(targetKey({ kind: "host", id: "host:web01" })).toBe("host:host:web01");
    expect(targetKey({ kind: "service", id: "svc:web01/nginx" })).toBe("service:svc:web01/nginx");
  });
});

describe("buildLaneTree (05 §3.3)", () => {
  test("REQ-LANE-01: reproduces the 05 §3.3 worked example exactly", () => {
    expect(buildLaneTree(workedSnapshot(), workedIndex())).toEqual({
      domains: [],
      hosts: [
        {
          target: { kind: "host", id: "host:web01" }, label: "web01", name: "web01", hostName: null, endpoints: [],
          queryIds: ["estate.liveness", "host.cpu.utilization", "host.memory.utilization"],
          grafanaUrl: "https://g/d/pulse-host?var-host=web01",
          children: [{
            target: { kind: "service", id: "svc:web01/nginx" }, label: "nginx", name: "nginx", hostName: "web01",
            endpoints: ["web01/nginx"], queryIds: [], grafanaUrl: null, children: [],
          }],
        },
        {
          target: { kind: "host", id: "host:db01" }, label: "db01", name: "db01", hostName: null, endpoints: [],
          queryIds: [], grafanaUrl: null, children: [],
        },
      ],
    });
  });

  test("REQ-LANE-01: a host absent from the index is kept with queryIds []", () => {
    const snapshot = makeHierarchySnapshot({ hosts: 3, servicesPerHost: 1 });
    const tree = buildLaneTree(snapshot, makeTimelineIndex(snapshot, { omitHosts: ["host:host-002"] }));
    expect(hostKeys(tree.hosts)).toEqual(["host:host:host-001", "host:host:host-002", "host:host:host-003"]);
    expect(tree.hosts[1]!.queryIds).toEqual([]);
    expect(tree.hosts[0]!.queryIds.length).toBe(5);
    // Its services stay in the index.
    expect(tree.hosts[1]!.children[0]!.queryIds).toEqual(["estate.liveness"]);
  });

  test("REQ-LANE-01: a null index gives empty queryIds and endpoints everywhere", () => {
    const tree = buildLaneTree(makeHierarchySnapshot({ hosts: 2, servicesPerHost: 2, grafana: true }), null);
    expect(tree.domains).toEqual([]);
    for (const host of tree.hosts) {
      expect(host.queryIds).toEqual([]);
      expect(host.endpoints).toEqual([]);
      expect(host.grafanaUrl).not.toBeNull();
      for (const child of host.children) {
        expect(child.queryIds).toEqual([]);
        expect(child.endpoints).toEqual([]);
      }
    }
  });

  test("REQ-ECR-C2: services nest in model order with endpoints = parent-linked endpoint targets ∩ checkHistory, deduped, sorted", () => {
    const snapshot = makeHierarchySnapshot({ hosts: 1, servicesPerHost: 2 });
    const host = snapshot.hosts[0]!;
    const svc = host.services[0]!;
    const base = makeTimelineIndex(snapshot);
    const endpointTarget = (id: string, parentId: string | null): TimelineTarget => ({
      target: { kind: "endpoint", id }, name: id, queryIds: ["endpoint.check.latency"], ranges: ["1h", "6h", "24h"],
      parent: parentId === null ? null : { kind: "service", id: parentId },
    });
    const index: TimelinePayload = {
      ...base,
      targets: [
        ...base.targets.filter((t) => t.target.kind !== "endpoint"),
        endpointTarget("z/linked", svc.drilldownId),
        endpointTarget("a/linked", svc.drilldownId),
        endpointTarget("z/linked", svc.drilldownId), // duplicate target
        endpointTarget("m/unlisted", svc.drilldownId), // parent-linked but not in checkHistory
        endpointTarget("q/orphan", null), // listed but no parent
        { ...endpointTarget("h/host-parent", null), parent: { kind: "host", id: host.drilldownId } },
      ],
      checkHistory: { endpoints: ["a/linked", "h/host-parent", "q/orphan", "z/linked"], provenance: "gatus" },
    };
    const tree = buildLaneTree(snapshot, index);
    const children = tree.hosts[0]!.children;
    expect(children.map((c) => c.name)).toEqual(["nginx", "postgres"]);
    expect(children[0]!.endpoints).toEqual(["a/linked", "z/linked"]);
    expect(children[1]!.endpoints).toEqual([]);
    expect(children[0]!.hostName).toBe("host-001");
    expect(children[0]!.label).toBe("nginx");
  });

  test("REQ-ECR-C2: a snapshot check absent from the parent links is excluded, even when checkHistory lists it", () => {
    const snapshot = makeHierarchySnapshot({ hosts: 1, servicesPerHost: 1 });
    const svc = snapshot.hosts[0]!.services[0]!;
    const own = svc.checks[0]!.endpoint;
    const extra = { endpoint: "snap/only", success: true, lastEvaluatedAt: "2026-09-24T12:00:00.000Z" };
    const snap2: OverviewSnapshotV2 = {
      ...snapshot,
      hosts: [{ ...snapshot.hosts[0]!, services: [{ ...svc, checks: [...svc.checks, extra] }] }],
    };
    const base = makeTimelineIndex(snapshot);
    const index: TimelinePayload = {
      ...base,
      checkHistory: { endpoints: [...base.checkHistory.endpoints, "snap/only"].sort(), provenance: "gatus" },
    };
    expect(buildLaneTree(snap2, index).hosts[0]!.children[0]!.endpoints).toEqual([own]);
  });

  test("REQ-ECR-C2: a parent-linked endpoint is used even when the snapshot service declares no check", () => {
    const snapshot = makeHierarchySnapshot({ hosts: 1, servicesPerHost: 1 });
    const svc = snapshot.hosts[0]!.services[0]!;
    const index = makeTimelineIndex(snapshot);
    const snap2: OverviewSnapshotV2 = { ...snapshot, hosts: [{ ...snapshot.hosts[0]!, services: [{ ...svc, checks: [] }] }] };
    expect(buildLaneTree(snap2, index).hosts[0]!.children[0]!.endpoints).toEqual([svc.checks[0]!.endpoint]);
  });

  test("REQ-LANE-01: an ambiguous endpoint (declared by two services) is excluded", () => {
    const snapshot = makeHierarchySnapshot({ hosts: 1, servicesPerHost: 2 });
    const host = snapshot.hosts[0]!;
    const shared = [{ endpoint: "shared/key", success: true, lastEvaluatedAt: "2026-09-24T12:00:00.000Z" }];
    const snap2: OverviewSnapshotV2 = {
      ...snapshot,
      hosts: [{ ...host, services: host.services.map((s) => ({ ...s, checks: [...s.checks, ...shared] })) }],
    };
    // makeTimelineIndex mirrors foldTimeline: an ambiguous key is absent from checkHistory.endpoints.
    const index = makeTimelineIndex(snap2);
    expect(index.checkHistory.endpoints).not.toContain("shared/key");
    const tree = buildLaneTree(snap2, index);
    expect(tree.hosts[0]!.children[0]!.endpoints).toEqual(["host-001/nginx"]);
    expect(tree.hosts[0]!.children[1]!.endpoints).toEqual(["host-001/postgres"]);
  });

  test("REQ-LANE-01: duplicate drilldownIds are skipped (first occurrence wins); no index domains → domains []", () => {
    const snapshot = makeHierarchySnapshot({ hosts: 2, servicesPerHost: 1 });
    const [h0, h1] = snapshot.hosts as [HostStatus, HostStatus];
    const dup: OverviewSnapshotV2 = { ...snapshot, hosts: [h0, { ...h1, drilldownId: h0.drilldownId }, h0] };
    const tree = buildLaneTree(dup, null);
    expect(tree.hosts.length).toBe(1);
    expect(tree.hosts[0]!.name).toBe("host-001");
    const empty = buildLaneTree({ ...snapshot, hosts: [] }, makeTimelineIndex(snapshot));
    expect(empty).toEqual({ hosts: [], domains: [] });
  });

  test("REQ-ECR-C3: LaneTree.domains is index.domains deduplicated by endpoint, in order; [] for a null index", () => {
    const snapshot = makeHierarchySnapshot({ hosts: 1, servicesPerHost: 1 });
    const base = makeTimelineIndex(snapshot, { domains: ["b.example", "a.example"] });
    expect(buildLaneTree(snapshot, base).domains).toEqual([
      { domain: "b.example", endpoint: "dns:b.example" },
      { domain: "a.example", endpoint: "dns:a.example" },
    ]);
    const dup = { ...base, domains: [...base.domains, { domain: "b-again", endpoint: "dns:b.example" }] };
    expect(buildLaneTree(snapshot, dup).domains.map((d) => d.domain)).toEqual(["b.example", "a.example"]);
    expect(buildLaneTree(snapshot, null).domains).toEqual([]);
  });

  test("REQ-LANE-01: endpoint-kind index targets are never lanes", () => {
    const snapshot = makeHierarchySnapshot({ hosts: 2, servicesPerHost: 2 });
    const tree = buildLaneTree(snapshot, makeTimelineIndex(snapshot));
    const kinds = tree.hosts.flatMap((h) => [h.target.kind, ...h.children.map((c) => c.target.kind)]);
    expect(new Set(kinds)).toEqual(new Set(["host", "service"]));
  });
});

// ---------------------------------------------------------------------------
// findLane
// ---------------------------------------------------------------------------

describe("findLane (05 §3.4)", () => {
  const snapshot = makeHierarchySnapshot({ hosts: 3, servicesPerHost: 2 });
  const tree = buildLaneTree(snapshot, makeTimelineIndex(snapshot));

  test("finds hosts and services", () => {
    expect(findLane(tree, { kind: "host", id: "host:host-002" })).toBe(tree.hosts[1]!);
    expect(findLane(tree, { kind: "service", id: "svc:host-003/postgres" })).toBe(tree.hosts[2]!.children[1]!);
  });

  test("returns null for endpoint-kind and unknown identities", () => {
    expect(findLane(tree, { kind: "endpoint", id: "host-001/nginx" })).toBeNull();
    expect(findLane(tree, { kind: "host", id: "host:nope" })).toBeNull();
    // Right id, wrong kind.
    expect(findLane(tree, { kind: "service", id: "host:host-001" })).toBeNull();
  });

  test("reuses its WeakMap index on repeat calls (built once per tree)", () => {
    const fresh = buildLaneTree(snapshot, null);
    let hostReads = 0;
    const counted: LaneTree = {
      domains: [],
      get hosts() {
        hostReads += 1;
        return fresh.hosts;
      },
    };
    expect(findLane(counted, { kind: "host", id: "host:host-001" })).toBe(fresh.hosts[0]!);
    const afterFirst = hostReads;
    expect(afterFirst).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) findLane(counted, { kind: "service", id: "svc:host-002/nginx" });
    expect(findLane(counted, { kind: "host", id: "host:host-003" })).toBe(fresh.hosts[2]!);
    expect(hostReads).toBe(afterFirst);
    // A different tree object gets its own index.
    expect(findLane(fresh, { kind: "host", id: "host:host-001" })).toBe(fresh.hosts[0]!);
  });
});

// ---------------------------------------------------------------------------
// orderHosts / createHostOrder
// ---------------------------------------------------------------------------

describe("orderHosts (05 §3.5)", () => {
  test("REQ-LANE-05: stable partition, problems first, model order within each group", () => {
    const snapshot = makeHierarchySnapshot({ hosts: 6, servicesPerHost: 0 });
    const tree = buildLaneTree(snapshot, null);
    const input = [...tree.hosts];
    const problems = new Set<TargetKey>(["host:host:host-005", "host:host:host-002", "host:host:host-004"]);
    const out = orderHosts(input, problems);
    expect(hostKeys(out)).toEqual([
      "host:host:host-002", "host:host:host-004", "host:host:host-005",
      "host:host:host-001", "host:host:host-003", "host:host:host-006",
    ]);
    // Input not mutated; a new array is returned.
    expect(input).toEqual([...tree.hosts]);
    expect(out).not.toBe(input);
    expect(hostKeys(orderHosts(input, new Set()))).toEqual(hostKeys(input));
  });
});

describe("createHostOrder (05 §3.6)", () => {
  const snapshot = makeHierarchySnapshot({ hosts: 4, servicesPerHost: 0 });
  const tree = buildLaneTree(snapshot, null);
  const H = (n: number): TargetKey => `host:host:host-00${n}` as TargetKey;

  function input(o: Partial<HostOrderInput> & { readonly problemKeys?: readonly TargetKey[] }, calls?: { n: number }): HostOrderInput {
    const keys = o.problemKeys ?? [];
    return {
      tree: o.tree ?? tree,
      range: o.range ?? "24h",
      end: o.end ?? null,
      alertsFetchedAt: o.alertsFetchedAt === undefined ? null : o.alertsFetchedAt,
      problems: () => {
        if (calls !== undefined) calls.n += 1;
        return new Set(keys);
      },
    };
  }

  test("REQ-LANE-05: model order while alerts are loading (anchor null), problems not consulted", () => {
    const memo = createHostOrder();
    const calls = { n: 0 };
    const out = memo.order(input({ problemKeys: [H(3)] }, calls));
    expect(out).toBe(tree.hosts);
    expect(calls.n).toBe(0);
  });

  test("REQ-LANE-05: first ready alerts payload freezes the problem-first order", () => {
    const memo = createHostOrder();
    memo.order(input({}));
    const out = memo.order(input({ alertsFetchedAt: "A", problemKeys: [H(3)] }));
    expect(hostKeys(out)).toEqual([H(3), H(1), H(2), H(4)]);
  });

  test("REQ-LANE-05: a second alertsFetchedAt with the same freeze key does not reorder even when problems change", () => {
    const memo = createHostOrder();
    const calls = { n: 0 };
    const first = memo.order(input({ alertsFetchedAt: "A", problemKeys: [H(3)] }, calls));
    const second = memo.order(input({ alertsFetchedAt: "B", problemKeys: [H(4), H(2)] }, calls));
    expect(hostKeys(second)).toEqual([H(3), H(1), H(2), H(4)]);
    expect(calls.n).toBe(1);
    // Stable result identity while tree and frozen order are unchanged.
    expect(second).toBe(first);
    // A failed refresh (alerts null) keeps the frozen order too.
    expect(memo.order(input({ alertsFetchedAt: null }))).toBe(first);
  });

  test("REQ-LANE-05: a range change resets and recomputes on the first ready payload of the new range", () => {
    const memo = createHostOrder();
    memo.order(input({ alertsFetchedAt: "A", problemKeys: [H(3)] }));
    // New range, alerts still loading: model order.
    expect(memo.order(input({ range: "6h", alertsFetchedAt: null, problemKeys: [H(4)] }))).toBe(tree.hosts);
    const out = memo.order(input({ range: "6h", alertsFetchedAt: "C", problemKeys: [H(4)] }));
    expect(hostKeys(out)).toEqual([H(4), H(1), H(2), H(3)]);
  });

  test("REQ-LANE-05: an end change (pause or resume) resets and recomputes immediately when a payload is ready", () => {
    const memo = createHostOrder();
    memo.order(input({ alertsFetchedAt: "A", problemKeys: [H(3)] }));
    const paused = memo.order(input({ end: 1_790_000_000, alertsFetchedAt: "A", problemKeys: [H(2)] }));
    expect(hostKeys(paused)).toEqual([H(2), H(1), H(3), H(4)]);
    const resumed = memo.order(input({ end: null, alertsFetchedAt: "A", problemKeys: [H(1), H(4)] }));
    expect(hostKeys(resumed)).toEqual([H(1), H(4), H(2), H(3)]);
  });

  test("REQ-LANE-05: HISTORY_LIMIT_EXCEEDED (alerts null) keeps model order until a ready payload", () => {
    const memo = createHostOrder();
    expect(memo.order(input({ alertsFetchedAt: null, problemKeys: [H(2)] }))).toBe(tree.hosts);
    expect(memo.order(input({ alertsFetchedAt: null, problemKeys: [H(2)] }))).toBe(tree.hosts);
    expect(hostKeys(memo.order(input({ alertsFetchedAt: "A", problemKeys: [H(2)] })))).toEqual([H(2), H(1), H(3), H(4)]);
  });

  test("REQ-LANE-05: a model change appends a new host at the end and drops removed hosts", () => {
    const memo = createHostOrder();
    memo.order(input({ alertsFetchedAt: "A", problemKeys: [H(3)] }));
    const bigger = buildLaneTree(makeHierarchySnapshot({ hosts: 5, servicesPerHost: 0 }), null);
    // host-005 is new; the problem set now names it, but the order is frozen.
    const grown = memo.order(input({ tree: bigger, alertsFetchedAt: "B", problemKeys: [H(5)] }));
    expect(hostKeys(grown)).toEqual([H(3), H(1), H(2), H(4), H(5)]);
    // Result nodes come from the current tree.
    expect(grown[0]).toBe(bigger.hosts[2]!);
    expect(memo.order(input({ tree: bigger, alertsFetchedAt: "C" }))).toBe(grown);
    const smaller: LaneTree = { hosts: bigger.hosts.filter((h) => h.name !== "host-003"), domains: [] };
    const shrunk = memo.order(input({ tree: smaller, alertsFetchedAt: "D" }));
    expect(hostKeys(shrunk)).toEqual([H(1), H(2), H(4), H(5)]);
    expect(shrunk).not.toBe(grown);
  });

  test("REQ-LANE-05: separate memos (remounts) are independent", () => {
    const a = createHostOrder();
    const b = createHostOrder();
    a.order(input({ alertsFetchedAt: "A", problemKeys: [H(4)] }));
    expect(hostKeys(b.order(input({ alertsFetchedAt: "A", problemKeys: [H(2)] })))).toEqual([H(2), H(1), H(3), H(4)]);
  });
});

// ---------------------------------------------------------------------------
// Structural guards over views/timeline/** (08 §5.1). Plain string/regex checks, not AST analysis.
// Protection set: every .ts/.tsx source under views/timeline/ and views/_shared/timeseries/
// (history/ included). Non-goals: test files, type-only /wire imports, engine → timeline imports (D8).
// ---------------------------------------------------------------------------

describe("structural guards", () => {
  const TIMELINE_ROOT = new URL("../src/client/views/timeline/", import.meta.url).pathname;
  const ENGINE_ROOT = new URL("../src/client/views/engine/", import.meta.url).pathname;

  const SHARED_ROOT = new URL("../src/client/views/_shared/timeseries/", import.meta.url).pathname;

  async function timelineSources(): Promise<readonly { readonly root: string; readonly rel: string; readonly text: string }[]> {
    const out: { root: string; rel: string; text: string }[] = [];
    for (const root of [TIMELINE_ROOT, SHARED_ROOT]) {
      for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
        out.push({ root, rel, text: await Bun.file(root + rel).text() });
      }
    }
    return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  }

  /** Every import/export specifier in a source (static, side-effect and dynamic forms). */
  function specifiers(text: string): string[] {
    const out: string[] = [];
    const re = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m[1]!);
    return out;
  }

  test("the guards scan a non-empty file set that includes view.tsx, model.ts and history/", async () => {
    const rels = (await timelineSources()).map((s) => s.rel);
    expect(rels).toContain("view.tsx");
    expect(rels).toContain("model.ts");
    expect(rels.some((r) => r.startsWith("history/"))).toBe(true);
    expect(rels.length).toBeGreaterThanOrEqual(20);
  });

  test("REQ-SEC-01: no timeline source imports the query catalog", async () => {
    const catalog = "@pulse/web-data/" + "queries";
    const offenders = (await timelineSources())
      .filter((s) => specifiers(s.text).includes(catalog) || s.text.includes(`from "${catalog}"`) || s.text.includes(`import("${catalog}")`))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  test("CON-03 / V-002: no timeline source (outside the shared SyncedChart wrapper) uses the generic TimeSeriesChart (charts go through SyncedChart)", async () => {
    const offenders = (await timelineSources()).filter((s) => s.root === TIMELINE_ROOT)
      .filter((s) => /\bTimeSeriesChart\b/.test(s.text) || specifiers(s.text).some((spec) => /viz\/time-series-chart(\.js)?$/.test(spec)))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  test("REQ-SEC-02: no timeline source uses dangerouslySetInnerHTML or assigns innerHTML", async () => {
    const offenders = (await timelineSources())
      .filter((s) => s.text.includes("dangerouslySetInnerHTML") || /\binnerHTML\s*=(?!=)/.test(s.text))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  test("V-001: the view ships no stylesheet — no .css import and no .css file under timeline/ or _shared/timeseries/", async () => {
    const cssImports = (await timelineSources()).flatMap((s) =>
      specifiers(s.text).filter((spec) => spec.endsWith(".css")).map((spec) => `${s.rel} -> ${spec}`),
    );
    expect(cssImports).toEqual([]);
    const cssFiles: string[] = [];
    for (const root of [TIMELINE_ROOT, SHARED_ROOT]) {
      for await (const rel of new Bun.Glob("**/*.css").scan({ cwd: root })) cssFiles.push(rel);
    }
    expect(cssFiles).toEqual([]);
    expect(await Bun.file(TIMELINE_ROOT + "view.css").exists()).toBe(false);
  });

  test("08 §5.1: no timeline source imports from views/engine/**", async () => {
    const offenders: string[] = [];
    for (const s of await timelineSources()) {
      for (const spec of specifiers(s.text)) {
        const resolved = spec.startsWith(".") ? new URL(spec, "file://" + s.root + s.rel).pathname : spec;
        if (resolved.startsWith(ENGINE_ROOT) || /(^|\/)views\/engine\//.test(spec)) offenders.push(`${s.rel} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
