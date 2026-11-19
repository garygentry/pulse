// apps/web/tests/contract/shape.test.ts — the frozen shape snapshots gate wire-type changes: the current
// extraction must equal the snapshot for CONTRACT_VERSION, a change since the previous snapshot must be
// matched by the version bump its class requires, and a frozen snapshot is never overwritten.

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTRACT_VERSION, formatContractVersion, type ContractVersion } from "@pulse/web-data/contract";
import { canonicalJson } from "@pulse/web-data/cycle";

import { classifyShapeDiff } from "../../scripts/contract/classify-shape-diff.js";
import { ContractToolError } from "../../scripts/contract/errors.js";
import { generateContract } from "../../scripts/contract/generate.js";
import type { ShapeNode, ShapeSnapshot } from "../../scripts/contract/shape-types.js";
import { currentShape, GENERATION_TIMEOUT, REPO_ROOT } from "./generated.js";

const SHAPE_DIR = join(REPO_ROOT, "contract/shape");
const DECODER = new TextDecoder();

/** The bytes the generator writes for a snapshot: canonical JSON and one trailing newline. */
function snapshotText(shape: ShapeSnapshot): string {
  return `${DECODER.decode(canonicalJson(shape))}\n`;
}

function readFrozen(version: ContractVersion): string | null {
  try {
    return readFileSync(join(SHAPE_DIR, `${formatContractVersion(version)}.json`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Why the current extraction does not match the frozen snapshot text for its version, or null. */
function frozenDrift(frozenText: string | null, current: ShapeSnapshot): string | null {
  if (frozenText === snapshotText(current)) return null;
  const header =
    "wire types changed; bump CONTRACT_VERSION in packages/web-data/src/contract/version.ts and run bun run contract:gen";
  if (frozenText === null) return header;
  const { changes } = classifyShapeDiff(JSON.parse(frozenText) as ShapeSnapshot, current);
  return [header, ...changes.map((change) => `  ${change.class} ${change.change} ${change.path}`)].join("\n");
}

/** Why the version of `current` is too low for its changes since the snapshot `previous`, or null. */
function bumpProblem(previous: ShapeSnapshot, current: ShapeSnapshot): string | null {
  const diff = classifyShapeDiff(previous, current);
  const p = previous.version;
  const c = current.version;
  const paths = [...new Set(diff.changes.filter((change) => change.class === diff.class).map((change) => change.path))].join(", ");
  const since = formatContractVersion(p);
  if (diff.class === "breaking" && c.major <= p.major) {
    return `breaking wire change since ${since}: ${paths}; bump CONTRACT_VERSION to ${p.major + 1}.0 and run bun run contract:gen`;
  }
  if (diff.class === "additive" && !(c.major > p.major || (c.major === p.major && c.minor > p.minor))) {
    return `additive wire change since ${since}: ${paths}; bump CONTRACT_VERSION to ${p.major}.${p.minor + 1} and run bun run contract:gen`;
  }
  return null;
}

function isBefore(a: ContractVersion, b: ContractVersion): boolean {
  return a.major < b.major || (a.major === b.major && a.minor < b.minor);
}

/** The highest frozen version below `version` among the snapshot file names, or null. */
function previousVersion(names: readonly string[], version: ContractVersion): ContractVersion | null {
  let best: ContractVersion | null = null;
  for (const name of names) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.json$/.exec(name);
    if (match === null) continue;
    const candidate = { major: Number(match[1]), minor: Number(match[2]) };
    if (isBefore(candidate, version) && (best === null || isBefore(best, candidate))) best = candidate;
  }
  return best;
}

type MutableNode = { -readonly [K in keyof ShapeNode]: ShapeNode[K] };
type MutableSnapshot = { version: ContractVersion; roots: Record<string, MutableNode[]> };

function mutable(shape: ShapeSnapshot): MutableSnapshot {
  return structuredClone(shape) as MutableSnapshot;
}

/** The committed snapshot for CONTRACT_VERSION: a stable base for the synthetic cases below. */
function frozenSnapshot(): ShapeSnapshot {
  return JSON.parse(readFrozen(CONTRACT_VERSION)!) as ShapeSnapshot;
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("frozen shape snapshots", () => {
  test("the current extraction equals the snapshot frozen for CONTRACT_VERSION", async () => {
    const problem = frozenDrift(readFrozen(CONTRACT_VERSION), await currentShape());
    if (problem !== null) throw new Error(problem);
  }, GENERATION_TIMEOUT);

  test("a change since the previous frozen snapshot is matched by the version bump", async () => {
    const names = readdirSync(SHAPE_DIR);
    expect(names).toContain(`${formatContractVersion(CONTRACT_VERSION)}.json`);
    for (const name of names) expect(name).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.json$/);
    const previous = previousVersion(names, CONTRACT_VERSION);
    if (previous === null) return; // The first frozen version has nothing before it.
    const snapshot = JSON.parse(readFrozen(previous)!) as ShapeSnapshot;
    expect(snapshot.version).toEqual(previous);
    const problem = bumpProblem(snapshot, await currentShape());
    if (problem !== null) throw new Error(problem);
  }, GENERATION_TIMEOUT);

  test("the generator refuses to overwrite a frozen snapshot with other content", async () => {
    const root = mkdtempSync(join(tmpdir(), "contract-shape-"));
    scratch.push(root);
    mkdirSync(join(root, "contract"), { recursive: true });
    cpSync(SHAPE_DIR, join(root, "contract/shape"), { recursive: true });
    const frozenBefore = readFileSync(join(root, "contract/shape", `${formatContractVersion(CONTRACT_VERSION)}.json`));

    const mutated = mutable(frozenSnapshot());
    const node = mutated.roots.SessionPayload![0]!;
    node.optional = !node.optional;
    const attempt = generateContract({ repoRoot: root, frozen: "enforce", extract: () => mutated });
    await expect(attempt).rejects.toBeInstanceOf(ContractToolError);
    await expect(attempt).rejects.toMatchObject({
      code: "SNAPSHOT_FROZEN",
      subject: `contract/shape/${formatContractVersion(CONTRACT_VERSION)}.json`,
    });
    expect(readdirSync(join(root, "contract"))).toEqual(["shape"]);
    expect(
      readFileSync(join(root, "contract/shape", `${formatContractVersion(CONTRACT_VERSION)}.json`)).equals(frozenBefore),
    ).toBe(true);
  }, GENERATION_TIMEOUT);
});

describe("drift report against the frozen snapshot", () => {
  const HEADER =
    "wire types changed; bump CONTRACT_VERSION in packages/web-data/src/contract/version.ts and run bun run contract:gen";

  test("no drift when the extraction serialises to the frozen bytes", () => {
    const current = frozenSnapshot();
    expect(frozenDrift(snapshotText(current), current)).toBeNull();
  });

  test("a removed field is reported with its class, change and path", () => {
    const current = frozenSnapshot();
    const changed = mutable(current);
    changed.roots.SessionPayload = changed.roots.SessionPayload!.filter((node) => node.path !== "SessionPayload.authMode");
    expect(changed.roots.SessionPayload).toHaveLength(current.roots.SessionPayload!.length - 1);
    expect(frozenDrift(snapshotText(current), changed)).toBe(
      `${HEADER}\n  breaking field-removed SessionPayload.authMode`,
    );
  });

  test("an added optional field is reported as additive", () => {
    const current = frozenSnapshot();
    const changed = mutable(current);
    changed.roots.SessionPayload!.push({ path: "SessionPayload.zzz", kind: "string", optional: true, nullable: false });
    expect(frozenDrift(snapshotText(current), changed)).toBe(`${HEADER}\n  additive field-added SessionPayload.zzz`);
  });

  test("a missing snapshot file is reported without a change list", () => {
    expect(frozenDrift(null, frozenSnapshot())).toBe(HEADER);
  });
});

describe("version bump required since the previous snapshot", () => {
  const node = (path: string, extra: Partial<ShapeNode> = {}): ShapeNode => ({
    path,
    kind: "string",
    optional: false,
    nullable: false,
    ...extra,
  });
  const snapshot = (major: number, minor: number, nodes: readonly ShapeNode[]): ShapeSnapshot => ({
    version: { major, minor },
    roots: { Root: nodes },
  });
  const BASE = [node("Root.a"), node("Root.b")];
  const REMOVED = [node("Root.a")];
  const ADDED = [...BASE, node("Root.c", { optional: true })];

  test("a breaking change needs a higher major", () => {
    const message = "breaking wire change since 1.2: Root.b; bump CONTRACT_VERSION to 2.0 and run bun run contract:gen";
    expect(bumpProblem(snapshot(1, 2, BASE), snapshot(1, 2, REMOVED))).toBe(message);
    expect(bumpProblem(snapshot(1, 2, BASE), snapshot(1, 3, REMOVED))).toBe(message);
    expect(bumpProblem(snapshot(1, 2, BASE), snapshot(2, 0, REMOVED))).toBeNull();
  });

  test("an additive change needs a higher minor or a higher major", () => {
    const message = "additive wire change since 1.2: Root.c; bump CONTRACT_VERSION to 1.3 and run bun run contract:gen";
    expect(bumpProblem(snapshot(1, 2, BASE), snapshot(1, 2, ADDED))).toBe(message);
    expect(bumpProblem(snapshot(1, 2, BASE), snapshot(1, 3, ADDED))).toBeNull();
    expect(bumpProblem(snapshot(1, 2, BASE), snapshot(2, 0, ADDED))).toBeNull();
  });

  test("a breaking message lists only the breaking paths", () => {
    const both = [node("Root.a"), node("Root.c", { optional: true })];
    expect(bumpProblem(snapshot(1, 0, BASE), snapshot(1, 1, both))).toBe(
      "breaking wire change since 1.0: Root.b; bump CONTRACT_VERSION to 2.0 and run bun run contract:gen",
    );
  });

  test("no shape change always passes: a capability-only minor bump is legal", () => {
    expect(bumpProblem(snapshot(1, 0, BASE), snapshot(1, 1, BASE))).toBeNull();
    expect(bumpProblem(snapshot(1, 0, BASE), snapshot(1, 0, BASE))).toBeNull();
  });

  test("the previous snapshot is the highest version below the current one", () => {
    const names = ["1.0.json", "1.2.json", "1.10.json", "2.0.json", "2.1.json", "notes.txt"];
    expect(previousVersion(names, { major: 2, minor: 1 })).toEqual({ major: 2, minor: 0 });
    expect(previousVersion(names, { major: 2, minor: 0 })).toEqual({ major: 1, minor: 10 });
    expect(previousVersion(names, { major: 1, minor: 2 })).toEqual({ major: 1, minor: 0 });
    expect(previousVersion(names, { major: 1, minor: 0 })).toBeNull();
  });
});
