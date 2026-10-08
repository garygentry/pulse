// src/client/views/alerts/model.ts — the narrowing boundary + pure selectors (02 §2).
//
// The single place the view reads the store's alerts payload as the frozen wire `AlertsPayload`,
// plus the pure, order-preserving selectors every surface reads (REQ-TRIAGE-03). No re-validation —
// the data tier owns upstream validation (CON-04). Its only local import is the shared `targetRef`
// formatter: it is the root of the alerts view's module graph.

import type { AppStore } from "../../store/index.js";
import type {
  ActiveAlert,
  ActiveSilence,
  AlertsPayload,
  RuleState,
  TargetIdentity,
} from "@pulse/web-data/wire";
import { targetRef } from "../../target-ref.js";

/** Sentinel rule family for an alert with no matching catalog rule (00 §6, tech-spec §3.2). */
export const UNGROUPED_FAMILY = "ungrouped";

/** Distinct facet values for the FacetBar, one array per facet key. Shape mirrors FacetSelection's
 *  keys. Arrays are in first-seen (deterministic) order. */
export interface FacetValues {
  readonly severity: readonly string[];
  readonly state: readonly string[];
  readonly group: readonly string[];
  readonly hostService: readonly string[];
  readonly ruleFamily: readonly string[];
  readonly ack: readonly string[];
}

/**
 * Narrow the store's alerts payload to the frozen wire `AlertsPayload`.
 * This is the ONLY place the view casts the store payload; every selector below takes the
 * narrowed type so no other module repeats the cast (tech-spec §3.2). No re-validation is
 * performed — the data tier owns upstream validation and CON-04 restricts the view to reading.
 *
 * web-data-tier has already narrowed `store.alerts` in place, so the cast is currently a no-op; it
 * stays as the single intentional bridge should the signal type ever widen again (02 §2.1 WARNING).
 *
 * @param store - The signals AppStore. Read synchronously; no subscription here.
 * @returns The current `AlertsPayload`, or `null` before web-data-tier has published one.
 */
export function readAlerts(store: AppStore): AlertsPayload | null {
  return (store.alerts.value ?? null) as AlertsPayload | null;
}

/**
 * The firing-alert rows to render, in the data tier's deterministic order
 * (state → severity → start → fingerprint, owned by the fold). Returns `payload.alerts`
 * UNCHANGED — the view NEVER re-sorts or re-derives order (REQ-TRIAGE-03).
 * Silenced/inhibited alerts are present (visible-by-default, marked not filtered);
 * resolved alerts are already absent (REQ-TRIAGE-02).
 *
 * @param payload - The narrowed alerts payload.
 * @returns `payload.alerts` by reference — no copy, no sort.
 */
export function firingRows(payload: AlertsPayload): readonly ActiveAlert[] {
  return payload.alerts;
}

/** The vmalert rule catalog in the data tier's rule order (group/family → name, REQ-CATALOG-02).
 *  Returned unchanged — the catalog tab never re-sorts. */
export function rules(payload: AlertsPayload): readonly RuleState[] {
  return payload.rules;
}

/** The active silences in the data tier's silence order (start → id, REQ-SILENCE-02).
 *  Returned unchanged — the silences tab never re-sorts. */
export function silences(payload: AlertsPayload): readonly ActiveSilence[] {
  return payload.silences;
}

/**
 * Resolve an alert's rule family by joining `ActiveAlert.name` → `RuleState.name` against the
 * catalog (`payload.rules`) and reading the matched rule's `family` (`ActiveAlert` has no family).
 *
 * Tie-break: the FIRST match in the data tier's rule order wins. Fallback: an alert with no matching
 * catalog rule resolves to the selectable sentinel `UNGROUPED_FAMILY`.
 *
 * @returns The rule family, or `UNGROUPED_FAMILY` when unmatched. Never throws, never null.
 */
export function ruleFamily(payload: AlertsPayload, alert: ActiveAlert): string {
  const rule = payload.rules.find((r) => r.name === alert.name); // first in rule order (tie-break)
  return rule?.family ?? UNGROUPED_FAMILY;
}

/**
 * A name → family index for hot paths (facet-value collection, the filter pass over many rows).
 * `index.get(name) ?? UNGROUPED_FAMILY` is IDENTICAL to `ruleFamily` (both take the first rule in
 * order), but O(1) per lookup instead of O(rules) (REQ-PERF-01).
 *
 * @returns A read-only Map from alert/rule name to family (first-match-wins).
 */
export function buildRuleFamilyIndex(payload: AlertsPayload): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const rule of payload.rules) {
    if (!index.has(rule.name)) index.set(rule.name, rule.family); // first match preserved
  }
  return index;
}

/**
 * Collect the DISTINCT value universe for each facet over ALL firing rows (unfiltered), so the
 * FacetBar chip set is stable regardless of the current selection. De-duplicated in first-seen order
 * (deterministic because `payload.alerts` is already in the data tier's fixed order); never re-sorted.
 * An alert with `group: null` / `target: null` contributes no value to that facet.
 *
 * @returns One distinct, ordered string[] per facet key.
 */
export function facetValues(payload: AlertsPayload): FacetValues {
  const severity = new Set<string>();
  const state = new Set<string>();
  const group = new Set<string>();
  const hostService = new Set<string>();
  const family = new Set<string>();
  const ack = new Set<string>();
  const familyIndex = buildRuleFamilyIndex(payload);

  for (const a of payload.alerts) {
    severity.add(a.severity);
    state.add(a.state);
    if (a.group !== null) group.add(a.group);
    const hs = hostServiceValue(a);
    if (hs !== null) hostService.add(hs);
    family.add(familyIndex.get(a.name) ?? UNGROUPED_FAMILY);
    ack.add(a.ack !== undefined ? "acked" : "unacked");
  }

  return {
    severity: [...severity],
    state: [...state],
    group: [...group],
    hostService: [...hostService],
    ruleFamily: [...family],
    ack: [...ack],
  };
}

/**
 * The host/service facet value: the target's canonical reference (`targetRef`), e.g. "host:web01" or
 * "svc:web01/nginx" — the wire id already carries the kind, so it is not prefixed again (GitHub #10).
 * `null` when the alert is unattributable (`target === null`). Matches the tech-spec §3.3 URL example
 * (`hs=host:web01`).
 */
export function hostServiceValue(alert: ActiveAlert): string | null {
  return alert.target === null ? null : targetRef(alert.target);
}

/**
 * Exact `TargetIdentity` equality over `{kind,id}`. Two nulls are NOT equal — an unattributable
 * alert has no "same target" (REQ-DETAIL-09: never a fuzzy label-based guess).
 *
 * @returns true iff both are non-null and share kind AND id.
 */
export function targetEquals(a: TargetIdentity | null, b: TargetIdentity | null): boolean {
  if (a === null || b === null) return false;
  return a.kind === b.kind && a.id === b.id;
}

/**
 * Firing alerts on the SAME target as `target`, by exact `TargetIdentity` equality (REQ-DETAIL-09),
 * in `payload.alerts` order. A null `target` yields `[]`. The result INCLUDES the alert whose target
 * this is; the Related section excludes the open fingerprint itself.
 */
export function relatedByTarget(
  payload: AlertsPayload,
  target: TargetIdentity | null,
): readonly ActiveAlert[] {
  if (target === null) return [];
  return payload.alerts.filter((a) => targetEquals(a.target, target));
}
