// packages/web-data/src/audit/writer.ts — the durable append-only JSONL audit writer (09 §§6–8).
//
// Server-side only. `createJsonlAuditWriter` is the public factory (absolute path only — no
// default/env/singleton/rotation). Each `append` validates the event against the bounded-safe
// contract, canonicalizes it to one JSON object plus exactly one `\n`, and — through a single
// promise chain that serializes all appends and the close — lazily opens the file, writes every
// byte (looping on partial writes), and calls `fsync` before resolving `{ ok: true }`. A caller
// can never observe success for a partially written or unsynced line. Failures are mapped to the
// explicit `open`/`write`/`sync`/`close` kinds. `createJsonlAuditWriterInternal` (not re-exported
// from the `/audit` barrel) additionally accepts an injected `open` seam so tests can drive
// deterministic open/write/partial/sync/close failures.

import { canonicalJson } from "../canonical.js";
import type {
  AuditAppendResult,
  AuditEvent,
  AuditFailure,
  AuditWriter,
  JsonlAuditWriterOptions,
} from "./types.js";

// ── Bounded-safe validation limits (09 §6) ──────────────────────────────────────────────────────

/** Max UTF-8 bytes for a bounded scalar field (`action`/`target`/`requestId`/`correlationId`/actor). */
const MAX_FIELD_BYTES = 256;
/** Max number of `details` entries. */
const MAX_DETAIL_ENTRIES = 32;
/** Max UTF-8 bytes for a `details` key. */
const MAX_DETAIL_KEY_BYTES = 128;
/** Max UTF-8 bytes for a string `details` value. */
const MAX_DETAIL_VALUE_BYTES = 256;

/** Prototype-pollution detail keys that are always rejected. */
const FORBIDDEN_DETAIL_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

/** Case-insensitive substrings that mark a raw-header/auth/credential-like detail key. */
const SENSITIVE_KEY_SUBSTRINGS: readonly string[] = [
  "authorization",
  "cookie",
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api-key",
  "api_key",
  "credential",
  "bearer",
  "x-forwarded",
  "remote-user",
];

const textEncoder = new TextEncoder();

/** UTF-8 byte length of `value`. */
function byteLength(value: string): number {
  return textEncoder.encode(value).length;
}

/**
 * Whether `value` contains any disallowed control character: C0 (< 0x20, including newline/CR/tab),
 * DEL (0x7f), or C1 (0x80–0x9f). Bounded audit fields must be single-line and control-free.
 */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
  }
  return false;
}

/** Whether `value` is a non-empty, control-free string within `maxBytes`. */
function isBoundedScalar(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !hasControlChar(value) &&
    byteLength(value) <= maxBytes
  );
}

/** Whether `key` looks like a raw header/auth/credential-bearing detail key. */
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_SUBSTRINGS.some((needle) => lower.includes(needle));
}

/** Whether `container` is a plain object literal (its prototype is `Object.prototype` or null). */
function isPlainObject(container: unknown): container is Record<string, unknown> {
  if (typeof container !== "object" || container === null || Array.isArray(container)) return false;
  const proto = Object.getPrototypeOf(container) as object | null;
  return proto === null || proto === Object.prototype;
}

/**
 * Validate a `details` map: ≤32 entries, each key bounded/control-free/non-forbidden/non-sensitive,
 * each value a string (bounded/control-free), a finite number, a boolean, or null. Nested values,
 * non-finite numbers, and prototype-pollution keys are rejected.
 */
function detailsAreValid(details: unknown): boolean {
  if (!isPlainObject(details)) return false;
  const keys = Object.keys(details);
  if (keys.length > MAX_DETAIL_ENTRIES) return false;
  for (const key of keys) {
    if (FORBIDDEN_DETAIL_KEYS.has(key)) return false;
    if (key.length === 0 || hasControlChar(key) || byteLength(key) > MAX_DETAIL_KEY_BYTES) return false;
    if (isSensitiveKey(key)) return false;
    const value = details[key];
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value === "string") {
      if (hasControlChar(value) || byteLength(value) > MAX_DETAIL_VALUE_BYTES) return false;
      continue;
    }
    return false; // objects, arrays, bigint, undefined, functions, symbols
  }
  return true;
}

