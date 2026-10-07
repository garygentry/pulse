// packages/web-data/src/cycle/fold-timeline.ts — the pure timeline fold
// (04-cycle-and-current-view-folds.md §11). This is an INDEX, not historical bodies: it
// emits stable target identities, human names, the exactly-applicable curated-catalog query
// ids and their accepted ranges, plus alert-history (vmalert) and Gatus endpoint-history
// (gatus) capability metadata. Historical bodies are served only by HistoryService routes.
//
// Applicability is derived from `QUERY_CATALOG` and the exact captured rendered relationships
// via `bindCuratedQuery` — the single source of truth for "does this query apply to this
// target". There is no second hand-maintained id list: catalog ids come from
// `queryIdsForTargetKind` (frozen catalog order) and accepted ranges from
// `acceptedRangesForQuery`. A query is never advertised for an inapplicable target, and a
// removed/ambiguous/invalid model relationship (a host with no instances, a service missing
// its declared metric, a duplicate endpoint key) is handled explicitly by the binder
// returning not-ok, so that target simply carries no such id.
//
// The fold performs NO source or history call: it reads only `inputs.model` and
// `inputs.observedAt`. Targets never fabricate an identity from a display name — every
// identity is a rendered `drilldownId` or an exact rendered Gatus endpoint key. `generatedAt`
// is body materialization time.
//
// Amendment 12 §4: every target carries its `parent` (host → null; service → the host whose
// name equals `service.host`, or null when undeclared; endpoint → its single declaring service),
// and the payload lists estate-level per-domain DNS checks (`domains`, from
// `model.estate.domains` in order, deduplicated first-wins, endpoint `dns:<domain>`).
// `checkHistory.endpoints` is the union of resolvable service endpoint keys and the domain
// endpoint names, sorted ascending. Domain endpoints are NOT endpoint targets.

import type { RangeId, TargetKind } from "../wire/common.js";
import type { QueryId, TargetIdentity } from "../wire/history.js";
import type { TimelineDomain, TimelinePayload, TimelineTarget } from "../wire/timeline.js";
import { QUERY_CATALOG, queryIdsForTargetKind } from "../queries/catalog.js";
import { bindCuratedQuery } from "../queries/binding.js";
import { RANGE_IDS, acceptedRangesForQuery } from "../queries/ranges.js";
import type { FoldInputs } from "./records.js";

/** Deterministic timeline target ordering: host < service < endpoint, then by exact id (§11). */
const TARGET_KIND_RANK: Readonly<Record<Exclude<TargetKind, "estate">, number>> = {
  host: 0,
  service: 1,
  endpoint: 2,
};

/**
 * The catalog query ids applicable to `target` against the captured model, in frozen catalog
 * order. Applicability is proven by the binder (`bindCuratedQuery`), so it follows the exact
 * declared relationships — a host with no scrape instances, a service without its deep-health
 * or backup metric, or an ambiguous endpoint key yields no ids. The range is passed as `null`
 * (the applicability check does not depend on a range) and the built PromQL is discarded.
 */
function applicableQueryIds(target: TargetIdentity, model: FoldInputs["model"]): readonly QueryId[] {
  return queryIdsForTargetKind(target.kind).filter(
    (id) => bindCuratedQuery(id, target, null, model).ok,
  );
}

/** Union of accepted ranges across `queryIds`, in ascending duration order (catalog/§5 order). */
function rangesUnion(queryIds: readonly QueryId[]): readonly RangeId[] {
  const union = new Set<RangeId>();
  for (const id of queryIds) {
    for (const range of acceptedRangesForQuery(QUERY_CATALOG[id])) union.add(range);
  }
  return RANGE_IDS.filter((range) => union.has(range));
}

/** Build one timeline target when it has at least one applicable query, else `null`. */
function buildTarget(
  target: TargetIdentity,
  name: string,
  parent: TargetIdentity | null,
  model: FoldInputs["model"],
): TimelineTarget | null {
  const queryIds = applicableQueryIds(target, model);
  if (queryIds.length === 0) return null;
  return { target, name, queryIds, ranges: rangesUnion(queryIds), parent };
}

