// src/client/views/estate/inventory-model.ts — pure data model for the inventory tab: collection-class
// grouping, the flat expansion-aware tree rows, orphaned-service detection, and host/service coverage
// classification. Pure: no JSX, no UI-framework import; inventory.tsx renders from these.

import type {
  CoverageEntry,
  WebCoverageArtifact,
  WebEstateHostV2,
  WebEstateServiceV2,
} from "@pulse/renderer";
import type { AvailabilitySection } from "@pulse/web-data/wire";

import type { IconName } from "@/ui";

export type CollectionClass = WebEstateHostV2["collectionClass"];

/** Fixed display order + label for each collection-class group (closed set). */
export const CLASS_GROUPS: readonly {
  readonly class: CollectionClass;
  readonly label: string;
  readonly icon: IconName;
}[] = [
  { class: "managed-linux", label: "Managed Linux", icon: "server" },
  { class: "hypervisor-api", label: "Hypervisor API", icon: "layout-grid" },
  { class: "nas-api", label: "NAS API", icon: "layout-grid" },
  { class: "probe-only", label: "Probe-only", icon: "network" },
  { class: "excluded", label: "Excluded", icon: "circle" },
];

export const CLASS_LABEL = new Map<string, string>(CLASS_GROUPS.map((g) => [g.class, g.label]));

/** One flattened, renderable tree row; `kind` drives the cell projection. */
export type TreeRow =
  | {
      readonly kind: "group";
      readonly id: string;
      readonly class: CollectionClass;
      readonly label: string;
      readonly icon: IconName;
      readonly hostCount: number;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "host";
      readonly id: string;
      readonly host: WebEstateHostV2;
      readonly serviceCount: number;
      readonly expanded: boolean;
    }
  | { readonly kind: "service"; readonly id: string; readonly service: WebEstateServiceV2 }
  | { readonly kind: "error"; readonly id: string; readonly message: string };

/** Defensive shape guard shared by hosts and services: the fields a row projection reads. */
function isRenderableEntity(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const r = e as { name?: unknown; drilldownId?: unknown; provenance?: unknown };
  return (
    typeof r.name === "string" &&
    typeof r.drilldownId === "string" &&
    typeof r.provenance === "object" &&
    r.provenance !== null
  );
}

const byName = <T extends { readonly name: string }>(a: T, b: T): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Build the flat, expansion-aware row list. Pure. With `matchedIds` set, only matched
 * hosts/services survive (a host also survives when it owns a matched service) and every group plus
 * every host owning a matched service is force-expanded so matches are visible. Services whose host
 * matches no declared host are left out of the tree (see {@link findOrphanedServices}). A malformed
 * host/service becomes an `error` row instead of throwing.
 */