/** Whether `actor` is exactly `{ subject, displayName, source: "proxy-header" }` with bounded fields. */
function actorIsValid(actor: unknown): boolean {
  if (!isPlainObject(actor)) return false;
  const keys = Object.keys(actor);
  if (keys.length !== 3) return false;
  return (
    isBoundedScalar(actor.subject, MAX_FIELD_BYTES) &&
    isBoundedScalar(actor.displayName, MAX_FIELD_BYTES) &&
    actor.source === "proxy-header"
  );
}

const VALID_OUTCOMES: ReadonlySet<string> = new Set(["attempted", "succeeded", "failed"]);

/**
 * Validate an `AuditEvent` against the bounded-safe contract (09 §6). Returns `true` when the event
 * is safe to canonicalize and durably record; `false` when any field is missing, oversized, nested,
 * non-finite, control-bearing, or sensitive. Validation never opens the file.
 */
function eventIsValid(event: AuditEvent): boolean {
  if (!isPlainObject(event)) return false;
  // Valid UTC timestamp: bounded, control-free, and parseable to a finite epoch.
  if (!isBoundedScalar(event.at, MAX_FIELD_BYTES) || !Number.isFinite(Date.parse(event.at))) return false;
  if (!actorIsValid(event.actor)) return false;
  if (!isBoundedScalar(event.action, MAX_FIELD_BYTES)) return false;
  if (!isBoundedScalar(event.target, MAX_FIELD_BYTES)) return false;
  if (typeof event.outcome !== "string" || !VALID_OUTCOMES.has(event.outcome)) return false;
  if (!isBoundedScalar(event.requestId, MAX_FIELD_BYTES)) return false;
  if (event.correlationId !== null && !isBoundedScalar(event.correlationId, MAX_FIELD_BYTES)) return false;
  if (!detailsAreValid(event.details)) return false;
  return true;
}

// ── Injectable file-handle seam (09 §8) ─────────────────────────────────────────────────────────

/**
 * The minimal append-only file handle the writer drives. Modeled on `node:fs/promises` `FileHandle`
 * so the default `open` can wrap it directly; tests inject a handle whose methods fail deterministically.
 */
export interface AuditFileHandle {
  /** Write `length` bytes of `data` starting at `offset`; resolves the count actually written. */
  write(data: Uint8Array, offset: number, length: number): Promise<{ readonly bytesWritten: number }>;
  /** Flush the file to durable storage (fsync). */
  sync(): Promise<void>;
  /** Close the underlying file descriptor. */
  close(): Promise<void>;
}

/**
 * Open an append-only handle for the audit file at `absolutePath`. The default implementation opens
 * with append/create permissions; a test seam may substitute a handle that fails on demand.
 */
export type AuditOpen = (absolutePath: string) => Promise<AuditFileHandle>;

/**
 * Internal options for the JSONL audit writer: the validated absolute path plus an optional injected
 * `open` seam for deterministic failure tests. The public factory omits `open`.
 */
export interface InternalJsonlAuditWriterOptions {
  /** Absolute append-only audit path. */ readonly absolutePath: string;
  /** Injected open seam for tests; defaults to a real append/create open. */ readonly open?: AuditOpen;
}

/** The default `open`: an append/create `node:fs/promises` handle wrapped as an {@link AuditFileHandle}. */
const defaultOpen: AuditOpen = async (absolutePath) => {
  const { open } = await import("node:fs/promises");
  const handle = await open(absolutePath, "a");
  return {
    async write(data, offset, length) {
      const { bytesWritten } = await handle.write(data, offset, length, null);
      return { bytesWritten };
    },
    sync() {
      return handle.sync();
    },
    close() {
      return handle.close();
    },
  };
};

// ── Explicit failure results (bounded, value-free messages) ──────────────────────────────────────

const MESSAGES = {
  invalidEvent: "The audit event failed bounded-safe validation.",
  serialize: "The audit event could not be canonicalized.",
  open: "The audit file could not be opened for append.",
  write: "The audit line could not be fully written.",
  sync: "The audit line could not be synchronized to durable storage.",
  close: "The audit file could not be closed.",
  closed: "The audit writer is closed.",
} as const;

function failure(kind: AuditFailure["kind"], message: string): AuditAppendResult {
  return { ok: false, error: { kind, message } };
}

const SUCCESS: AuditAppendResult = { ok: true };

/**
 * Create a JSONL audit writer over the internal options (validated path + optional `open` seam).
 * Not re-exported from the `/audit` barrel; the public factory {@link createJsonlAuditWriter} wraps it.
 */
