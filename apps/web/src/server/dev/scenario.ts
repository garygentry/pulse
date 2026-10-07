// src/server/dev/scenario.ts — read, parse, and validate a mock scenario directory.
//
// The single throwing entry point in the mock stack: every downstream never-throw contract rests
// on `loadScenario` failing FAST at construction so a bad fixture surfaces once (loud) rather than
// being swallowed into `SourceHealth` at request time. Each source fixture is parsed through the
// REAL client parser (`parseLiveness`/`parseAlerts`/`parseChecks`) so a drift between the mock
// body and the wire shape fails here.

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { WebAppError } from "../../shared/errors.js";
import {
  parseAlerts,
  parseChecks,
  parseLiveness,
  type AmAlertsResponse,
  type AmGettableAlert,
  type GatusStatusesResponse,
  type VmQueryResponse,
} from "../sources/index.js";
import type {
  MockSource,
  ScenarioBase,
  Timeline,
  TimelineOp,
  TimelineStep,
  VmalertRulesResponse,
} from "./timeline.js";

/** File names inside a scenario directory. `timeline.json` is optional. */
export const SCENARIO_FILES = {
  vm: "vm.json",
  alertmanager: "alertmanager.json",
  gatus: "gatus.json",
  vmalert: "vmalert.json",
  timeline: "timeline.json",
} as const;

/** Absolute default scenario root — `apps/web/src/server/dev` → `apps/web/tests/fixtures/engine`. */
export const DEFAULT_SCENARIO_DIR = resolve(import.meta.dir, "../../../tests/fixtures/engine");

/** A loaded, validated scenario ready for `createMockEngine`. */
export interface LoadedScenario {
  /** The scenario directory name (as passed to `loadScenario`). */
  name: string;
  /** The three parsed fixture bodies, before any timeline step is applied. */
  base: ScenarioBase;
  /** Empty when `timeline.json` is absent. */
  timeline: Timeline;
}

/** Stable machine codes for scenario failures. */
export type MockScenarioErrorCode = "MOCK_SCENARIO_UNKNOWN" | "MOCK_SCENARIO_INVALID";

/**
 * A mock scenario could not be used. UNKNOWN names a missing directory and carries available
 * siblings; INVALID names malformed or missing scenario content.
 */
export class MockScenarioError extends WebAppError {
  override readonly code: MockScenarioErrorCode;
  readonly scenario: string;
  readonly available: readonly string[];
  readonly file: string | null;
  constructor(
    code: MockScenarioErrorCode,
    scenario: string,
    message: string,
    detail: { available?: readonly string[]; file?: string | null } = {},
  ) {
    super(code, message);
    this.code = code;
    this.scenario = scenario;
    this.available = detail.available ?? [];
    this.file = detail.file ?? null;
  }
}

const KNOWN_OPS: ReadonlySet<TimelineOp["op"]> = new Set([
  "host-down",
  "host-up",
  "alert-fire",
  "alert-resolve",
  "check-fail",
  "check-pass",
  "outage-begin",
  "outage-end",
]);
const OUTAGE_SOURCES: ReadonlySet<string> = new Set(["vm", "alertmanager", "gatus", "vmalert"]);

/**
 * Read and validate `<fixturesDir>/<name>/`. Every source body is parsed through the real client
 * parser so a fixture drifting from the wire shape fails at load.
 */
export async function loadScenario(fixturesDir: string, name: string): Promise<LoadedScenario> {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw notFound(fixturesDir, name, await listSiblings(fixturesDir));
  }
  const scenarioDir = resolve(fixturesDir, name);
  if (!(await isDirectory(scenarioDir))) {
    throw notFound(fixturesDir, name, await listSiblings(fixturesDir));
  }

  const invalidPrefix = `mock scenario "${name}" is invalid: `;

  const vm = await loadSource(
    scenarioDir,
    SCENARIO_FILES.vm,
    name,
    invalidPrefix,
    (body) => (parseLiveness(body as VmQueryResponse), body as VmQueryResponse),
  );
  const alertmanager = await loadSource(
    scenarioDir,
    SCENARIO_FILES.alertmanager,
    name,
    invalidPrefix,
    (body) => (parseAlerts(body as AmAlertsResponse), body as AmAlertsResponse),
  );
  const gatus = await loadSource(
    scenarioDir,
    SCENARIO_FILES.gatus,
    name,
    invalidPrefix,
    (body) => (parseChecks(body as GatusStatusesResponse), body as GatusStatusesResponse),
  );
  // vmalert has no production client yet (00 §4.1): validate the fixture envelope shape locally
  // so a malformed body still fails FAST at load, matching the other sources' never-swallow rule.
  const vmalert = await loadSource(
    scenarioDir,
    SCENARIO_FILES.vmalert,
    name,
    invalidPrefix,
    (body) => validateVmalertRules(body),
  );

  const timelineRaw = await tryRead(scenarioDir, SCENARIO_FILES.timeline);
  const timeline = timelineRaw === null ? { steps: [] } : parseTimeline(name, timelineRaw, invalidPrefix);

  const base: ScenarioBase = { vm, alertmanager, gatus, vmalert };
  return { name, base, timeline };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function tryRead(dir: string, file: string): Promise<string | null> {
  try {
    return await readFile(resolve(dir, file), "utf8");
  } catch {
    return null;
  }
}

