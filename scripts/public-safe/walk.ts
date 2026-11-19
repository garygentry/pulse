/**
 * Scan-set file walk. A filesystem walk, not a git-index query: CI checkouts hold only tracked files, and
 * locally an untracked file under a tracked root is scanned too, since it is about to be committed.
 * Symlinks are never followed.
 */

import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { ScanInput, ScanSet } from "./types.js";

/** Tracked scan roots. */
export const TRACKED_ROOTS = ["contract", "apps/ios"] as const;
/** Local spec root, scanned only for the set "tracked+local-specs". */
export const LOCAL_SPEC_ROOT = "specs/ios";
/**
 * Directory names never entered, in any set and at any depth. The Xcode entries hold build state and
 * per-user state that records absolute paths.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".build", "DerivedData", "xcuserdata"]);
/** Extra directory names skipped at any depth under the local spec root. */
export const LOCAL_SPEC_SKIP_DIRS: ReadonlySet<string> = new Set([".verification", "backlogs", ".rauf", "logs"]);
/** File names skipped under the local spec root. */
export const LOCAL_SPEC_SKIP_FILE_RE = /\.(?:log|ndjson)$/i;
/** Extensions treated as binary without inspecting content. */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "icns", "heic", "pdf", "zip", "gz", "tgz", "xz", "bz2", "7z", "tar",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "wav", "caf", "car", "a", "o", "dylib", "so",
  "mobileprovision", "p12", "cer", "der", "sqlite", "db",
]);
/** Bytes inspected for a NUL to detect binaries. */
export const BINARY_SNIFF_BYTES = 8192;

/** Result of walking one scan set. */
export interface WalkReport {
  /** Text files to scan, sorted by path; paths repo-relative with "/" separators. */
  readonly files: readonly ScanInput[];
  /** Text files found under contract/. */
  readonly contractFileCount: number;
  /** Files contributed by the tracked set. */
  readonly trackedCount: number;
  /** Files contributed by the local spec root; null when the set was not requested or the root is absent. */
  readonly localSpecCount: number | null;
  /** Roots that were absent or were themselves symlinks, e.g. "apps/ios". */
  readonly skippedRoots: readonly string[];
  /** Files skipped as binary. */
  readonly skippedBinary: number;
  /** Symlinks not followed. */
  readonly skippedSymlinks: number;
}

/** Binary when the extension is in BINARY_EXTENSIONS or a NUL byte occurs in the first BINARY_SNIFF_BYTES bytes. Pure. */
export function isBinary(path: string, bytes: Uint8Array): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot !== -1 && BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) return true;
  const end = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Walk the requested scan set under repoRoot.
 * @throws the underlying Node error for any I/O failure other than an absent root
 */
export async function walkScanSet(repoRoot: string, set: ScanSet): Promise<WalkReport> {
  const files: ScanInput[] = [];
  const skippedRoots: string[] = [];
  const decoder = new TextDecoder("utf-8");
  let skippedBinary = 0;
  let skippedSymlinks = 0;

  async function walkDir(dir: string, local: boolean): Promise<void> {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const abs = join(dir, name);
      const stats = await lstat(abs);
      if (stats.isSymbolicLink()) {
        skippedSymlinks += 1;
      } else if (stats.isDirectory()) {
        if (SKIP_DIRS.has(name) || (local && LOCAL_SPEC_SKIP_DIRS.has(name))) continue;
        await walkDir(abs, local);
      } else if (stats.isFile()) {
        if (local && LOCAL_SPEC_SKIP_FILE_RE.test(name)) continue;
        const path = relative(repoRoot, abs).replaceAll("\\", "/");
        const bytes = await readFile(abs);
        if (isBinary(path, bytes)) {
          skippedBinary += 1;
          continue;
        }
        files.push({ path, text: decoder.decode(bytes) });
      }
    }
  }

  /** Returns the number of files the root contributed, or null when the root was skipped. */
  async function walkRoot(root: string, local: boolean): Promise<number | null> {
    const abs = join(repoRoot, root);
    let stats;
    try {
      stats = await lstat(abs);
    } catch (error) {
      if (!isMissing(error)) throw error;
      skippedRoots.push(root);
      return null;
    }
    if (stats.isSymbolicLink()) {
      skippedRoots.push(root);
      skippedSymlinks += 1;
      return null;
    }
    if (!stats.isDirectory()) {
      skippedRoots.push(root);
      return null;
    }
    const before = files.length;
    await walkDir(abs, local);
    return files.length - before;
  }

  let trackedCount = 0;
  for (const root of TRACKED_ROOTS) trackedCount += (await walkRoot(root, false)) ?? 0;
  const localSpecCount = set === "tracked+local-specs" ? await walkRoot(LOCAL_SPEC_ROOT, true) : null;

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files,
    contractFileCount: files.filter((file) => file.path.startsWith("contract/")).length,
    trackedCount,
    localSpecCount,
    skippedRoots,
    skippedBinary,
    skippedSymlinks,
  };
}
