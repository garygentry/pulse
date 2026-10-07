// apps/web/src/server/mutations/write-path.ts — write-path store/reason types.
//
// Types and closed constants plus `createWritePath`, the live probing implementation.
// Constructed only by the proxy-header bootstrap; never in none mode.

import { constants as FS } from "node:fs";
import { access, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { SecretStatus, WritePathConfig } from "../config.js";
import { log as defaultLog, type LogEvent } from "../log.js";

/** The five write-path health slots. */
export type WritePathStore = "audit" | "acks" | "proposals" | "secret" | "alertmanager";
/** Every WritePathStore, in canonical order. */
export const WRITE_PATH_STORES: readonly WritePathStore[] = ["audit", "acks", "proposals", "secret", "alertmanager"] as const;

/** Closed reason set — used in /healthz, /api/session derivation and the status gauge label. */
export type WritePathReason =
  | "not-configured" // no explicit path and no PULSE_WEB_DATA_DIR
  | "missing" // path/dir absent and could not be created
  | "unwritable" // fs.access(W_OK) or open-for-append failed
  | "corrupt" // acks.json unparseable / schema-invalid (file preserved)
  | "secret-missing" // PULSE_PROPOSAL_SECRET unset/empty
  | "secret-too-short" // < PROPOSAL_SECRET_MIN_BYTES
  | "write-failed" // a live write failed (markFailed); recovers on the next good probe
  | "auth-mode-none"; // reported by /healthz only; WritePath is never constructed in none mode
/** Every WritePathReason, for exhaustive tables and tests. */
export const WRITE_PATH_REASONS: readonly WritePathReason[] = [
  "not-configured",
  "missing",
  "unwritable",
  "corrupt",
  "secret-missing",
  "secret-too-short",
  "write-failed",
  "auth-mode-none",
] as const;

/** Health of one store. */
export interface StoreStatus {
  /** True when the store can currently accept writes. */
  readonly ok: boolean;
  /** Null iff ok. */
  readonly reason: WritePathReason | null;
}
/** Immutable per-store snapshot. */
export type WritePathSnapshot = Readonly<Record<WritePathStore, StoreStatus>>;

/** Live write-path health (proxy-header mode only). */
export interface WritePath {
  /** Current snapshot (cheap; read on every request). */
  snapshot(): WritePathSnapshot;
  /** Mark a store degraded immediately after a live write failure. Logs the edge once. */
  markFailed(store: "audit" | "acks" | "proposals", reason: "write-failed" | "unwritable" | "corrupt"): void;
  /** Re-probe the filesystem stores (start-up and every slow cycle). Logs degrade/recover edges. */
  probe(): Promise<WritePathSnapshot>;
}

/** Minimal filesystem surface the probes use (test seam; defaults to node:fs/promises). */
export interface WritePathFs {
  /** `mkdir -p`. */
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  /** Rejects when `mode` is not permitted or the path is absent. */
  access(path: string, mode: number): Promise<void>;
  /** Open (flag "a" = create-if-absent append); the handle is closed immediately. */
  open(path: string, flags: "a"): Promise<{ close(): Promise<void> }>;
}

/** Construction inputs besides the config. */
export interface WritePathDeps {
  /** Status of PULSE_PROPOSAL_SECRET (from SecretProvider.status). */
  readonly secret: SecretStatus;
  /** True iff the Alertmanager write client was constructed (reachability is checked per request). */
  readonly alertmanagerConfigured: boolean;
  /**
   * Late-bound AckStore.loadStatus. Read on EVERY probe as an input to the acks slot, so a bad load
   * (`corrupt`/`unwritable`) is STICKY: a passing filesystem check never clears it. A getter because the
   * ack store is constructed AFTER the WritePath (it takes `{ writePath }`). Absent ⇒ not consulted; a
   * throwing getter ⇒ `corrupt`.
   */
  readonly ackLoadStatus?: () => StoreStatus;
  /** Filesystem seam. Default: node:fs/promises. */
  readonly fs?: WritePathFs;
  /** Log sink seam. Default: server/log.ts `log`. */
  readonly log?: (evt: LogEvent) => void;
}

type MarkableStore = "audit" | "acks" | "proposals";
type MarkReason = "write-failed" | "unwritable" | "corrupt";

/**
 * Build the WritePath (proxy-header only; constructed solely by the write-path bootstrap). Performs NO
 * I/O: the initial snapshot is "not yet probed" (every filesystem slot `{ ok:false, reason:"missing" }`,
 * secret/alertmanager from deps). Callers MUST `await probe()` before exposing it.
 *
 * Probe steps per filesystem store (first failing step wins): not-configured > missing (mkdir -p) >
 * unwritable (access W_OK / open "a") > acks load status (sticky). `markFailed` overlays only ok slots
 * and is cleared only by a passing probe that STARTED after the mark. `probe()` is single-flight and
 * never rejects. Degrade/recover edges are logged; errno text never is.
 *
 * @param config - Parsed write-path configuration.
 * @param deps - Secret status, alertmanager presence, ack load-status getter and test seams.
 * @returns The live WritePath.
 */
export function createWritePath(config: WritePathConfig, deps: WritePathDeps): WritePath {
  const fs: WritePathFs = deps.fs ?? { mkdir, access, open };
  const emit = deps.log ?? defaultLog;
  /** Live-write failures, overlayed on the probe result until a later probe that STARTED after them passes. */
  const failed = new Map<MarkableStore, { reason: MarkReason; seq: number }>();
  let failSeq = 0;
  let probed: Record<WritePathStore, StoreStatus> = {
    audit: DOWN("missing"),
    acks: DOWN("missing"),
    proposals: DOWN("missing"),
    secret: deps.secret.present ? UP : DOWN(deps.secret.reason),
    alertmanager: deps.alertmanagerConfigured ? UP : DOWN("not-configured"),
  };
  let current: WritePathSnapshot = freeze(probed);
  let baselineLogged = false;
  let inFlight: Promise<WritePathSnapshot> | null = null;

  /** Recompose the immutable snapshot from the probe result + failure overlay, logging edges. */
  function publish(): WritePathSnapshot {
    const next: Record<WritePathStore, StoreStatus> = { ...probed };
    for (const [store, mark] of failed) {
      // A probe-level failure outranks a live-write mark (within-store precedence); only overlay an ok slot.
      if (next[store].ok) next[store] = DOWN(mark.reason);
    }
    const snapshot = freeze(next);
    logEdges(current, snapshot, !baselineLogged);
    baselineLogged = true;
    current = snapshot;
    return snapshot;
  }

  /** ok→degraded or reason change → write_path_degraded; degraded→ok → write_path_recovered.
   *  On the first publish (start-up baseline) only degraded stores are logged. */
  function logEdges(prev: WritePathSnapshot, next: WritePathSnapshot, baseline: boolean): void {
    for (const store of WRITE_PATH_STORES) {
      const a = prev[store];
      const b = next[store];
      try {
        if (!b.ok && (baseline || a.ok || a.reason !== b.reason)) {
          emit({ event: "write_path_degraded", ok: false, store, reason: b.reason });
        } else if (b.ok && !a.ok && !baseline) {
          emit({ event: "write_path_recovered", ok: true, store });
        }
      } catch {
        /* a log sink throw never breaks health bookkeeping */
      }
    }
  }

  async function step(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  }

  async function probeAudit(): Promise<StoreStatus> {
    const p = config.auditPath;
    if (p === null) return DOWN("not-configured");
    if (!(await step(() => fs.mkdir(dirname(p), { recursive: true })))) return DOWN("missing");
    if (!(await step(() => fs.access(dirname(p), FS.W_OK)))) return DOWN("unwritable");
    if (
      !(await step(async () => {
        const h = await fs.open(p, "a");
        await h.close();
      }))
    ) {
      return DOWN("unwritable");
    }
    return UP;
  }

  async function probeAcks(): Promise<StoreStatus> {
    const p = config.ackStorePath;
    if (p === null) return DOWN("not-configured");
    if (!(await step(() => fs.mkdir(dirname(p), { recursive: true })))) return DOWN("missing");
    if (!(await step(() => fs.access(dirname(p), FS.W_OK)))) return DOWN("unwritable");
    const exists = await step(() => fs.access(p, FS.F_OK));
    if (exists && !(await step(() => fs.access(p, FS.W_OK)))) return DOWN("unwritable");
    const load = safeLoadStatus(); // sticky input: a bad load is never cleared here
    return load.ok ? UP : DOWN(load.reason ?? "corrupt");
  }

  async function probeProposals(): Promise<StoreStatus> {
    const d = config.proposalsDir;
    if (d === null) return DOWN("not-configured");
    if (!(await step(() => fs.mkdir(d, { recursive: true })))) return DOWN("missing");
    if (!(await step(() => fs.access(d, FS.W_OK)))) return DOWN("unwritable");
    return UP;
  }

  function safeLoadStatus(): StoreStatus {
    try {
      return deps.ackLoadStatus?.() ?? UP;
    } catch {
      return DOWN("corrupt");
    }
  }

  async function runProbe(): Promise<WritePathSnapshot> {
    const startSeq = failSeq;
    const [audit, acks, proposals] = await Promise.all([probeAudit(), probeAcks(), probeProposals()]);
    probed = { ...probed, audit, acks, proposals };
    // Recovery: a passing probe clears marks recorded BEFORE it started; a mark raised while the probe
    // was running is kept (the probe may have raced the failing write).
    for (const [store, mark] of [...failed]) {
      if (mark.seq <= startSeq && probed[store].ok) failed.delete(store);
    }
    return publish();
  }

  return {
    snapshot: () => current,
    markFailed(store, reason) {
      failSeq += 1;
      failed.set(store, { reason, seq: failSeq });
      publish();
    },
    probe(): Promise<WritePathSnapshot> {
      // Single-flight: concurrent callers (slow-cycle hook + bootstrap/tests) share one probe.
      inFlight ??= runProbe().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

const UP: StoreStatus = Object.freeze({ ok: true, reason: null });
function DOWN(reason: WritePathReason): StoreStatus {
  return Object.freeze({ ok: false, reason });
}
function freeze(s: Record<WritePathStore, StoreStatus>): WritePathSnapshot {
  return Object.freeze({ ...s });
}
