// apps/web/tests/contract/generated.ts — the one in-memory contract generation every generator-backed test
// shares. Generation is memoised per process; no test file generates on its own.

import { resolve } from "node:path";

import { currentShape as extractedShape, generateContract } from "../../scripts/contract/generate.js";
import type { ShapeSnapshot } from "../../scripts/contract/shape-types.js";
import type { FixtureIndex, GeneratedFile } from "../../scripts/contract/types.js";

/** Absolute repository root. */
export const REPO_ROOT = resolve(import.meta.dir, "../../../..");
/** Timeout for a test that may be the first to wait for the generation. */
export const GENERATION_TIMEOUT = { timeout: 30_000 };

const DECODER = new TextDecoder();

let pending: Promise<{ readonly files: readonly GeneratedFile[]; readonly ms: number }> | undefined;

function run(): Promise<{ readonly files: readonly GeneratedFile[]; readonly ms: number }> {
  pending ??= (async () => {
    const started = performance.now();
    const files = await generateContract({ frozen: "report" });
    return { files, ms: performance.now() - started };
  })();
  return pending;
}

/** Every generated file. An existing frozen shape snapshot is emitted as committed, never replaced. */
export async function generated(): Promise<readonly GeneratedFile[]> {
  return (await run()).files;
}

/** Duration of the first, uncached generation in this process, shape extraction included. */
export async function firstGenerationMs(): Promise<number> {
  return (await run()).ms;
}

/**
 * The shape extracted from the current wire types: the same snapshot the generation used. It is available
 * even when the generation fails after extraction, so the shape checks can still name the changed paths.
 */
export async function currentShape(): Promise<ShapeSnapshot> {
  // Wait for the generation first, so its timing always includes the one extraction.
  await run().catch(() => undefined);
  return extractedShape(REPO_ROOT);
}

/** One generated file's text, by repo-relative path. */
export async function generatedText(path: string): Promise<string> {
  const file = (await generated()).find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`not generated: ${path}`);
  return DECODER.decode(file.bytes);
}

/** The generated fixture index. */
export async function fixtureIndex(): Promise<FixtureIndex> {
  return JSON.parse(await generatedText("contract/index.json")) as FixtureIndex;
}
