// Push data directory: the async file seam and the startup probe that push can persist under PULSE_WEB_DATA_DIR.

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Minimal async file seam used by probePushDataDir, whose `readFile` is also passed to the registry loader. Every
 * method rejects on failure with a Node-style error carrying `code` when available.
 */
export interface PushFs {
  /** `mkdir -p`. Resolves when the directory exists (already existing is success). */
  mkdir(path: string, options: { readonly recursive: true; readonly mode: number }): Promise<unknown>;
  /** Create or truncate `path` with `data` and `mode`. */
  writeFile(path: string, data: Uint8Array, options: { readonly mode: number }): Promise<void>;
  /** Remove a file. */
  unlink(path: string): Promise<void>;
  /** Read a whole file. Rejects with an error whose `code` is "ENOENT" when it does not exist. */
  readFile(path: string): Promise<Uint8Array>;
}

/** Production seam over node:fs/promises. */
export const NODE_PUSH_FS: PushFs = Object.freeze({
  mkdir: (path: string, options: { readonly recursive: true; readonly mode: number }) => mkdir(path, options),
  writeFile: (path: string, data: Uint8Array, options: { readonly mode: number }) => writeFile(path, data, options),
  unlink: (path: string) => unlink(path),
  readFile: async (path: string) => new Uint8Array(await readFile(path)),
});

/** Outcome of the bootstrap probe. `code` is the errno code (e.g. "EACCES") for the log, or null. */
export type PushProbeResult =
  | {
      /** Push can persist. */
      readonly ok: true;
      /** `<dataDir>/push`, which now exists. */
      readonly pushDir: string;
    }
  | {
      /** Push cannot persist. */
      readonly ok: false;
      /** Always `data-dir-unwritable`. */
      readonly reason: "data-dir-unwritable";
      /** The first failing step. */
      readonly step: "mkdir" | "write" | "unlink";
      /** The errno code, or null. Never the path or message. */
      readonly code: string | null;
    };

function codeOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function unwritable(step: "mkdir" | "write" | "unlink", err: unknown): PushProbeResult {
  return Object.freeze({ ok: false, reason: "data-dir-unwritable", step, code: codeOf(err) });
}

/**
 * Probe that push can persist under `dataDir`. Never rejects; logs nothing.
 *
 * 1. `mkdir <dataDir>/push` (recursive, mode 0700). This also creates `dataDir` if absent. An existing directory
 *    keeps its mode.
 * 2. Write an empty `<dataDir>/push/.probe-<pid>` with mode 0600 (create-or-truncate, so a stale probe file from a
 *    hard stop never fails the next boot).
 * 3. Unlink it. A directory that accepts writes but not unlinks is unusable for atomic writes.
 *
 * @param dataDir - The normalised absolute data directory.
 * @param fs      - File seam.
 * @param pid     - Probe file suffix. Default `process.pid`.
 */
export async function probePushDataDir(
  dataDir: string,
  fs: PushFs,
  pid: number = process.pid,
): Promise<PushProbeResult> {
  const pushDir = join(dataDir, "push");
  try {
    await fs.mkdir(pushDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return unwritable("mkdir", err);
  }
  const probe = join(pushDir, `.probe-${pid}`);
  try {
    await fs.writeFile(probe, new Uint8Array(0), { mode: 0o600 });
  } catch (err) {
    return unwritable("write", err);
  }
  try {
    await fs.unlink(probe);
  } catch (err) {
    return unwritable("unlink", err);
  }
  return Object.freeze({ ok: true, pushDir });
}
