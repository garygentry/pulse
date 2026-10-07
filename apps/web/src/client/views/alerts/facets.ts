// src/client/views/alerts/facets.ts — facet definitions & the client-side filter predicate (02 §4).
//
// The edge into url-state.ts is `import type` only (no runtime cycle — url-state imports model.ts at
// runtime, and so does this module; neither imports the other's values).
import type { ActiveAlert, AlertsPayload } from "@pulse/web-data/wire";
import type { FacetKey, FacetSelection } from "./url-state.js";
import { hostServiceValue, ruleFamily } from "./model.js";

/** One facet: its key, a display label, and the accessor that yields an alert's value for it
 *  (or null when not applicable — e.g. null target/group). */
export interface FacetDef {
  readonly key: FacetKey;
  readonly label: string;
  readonly valueOf: (payload: AlertsPayload, alert: ActiveAlert) => string | null;
}

/** The facets (REQ-FACET-01; `ack` per REQ-ACK-07c), in FACET_KEYS order. `payload` is unused by the four pure
 *  accessors and threaded only for the rule-family join. */
export const FACET_DEFS: readonly FacetDef[] = [
  { key: "severity", label: "Severity", valueOf: (_p, a) => a.severity },
  { key: "state", label: "State", valueOf: (_p, a) => a.state },
  { key: "group", label: "Group", valueOf: (_p, a) => a.group },
  { key: "hostService", label: "Host / Service", valueOf: (_p, a) => hostServiceValue(a) },
  { key: "ruleFamily", label: "Rule family", valueOf: (p, a) => ruleFamily(p, a) },
  { key: "ack", label: "Acknowledged", valueOf: (_p, a) => (a.ack !== undefined ? "acked" : "unacked") },
];

/**
 * Whether an alert passes the current facet selection. Composition (REQ-FACET-03):
 *   - UNION within a facet (OR): the alert's value need only be one of that facet's selected values;
 *   - INTERSECTION across facets (AND): every facet that HAS a selection must match.
 * An empty selection for a facet means "no filter on this facet" → it is skipped, so a fully-empty
 * selection passes ALL firing rows (REQ-FACET-02). Silenced/inhibited alerts are firing rows and pass
 * by default (visible-by-default, marked not filtered — REQ-TRIAGE-02). Runs entirely over the loaded
 * payload — no refetch (REQ-FACET-05). Never throws.
 *
 * @param payload - The narrowed alerts payload (needed by the rule-family accessor).
 * @param alert   - The firing alert to test.
 * @param sel     - The current facet selection.
 * @returns true iff the alert satisfies every active facet.
 */
export function matchesFacets(
  payload: AlertsPayload,
  alert: ActiveAlert,
  sel: FacetSelection,
): boolean {
  for (const def of FACET_DEFS) {
    const selected: readonly string[] = sel[def.key];
    if (selected.length === 0) continue; // facet inactive → no constraint (REQ-FACET-02)
    const value = def.valueOf(payload, alert);
    // OR within the facet; a null/absent value cannot satisfy an active facet (AND across facets):
    if (value === null || !selected.includes(value)) return false;
  }
  return true;
}
