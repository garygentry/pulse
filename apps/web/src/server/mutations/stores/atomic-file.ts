// apps/web/src/server/mutations/stores/atomic-file.ts — the crash-safe file write primitive shared by
// the ack store (replace mode) and the proposal store (`exclusive` mode).
//
// The function holds no lock: callers serialize writes to the same path (the ack store's write chain,
// unique proposal ids). Leftover `<base>.tmp-<pid>-<n>` files after a crash are harmless and never
// cleaned automatically.

import { link, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Options for {@link writeFileAtomic}. */
export interface AtomicWriteOptions {
  /**
   * When true, fail with `kind: "exists"` if `path` already exists, and never replace it
   * (proposal files, O_EXCL semantics). Implemented as tmp + fsync + `link(tmp, path)` + unlink(tmp),
   * so a reader never sees a partially written file even in exclusive mode. Default false (replace).
   */
  readonly exclusive?: boolean;
  /** File mode for the created file. Default 0o640. */
  readonly mode?: number;
}

/** The step at which an atomic write failed (bounded; safe for logs). */
export type AtomicWriteStep = "open" | "write" | "fsync" | "rename" | "link";

/** Result of {@link writeFileAtomic}. Never throws. */
export type AtomicWriteResult =
  | {
      /** The new bytes are at `path`. */
      readonly ok: true;
      /** False when the post-rename parent-directory fsync failed. The data is in place but its
       *  directory entry may not have reached stable storage. Callers treat this as success. */
      readonly durable: boolean;
    }
  | {
      /** Nothing at `path` changed (replace mode: old file intact; exclusive mode: nothing created). */
      readonly ok: false;
      /** `exists` only in exclusive mode when `path` already exists; otherwise `io`. */
      readonly kind: "exists" | "io";
      /** Failing step. */
      readonly step: AtomicWriteStep;
      /** Node error code (e.g. "ENOSPC", "EACCES") or null. Never includes the path or message. */
      readonly code: string | null;
    };

/** Per-process monotonic suffix so concurrent writers in one process never share a tmp name. */
let tmpCounter = 0;

/**
 * Write `bytes` to `path` so that any observer — including the next process after a crash — sees
 * either the complete old content or the complete new content, never a torn file.
 *
 * Sequence:
 *   1. open `<dir>/<base>.tmp-<pid>-<n>` with flags "wx" (the tmp name is unique; "wx" guards reuse);
 *   2. write all bytes; fsync the tmp handle; close it;
 *   3. replace mode: rename(tmp, path) — atomic on POSIX within one filesystem (tmp is a sibling);
 *      exclusive mode: link(tmp, path) — fails EEXIST atomically — then unlink(tmp);
 *   4. open the parent directory read-only and fsync it so the rename/link survives power loss.
 * On any failure in steps 1–3 the tmp file is unlinked (best effort) and `{ok:false}` is returned.
 *
 * @param path - Absolute destination path (its directory must exist; the write path probe creates it).
 * @param bytes - Complete file content.
 * @param options - {@link AtomicWriteOptions}.
 * @returns A discriminated result; never rejects.
 */
export async function writeFileAtomic(
  path: string,
  bytes: Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
  const dir = dirname(path);
  const tmp = join(dir, `${basename(path)}.tmp-${process.pid}-${++tmpCounter}`);
  let step: AtomicWriteStep = "open";
  let created = false;
  try {
    const handle = await open(tmp, "wx", options.mode ?? 0o640);
    created = true;
    try {
      step = "write";
      await handle.writeFile(bytes);
      step = "fsync";
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.exclusive === true) {
      step = "link";
      await link(tmp, path); // EEXIST → kind "exists"
      await unlink(tmp).catch(() => undefined); // the link already committed the file
      created = false;
    } else {
      step = "rename";
      await rename(tmp, path);
      created = false;
    }
  } catch (err) {
    if (created) await unlink(tmp).catch(() => undefined);
    // Guarded so a non-object throw value can never make the catch itself reject.
    const raw = typeof err === "object" && err !== null ? (err as NodeJS.ErrnoException).code : undefined;
    const code = typeof raw === "string" ? raw : null;
    return { ok: false, kind: step === "link" && code === "EEXIST" ? "exists" : "io", step, code };
  }
  return { ok: true, durable: await fsyncDir(dir) };
}

/** fsync a directory; returns false (never throws) when the platform or filesystem refuses. */
async function fsyncDir(dir: string): Promise<boolean> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  }
}
