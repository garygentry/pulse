// The ordered list of scenario modules and the deterministic helpers every module is handed.

import { canonicalJson, sha256Id } from "@pulse/web-data/cycle";
import type { HashId } from "@pulse/web-data/wire";

import type { ShapeSnapshot } from "../shape-types.js";
import type { FixtureGroup, ScenarioFixture } from "../types.js";
import { at, atMs } from "./common.js";
import { connectLinkScenarios } from "./connect-link.js";
import { errorScenarios } from "./errors.js";
import { handshakeScenarios } from "./handshake.js";
import { sessionScenarios } from "./session.js";

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
  errorScenarios,
  handshakeScenarios,
  connectLinkScenarios,
]);

/**
 * Derived pass: one `unknown-enum-<group>` fixture per enum fallback entry, built from the fixtures the
 * modules produced. Not implemented yet: it needs the view, history and event groups, so it yields nothing.
 */
export function buildUnknownEnumFixtures(
  _shape: ShapeSnapshot,
  _built: readonly ScenarioFixture[],
  _ctx: ScenarioContext,
): readonly ScenarioFixture[] {
  return [];
}
