/**
 * The provider freshness stamp `FreshnessBadge` renders. Deck imports these from its server
 * contract; pulse has no such contract, so the shape lives with the library.
 */
export type FreshnessState = "fresh" | "stale" | "unreachable" | "static" | "pending";

export interface FreshnessStamp {
  state: FreshnessState;
  observedAt: string | null;
  ageMs: number | null;
  ttlMs: number | null;
}
