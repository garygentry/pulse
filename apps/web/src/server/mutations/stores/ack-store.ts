// apps/web/src/server/mutations/stores/ack-store.ts — the durable Pulse-local ack store.
//
// One JSON file (`acks.json`, format `pulse-acks/v1`) keyed by alert fingerprint. Every change builds
// a new Map from the committed state and commits it only after `writeFileAtomic` succeeds
// (copy-on-write), so a failed persist leaves memory at its prior state. A serialization chain runs
// exactly one read-modify-persist step at a time. A corrupt or unreadable file is preserved byte for
// byte and every write is refused for the process lifetime (sticky).

import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { AlertmanagerAlert, SourceRecord } from "@pulse/web-data/sources";
import type { AckFoldRecord } from "@pulse/web-data/cycle";
import { SOURCE_MAX_NAME_BYTES } from "@pulse/web-data/wire";
import { ACK_NOTE_MAX_CHARS } from "../../../shared/mutations.js";
import { MUTATION_ID_MAX_BYTES } from "../constants.js";
import type { StoreStatus, WritePath } from "../write-path.js";
import { recordAckAutoClears } from "../../routes/metrics.js";
import { log } from "../../log.js";
import { writeFileAtomic } from "./atomic-file.js";

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

/** Durable ack record (REQ-ACK-02). `subject` stays server-side; the wire carries only displayName. */
export interface AckRecord {
  /** Acting identity as persisted (never sent to clients except displayName). */
  readonly actor: {
    /** Stable identity subject (server-side only, SEC-06). */ readonly subject: string;
    /** Human-facing name shown as `ack.by`. */ readonly displayName: string;
  };
  /** ISO-8601 UTC. */ readonly at: string;
  /** ≤ ACK_NOTE_MAX_CHARS, or null. */ readonly note: string | null;
}
/** acks.json (REQ-ACK-03). */
export interface AckFileV1 {
  /** Format tag. */ readonly format: "pulse-acks/v1";
  /** Ack records keyed by alert fingerprint. */ readonly acks: Readonly<Record<string, AckRecord>>;
}
/** Result of a persisted store change. */
export type StoreWriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: "write-failed" };

/** The ack store. */
export interface AckStore {
  /** Load status after construction ("corrupt" → capability degraded; file preserved). */
  readonly loadStatus: StoreStatus;
  /** Last-writer-wins set (REQ-ACK-05). Rolls back in memory on persist failure. */
  set(fingerprint: string, record: AckRecord): Promise<StoreWriteResult<AckRecord>>;
  /** Idempotent remove; value = whether an ack existed. */
  remove(fingerprint: string): Promise<StoreWriteResult<boolean>>;
  /** Auto-clear (REQ-ACK-04): only when `record.latest.result.ok` (fetched fresh this cycle); returns cleared count. */
  reconcile(record: SourceRecord<readonly AlertmanagerAlert[]>): Promise<number>;
  /** Display-safe projection for FoldInputs.acks. */
  foldView(): ReadonlyMap<string, AckFoldRecord>;
  /** Current record (tests). */
  get(fingerprint: string): AckRecord | undefined;
}

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------

/** Refuse to parse an acks.json larger than this (defensive; the SCALE-01 worst case is ≈ 2.4 MiB). */
const ACK_FILE_MAX_BYTES = 16 * 1024 * 1024;

const utf8 = new TextEncoder();
/** C0 (except \n), DEL and C1 control characters. */
const CONTROL_EXCEPT_NL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u;
/** Any control character, including \n. */
const ANY_CONTROL = /[\u0000-\u001F\u007F-\u009F]/u;

/**
 * Alert fingerprint: 1..MUTATION_ID_MAX_BYTES (128) UTF-8 bytes, no control characters.
 * Keeps the audit target `alert:<fp>` well under the writer's 256-byte field cap.
 */
export const fingerprintSchema = z
  .string()
  .min(1)
  .refine((s) => utf8.encode(s).length <= MUTATION_ID_MAX_BYTES && !ANY_CONTROL.test(s), "fingerprint");

/** Stored note: 1..ACK_NOTE_MAX_CHARS code points (already trimmed on write), no control chars except \n. */
export const storedNoteSchema = z
  .string()
  .refine((s) => s.length > 0 && [...s].length <= ACK_NOTE_MAX_CHARS && !CONTROL_EXCEPT_NL.test(s), "note");

/** Bounded identity text (subject/displayName) as persisted. */
const identityText = z
  .string()
  .min(1)
  .refine((s) => utf8.encode(s).length <= SOURCE_MAX_NAME_BYTES);

/** One persisted AckRecord (strict). */
const ackRecordSchema = z
  .object({
    actor: z.object({ subject: identityText, displayName: identityText }).strict(),
    at: z.string().refine((s) => Number.isFinite(Date.parse(s)), "at"),
    note: storedNoteSchema.nullable(),
  })
  .strict();

