// src/client/views/alerts/url-state.ts — the triage-state URL codec (02 §3).
//
// The single boundary between `RouteMatch.query` (a flat, already-URL-decoded record) and the typed
// `TriageUrlState`. Encodes ONLY facets + selection: kiosk/rotate are carried by the router's
// `navigate` (CARRIED_QUERY_KEYS), so this module never emits or strips them (REQ-FACET-06).
import type { RouteMatch } from "../../router.js";
import type { ActiveAlert, AlertsPayload } from "@pulse/web-data/wire";
import { firingRows } from "./model.js";

/** The facets (00 §4.1, plus `ack`). Multi-select; union within a facet, AND across
 *  (REQ-FACET-01/03). */
export type FacetKey = "severity" | "state" | "group" | "hostService" | "ruleFamily" | "ack";

/** Ack facet values; the URL value is the same string (REQ-ACK-07c). */
export type AckFacetValue = "acked" | "unacked";

/** A facet selection (00 §4.1). Empty arrays = "no filter" → all firing rows (REQ-FACET-02). */
export interface FacetSelection {
  readonly severity: readonly string[];
  readonly state: readonly ("firing" | "silenced" | "inhibited")[];
  readonly group: readonly string[];
  readonly hostService: readonly string[];
  readonly ruleFamily: readonly string[];
  readonly ack: readonly AckFacetValue[];
}

/** The FULL triage state carried in the URL query (00 §4.1, REQ-FACET-04, REQ-ROUTE-01/02).
 *  `selected` = the `sel` value = an `ActiveAlert.fingerprint`, or null (pane closed). */
export interface TriageUrlState {
  readonly facets: FacetSelection;
  readonly selected: string | null;
}

/** Ordered facet keys for the codec and FacetBar (00 §6). */
export const FACET_KEYS = ["severity", "state", "group", "hostService", "ruleFamily", "ack"] as const;

/** URL query parameter names — stable, sorted output for shareable-link determinism (00 §6). */
export const QUERY_KEYS = {
  severity: "sev",
  state: "state",
  group: "group",
  hostService: "hs",
  ruleFamily: "family",
  ack: "ack",
  selected: "sel",
} as const;

/** Multi-select facet value delimiter in the query string (00 §6). */
export const FACET_DELIMITER = ",";

/**
 * Encode the full triage state into a query string (WITHOUT a leading "?"). Settles OQ-01:
 *   - param names come from QUERY_KEYS (sev/state/group/hs/family/sel);
 *   - multi-select values are joined by FACET_DELIMITER (",");
 *   - facet params are emitted in FACET_KEYS canonical order, and each facet's values are SORTED,
 *     so two operators reaching the same selection produce the SAME shareable link regardless of the
 *     order chips were toggled (deterministic — REQ-FACET-04).
 * Empty facets are omitted; a null/empty `selected` omits `sel`. Returns "" for the fully-default
 * state (caller then navigates to "/alerts" with no query).
 *
 * Note: kiosk/rotate are NOT emitted here — the router carries them automatically on navigate
 * (REQ-FACET-06). This function encodes ONLY facets + selection.
 *
 * Limitation (OQ-01): the comma delimiter assumes facet values contain no literal comma; a `group`
 * name containing one would split on decode — acceptable for M1.
 *
 * @param state - The triage state to serialize.
 * @returns A query string without the leading "?"; "" when nothing is selected/filtered.
 */
export function encodeTriageState(state: TriageUrlState): string {
  const params = new URLSearchParams();
  for (const key of FACET_KEYS) {
    const values = state.facets[key];
    if (values.length === 0) continue;
    const sorted = [...values].sort(); // order-independent → deterministic shareable links (OQ-01)
    params.set(QUERY_KEYS[key], sorted.join(FACET_DELIMITER));
  }
  if (state.selected !== null && state.selected !== "") {
    params.set(QUERY_KEYS.selected, state.selected);
  }
  return params.toString();
}

/**
 * Decode `RouteMatch.query` back into the typed triage state. The router has already URL-decoded each
 * value, so values arrive plain (e.g. "critical,warning"). Missing/empty params decode to empty facet
 * arrays / null selection. Unknown facet values are NOT validated against the payload — an
 * unrecognized value simply matches no rows, which is graceful (never a crash; 00 §7.1).
 *
 * @param query - The frozen query record from `router.current().query` (00 §3.5).
 * @returns The decoded `TriageUrlState` (facets + selection).
 */
