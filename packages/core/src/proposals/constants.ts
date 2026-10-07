/** Proposal format limits (browser-safe; imports nothing). Every other module re-exports these from
 *  `@pulse/core/proposals`; they are never redefined. */

/** Minimum length of PULSE_PROPOSAL_SECRET, in UTF-8 bytes. signProposal throws below it. */
export const PROPOSAL_SECRET_MIN_BYTES = 32 as const;
/** Proposal rationale bounds, in characters after trim (REQ-PROP-02). */
export const PROPOSAL_RATIONALE_MIN_CHARS = 10 as const;
/** Maximum proposal rationale length, in characters after trim (REQ-PROP-02). */
export const PROPOSAL_RATIONALE_MAX_CHARS = 500 as const;
/** `pulse proposals reject --reason` bounds (REQ-PROP-09); also the result-sidecar schema bounds. */
export const PROPOSAL_REJECT_REASON_MIN_CHARS = 10 as const;
/** Maximum `--reason` length for a rejection, in characters (REQ-PROP-09). */
export const PROPOSAL_REJECT_REASON_MAX_CHARS = 500 as const;
/** Changes per proposal (REQ-PROP-02). */
export const PROPOSAL_CHANGES_MAX = 5 as const;
/**
 * Max UTF-8 bytes of a proposal `target.id` (drilldown id). The audit target is `"<kind>:<id>"` and the
 * audit writer caps targets at 256 bytes: `"service:".length + 247 ≤ 256`.
 */
export const PROPOSAL_TARGET_ID_MAX_BYTES = 247 as const;
/** Proposal/result files larger than this are counted invalid without parsing (bodies are ≤ 16 KiB). Web store and CLI. */
export const PROPOSAL_FILE_MAX_BYTES = 64 * 1024;
