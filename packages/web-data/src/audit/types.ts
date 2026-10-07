// packages/web-data/src/audit/types.ts — the audit contracts (01 §10, 09 §§6–7).
//
// Server-side only (reachable through the `/audit` barrel, never `/wire`). These are the
// authoritative shapes for the durable append-only JSONL audit seam: the minimized attributed
// actor, one bounded safe event, the explicit per-append result, and the writer surface. The
// writer ships dark in M1 — no production caller constructs it — but the contracts are pinned
// here so the M2 mutation path imports them rather than redeclaring competing shapes.

/**
 * The minimized attributed actor recorded on an audit event. It carries exactly the three
 * identity fields resolved from a trusted proxy header — never a raw header, peer, or credential.
 */
export interface AuditActor {
  /** Stable minimized subject. */ readonly subject: string;
  /** Human-readable minimized actor name. */ readonly displayName: string;
  /** Identity provenance. */ readonly source: "proxy-header";
}

/**
 * One durable audit event. Every field is bounded and control-free; `details` holds only
 * non-sensitive scalar values (no nested objects, non-finite numbers, or credential-like keys).
 */
export interface AuditEvent {
  /** Event time in UTC. */ readonly at: string;
  /** Minimized attributed actor. */ readonly actor: AuditActor;
  /** Bounded stable action name. */ readonly action: string;
  /** Bounded stable target name. */ readonly target: string;
  /** Attempt/result phase. */ readonly outcome: "attempted" | "succeeded" | "failed";
  /** Request identity. */ readonly requestId: string;
  /** Cross-request correlation identity, or null. */ readonly correlationId: string | null;
  /** Bounded non-sensitive scalar details. */
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
  /** Governing capability of the mutation; always set by the M2 dispatcher. Optional so existing literals stay valid. */
  readonly capability?: "silence" | "ack" | "proposeEstateEdit";
}

/**
 * An explicit, expected writer failure. The `kind` names the writer phase that failed and
 * `message` is a fixed bounded operator diagnostic that never echoes event data or paths.
 */
export interface AuditFailure {
  /** Stable writer phase that failed. */ readonly kind: "open" | "write" | "sync" | "close";
  /** Bounded safe operator diagnostic. */ readonly message: string;
}

/**
 * The result of one `append`/`close`. Success means the line was written AND fsync'd (a caller
 * may treat the event as durably recorded only on `{ ok: true }`); failure is always explicit.
 */
export type AuditAppendResult =
  | {
      /** Durable-success discriminator. */ readonly ok: true;
    }
  | {
      /** Explicit-failure discriminator. */ readonly ok: false;
      /** Expected bounded writer failure. */ readonly error: AuditFailure;
    };

/**
 * The durable append-only JSONL audit writer. Appends are serialized, canonicalized, written in
 * full, and fsync'd before success; `close` is authoritative and idempotent after a successful close.
 */
export interface AuditWriter {
  /** Append and durably synchronize one complete event line. */
  append(event: AuditEvent): Promise<AuditAppendResult>;
  /** Flush prior appends and close; expected close failures resolve explicitly and never reject. */
  close(): Promise<AuditAppendResult>;
}

/**
 * Options for the public JSONL audit writer factory. Only an absolute, non-empty path is exposed;
 * there is deliberately no default path, environment variable, rotation policy, or singleton.
 */
export interface JsonlAuditWriterOptions {
  /** Absolute append-only audit path validated by the app adapter. */ readonly absolutePath: string;
}
