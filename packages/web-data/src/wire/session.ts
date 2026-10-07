// packages/web-data/src/wire/session.ts — browser-safe session contract
// (01-core-definitions.md §8; widened in M2 with capabilities). Exposes the resolved minimized
// identity (or null when disabled/untrusted/invalid), the configured authentication mode, and the three
// capability flags, which are `boolean` and true only in proxy-header mode with a trusted identity and a
// healthy write path (REQ-AUTHZ-02). Every type import is erased under verbatimModuleSyntax, so `/wire`
// stays runtime-free even though `Identity`/`AuthMode` live under `identity/`.

import type { AuthMode } from "../identity/config.js";
import type { Identity } from "../identity/resolve.js";

/** Capability flags reported by /api/session; true only per REQ-AUTHZ-02. */
export interface SessionCapabilities {
  /** Create/expire silences. */ readonly silence: boolean;
  /** Acknowledge/unacknowledge alerts. */ readonly ack: boolean;
  /** Submit estate-edit proposals. */ readonly proposeEstateEdit: boolean;
}

/**
 * Response body for `/api/session`. Every capability is false unless the server runs in proxy-header
 * mode, the request carries a trusted identity, and the capability's write-path stores are healthy.
 */
export interface SessionPayload {
  /** Resolved request identity, or null when disabled/untrusted/invalid. */ readonly identity: Identity | null;
  /** Configured authentication mode. */ readonly authMode: AuthMode;
  /** Per-capability flags; all false unless proxy-header mode, trusted identity and healthy stores. */
  readonly capabilities: SessionCapabilities;
}