/**
 * The Gatus endpoint keys declared by exactly one service, each mapped to that service's
 * drilldown id (its parent). A key declared by more than one service is an ambiguous (invalid)
 * relationship the binder rejects, so it is excluded explicitly.
 */
function resolvableEndpointOwners(model: FoldInputs["model"]): ReadonlyMap<string, string> {
  const owners = new Map<string, string | null>();
  for (const service of model.services) {
    for (const key of service.gatusEndpoints) {
      owners.set(key, owners.has(key) ? null : service.drilldownId);
    }
  }
  const resolvable = new Map<string, string>();
  for (const [key, owner] of owners) if (owner !== null) resolvable.set(key, owner);
  return resolvable;
}

/**
 * Estate-level domain DNS checks in model order, deduplicated (first occurrence wins). A
 * `dns:<domain>` name that any service also declares is left out: check history resolves such a
 * name by the service rule (and rejects it when ambiguous), so advertising it here as a domain
 * would promise history the route does not serve.
 */
function timelineDomains(model: FoldInputs["model"]): readonly TimelineDomain[] {
  const serviceEndpoints = new Set(model.services.flatMap((s) => s.gatusEndpoints));
  const seen = new Set<string>();
  const domains: TimelineDomain[] = [];
  for (const domain of model.estate.domains) {
    if (seen.has(domain) || serviceEndpoints.has(`dns:${domain}`)) continue;
    seen.add(domain);
    domains.push({ domain, endpoint: `dns:${domain}` });
  }
  return domains;
}

/** Deterministic code-unit string comparison. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Fold the captured rendered model into the timeline index payload (§11). Lists every host,
 * service, and endpoint target that has at least one applicable curated query — with its exact
 * rendered identity, human name, applicable catalog ids (catalog order), and the union of their
 * accepted ranges (ascending) — sorted by kind then id. Adds alert-history range metadata
 * (`vmalert`) derived from `alerts.firing` and Gatus endpoint-history metadata (`gatus`) listing
 * the resolvable endpoint keys. Pure and total over valid inputs; performs no source or history
 * call and never infers a target from a display name.
 *
 * @param inputs - The captured model/artifacts, source records, and stamping metadata.
 * @returns The materialized {@link TimelinePayload}.
 */
export function foldTimeline(inputs: FoldInputs): TimelinePayload {
  const { model } = inputs;

  const targets: TimelineTarget[] = [];

  const hostIdByName = new Map<string, string>();
  for (const host of model.hosts) {
    if (!hostIdByName.has(host.name)) hostIdByName.set(host.name, host.drilldownId);
    const target = buildTarget({ kind: "host", id: host.drilldownId }, host.name, null, model);
    if (target !== null) targets.push(target);
  }
  for (const service of model.services) {
    const hostId = hostIdByName.get(service.host);
    const target = buildTarget(
      { kind: "service", id: service.drilldownId },
      `${service.host}/${service.name}`,
      hostId !== undefined ? { kind: "host", id: hostId } : null,
      model,
    );
    if (target !== null) targets.push(target);
  }
  const endpointOwners = resolvableEndpointOwners(model);
  for (const [key, owner] of endpointOwners) {
    const target = buildTarget(
      { kind: "endpoint", id: key },
      key,
      { kind: "service", id: owner },
      model,
    );
    if (target !== null) targets.push(target);
  }

  targets.sort(
    (a, b) =>
      TARGET_KIND_RANK[a.target.kind] - TARGET_KIND_RANK[b.target.kind] ||
      compareIds(a.target.id, b.target.id),
  );

  // Addressable Gatus check history: every resolvable service endpoint key (declared by exactly
  // one service — the same set the endpoint targets draw from) plus every domain endpoint name.
  const domains = timelineDomains(model);
  const checkEndpoints = [
    ...new Set([...endpointOwners.keys(), ...domains.map((d) => d.endpoint)]),
  ].sort(compareIds);

  return {
    generatedAt: inputs.observedAt,
    targets,
    alertHistory: {
      ranges: acceptedRangesForQuery(QUERY_CATALOG["alerts.firing"]),
      provenance: "vmalert",
    },
    checkHistory: {
      endpoints: checkEndpoints,
      provenance: "gatus",
    },
    domains,
  };
}
