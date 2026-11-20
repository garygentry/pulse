// Push error model. For now: the internal invariant error only.

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