export function createJsonlAuditWriterInternal(options: InternalJsonlAuditWriterOptions): AuditWriter {
  const { absolutePath } = options;
  if (typeof absolutePath !== "string" || absolutePath.length === 0 || !isAbsolutePath(absolutePath)) {
    throw new Error("createJsonlAuditWriter requires an absolute, non-empty path.");
  }
  const open = options.open ?? defaultOpen;

  let handle: AuditFileHandle | null = null;
  let closed = false;
  // After a terminal write/sync failure the (possibly torn) handle is closed/reset before the next
  // append, which may then retry open. This guards the "never report success for a partial line" rule.
  let needsReset = false;
  // The single promise chain that serializes every append and the close so lines never interleave.
  let chain: Promise<unknown> = Promise.resolve();

  /** Enqueue `op` onto the serialized chain; `op` never rejects (all paths return a result). */
  function enqueue(op: () => Promise<AuditAppendResult>): Promise<AuditAppendResult> {
    const run = chain.then(op);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Best-effort close of a torn handle before a retry; errors are swallowed (already failed path). */
  async function resetHandle(): Promise<void> {
    const torn = handle;
    handle = null;
    needsReset = false;
    if (torn !== null) {
      try {
        await torn.close();
      } catch {
        // The prior operation already failed; a reset-close error must not mask it.
      }
    }
  }

  async function appendOp(event: AuditEvent): Promise<AuditAppendResult> {
    if (closed) return failure("write", MESSAGES.closed);

    // 1. Validate before opening the file (a validation failure never touches the filesystem).
    if (!eventIsValid(event)) return failure("write", MESSAGES.invalidEvent);

    // 2. Canonicalize to one deterministic JSON object plus exactly one newline.
    let bytes: Uint8Array;
    try {
      const line = canonicalJson(event);
      const withNewline = new Uint8Array(line.length + 1);
      withNewline.set(line, 0);
      withNewline[line.length] = 0x0a; // "\n"
      bytes = withNewline;
    } catch {
      return failure("write", MESSAGES.serialize);
    }

    // 3. Reset a torn handle from a prior terminal failure before retrying open.
    if (needsReset) await resetHandle();

    // 4. Lazily open with append/create permissions.
    if (handle === null) {
      try {
        handle = await open(absolutePath);
      } catch {
        handle = null;
        return failure("open", MESSAGES.open);
      }
    }

    // 5. Write every byte, looping on partial writes. A zero-progress write is a write failure
    //    (rather than an infinite loop). Any exception is a write failure; the handle is reset.
    let offset = 0;
    try {
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
        if (bytesWritten <= 0) {
          needsReset = true;
          return failure("write", MESSAGES.write);
        }
        offset += bytesWritten;
      }
    } catch {
      needsReset = true;
      return failure("write", MESSAGES.write);
    }

    // 6. fsync before reporting success — a caller cannot treat the event as recorded before sync.
    try {
      await handle.sync();
    } catch {
      needsReset = true;
      return failure("sync", MESSAGES.sync);
    }

    return SUCCESS;
  }

  async function closeOp(): Promise<AuditAppendResult> {
    if (closed) return SUCCESS; // idempotent after a successful close
    if (handle === null) {
      // Nothing open (never opened, or reset after a terminal failure) — close is a no-op success.
      closed = true;
      return SUCCESS;
    }
    const open = handle;
    handle = null;
    try {
      await open.close();
      closed = true;
      return SUCCESS;
    } catch {
      // Expected close failure resolves the failure branch (never rejects); the fd is released.
      return failure("close", MESSAGES.close);
    }
  }

  return {
    append(event) {
      return enqueue(() => appendOp(event));
    },
    close() {
      // Any unexpected exception at the writer boundary is normalized to a bounded close failure.
      return enqueue(() => closeOp()).catch(() => failure("close", MESSAGES.close));
    },
  };
}

/** Whether `path` is an absolute POSIX or Windows path. Kept local to avoid a `node:path` import. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Create a durable append-only JSONL audit writer for the absolute `options.absolutePath` (09 §7).
 * There is no default path, environment variable, rotation/retention policy, or shared singleton:
 * the caller must inject an absolute path. Each `append` durably records one canonical line only
 * after fsync; `close` is authoritative and idempotent after a successful close.
 */
export function createJsonlAuditWriter(options: JsonlAuditWriterOptions): AuditWriter {
  return createJsonlAuditWriterInternal({ absolutePath: options.absolutePath });
}