async function listSiblings(fixturesDir: string): Promise<string[]> {
  try {
    const entries = await readdir(fixturesDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function notFound(fixturesDir: string, name: string, available: readonly string[]): MockScenarioError {
  const suffix = available.length === 0 ? ` — no scenarios found in ${fixturesDir}` : "";
  return new MockScenarioError(
    "MOCK_SCENARIO_UNKNOWN",
    name,
    `unknown mock scenario "${name}"${suffix}`,
    { available, file: null },
  );
}

async function loadSource<T>(
  dir: string,
  file: string,
  scenario: string,
  invalidPrefix: string,
  validate: (body: unknown) => T,
): Promise<T> {
  const raw = await tryRead(dir, file);
  if (raw === null) {
    throw new MockScenarioError(
      "MOCK_SCENARIO_INVALID",
      scenario,
      `${invalidPrefix}missing ${file}`,
      { file },
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    throw new MockScenarioError(
      "MOCK_SCENARIO_INVALID",
      scenario,
      `${invalidPrefix}${file} is not valid JSON — ${(err as Error).message}`,
      { file },
    );
  }
  try {
    return validate(body);
  } catch (err) {
    throw new MockScenarioError(
      "MOCK_SCENARIO_INVALID",
      scenario,
      `${invalidPrefix}${file} was rejected by the source parser — ${(err as Error).message}`,
      { file },
    );
  }
}

/**
 * Validate a vmalert `/api/v1/rules` fixture envelope (00 §4.1) without a production parser. Throws
 * on a malformed shape so `loadSource` surfaces `MOCK_SCENARIO_INVALID`; harmless additive upstream
 * fields are tolerated (the body is round-tripped as-is). Returns the body typed as the fixture
 * contract on success.
 */
function validateVmalertRules(body: unknown): VmalertRulesResponse {
  if (typeof body !== "object" || body === null) {
    throw new Error("vmalert rules body must be an object");
  }
  const status = (body as { status?: unknown }).status;
  if (typeof status !== "string") {
    throw new Error('vmalert rules body must have a string "status"');
  }
  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) {
    throw new Error('vmalert rules body must have a "data" object');
  }
  const groups = (data as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) {
    throw new Error('vmalert rules "data.groups" must be an array');
  }
  for (let g = 0; g < groups.length; g += 1) {
    const group = groups[g] as { name?: unknown; rules?: unknown };
    if (typeof group !== "object" || group === null || typeof group.name !== "string") {
      throw new Error(`vmalert rules group ${g} must have a string "name"`);
    }
    if (!Array.isArray(group.rules)) {
      throw new Error(`vmalert rules group ${g} must have a "rules" array`);
    }
    for (let r = 0; r < group.rules.length; r += 1) {
      const rule = group.rules[r] as { state?: unknown; name?: unknown; health?: unknown };
      if (
        typeof rule !== "object" || rule === null
        || typeof rule.state !== "string"
        || typeof rule.name !== "string"
        || typeof rule.health !== "string"
      ) {
        throw new Error(
          `vmalert rules group ${g} rule ${r} must have string "state", "name", and "health"`,
        );
      }
    }
  }
  return body as VmalertRulesResponse;
}

function parseTimeline(scenario: string, raw: string, invalidPrefix: string): Timeline {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new MockScenarioError(
      "MOCK_SCENARIO_INVALID",
      scenario,
      `${invalidPrefix}${SCENARIO_FILES.timeline} is not valid JSON — ${(err as Error).message}`,
      { file: SCENARIO_FILES.timeline },
    );
  }
  if (typeof doc !== "object" || doc === null || !Array.isArray((doc as { steps?: unknown }).steps)) {
    throw invalidShape(
      scenario,
      `${invalidPrefix}${SCENARIO_FILES.timeline} must be an object with a "steps" array`,
    );
  }
  const rawSteps = (doc as { steps: unknown[] }).steps;
  const steps: TimelineStep[] = [];
  let prevAt = -1;
  for (let i = 0; i < rawSteps.length; i += 1) {
    const step = rawSteps[i] as { atMs?: unknown; step?: unknown };
    const atMs = step.atMs;
    if (typeof atMs !== "number" || !Number.isFinite(atMs) || !Number.isInteger(atMs) || atMs < 0) {
      throw invalidShape(
        scenario,
        `${invalidPrefix}${SCENARIO_FILES.timeline} step ${i}: atMs must be a non-negative integer`,
      );
    }
    if (atMs < prevAt) {
      throw invalidShape(
        scenario,
        `${invalidPrefix}${SCENARIO_FILES.timeline} step ${i}: atMs ${atMs} is before step ${i - 1}'s ${prevAt} (steps must ascend)`,
      );
    }
    const op = validateOp(scenario, i, step.step, invalidPrefix);
    steps.push({ atMs, step: op });
    prevAt = atMs;
  }
  return { steps };
}

function invalidShape(scenario: string, message: string): MockScenarioError {
  return new MockScenarioError("MOCK_SCENARIO_INVALID", scenario, message, { file: SCENARIO_FILES.timeline });
}

function validateOp(scenario: string, index: number, raw: unknown, invalidPrefix: string): TimelineOp {
  if (typeof raw !== "object" || raw === null) {
    throw invalidShape(
      scenario,
      `${invalidPrefix}${SCENARIO_FILES.timeline} step ${index}: unknown op "${String(raw)}"`,
    );
  }
  const op = (raw as { op?: unknown }).op;
  if (typeof op !== "string" || !KNOWN_OPS.has(op as TimelineOp["op"])) {
    throw invalidShape(
      scenario,
      `${invalidPrefix}${SCENARIO_FILES.timeline} step ${index}: unknown op "${String(op)}"`,
    );
  }
  const detail = raw as Record<string, unknown>;
  switch (op) {
    case "host-down":
    case "host-up": {
      const host = detail.host;
      if (typeof host !== "string" || host === "") {
        throw invalidShape(
          scenario,
          `${invalidPrefix}${SCENARIO_FILES.timeline} step ${index}: op "${op}" requires a non-empty string "host"`,
        );
      }
      return { op, host };
    }
    case "alert-fire": {
      const alert = detail.alert as AmGettableAlert | undefined;
      if (
        typeof alert !== "object" || alert === null
        || typeof (alert as { labels?: unknown }).labels !== "object" || (alert as { labels?: unknown }).labels === null
        || typeof (alert as { startsAt?: unknown }).startsAt !== "string"
      ) {
        throw invalidShape(
          scenario,
          `${invalidPrefix}${SCENARIO_FILES.timeline} step ${index}: op "alert-fire" requires an "alert" object with "labels" and "startsAt"`,
        );
      }
      return { op, alert };
    }
    case "alert-resolve": {
      const alertname = detail.alertname;
      const instance = detail.instance;
      if (typeof alertname !== "string" || alertname === "" || typeof instance !== "string" || instance === "") {
        throw invalidShape(
          scenario,
          `${invalidPrefix}${SCENARIO_FILES.timeline} step ${index}: op "alert-resolve" requires non-empty strings "alertname" and "instance"`,
        );
      }
      return { op, alertname, instance };
    }
    case "check-fail":
    case "check-pass": {
      const endpoint = detail.endpoint;
      if (typeof endpoint !== "string" || endpoint === "") {
        throw invalidShape(
          scenario,
          `${invalidPrefix}${SCENARIO_FILES.timeline} step ${index}: op "${op}" requires a non-empty string "endpoint"`,
        );
      }
      return { op, endpoint };
    }
    case "outage-begin":
    case "outage-end": {
      const source = detail.source;
      if (typeof source !== "string" || !OUTAGE_SOURCES.has(source)) {
        throw invalidShape(
          scenario,
          `${invalidPrefix}${SCENARIO_FILES.timeline} step ${index}: op "${op}" requires "source" to be one of vm, alertmanager, gatus, vmalert`,
        );
      }
      return { op, source: source as MockSource };
    }
  }
  // Exhaustiveness — KNOWN_OPS covers every op above.
  throw invalidShape(
    scenario,
    `${invalidPrefix}${SCENARIO_FILES.timeline} step ${index}: unknown op "${op}"`,
  );
}
