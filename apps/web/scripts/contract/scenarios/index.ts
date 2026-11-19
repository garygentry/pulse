// The ordered list of scenario modules and the deterministic helpers every module is handed.

import { ENUM_FALLBACKS } from "@pulse/web-data/contract";
import { canonicalJson, sha256Id } from "@pulse/web-data/cycle";
import type { HashId } from "@pulse/web-data/wire";

import { ContractToolError } from "../errors.js";
import type { ShapeNode, ShapeSnapshot } from "../shape-types.js";
import type { FixtureGroup, ScenarioFixture } from "../types.js";
import { alertsScenarios } from "./alerts.js";
import { at, atMs } from "./common.js";
import { connectLinkScenarios } from "./connect-link.js";
import { errorScenarios } from "./errors.js";
import { estateScenarios } from "./estate.js";
import { eventScenarios } from "./events.js";
import { handshakeScenarios } from "./handshake.js";
import { historyAlertsScenarios } from "./history-alerts.js";
import { historyChecksScenarios } from "./history-checks.js";
import { historyEstateScenarios } from "./history-estate.js";
import { historyTargetScenarios } from "./history-target.js";
import { overviewScenarios } from "./overview.js";
import { sessionScenarios } from "./session.js";
import { timelineScenarios } from "./timeline.js";

/** Shared, deterministic helpers handed to every module. */
export interface ScenarioContext {
  /** Content hash of the canonical JSON of `seed`. */
  hash(seed: unknown): Promise<HashId>;
  /** ISO timestamp at the fixed epoch plus `offsetSeconds`. */
  at(offsetSeconds: number): string;
  /** Epoch milliseconds at the fixed epoch plus `offsetSeconds`. */
  atMs(offsetSeconds: number): number;
}

/** One operation's fixtures. A new operation adds one module and one line in SCENARIO_MODULES. */
export interface ScenarioModule {
  /** Group directory; every returned entry's group must equal it. */
  readonly group: FixtureGroup;
  /** Operation label written to every entry, for example "GET /api/overview". */
  readonly operation: string;
  /** Build every fixture of the group except the derived unknown-enum ones. */
  build(ctx: ScenarioContext): Promise<readonly ScenarioFixture[]>;
}

/** The context every generation uses. It reads no clock, environment or random source. */
export function createScenarioContext(): ScenarioContext {
  return { hash: (seed) => sha256Id(canonicalJson(seed)), at, atMs };
}

/** Ordered module list. The output is sorted by path, so the order only decides which error is reported first. */
export const SCENARIO_MODULES: readonly ScenarioModule[] = Object.freeze([
  sessionScenarios,
  overviewScenarios,
  alertsScenarios,
  estateScenarios,
  timelineScenarios,
  historyEstateScenarios,
  historyTargetScenarios,
  historyAlertsScenarios,
  historyChecksScenarios,
  eventScenarios,
  errorScenarios,
  handshakeScenarios,
  connectLinkScenarios,
]);

/** The value written where a client knows no such enum member. */
const FUTURE_VALUE = "future-value";
/** The same, for an enum whose members are numbers. */
const FUTURE_NUMBER = 987_654;

/** Which fixture a root type's unknown-enum variants are derived from. */
const UNKNOWN_ENUM_BASE: Readonly<Record<string, { readonly group: FixtureGroup; readonly scenario: string }>> = {
  SessionPayload: { group: "session", scenario: "all-optional" },
  OverviewSnapshotV2: { group: "overview", scenario: "all-optional" },
  AlertsPayload: { group: "alerts", scenario: "all-optional" },
  EstatePayload: { group: "estate", scenario: "all-optional" },
  TimelinePayload: { group: "timeline", scenario: "all-optional" },
  HistoryPayload: { group: "history-estate", scenario: "all-optional" },
  IntervalHistoryPayload: { group: "history-alerts", scenario: "all-optional" },
  EndpointHistoryPayload: { group: "history-checks", scenario: "all-optional" },
  LiveTick: { group: "events", scenario: "tick-typical" },
  ErrorEnvelope: { group: "errors", scenario: "invalid-request" },
  BundleErrorBody: { group: "errors", scenario: "bundle-error-missing" },
};

/** One step of a shape path below its root. */
type PathStep =
  | { readonly type: "member"; readonly name: string }
  | { readonly type: "element" }
  | { readonly type: "slot"; readonly index: number }
  | { readonly type: "record" }
  | { readonly type: "variant"; readonly field: string; readonly value: string };

const PATH_STEP = /\.([^.[\]{}()]+)|\[(\d*)\]|(\{\})|\(([^=()]+)=([^()]*)\)/y;