/** acks.json v1 (AckFileV1), strict. Unknown keys anywhere, or an over-bound key → schema-invalid → corrupt. */
export const ackFileSchema = z
  .object({
    format: z.literal("pulse-acks/v1"),
    acks: z.record(fingerprintSchema, ackRecordSchema),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

/**
 * Load acks.json and return the store. Never throws for file/content problems (they become
 * `loadStatus`); only a programming fault can reject.
 *
 * @param path - Absolute acks.json path (`WritePathConfig.ackStorePath`, non-null in proxy-header mode).
 * @param deps - `writePath`, used to degrade `acks` on corrupt load or persist failure.
 */
export async function createAckStore(path: string, deps: { readonly writePath: WritePath }): Promise<AckStore> {
  const loaded = await loadAckFile(path);
  if (!loaded.status.ok) {
    deps.writePath.markFailed("acks", loaded.status.reason === "corrupt" ? "corrupt" : "unwritable");
    if (loaded.status.reason === "corrupt") log({ event: "ack_store_corrupt", ok: false, path });
  }
  const writable = loaded.status.ok;

  /** Committed state: replaced wholesale only after a durable write (copy-on-write). */
  let committed: ReadonlyMap<string, AckRecord> = loaded.acks;
  /** Cached display projection of `committed`; rebuilt on every commit. */
  let view: ReadonlyMap<string, AckFoldRecord> = project(committed);
  /** Serialization chain: exactly one read-modify-persist step runs at a time. */
  let chain: Promise<unknown> = Promise.resolve();

  function serialize<T>(step: () => Promise<T>): Promise<T> {
    const next = chain.then(step, step);
    chain = next.catch(() => undefined);
    return next;
  }

  /** Persist `next` atomically; on success commit it, on failure keep `committed` (the rollback) and degrade. */
  async function commit(next: ReadonlyMap<string, AckRecord>): Promise<boolean> {
    const result = await writeFileAtomic(path, utf8.encode(serializeAckFile(next)));
    if (!result.ok) {
      deps.writePath.markFailed("acks", "write-failed");
      return false;
    }
    committed = next;
    view = project(next);
    return true;
  }

  return {
    loadStatus: loaded.status,

    async set(fingerprint: string, record: AckRecord): Promise<StoreWriteResult<AckRecord>> {
      if (!writable) return { ok: false, error: "write-failed" };
      return serialize(async () => {
        const next = new Map(committed);
        next.set(fingerprint, record); // LWW: no comparison with the prior record
        return (await commit(next)) ? { ok: true, value: record } : { ok: false, error: "write-failed" };
      });
    },

    async remove(fingerprint: string): Promise<StoreWriteResult<boolean>> {
      if (!writable) return { ok: false, error: "write-failed" };
      return serialize(async () => {
        if (!committed.has(fingerprint)) return { ok: true, value: false }; // no file write
        const next = new Map(committed);
        next.delete(fingerprint);
        return (await commit(next)) ? { ok: true, value: true } : { ok: false, error: "write-failed" };
      });
    },

    async reconcile(record: SourceRecord<readonly AlertmanagerAlert[]>): Promise<number> {
      if (!writable) return 0;
      try {
        const latest = record.latest.result;
        if (!latest.ok) return 0; // stale or unavailable: outage tolerance
        // Every listed alert counts as firing, whatever its state (silenced/inhibited keep their acks).
        const firing = new Set(latest.data.map((alert) => alert.fingerprint));
        return await serialize(async () => {
          const cleared = [...committed.keys()].filter((fp) => !firing.has(fp));
          if (cleared.length === 0) return 0; // steady state: no file write
          const next = new Map(committed);
          for (const fp of cleared) next.delete(fp);
          if (!(await commit(next))) return 0; // rollback + acks degraded; retry next cycle
          recordAckAutoClears(cleared.length);
          log({ event: "ack_auto_cleared", ok: true, count: cleared.length }); // no fingerprints
          return cleared.length;
        });
      } catch {
        return 0; // reconcile must never break a cycle
      }
    },

    foldView(): ReadonlyMap<string, AckFoldRecord> {
      return view;
    },

    get(fingerprint: string): AckRecord | undefined {
      return committed.get(fingerprint);
    },
  };
}

/**
 * Read + parse the ack file. Missing → empty and ok; oversize, invalid UTF-8/JSON or schema-invalid →
 * corrupt; any other read error → unwritable. Never throws.
 */
async function loadAckFile(
  path: string,
): Promise<{ readonly status: StoreStatus; readonly acks: ReadonlyMap<string, AckRecord> }> {
  const empty: ReadonlyMap<string, AckRecord> = new Map();
  const corrupt = { status: Object.freeze({ ok: false, reason: "corrupt" as const }), acks: empty };
  let text: string;
  try {
    const info = await stat(path);
    if (info.isFile() && info.size > ACK_FILE_MAX_BYTES) return corrupt;
    const bytes = await readFile(path);
    if (bytes.byteLength > ACK_FILE_MAX_BYTES) return corrupt;
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
    if (code === "ENOENT") return { status: Object.freeze({ ok: true, reason: null }), acks: empty };
    if (err instanceof TypeError) return corrupt; // invalid UTF-8
    return { status: Object.freeze({ ok: false, reason: "unwritable" as const }), acks: empty };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return corrupt;
  }
  const parsed = ackFileSchema.safeParse(raw);
  if (!parsed.success) return corrupt;
  const acks = new Map<string, AckRecord>();
  for (const [fp, r] of Object.entries(parsed.data.acks)) {
    acks.set(fp, {
      actor: { subject: r.actor.subject, displayName: r.actor.displayName },
      at: r.at,
      note: r.note,
    });
  }
  return { status: Object.freeze({ ok: true, reason: null }), acks };
}

/** Canonical JSON (sorted keys at every level, 2-space indent) + "\n". */
function serializeAckFile(acks: ReadonlyMap<string, AckRecord>): string {
  const file: AckFileV1 = { format: "pulse-acks/v1", acks: Object.fromEntries(acks) };
  return `${JSON.stringify(sortKeys(file), null, 2)}\n`;
}

/** Deep copy with object keys in sorted order (arrays keep their order). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(out, key, {
        value: sortKeys((value as Record<string, unknown>)[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/** Display-safe projection (SEC-06): subject is dropped here and never reaches the fold. */
function project(acks: ReadonlyMap<string, AckRecord>): ReadonlyMap<string, AckFoldRecord> {
  const out = new Map<string, AckFoldRecord>();
  for (const [fp, r] of acks) out.set(fp, { by: r.actor.displayName, at: r.at, note: r.note });
  return out;
}
