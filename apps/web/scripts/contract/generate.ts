// Generator for the committed contract artifacts under `contract/`: the fixtures, the fixture index, the
// frozen shape snapshot and the generated sections of CONTRACT.md.
//
// `generateContract` builds every file in memory and writes nothing, so the freshness checks can compare
// its output with the working tree. `bun run contract:gen` writes the result.

import { mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { CONTRACT_VERSION, formatContractVersion } from "@pulse/web-data/contract";
import { canonicalJson } from "@pulse/web-data/cycle";

import { buildGeneratedSections, CONTRACT_DOC_PATH, renderContractDoc } from "./contract-doc.js";
import { ContractToolError } from "./errors.js";
import { extractShape } from "./extract-shape.js";
import { buildUnknownEnumFixtures, createScenarioContext, SCENARIO_MODULES } from "./scenarios/index.js";
import type { ShapeSnapshot } from "./shape-types.js";
import { resetHandlerGlobals } from "./stub-context.js";
import type { FixtureIndex, FixtureIndexEntry, GeneratedFile, ScenarioFixture } from "./types.js";

/** How `generateContract` treats an existing frozen shape snapshot whose bytes differ from the extraction. */
export type FrozenPolicy =
  /** Throw `ContractToolError` SNAPSHOT_FROZEN (the CLI default). */
  | "enforce"
  /** Emit the existing frozen bytes unchanged, so a check can report the drift instead. */
  | "report";

/** Options for one generation. Every field is optional; the defaults are the real repository. */
export interface GenerateOptions {
  /** Absolute repository root. Default: resolved from this file's location. */
  readonly repoRoot?: string;
  /** Frozen-snapshot policy. Default "enforce". */
  readonly frozen?: FrozenPolicy;
  /** Test seam: replace shape extraction. A generation with this set is never memoised. */
  readonly extract?: (repoRoot: string) => ShapeSnapshot;
}

/** What `writeGenerated` did. */
export interface WriteSummary {
  /** Files in the generated set. */
  readonly written: number;
  /** Files created or replaced because their bytes differed. */
  readonly changed: number;
  /** Stale fixture files deleted. */
  readonly removed: number;
}

const DEFAULT_REPO_ROOT = resolve(import.meta.dir, "../../../..");
const CONTRACT_DIR = "contract";
const FIXTURES_DIR = `${CONTRACT_DIR}/fixtures`;
const SCENARIO_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ENCODER = new TextEncoder();
const NEWLINE = 0x0a;

const memo = new Map<string, Promise<readonly GeneratedFile[]>>();
const shapeMemo = new Map<string, ShapeSnapshot>();

/**
 * The shape extracted from the repository's wire types, memoised per process for each repository root.
 * A memoised generation uses the same snapshot, so a check that needs both pays for one extraction.
 *
 * @throws {ContractToolError} SHAPE_UNSUPPORTED_TYPE from shape extraction
 */
export function currentShape(repoRoot: string = DEFAULT_REPO_ROOT): ShapeSnapshot {
  let shape = shapeMemo.get(repoRoot);
  if (shape === undefined) {
    shape = extractShape(repoRoot);
    shapeMemo.set(repoRoot, shape);
  }
  return shape;
}

/**
 * Produce every generated contract artifact in memory. Reads the repository (sources, the existing
 * CONTRACT.md, the existing frozen shape) and writes nothing.
 *
 * Output: `contract/index.json`, every `contract/fixtures/<group>/<scenario>.<json|sse>`,
 * `contract/shape/<major>.<minor>.json` for CONTRACT_VERSION and `contract/CONTRACT.md`, sorted by path
 * (code-unit order). The result is memoised per process for each (repoRoot, frozen) pair.
 *
 * @throws {ContractToolError} SCENARIO_INVALID for a bad or duplicate scenario slug, a fixture in the wrong
 *   group, a kind/status mismatch, or a builder that could not produce its fixture
 * @throws {ContractToolError} SHAPE_UNSUPPORTED_TYPE from shape extraction
 * @throws {ContractToolError} SNAPSHOT_FROZEN when `frozen` is "enforce" and the shape file exists with other bytes
 * @throws {ContractToolError} MARKER_MISSING from the CONTRACT.md section rewrite
 * @throws {CanonicalJsonError} when a builder produced undefined, non-finite or non-plain data
 */
export function generateContract(options: GenerateOptions = {}): Promise<readonly GeneratedFile[]> {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const frozen = options.frozen ?? "enforce";
  if (options.extract !== undefined) return generate(repoRoot, frozen, options.extract);
  const key = `${frozen}\n${repoRoot}`;
  let pending = memo.get(key);
  if (pending === undefined) {
    pending = generate(repoRoot, frozen, currentShape);
    memo.set(key, pending);
  }
  return pending;
}

async function generate(
  repoRoot: string,
  frozen: FrozenPolicy,
  extract: (repoRoot: string) => ShapeSnapshot,
): Promise<readonly GeneratedFile[]> {
  const shape = extract(repoRoot);
  const fixtures = await buildFixtures(shape);

  const files: GeneratedFile[] = [];
  const entries: FixtureIndexEntry[] = [];
  for (const fixture of fixtures) {
    const { entry } = fixture;
    const path = `fixtures/${entry.group}/${entry.scenario}${entry.kind === "stream" ? ".sse" : ".json"}`;
    entries.push({ ...entry, path });
    // A transcript already ends with the blank line of its last frame; JSON gets one trailing newline.
    const bytes = isTranscript(fixture) ? ENCODER.encode(fixture.body.sse) : jsonBytes(fixture.body);
    files.push({ path: `${CONTRACT_DIR}/${path}`, bytes });
  }

  entries.sort((a, b) => compareCodeUnits(a.path, b.path));
  const index: FixtureIndex = { formatVersion: 1, contract: CONTRACT_VERSION, fixtures: entries };
  files.push({ path: `${CONTRACT_DIR}/index.json`, bytes: jsonBytes(index) });

  files.push(await shapeFile(repoRoot, frozen, shape));

  const currentDoc = await readFile(join(repoRoot, CONTRACT_DOC_PATH), "utf8");
  const doc = renderContractDoc(currentDoc, buildGeneratedSections({ snapshot: shape, index }));
  files.push({ path: CONTRACT_DOC_PATH, bytes: ENCODER.encode(doc) });

  return Object.freeze(files.sort((a, b) => compareCodeUnits(a.path, b.path)));
}

/** Run every scenario module and the derived pass, then validate the combined set. */
async function buildFixtures(shape: ShapeSnapshot): Promise<readonly ScenarioFixture[]> {
  const ctx = createScenarioContext();
  const fixtures: ScenarioFixture[] = [];
  try {
    for (const module of SCENARIO_MODULES) {
      for (const fixture of await module.build(ctx)) {
        const { entry } = fixture;
        if (entry.group !== module.group || entry.operation !== module.operation) {
          throw new ContractToolError(
            "SCENARIO_INVALID",
            `${entry.group}/${entry.scenario}`,
            `the ${module.group} module emitted a fixture for another group or operation`,
          );
        }
        fixtures.push(fixture);
      }
    }
    fixtures.push(...buildUnknownEnumFixtures(shape, fixtures, ctx));
  } finally {
    // Real handlers ran in this process: leave no write-path provider or metric series behind.
    resetHandlerGlobals();
  }

  const seen = new Set<string>();
  for (const { entry } of fixtures) {
    const subject = `${entry.group}/${entry.scenario}`;
    if (!SCENARIO_SLUG.test(entry.scenario)) {
      throw new ContractToolError("SCENARIO_INVALID", subject, "scenario slug is not kebab-case");
    }
    if (seen.has(subject)) throw new ContractToolError("SCENARIO_INVALID", subject, "duplicate scenario in its group");
    seen.add(subject);
    const hasStatus = entry.kind === "response" || entry.kind === "error";
    if (hasStatus !== (entry.status !== null)) {
      throw new ContractToolError("SCENARIO_INVALID", subject, `kind ${entry.kind} does not match status ${entry.status}`);
    }
  }
  return fixtures;
}

/** The shape snapshot file for CONTRACT_VERSION, honouring the frozen policy. */
async function shapeFile(repoRoot: string, frozen: FrozenPolicy, shape: ShapeSnapshot): Promise<GeneratedFile> {
  const version = formatContractVersion(CONTRACT_VERSION);
  const path = `${CONTRACT_DIR}/shape/${version}.json`;
  const bytes = jsonBytes(shape);
  const existing = await readIfPresent(join(repoRoot, path));
  if (existing === null || sameBytes(existing, bytes)) return { path, bytes };
  if (frozen === "report") return { path, bytes: existing };
  throw new ContractToolError(
    "SNAPSHOT_FROZEN",
    path,
    `${path} is frozen; wire types changed — bump CONTRACT_VERSION in packages/web-data/src/contract/version.ts`,
  );
}

/**
 * Write the files, each atomically, and delete stale files under `contract/fixtures/`. A file whose bytes
 * already match is left alone. Nothing else under `contract/` is touched.
 *
 * @throws {Error} filesystem errors propagate; the temporary directory is removed in every case
 */
export async function writeGenerated(repoRoot: string, files: readonly GeneratedFile[]): Promise<WriteSummary> {
  // Inside the repository root, so the temp dir shares a filesystem with `contract/` and rename is atomic.
  const temp = await mkdtemp(join(repoRoot, ".contract-gen-"));
  let changed = 0;
  let removed = 0;
  try {
    for (const [i, file] of files.entries()) {
      const target = join(repoRoot, file.path);
      const existing = await readIfPresent(target);
      if (existing !== null && sameBytes(existing, file.bytes)) continue;
      const staged = join(temp, String(i));
      await writeFile(staged, file.bytes);
      await mkdir(dirname(target), { recursive: true });
      await rename(staged, target);
      changed += 1;
    }
    const keep = new Set(files.map((file) => file.path));
    removed = await removeStale(repoRoot, FIXTURES_DIR, keep);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return { written: files.length, changed, removed };
}

/** Delete files under `dir` (repo-relative) that are not in `keep`, then the directory if it is empty. */
async function removeStale(repoRoot: string, dir: string, keep: ReadonlySet<string>): Promise<number> {
  let entries;
  try {
    entries = await readdir(join(repoRoot, dir), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
  let removed = 0;
  let remaining = entries.length;
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      removed += await removeStale(repoRoot, path, keep);
      if ((await readdir(join(repoRoot, path))).length === 0) {
        await rmdir(join(repoRoot, path));
        remaining -= 1;
      }
    } else if (!keep.has(path)) {
      await rm(join(repoRoot, path));
      removed += 1;
      remaining -= 1;
    }
  }
  return removed;
}

/**
 * CLI entry: generate with the frozen snapshot enforced, then write.
 *
 * @param argv - Command-line arguments after the script name. `--write` (the default) is the only one accepted.
 * @returns The process exit code: 0 on success, 1 on any error
 */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    const unknown = argv.find((arg) => arg !== "--write");
    if (unknown !== undefined) throw new Error(`unknown argument ${unknown}; usage: bun run contract:gen [--write]`);
    const files = await generateContract({ frozen: "enforce" });
    const summary = await writeGenerated(DEFAULT_REPO_ROOT, files);
    console.log(`contract: wrote ${summary.written} files (${summary.changed} changed, ${summary.removed} removed)`);
    return 0;
  } catch (error) {
    if (error instanceof ContractToolError) {
      console.error(`${error.code}: ${error.message}\n  at ${error.subject}`);
    } else {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    return 1;
  }
}

type TranscriptFixture = Extract<ScenarioFixture, { readonly body: { readonly sse: string } }>;

function isTranscript(fixture: ScenarioFixture): fixture is TranscriptFixture {
  return fixture.entry.kind === "stream";
}

function jsonBytes(value: unknown): Uint8Array {
  const json = canonicalJson(value);
  const bytes = new Uint8Array(json.length + 1);
  bytes.set(json);
  bytes[json.length] = NEWLINE;
  return bytes;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
