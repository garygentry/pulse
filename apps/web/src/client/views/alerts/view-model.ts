// src/client/views/alerts/view-model.ts — the alerts view's tab model: tab ids, the tab query key
// and the route-query → tab decision.

/** The three firing-surface tabs. `firing` is default; the other two are read-only tables. */
export type TriageTabId = "firing" | "catalog" | "silences";

/** Every tab id, in display order (view.tsx renders one tab per id). */
export const TRIAGE_TAB_IDS: readonly TriageTabId[] = ["firing", "catalog", "silences"];

/** view.tsx-local query key for the active tab (NOT part of TriageUrlState). */
export const TAB_QUERY_KEY = "tab";

/** Read the active tab from the route query; anything unrecognized falls back to "firing". */
export function tabFromQuery(query: Readonly<Record<string, string>>): TriageTabId {
  const t = query[TAB_QUERY_KEY];
  return TRIAGE_TAB_IDS.find((id) => id === t) ?? "firing";
}
