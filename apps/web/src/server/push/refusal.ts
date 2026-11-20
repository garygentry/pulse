// Push error model: internal error classes.

import type { PushConfigReason } from "./config.js";

/**
 * Programmer error (invariant violation). Thrown where an invariant fails. Push code never catches it except at the
 * designated catch sites (dispatcher → 500, background loops → log). Carries a stable code, never a secret, and is
 * never serialised into a response.
 */
export class PushInvariantError extends Error {
  /** Stable machine-readable code. */
  readonly code = "PUSH_INVARIANT" as const;

  constructor(message: string) {
    super(message);
    this.name = "PushInvariantError";
  }
}

/**
 * Per-variable failure carrier used inside push configuration parsing. It is always caught there and never escapes
 * the parser. Its message names the variable and the reason kind only, never the value.
 */
export class PushConfigParseError extends Error {
  /** Stable machine-readable code. */
  readonly code = "PUSH_CONFIG" as const;
  /** The rejected variable and why. */
  readonly reason: PushConfigReason;

  constructor(reason: PushConfigReason) {
    super(`${reason.envVar}: ${reason.reason}`);
    this.name = "PushConfigParseError";
    this.reason = reason;
  }
}
