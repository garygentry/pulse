// packages/renderer/src/diff.ts

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ConfigIoError } from "@pulse/core";

import type { RenderedTree } from "./tree.js";
import { MANIFEST_FILENAME, type RenderedManifest } from "./manifest.js";
import { compareString } from "./order.js";

/** The kind of drift a `--check` diff can report for one tree-relative path. */
export type DriftKind =
  | "added" //   present in the freshly-rendered tree, absent on disk (forgotten re-render)
  | "removed" // present on disk, absent in the freshly-rendered tree (stale/hand-added file)
  | "changed"; // present in both, contents differ (hand-edited output)

/**
 * One drift finding from `diffTree` (REQ-RND-07). Carries no file contents (only the path
 * and kind) so the `--json` `data.drift` payload stays lean and diff-reviewable.
 */
export interface DriftEntry {
  /** The tree-relative path that drifted (POSIX separators). */
  path: string;
  /** How it drifted. */
  kind: DriftKind;
}

/**
 * Read-only drift diff (REQ-RND-07): compare a freshly-rendered in-memory `tree` against the
 * committed on-disk tree under `outputRoot` WITHOUT writing anything. Powers `render --check`.
 *
 * The committed managed-file set is enumerated from the on-disk `.rendered-manifest.json` ledger
 * (NOT a directory walk), so unrelated repo files are never flagged as `removed`. The manifest
 * file itself is a normal member of both sets, so a change to the managed-file list surfaces as a
 * `changed` on the manifest path.
 *
 * Drift is a normal (exit-1) outcome; a corrupt/unreadable committed manifest or file is a TOOL
 * fault (exit 2) and throws `ConfigIoError "UNREADABLE"` rather than being reported as drift.
 *
 * @param tree - The freshly-rendered in-memory tree (the source of truth for this run).
 * @param outputRoot - The committed output root to diff against (resolved to an absolute path).
 * @returns The drift entries, sorted by `(path, kind)` via `compareString`. `[]` means no drift.
 * @throws {ConfigIoError} `UNREADABLE` — the committed manifest or a committed file could not be
 *   read or parsed (a tool fault, never emitted as a `DriftEntry`).
 */
export function diffTree(tree: RenderedTree, outputRoot: string): DriftEntry[] {
  const root = resolve(outputRoot);
  const entries: DriftEntry[] = [];

  // (1) Index the freshly-rendered tree by path.
  const newByPath = new Map<string, string>(tree.map((f) => [f.path, f.contents] as const));

  // (2) The committed managed-file set (ledger-scoped), or null when never rendered.
  const committed = readCommittedManifestPaths(root);

  // (3) added / changed — walk the new tree against disk.
  for (const [path, contents] of newByPath) {
    const abs = join(root, path);
    if (!existsSync(abs)) {
      entries.push({ path, kind: "added" });
      continue;
    }
    let onDisk: string;
    try {
      onDisk = readFileSync(abs, "utf8");
    } catch (cause) {
      throw new ConfigIoError("UNREADABLE", `Could not read rendered file: ${abs}`, abs);
    }
    if (onDisk !== contents) entries.push({ path, kind: "changed" });
  }

  // (4) removed — committed paths dropped from the new tree but still physically present.
  if (committed !== null) {
    for (const path of committed) {
      if (newByPath.has(path)) continue;
      if (existsSync(join(root, path))) entries.push({ path, kind: "removed" });
    }
  }

  entries.sort((a, b) => compareString(a.path, b.path) || compareString(a.kind, b.kind));
  return entries;
}

/**
 * Read the committed `.rendered-manifest.json` ledger under `root`. Returns `null` when the
 * manifest is absent (the estate was never rendered here). Otherwise returns the set of every
 * committed managed path PLUS the manifest filename itself (a normal member of the tree). A read
 * or JSON-parse fault is a TOOL fault, not drift → `ConfigIoError "UNREADABLE"`.
 */
function readCommittedManifestPaths(root: string): Set<string> | null {
  const manifestPath = join(root, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return null;

  let parsed: RenderedManifest;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as RenderedManifest;
  } catch (cause) {
    throw new ConfigIoError("UNREADABLE", `Could not read committed manifest: ${manifestPath}`, manifestPath);
  }

  const paths = new Set<string>(parsed.files);
  paths.add(MANIFEST_FILENAME);
  return paths;
}
