// src/client/views/estate/search-model.ts — pure in-memory estate filter: a single-linear-pass,
// case-insensitive substring match over the loaded model.

import type {
  WebChannel,
  WebEstateHostV2,
  WebEstateModelV2,
  WebEstateServiceV2,
  WebRoutingOverride,
  WebStandaloneSuppression,
} from "@pulse/renderer";

/**
 * The result of filtering the declared estate by a search query. A host is retained when it
 * matches OR hosts a matching service, so a matching service is never orphaned from the tree.
 * When the query is empty every collection is the input model's array (identity-preserved).
 */
export interface FilteredEstate {
  readonly hosts: readonly WebEstateHostV2[];
  readonly services: readonly WebEstateServiceV2[];
  readonly channels: readonly WebChannel[];
  readonly routingOverrides: readonly WebRoutingOverride[];
  readonly suppressions: readonly WebStandaloneSuppression[];
  /** The normalized (trimmed, lowercased) query that produced this result. */
  readonly query: string;
  /** False when the query is empty — every entity passes through unchanged. */
  readonly isFiltered: boolean;
}

/** Case-insensitive substring match of a pre-lowercased `needle` against any non-empty field. */
function matchesFields(fields: readonly string[], needle: string): boolean {
  for (const field of fields) {
    if (field !== "" && field.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/**
 * Filter the declared estate by a case-insensitive substring query: entity name,
 * collectionClass / service kind, and `provenance.file` across all five collections. An empty or
 * whitespace query returns the model's collections unchanged with `isFiltered: false`.
 */
export function filterEstate(model: WebEstateModelV2, query: string): FilteredEstate {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return {
      hosts: model.hosts,
      services: model.services,
      channels: model.channels,
      routingOverrides: model.routingOverrides,
      suppressions: model.suppressions,
      query: "",
      isFiltered: false,
    };
  }

  const services = model.services.filter((s) =>
    matchesFields([s.name, s.kind, s.host, s.provenance.file], needle),
  );
  // Retain hosts that match themselves OR host a matching service (keeps the tree intact).
  const matchedHostNames = new Set(services.map((s) => s.host));
  const hosts = model.hosts.filter(
    (h) =>
      matchedHostNames.has(h.name) ||
      matchesFields([h.name, h.collectionClass, h.provenance.file], needle),
  );
  const channels = model.channels.filter((c) =>
    matchesFields([c.name, c.kind, c.provenance.file], needle),
  );
  const routingOverrides = model.routingOverrides.filter((r) =>
    matchesFields([r.severity, ...r.channels, r.provenance.file], needle),
  );
  const suppressions = model.suppressions.filter((sp) =>
    matchesFields([sp.target, sp.class, sp.rationale, sp.provenance.file], needle),
  );

  return { hosts, services, channels, routingOverrides, suppressions, query: needle, isFiltered: true };
}
