// packages/renderer/src/materialize.ts

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { RenderedTree } from "./tree.js";

/** Stable codes for materialize IO/safety faults (write-side analogue of ConfigIoError). */
export type RenderIoErrorCode =
  | "STAGE_FAILED" //  could not create/populate the staging dir
  | "WRITE_FAILED" //  a staged file write failed
  | "SWAP_FAILED" //   the atomic rename/replace failed
  | "PATH_ESCAPE"; //  a rendered path resolved outside outputRoot (REQ-RND-03 guard)

/**
 * Thrown by `materialize` for a write-side IO or path-containment fault. Structurally
 * identical to core's `ConfigIoError` (a typed `code` on an `Error`). The CLI's single
 * top-level catch (`04 §…`) maps ANY thrown error → exit `2` (REQ-CLI-02b), so the exact
 * class is immaterial to the exit contract; the typed `code` aids the stderr diagnostic.
 */
export class RenderIoError extends Error {
  readonly code: RenderIoErrorCode;
  readonly path?: string;
  constructor(code: RenderIoErrorCode, message: string, path?: string) {
    super(message);
    this.name = "RenderIoError";
    this.code = code;
    if (path !== undefined) this.path = path;
    Object.setPrototypeOf(this, RenderIoError.prototype); // instanceof across ESM
  }
}

/**
 * Atomically write the complete in-memory rendered tree under `outputRoot`, crash-safely
 * (REQ-RND-06). The tree is written into a sibling staging directory, fsync'd, then swapped into
 * place, replacing the previous root wholesale so a target for a host removed from the estate
 * disappears (REQ-RND-03, "owns its tree"). An interrupted run leaves at most a staging (or
 * backup) directory, NEVER a partially written `outputRoot`.
 *
 * Single-writer assumed (REQ-CONC-01): no file locking. `materialize` does NOT compute the
 * manifest — it writes the tree's `.rendered-manifest.json` member like any other file.
 *
 * @throws {RenderIoError} `PATH_ESCAPE` / `STAGE_FAILED` / `WRITE_FAILED` / `SWAP_FAILED`.
 */
export function materialize(tree: RenderedTree, outputRoot: string): void {
  const root = resolve(outputRoot);
  const parent = dirname(root);
  const base = basename(root);
  const stagingDir = join(parent, `${base}.tmp-${nextIndex(parent, base, "tmp")}`);

  // (1) Guard first — pure string math, no side effects (§3.3).
  assertContained(tree, stagingDir);

  // (2) Stage: write the FULL tree into the staging dir, then fsync for durability.
  try {
    mkdirSync(stagingDir, { recursive: true });
  } catch (cause) {
    throw new RenderIoError("STAGE_FAILED", `could not create staging dir: ${msg(cause)}`, stagingDir);
  }
  for (const file of tree) {
    const abs = join(stagingDir, file.path);
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.contents, "utf8"); // contents already canonical + trailing NL (02 §5)
      fsyncPath(abs); // persist file data before the swap
    } catch (cause) {
      throw new RenderIoError("WRITE_FAILED", `could not write ${file.path}: ${msg(cause)}`, abs);
    }
  }
  fsyncPath(stagingDir); // persist the staging dir entries (Linux; CON-03)

  // (3) Swap: promote the staging tree to `root`, replacing the old root wholesale.
  swapIntoPlace(stagingDir, root, parent, base);
}

/**
 * The next monotonic index for a sibling helper directory `<base>.<suffix>-<n>`. Scans the parent
 * for existing matches and returns (max seen) + 1, or 0 when none exist or the parent is not yet
 * readable. Derived from filesystem state ONLY — no Date.now / no process.pid (REQ-DET-01).
 */
function nextIndex(parent: string, base: string, suffix: "tmp" | "bak"): number {
  const re = new RegExp(`^${escapeRe(base)}\\.${suffix}-(\\d+)$`);
  let max = -1;
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return 0; // parent does not exist yet (first render) — mkdir(recursive) creates it
  }
  for (const name of entries) {
    const m = re.exec(name);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

/** Escape a directory basename for safe embedding in a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Assert every rendered path is contained within `stagingDir`. Throws before any write, so a path
 * escape can never produce a partial staging tree (REQ-RND-03).
 * @throws {RenderIoError} `PATH_ESCAPE` on an absolute path, a `..`-escape, or a path that
 *         resolves to the staging dir itself.
 */
function assertContained(tree: RenderedTree, stagingDir: string): void {
  for (const file of tree) {
    if (isAbsolute(file.path)) {
      throw new RenderIoError("PATH_ESCAPE", `rendered path is absolute: ${file.path}`, file.path);
    }
    const abs = resolve(stagingDir, file.path);
    const rel = relative(stagingDir, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new RenderIoError("PATH_ESCAPE", `rendered path escapes output root: ${file.path}`, file.path);
    }
  }
}

/**
 * Atomically replace `root` with the fully-staged `stagingDir`. If `root` exists it is first
 * renamed aside to a `<base>.bak-<n>` sibling; then `stagingDir` is renamed onto `root`; then the
 * backup is removed. Every intermediate state holds a COMPLETE tree at `root` (the old one), or
 * `root` briefly absent with a complete tree at both the backup and staging — never a partially
 * written `root` (REQ-RND-06).
 * @throws {RenderIoError} `SWAP_FAILED` on any rename failure (best-effort restores the old root).
 */
function swapIntoPlace(stagingDir: string, root: string, parent: string, base: string): void {
  const hadRoot = existsSync(root);
  let backup: string | null = null;
  try {
    if (hadRoot) {
      backup = join(parent, `${base}.bak-${nextIndex(parent, base, "bak")}`);
      renameSync(root, backup); // (A) park the old complete tree aside
    }
    renameSync(stagingDir, root); // (B) promote the new complete tree
  } catch (cause) {
    // If (B) failed after (A), restore the old tree so `root` is never left absent.
    if (backup !== null && !existsSync(root)) {
      try {
        renameSync(backup, root);
      } catch {
        /* leave backup for manual recovery */
      }
    }
    throw new RenderIoError("SWAP_FAILED", `atomic swap failed: ${msg(cause)}`, root);
  }
  try {
    fsyncPath(parent);
  } catch {
    /* durability of the rename is best-effort */
  }
  if (backup !== null) {
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch {
      /* stale backup is inert */
    }
  }
}

/** fsync a file or directory by path (Linux directory-fsync persists its entries; CON-03). */
function fsyncPath(p: string): void {
  const fd = openSync(p, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Normalize an unknown thrown cause to a message string for diagnostics. */
function msg(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