/** Split a shape path into its root name and steps, or null when it does not follow the path grammar. */
function parseShapePath(path: string): { readonly root: string; readonly steps: readonly PathStep[] } | null {
  const rootEnd = path.search(/[.[{(]/);
  const root = rootEnd === -1 ? path : path.slice(0, rootEnd);
  const steps: PathStep[] = [];
  PATH_STEP.lastIndex = root.length;
  while (PATH_STEP.lastIndex < path.length) {
    const match = PATH_STEP.exec(path);
    if (match === null) return null;
    const [, name, index, record, field, value] = match;
    if (name !== undefined) steps.push({ type: "member", name });
    else if (record !== undefined) steps.push({ type: "record" });
    else if (field !== undefined) steps.push({ type: "variant", field, value: value ?? "" });
    else if (index === "") steps.push({ type: "element" });
    else steps.push({ type: "slot", index: Number(index) });
  }
  return root === "" ? null : { root, steps };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where a walked path ended: the container holding the value, and the key or index it sits at. */
interface Slot {
  readonly holder: Record<string, unknown> | unknown[];
  readonly key: string | number;
}

function read(slot: Slot): unknown {
  return Array.isArray(slot.holder) ? slot.holder[slot.key as number] : slot.holder[slot.key as string];
}

function write(slot: Slot, value: unknown): void {
  if (Array.isArray(slot.holder)) slot.holder[slot.key as number] = value;
  else slot.holder[slot.key as string] = value;
}

/**
 * Follow `steps` from the body root: a member by name, element 0 of an array (or the first element of the
 * variant a following step names), a tuple slot, the first key of a record in sorted order. Returns null
 * when the body holds no value there.
 */
function walk(body: unknown, steps: readonly PathStep[]): Slot | null {
  let slot: Slot = { holder: [body], key: 0 };
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    const current = read(slot);
    switch (step.type) {
      case "member":
        if (!isObject(current) || !Object.hasOwn(current, step.name)) return null;
        slot = { holder: current, key: step.name };
        break;
      case "element": {
        if (!Array.isArray(current)) return null;
        const next = steps[i + 1];
        const index =
          next?.type === "variant"
            ? current.findIndex((item) => isObject(item) && item[next.field] === next.value)
            : 0;
        if (index < 0 || index >= current.length) return null;
        slot = { holder: current, key: index };
        break;
      }
      case "slot":
        if (!Array.isArray(current) || step.index >= current.length) return null;
        slot = { holder: current, key: step.index };
        break;
      case "record": {
        if (!isObject(current)) return null;
        const first = Object.keys(current).sort()[0];
        if (first === undefined) return null;
        slot = { holder: current, key: first };
        break;
      }
      case "variant":
        // The value must already be the named variant (an array step picked it; a plain member has to match).
        if (!isObject(current) || current[step.field] !== step.value) return null;
        break;
    }
  }
  return slot;
}

/**
 * Derived pass: one `unknown-enum-<group>` fixture per enum fallback entry. Each is a copy of an existing
 * fixture of the entry's first path's root, with a value no client knows written at that path, so a client
 * can prove its fallback for the enum.
 *
 * @throws {ContractToolError} SCENARIO_INVALID when the base fixture is missing or does not reach the path,
 *   or the path is not an enum or a keyed object in the shape snapshot
 */
export function buildUnknownEnumFixtures(
  shape: ShapeSnapshot,
  built: readonly ScenarioFixture[],
  _ctx: ScenarioContext,
): readonly ScenarioFixture[] {
  const fixtures: ScenarioFixture[] = [];
  for (const { group: enumGroup, paths } of ENUM_FALLBACKS) {
    const subject = `unknown-enum-${enumGroup}`;
    const fail = (message: string): never => {
      throw new ContractToolError("SCENARIO_INVALID", subject, message);
    };
    const path = paths[0] ?? fail("enum fallback entry has no path");
    const parsed = parseShapePath(path) ?? fail(`cannot parse shape path ${path}`);
    const baseRef = UNKNOWN_ENUM_BASE[parsed.root] ?? fail(`no fixture group for root ${parsed.root}`);
    const base =
      built.find(({ entry }) => entry.group === baseRef.group && entry.scenario === baseRef.scenario) ??
      fail(`base fixture ${baseRef.group}/${baseRef.scenario} was not built`);
    const node: ShapeNode =
      shape.roots[parsed.root]?.find((candidate) => candidate.path === path) ??
      fail(`shape snapshot has no node ${path}`);

    const body: unknown = structuredClone(base.body);
    const slot =
      walk(body, parsed.steps) ??
      fail(`base fixture does not reach ${path}; add the value to ${baseRef.group}/${baseRef.scenario}`);
    if (node.kind === "literal-union" || node.kind === "literal") {
      const numeric = (node.members ?? []).length > 0 && (node.members ?? []).every((member) => /^-?\d+(\.\d+)?$/.test(member));
      write(slot, numeric ? FUTURE_NUMBER : FUTURE_VALUE);
    } else if (node.kind === "object") {
      // A closed key set: a key no client knows, carrying a copy of a known key's value.
      const value = read(slot);
      const first = isObject(value) ? Object.keys(value).sort()[0] : undefined;
      if (!isObject(value) || first === undefined) {
        fail(`base fixture does not reach ${path}; add the value to ${baseRef.group}/${baseRef.scenario}`);
      } else {
        value[FUTURE_VALUE] = structuredClone(value[first]);
      }
    } else {
      fail(`${path} is a ${node.kind}, not an enum or a keyed object`);
    }

    if (base.entry.kind === "stream") fail(`base fixture ${baseRef.group}/${baseRef.scenario} is a transcript`);
    const kind = base.entry.kind as Exclude<ScenarioFixture["entry"]["kind"], "stream">;
    fixtures.push({
      entry: {
        group: base.entry.group,
        operation: base.entry.operation,
        scenario: subject,
        kind,
        status: base.entry.status,
        expect: "accept",
        webValidator: null,
      },
      body,
    });
  }
  return fixtures;
}