export function buildTreeRows(input: {
  readonly hosts: readonly WebEstateHostV2[];
  readonly services: readonly WebEstateServiceV2[];
  readonly expandedGroups: ReadonlySet<CollectionClass>;
  readonly expandedHosts: ReadonlySet<string>;
  readonly matchedIds: ReadonlySet<string> | null;
}): readonly TreeRow[] {
  const { matchedIds } = input;
  const rows: TreeRow[] = [];
  const errors: TreeRow[] = [];

  // Index (surviving) services by owner name — the only nesting join.
  const servicesByHost = new Map<string, WebEstateServiceV2[]>();
  input.services.forEach((service, i) => {
    if (!isRenderableEntity(service) || typeof service.host !== "string") {
      errors.push({ kind: "error", id: `error:service:${i}`, message: "Malformed service entry" });
      return;
    }
    if (matchedIds !== null && !matchedIds.has(service.drilldownId)) return;
    const list = servicesByHost.get(service.host);
    if (list === undefined) servicesByHost.set(service.host, [service]);
    else list.push(service);
  });

  // Bucket (surviving) hosts by collection class.
  const hostsByClass = new Map<CollectionClass, WebEstateHostV2[]>();
  input.hosts.forEach((host, i) => {
    if (!isRenderableEntity(host) || !CLASS_LABEL.has(host.collectionClass)) {
      errors.push({ kind: "error", id: `error:host:${i}`, message: "Malformed host entry" });
      return;
    }
    if (matchedIds !== null && !matchedIds.has(host.drilldownId) && !servicesByHost.has(host.name)) {
      return;
    }
    const list = hostsByClass.get(host.collectionClass);
    if (list === undefined) hostsByClass.set(host.collectionClass, [host]);
    else list.push(host);
  });

  for (const group of CLASS_GROUPS) {
    const hosts = hostsByClass.get(group.class);
    if (hosts === undefined || hosts.length === 0) continue;
    const groupExpanded = matchedIds !== null || input.expandedGroups.has(group.class);
    rows.push({
      kind: "group",
      id: `group:${group.class}`,
      class: group.class,
      label: group.label,
      icon: group.icon,
      hostCount: hosts.length,
      expanded: groupExpanded,
    });
    if (!groupExpanded) continue;
    for (const host of [...hosts].sort(byName)) {
      const services = servicesByHost.get(host.name) ?? [];
      const forced = matchedIds !== null && services.length > 0;
      const expanded = services.length > 0 && (forced || input.expandedHosts.has(host.drilldownId));
      rows.push({ kind: "host", id: host.drilldownId, host, serviceCount: services.length, expanded });
      if (!expanded) continue;
      for (const service of [...services].sort(byName)) {
        rows.push({ kind: "service", id: service.drilldownId, service });
      }
    }
  }
  return errors.length > 0 ? [...rows, ...errors] : rows;
}

/** Services whose `host` names no declared host — surfaced in the secondary region. */
export function findOrphanedServices(
  hosts: readonly WebEstateHostV2[],
  services: readonly WebEstateServiceV2[],
): readonly WebEstateServiceV2[] {
  const names = new Set(hosts.map((h) => h.name));
  return services.filter((s) => isRenderableEntity(s) && !names.has(s.host));
}

/** A host/service coverage classification for the tree indicator. */
export type HostCoverage = "covered" | "gap" | "suppressed" | "unknown";

/**
 * Classify a host from the coverage artifact. `coverage.value === null` ⇒ "unknown" for
 * EVERY host, never "covered". Otherwise bucket precedence is suppressed → gap → covered, and a
 * host in no bucket is "unknown".
 */
export function classifyHostCoverage(
  host: Pick<WebEstateHostV2, "name">,
  coverage: AvailabilitySection<WebCoverageArtifact>,
): HostCoverage {
  if (coverage.value === null) return "unknown";
  return classifyIn(buildCoverageIndex(coverage.value), "host", host.name);
}

/** Per-bucket entity keys (`host|<name>` / `service|<host>/<name>`), built once per payload. */
export interface CoverageIndex {
  readonly suppressed: ReadonlySet<string>;
  readonly gaps: ReadonlySet<string>;
  readonly covered: ReadonlySet<string>;
}

export function buildCoverageIndex(art: WebCoverageArtifact): CoverageIndex {
  const keys = (b: readonly CoverageEntry[]): Set<string> =>
    new Set(b.map((e) => `${e.kind}|${e.name}`));
  return { suppressed: keys(art.suppressed), gaps: keys(art.gaps), covered: keys(art.covered) };
}

export function classifyIn(index: CoverageIndex | null, kind: CoverageEntry["kind"], name: string): HostCoverage {
  if (index === null) return "unknown"; // absent ⇒ unknown
  const key = `${kind}|${name}`;
  if (index.suppressed.has(key)) return "suppressed";
  if (index.gaps.has(key)) return "gap";
  if (index.covered.has(key)) return "covered";
  return "unknown";
}

export const COVERAGE_LABEL: Record<HostCoverage, string> = {
  covered: "Covered",
  gap: "Coverage gap",
  suppressed: "Suppressed",
  unknown: "Coverage unknown",
};