export function decodeTriageState(query: RouteMatch["query"]): TriageUrlState {
  const split = (raw: string | undefined): string[] =>
    raw === undefined || raw === "" ? [] : raw.split(FACET_DELIMITER).filter((v) => v !== "");
  const sel = query[QUERY_KEYS.selected];
  return {
    facets: {
      severity: split(query[QUERY_KEYS.severity]),
      // Unvalidated cast: a bogus hand-typed state degrades to matching no rows (02 §3.2).
      state: split(query[QUERY_KEYS.state]) as ("firing" | "silenced" | "inhibited")[],
      group: split(query[QUERY_KEYS.group]),
      hostService: split(query[QUERY_KEYS.hostService]),
      ruleFamily: split(query[QUERY_KEYS.ruleFamily]),
      // Validated: only the two ack literals survive; anything else is dropped.
      ack: split(query[QUERY_KEYS.ack]).filter(
        (v): v is AckFacetValue => v === "acked" || v === "unacked",
      ),
    },
    selected: sel === undefined || sel === "" ? null : sel,
  };
}

/** The overview `target` alias query key: `/alerts?target=<TargetIdentity.id>` (overview-redesign's
 *  targetTriagePath). Accepted on decode only; the view never emits it (`hs` is canonical). */
export const TARGET_ALIAS_KEY = "target";

/** The TargetIdentity kinds a bare `target` id expands to. The alias carries only the id, so it
 *  selects that id under every attributable kind (union within the hostService facet). */
export const TARGET_ALIAS_KINDS = ["host", "service", "endpoint"] as const;

/**
 * Decode a full `RouteMatch` (path params + query) into the triage state. Extends
 * `decodeTriageState` with the two overview deep-link forms (charter 04 §2 carve-out, V-001):
 *   - `/alerts/:fingerprint` — `params.fingerprint` selects the alert when `sel` is absent/empty
 *     (`sel` wins when both are present);
 *   - `?target=<id>` — adds `host:<id>`, `service:<id>` and `endpoint:<id>` to the hostService facet,
 *     merged with any `hs` values and de-duplicated (first-seen order).
 *
 * A `TargetIdentity` has exactly one kind, so at most one expanded value can match. When the
 * caller knows the payload's host/service values (`available`) and at least one expanded value is
 * among them, only those are kept, so no invisible, unmatchable value is left in the selection
 * (it would turn the filter into a falsely empty table once the visible chip is cleared). With no
 * payload, or no match, the full expansion is kept (the view renders such values as clearable chips).
 *
 * @param match - The current route (`router.current()`).
 * @param available - `facetValues(payload).hostService`, or null/omitted when no payload is loaded.
 * @returns The decoded `TriageUrlState`.
 */
export function decodeTriageRoute(match: RouteMatch, available?: readonly string[] | null): TriageUrlState {
  const base = decodeTriageState(match.query);
  const param = match.params["fingerprint"];
  const selected = base.selected ?? (param === undefined || param === "" ? null : param);
  const target = match.query[TARGET_ALIAS_KEY];
  if (target === undefined || target === "") return { ...base, selected };
  const expanded = TARGET_ALIAS_KINDS.map((k) => `${k}:${target}`);
  const matching = available == null ? [] : expanded.filter((v) => available.includes(v));
  const alias = matching.length > 0 ? matching : expanded;
  const hostService = [...new Set([...base.facets.hostService, ...alias])];
  return { facets: { ...base.facets, hostService }, selected };
}

/**
 * Resolve the `sel` fingerprint to the firing alert it names, or `null` when it matches none — i.e.
 * the fingerprint churned across an Alertmanager restart/rule edit, or the alert has resolved. This is
 * the PURE resolver that feeds REQ-ROUTE-03; the "no longer firing" rendering is the DetailPane's.
 *
 * @param payload  - The narrowed alerts payload, or null (not yet loaded).
 * @param selected - The `sel` value (an `ActiveAlert.fingerprint`), or null (pane closed).
 * @returns The matching firing alert, or null (closed, not-loaded, or churned/resolved).
 */
export function resolveSelected(
  payload: AlertsPayload | null,
  selected: string | null,
): ActiveAlert | null {
  if (payload === null || selected === null || selected === "") return null;
  return firingRows(payload).find((a) => a.fingerprint === selected) ?? null;
}
