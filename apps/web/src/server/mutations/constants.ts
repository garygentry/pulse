// apps/web/src/server/mutations/constants.ts — server-side mutation constants.
//
// Single home of the server mutation constants. PROPOSAL_SECRET_MIN_BYTES is NOT defined here: it is
// imported from @pulse/core/proposals — shared by web, core sign and the CLI. The audit-encoding bounds live
// in audit.ts because they mirror writer.ts, not configuration.

/** Fixed prefix every mutation path sits under (REQ-SEAM-01); registration rejects any other path. */
export const MUTATION_PATH_PREFIX = "/api/mutations/" as const;
// Header names are lowercase (Headers lookups are case-insensitive; 03's mutationHeaders uses these values).
/** Request header carrying the client idempotency key (REQ-IDEM-01). */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key" as const;
/** Response header carrying the server request id. */
export const REQUEST_ID_HEADER = "x-request-id" as const;
/** Response header set to `true` on an idempotent replay. */
export const IDEMPOTENCY_REPLAYED_HEADER = "idempotency-replayed" as const;
/** Cache-Control on every mutation response. */
export const MUTATION_CACHE_CONTROL = "private, no-store" as const;
/** Bound for ids that become audit targets/details (writer caps target and values at 256 bytes). */
export const MUTATION_ID_MAX_BYTES = 128;                        // fingerprint, silenceId; no control chars
/** Request body cap (REQ-SEC-03). */
export const MUTATION_BODY_MAX_BYTES = 16 * 1024;
/** Idempotency-Key grammar (REQ-IDEM-01). */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
/** Idempotency entry lifetime after completion (REQ-IDEM-02). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** Idempotency store capacity. */
export const IDEMPOTENCY_MAX_ENTRIES = 10_000;
/** details.fields cap in UTF-8 bytes. */
export const INVALID_FIELDS_MAX_BYTES = 512;
/** GET /api/proposals list cap. */
export const PROPOSAL_LIST_MAX = 50;
/** Write-path env names (REQ-CFG-01). */
export const WRITE_PATH_ENV = {
  dataDir: "PULSE_WEB_DATA_DIR",
  auditPath: "PULSE_WEB_AUDIT_PATH",
  ackStorePath: "PULSE_WEB_ACK_STORE_PATH",
  proposalsDir: "PULSE_WEB_PROPOSALS_DIR",
  secret: "PULSE_PROPOSAL_SECRET",
} as const;
/** Default store locations, relative to the data dir. */
export const WRITE_PATH_DEFAULTS = { audit: "audit/audit.jsonl", acks: "acks.json", proposals: "proposals" } as const;
