// apps/web/tests/contract/fixtures-fresh.test.ts — the committed `contract/**` equals the in-memory
// generation, byte for byte. CONTRACT.md is in the generated set, so its generated sections are covered.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { GeneratedFile } from "../../scripts/contract/types.js";
import { generated, GENERATION_TIMEOUT, REPO_ROOT } from "./generated.js";

function readIfPresent(path: string): Uint8Array | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Repo-relative paths of every file under `dir`, forward slashes. Empty when `dir` is absent. */
function walk(repoRoot: string, dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(join(repoRoot, dir), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap((entry) =>
    entry.isDirectory() ? walk(repoRoot, `${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
  );
}

/** The out-of-date report for a tree, or null when the tree equals the generation. */
function freshnessReport(repoRoot: string, files: readonly GeneratedFile[]): string | null {
  const lines: string[] = [];
  for (const file of files) {
    const onDisk = readIfPresent(join(repoRoot, file.path));
    if (onDisk === null) lines.push(`  + ${file.path}`);
    else if (Buffer.compare(onDisk, file.bytes) !== 0) lines.push(`  M ${file.path}`);
  }
  const expected = new Set(files.map((file) => file.path));
  const present = [...walk(repoRoot, "contract/fixtures"), "contract/index.json"].sort();
  for (const path of present) {
    if (!expected.has(path) && readIfPresent(join(repoRoot, path)) !== null) lines.push(`  - ${path}`);
  }
  if (lines.length === 0) return null;
  const order = (line: string): number => "M+-".indexOf(line[2]!);
  lines.sort((a, b) => order(a) - order(b));
  return ["contract artifacts are out of date:", ...lines, "run: bun run contract:gen"].join("\n");
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway root holding exactly the generated tree. */
function writtenCopy(files: readonly GeneratedFile[]): string {
  const root = mkdtempSync(join(tmpdir(), "contract-fresh-"));
  scratch.push(root);
  for (const file of files) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), file.bytes);
  }
  return root;
}

describe("committed contract artifacts", () => {
  test("equal the in-memory generation", async () => {
    const report = freshnessReport(REPO_ROOT, await generated());
    if (report !== null) throw new Error(report);
  }, GENERATION_TIMEOUT);
});

describe("the freshness report", () => {
  test("is empty for a tree written from the generation", async () => {
    expect(freshnessReport(writtenCopy(await generated()), await generated())).toBeNull();
  }, GENERATION_TIMEOUT);

  test("lists modified, missing and stale paths, then the command that fixes them", async () => {
    const files = await generated();
    const root = writtenCopy(files);
    const modified = "contract/fixtures/overview/typical.json";
    const bytes = readFileSync(join(root, modified));
    bytes[10] = bytes[10]! ^ 1;
    writeFileSync(join(root, modified), bytes);
    const doc = readFileSync(join(root, "contract/CONTRACT.md"), "utf8");
    writeFileSync(join(root, "contract/CONTRACT.md"), doc.replace("| Response | Limit |", "| Response | Limits |"));
    rmSync(join(root, "contract/fixtures/alerts/max-size.json"));
    writeFileSync(join(root, "contract/fixtures/alerts/old.json"), "{}\n");

    expect(freshnessReport(root, files)).toBe(
      [
        "contract artifacts are out of date:",
        "  M contract/CONTRACT.md",
        "  M contract/fixtures/overview/typical.json",
        "  + contract/fixtures/alerts/max-size.json",
        "  - contract/fixtures/alerts/old.json",
        "run: bun run contract:gen",
      ].join("\n"),
    );
  }, GENERATION_TIMEOUT);

  test("a missing index is reported as missing, not as stale", async () => {
    const files = await generated();
    const root = writtenCopy(files);
    rmSync(join(root, "contract/index.json"));
    expect(freshnessReport(root, files)).toBe(
      ["contract artifacts are out of date:", "  + contract/index.json", "run: bun run contract:gen"].join("\n"),
    );
  }, GENERATION_TIMEOUT);
});
