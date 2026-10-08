// src/client/views/estate/inventory.tsx — the inventory landing tab: the hosts→services tree plus the
// secondary channels / routing / suppressions tables.
//
// Read-only and props-driven: view.tsx narrows the payload and gates delivery before mounting this
// surface, so it only ever sees a non-null model. The tree is a `TreeView` over a nested node model
// folded from `buildTreeRows`. Services nest under the host whose `name === service.host`; nothing is
// derived by parsing a name.

import type { ReactElement, ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import type {
  WebChannel,
  WebCoverageArtifact,
  WebEstateHostV2,
  WebEstateModelV2,
  WebEstateServiceV2,
  WebRoutingOverride,
  WebStandaloneSuppression,
} from "@pulse/renderer";
import type { AvailabilitySection, EstateTargetState } from "@pulse/web-data/wire";

import {
  Badge,
  Callout,
  DataTable,
  EmptyState,
  Icon,
  Section,
  StatusBadge,
  TARGET_STATUS,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TreeView,
} from "@/ui";
import type { ColumnDef, IconName } from "@/ui";
import { STATUS_LABEL } from "../../a11y/index.js";
import { COVERAGE_STATUS } from "../../status/target-status.js";
import type { PathRouter } from "../../router.js";
import { safeCell, safeNavigate } from "./error-boundary.js";
import { ProvenanceChip } from "./provenance-chip.js";
import { provenanceRef } from "./provenance.js";
import { toTargetStatus } from "./status.js";
import { effectiveStatus } from "./coverage-model.js";
import {
  CLASS_GROUPS,
  CLASS_LABEL,
  buildCoverageIndex,
  buildTreeRows,
  classifyIn,
  coverageLabel,
  coverageStaleness,
  findOrphanedServices,
} from "./inventory-model.js";
import type {
  CollectionClass,
  CoverageIndex,
  CoverageStaleness,
  HostCoverage,
  TreeRow,
} from "./inventory-model.js";

/** Props for the inventory landing surface. */
export interface InventoryProps {
  /** The declared v2 model — the stable inventory. */
  readonly estate: Readonly<WebEstateModelV2>;
  /** Live-state rows, matched to model entities by drilldownId (status only). */
  readonly liveTargets: readonly EstateTargetState[];
  /** Coverage buckets, or the absent envelope (`value === null`) ⇒ every entity "unknown". A present
   *  but non-current section never badges ok: covered reads "Stale coverage" (etc.) as unknown. */
  readonly coverage: AvailabilitySection<WebCoverageArtifact>;
  /** drilldownIds matching the active search, or `null` when no query is active. */
  readonly matchedIds: ReadonlySet<string> | null;
  /** Router for entity deep-link navigation. */
  readonly router: PathRouter;
}

type SecondaryTabId = "channels" | "routing" | "suppressions";

const SECONDARY_TABS: readonly { id: SecondaryTabId; label: string; icon: IconName }[] = [
  { id: "channels", label: "Channels", icon: "list" },
  { id: "routing", label: "Routing overrides", icon: "network" },
  { id: "suppressions", label: "Suppressions", icon: "circle-help" },
];

/** One node of the declared tree: class group → host → service. */
type InventoryNode =
  | {
      readonly kind: "group";
      readonly id: string;
      readonly class: CollectionClass;
      readonly label: string;
      readonly icon: IconName;
      readonly hostCount: number;
      readonly children: InventoryNode[];
    }
  | {
      readonly kind: "host";
      readonly id: string;
      readonly host: WebEstateHostV2;
      readonly serviceCount: number;
      readonly children: InventoryNode[];
    }
  | { readonly kind: "service"; readonly id: string; readonly service: WebEstateServiceV2 };

type ErrorRow = Extract<TreeRow, { kind: "error" }>;

/** Fold the flat row list (built with every branch open) into nested nodes plus the error rows. */
function foldTree(rows: readonly TreeRow[]): { nodes: InventoryNode[]; errors: ErrorRow[] } {
  const nodes: InventoryNode[] = [];
  const errors: ErrorRow[] = [];
  let group: Extract<InventoryNode, { kind: "group" }> | null = null;
  let host: Extract<InventoryNode, { kind: "host" }> | null = null;
  for (const row of rows) {
    if (row.kind === "error") {
      errors.push(row);
    } else if (row.kind === "group") {
      group = { ...row, children: [] };
      host = null;
      nodes.push(group);
    } else if (row.kind === "host") {
      host = { kind: "host", id: row.id, host: row.host, serviceCount: row.serviceCount, children: [] };
      group?.children.push(host);
    } else {
      host?.children.push({ kind: "service", id: row.id, service: row.service });
    }
  }
  return { nodes, errors };
}

/** Deep route for a host / service node. */
function entityPath(node: InventoryNode): string | null {
  if (node.kind === "host") return `/estate/host/${encodeURIComponent(node.host.name)}`;
  if (node.kind === "service") {
    const s = node.service;
    return `/estate/service/${encodeURIComponent(s.host)}/${encodeURIComponent(s.name)}`;
  }
  return null;
}

const nodeLabel = (node: InventoryNode): string =>
  node.kind === "group" ? node.label : node.kind === "host" ? node.host.name : node.service.name;
const nodeChildren = (node: InventoryNode): readonly InventoryNode[] | undefined =>
  node.kind === "service" ? undefined : node.children;
const nodeId = (node: InventoryNode): string => node.id;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Live-health dot for an entity: no live row ⇒ unknown, never ok. */
function LiveBadge(props: {
  entity: Pick<WebEstateHostV2, "drilldownId" | "suppressed">;
  liveById: ReadonlyMap<string, EstateTargetState>;
}): ReactElement {
  const live = props.liveById.get(props.entity.drilldownId);
  const { status, staleNote } = toTargetStatus({
    health: live?.state ?? "not-configured",
    suppressed: props.entity.suppressed !== null,
    availability: live?.availability.state ?? "not-configured",
  });
  const { tone, icon } = TARGET_STATUS[status];
  return (
    <StatusBadge
      tone={tone}
      icon={icon}
      variant="dot"
      label={`Live ${staleNote ?? STATUS_LABEL[status]}`}
      data-indicator="live"
      data-status={status}
    />
  );
}

/** Coverage badge for an entity. Non-current coverage downgrades ok → unknown (as the coverage tab
 *  does) and says so in the label, so a covered entity is never badged green on stale data (I3). */
function CoverageBadge(props: { coverage: HostCoverage; staleness: CoverageStaleness }): ReactElement {
  const status = effectiveStatus(COVERAGE_STATUS[props.coverage], props.staleness !== null);
  const { tone, icon, variant } = TARGET_STATUS[status];
  return (
    <StatusBadge
      tone={tone}
      icon={icon}
      {...(variant !== undefined ? { variant } : {})}
      label={coverageLabel(props.coverage, props.staleness)}
      data-indicator="coverage"
      data-status={status}
    />
  );
}

function ProvenanceText(props: { provenance: WebEstateHostV2["provenance"] }): ReactElement {
  return (
    <span data-provenance-ref="" className="font-mono text-xs text-muted-foreground wrap-anywhere">
      {provenanceRef(props.provenance)}
    </span>
  );
}

/** Everything a row's trailing content needs beyond its node. */
interface RowContext {
  readonly coverageIndex: CoverageIndex | null;
  /** Non-current availability of the coverage section, or `null` when current/absent. */
  readonly coverageStaleness: CoverageStaleness;
  readonly liveById: ReadonlyMap<string, EstateTargetState>;
}

const META = "flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-2 gap-y-1";
/**
 * Host and service meta. Below a wide tree (the `@container` on the tree region) it takes a line of
 * its own under the label, aligned with it (past the chevron and its gap), wrapping there, instead
 * of splitting the row with a truncated label into a very tall row. In a wide tree it sits beside the
 * label at its natural width (`basis-auto`), so its badges stay on one line.
 */
const ENTITY_META = `${META} basis-full justify-start ps-5.5 @4xl:basis-auto @4xl:justify-end @4xl:ps-0`;

/**
 * A row's trailing content. Plain text and decorative badges only (tree rows hold no interactive
 * elements); the element carries the row's test hook (`data-testid` + `data-class`/`data-host`/
 * `data-service`).
 */
function renderRowMeta(node: InventoryNode, ctx: RowContext): ReactNode {
  if (node.kind === "group") {
    return (
      <span data-testid="estate-group-row" data-class={node.class} className={META}>
        <Badge variant="secondary">{plural(node.hostCount, "host")}</Badge>
      </span>
    );
  }
  if (node.kind === "host") {
    const host = node.host;
    return (
      <span data-testid="estate-host-row" data-host={host.name} className={ENTITY_META}>
        <span className="text-xs text-muted-foreground">{CLASS_LABEL.get(host.collectionClass) ?? host.collectionClass}</span>
        <CoverageBadge coverage={classifyIn(ctx.coverageIndex, "host", host.name)} staleness={ctx.coverageStaleness} />
        <LiveBadge entity={host} liveById={ctx.liveById} />
        <Badge variant="secondary">{plural(node.serviceCount, "service")}</Badge>
        <ProvenanceText provenance={host.provenance} />
      </span>
    );
  }
  const service = node.service;
  return (
    <span data-testid="estate-service-row" data-host={service.host} data-service={service.name} className={ENTITY_META}>
      <Badge variant="outline">{service.kind}</Badge>
      <CoverageBadge
        coverage={classifyIn(ctx.coverageIndex, "service", `${service.host}/${service.name}`)}
        staleness={ctx.coverageStaleness}
      />
      <LiveBadge entity={service} liveById={ctx.liveById} />
      <ProvenanceText provenance={service.provenance} />
    </span>
  );
}

const renderRowIcon = (node: InventoryNode): ReactNode =>
  node.kind === "group" ? <Icon name={node.icon} className="shrink-0 text-muted-foreground" aria-hidden="true" /> : null;

const channelKind = safeCell((c: WebChannel) => <Badge variant="outline">{c.kind}</Badge>);
const channelSource = safeCell((c: WebChannel) => <ProvenanceChip provenance={c.provenance} />);
const CHANNEL_COLUMNS: ColumnDef<WebChannel>[] = [
  { id: "name", header: "Channel", cell: ({ row }) => row.original.name },
  { id: "kind", header: "Kind", cell: ({ row }) => channelKind(row.original) },
  { id: "prov", header: "Source", cell: ({ row }) => channelSource(row.original) },
];

const routingChannels = safeCell((r: WebRoutingOverride) => r.channels.join(", "));
const routingSource = safeCell((r: WebRoutingOverride) => <ProvenanceChip provenance={r.provenance} />);
const ROUTING_COLUMNS: ColumnDef<WebRoutingOverride>[] = [
  { id: "severity", header: "Severity", cell: ({ row }) => row.original.severity },
  { id: "channels", header: "Channels", cell: ({ row }) => routingChannels(row.original) },
  { id: "prov", header: "Source", cell: ({ row }) => routingSource(row.original) },
];

const suppressionClass = safeCell((s: WebStandaloneSuppression) => <Badge variant="secondary">{s.class}</Badge>);
const suppressionSource = safeCell((s: WebStandaloneSuppression) => <ProvenanceChip provenance={s.provenance} />);
const SUPPRESSION_COLUMNS: ColumnDef<WebStandaloneSuppression>[] = [
  { id: "target", header: "Target", cell: ({ row }) => row.original.target },
  { id: "class", header: "Class", cell: ({ row }) => suppressionClass(row.original) },
  { id: "rationale", header: "Rationale", cell: ({ row }) => row.original.rationale },
  { id: "prov", header: "Source", cell: ({ row }) => suppressionSource(row.original) },
];

const rowKey = (prefix: string) => (_row: unknown, index: number): string => `${prefix}:${index}`;

/** Channels / routing overrides / suppressions — separate from the host tree. */
function SecondarySections(props: {
  estate: Readonly<WebEstateModelV2>;
  orphans: readonly WebEstateServiceV2[];
}): ReactElement {
  const [active, setActive] = useState<SecondaryTabId>("channels");
  const { estate, orphans } = props;
  return (
    <Section title="Relationships" level={2} data-region="estate-secondary">
      <Tabs value={active} onValueChange={(id) => setActive(id as SecondaryTabId)} activationMode="manual">
        <TabsList
          aria-label="Estate relationships"
          className="max-w-full flex-wrap justify-start group-data-[orientation=horizontal]/tabs:h-auto"
        >
          {SECONDARY_TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              <Icon name={t.icon} aria-hidden="true" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="channels" data-panel="channels">
          <DataTable
            caption="Channels"
            captionHidden
            data={estate.channels}
            columns={CHANNEL_COLUMNS}
            getRowId={rowKey("channel")}
            empty="No channels declared"
            virtualize
          />
        </TabsContent>
        <TabsContent value="routing" data-panel="routing">
          <DataTable
            caption="Routing overrides"
            captionHidden
            data={estate.routingOverrides}
            columns={ROUTING_COLUMNS}
            getRowId={rowKey("routing")}
            empty="No routing overrides declared"
            virtualize
          />
        </TabsContent>
        <TabsContent value="suppressions" data-panel="suppressions">
          <DataTable
            caption="Suppressions"
            captionHidden
            data={estate.suppressions}
            columns={SUPPRESSION_COLUMNS}
            getRowId={rowKey("suppression")}
            empty="No suppressions declared"
            virtualize
          />
        </TabsContent>
      </Tabs>
      {orphans.length > 0 ? (
        <Callout
          tone={TARGET_STATUS.warning.tone}
          icon="triangle-alert"
          role="note"
          title="Orphaned services"
          data-testid="estate-orphans"
        >
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {orphans.map((s) => (
              <li key={s.drilldownId} className="flex flex-wrap items-center gap-2">
                <span>{`${s.name} (declared host "${s.host}" not found)`}</span>
                <ProvenanceChip provenance={s.provenance} />
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
    </Section>
  );
}

const INITIAL_EXPANDED: ReadonlySet<string> = new Set(CLASS_GROUPS.map((g) => `group:${g.class}`));

/** The inventory landing tab: primary host tree + secondary relationship sections. */
export function Inventory(props: InventoryProps): ReactElement {
  const { estate, liveTargets, coverage, matchedIds, router } = props;

  // User expansion (group ids `group:<class>`, host drilldownIds): groups open, hosts closed.
  const [userExpanded, setUserExpanded] = useState<ReadonlySet<string>>(INITIAL_EXPANDED);

  const liveIndex = useMemo(() => {
    const byId = new Map<string, EstateTargetState>();
    const errors: ErrorRow[] = [];
    liveTargets.forEach((target, index) => {
      const candidate = target as Partial<EstateTargetState>;
      if (
        typeof candidate.target !== "object" ||
        candidate.target === null ||
        typeof candidate.target.id !== "string" ||
        typeof candidate.state !== "string" ||
        typeof candidate.availability !== "object" ||
        candidate.availability === null
      ) {
        errors.push({ kind: "error", id: `error:live:${index}`, message: "Malformed live target entry" });
        return;
      }
      byId.set(candidate.target.id, target);
    });
    return { byId, errors };
  }, [liveTargets]);

  // The whole (search-filtered) tree, every branch open, folded into nodes; TreeView owns visibility.
  const tree = useMemo(() => {
    const allHosts = new Set<string>();
    for (const h of estate.hosts as readonly Partial<WebEstateHostV2>[]) {
      if (typeof h?.drilldownId === "string") allHosts.add(h.drilldownId);
    }
    const rows = buildTreeRows({
      hosts: estate.hosts,
      services: estate.services,
      expandedGroups: new Set(CLASS_GROUPS.map((g) => g.class)),
      expandedHosts: allHosts,
      matchedIds,
    });
    const { nodes, errors } = foldTree(rows);
    // A search forces every group and every host holding a matched service open.
    const forced = new Set<string>();
    if (matchedIds !== null) {
      for (const group of nodes) {
        forced.add(group.id);
        if (group.kind !== "group") continue;
        for (const host of group.children) if (host.kind === "host" && host.children.length > 0) forced.add(host.id);
      }
    }
    return { nodes, errors: [...errors, ...liveIndex.errors], forced };
  }, [estate, matchedIds, liveIndex]);

  const expanded = useMemo<ReadonlySet<string>>(
    () => (tree.forced.size === 0 ? userExpanded : new Set([...userExpanded, ...tree.forced])),
    [userExpanded, tree.forced],
  );
  // Each branch TreeView flips toggles the user's own state (forced branches stay open while searching).
  const onExpandedChange = (next: ReadonlySet<string>): void => {
    setUserExpanded((prev) => {
      const out = new Set(prev);
      for (const id of new Set([...next, ...expanded])) {
        if (next.has(id) !== expanded.has(id)) {
          if (out.has(id)) out.delete(id);
          else out.add(id);
        }
      }
      return out;
    });
  };

  const orphans = useMemo(
    () =>
      findOrphanedServices(
        estate.hosts,
        matchedIds === null ? estate.services : estate.services.filter((s) => matchedIds.has(s.drilldownId)),
      ),
    [estate, matchedIds],
  );
  const coverageIndex = useMemo(
    () => (coverage.value === null ? null : buildCoverageIndex(coverage.value)),
    [coverage],
  );
  const ctx: RowContext = { coverageIndex, coverageStaleness: coverageStaleness(coverage), liveById: liveIndex.byId };
  const renderMeta = safeCell((node: InventoryNode) => renderRowMeta(node, ctx));

  // A pointer click on a branch's chevron (the row's first child) only toggles it; anywhere else on
  // a host/service row navigates. Set in the capture phase, read by onSelect, cleared on bubble.
  const chevronClick = useRef(false);
  const onSelect = (node: InventoryNode): void => {
    if (chevronClick.current && nodeChildren(node)?.length) return;
    const path = entityPath(node);
    if (path !== null) safeNavigate(router, path);
  };

  return (
    <div className="flex flex-col gap-6" data-region="estate-inventory">
      <Section title="Hosts" level={2}>
        {estate.hosts.length === 0 ? (
          <EmptyState
            title="No hosts declared"
            description="This estate declares no hosts. Add hosts to the estate source and re-render."
            icon="server"
          />
        ) : tree.nodes.length === 0 && tree.errors.length === 0 ? (
          <EmptyState title="No matching hosts or services" icon="search" />
        ) : (
          <div
            data-region="estate-tree"
            className="@container flex flex-col gap-2"
            onClickCapture={(e) => {
              const target = e.target as Element;
              const chevron = target.closest?.("[data-tree-row]")?.firstElementChild ?? null;
              chevronClick.current = chevron !== null && chevron.contains(target);
            }}
            onClick={() => {
              chevronClick.current = false;
            }}
          >
            {tree.nodes.length > 0 ? (
              <TreeView<InventoryNode>
                aria-label="Declared estate"
                nodes={tree.nodes}
                getId={nodeId}
                getLabel={nodeLabel}
                getChildren={nodeChildren}
                expanded={expanded}
                onExpandedChange={onExpandedChange}
                selectBranches
                onSelect={onSelect}
                renderIcon={renderRowIcon}
                renderMeta={(node) => renderMeta(node)}
                virtualize
              />
            ) : null}
            {tree.errors.length > 0 ? (
              <ul aria-label="Unreadable entries" className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                {tree.errors.map((row) => (
                  <li key={row.id} data-testid="estate-error-row">
                    <span data-status="critical" className="inline-flex items-center gap-1 font-medium">
                      <Icon name="circle-alert" className="shrink-0" aria-hidden="true" /> {row.message}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </Section>
      <SecondarySections estate={estate} orphans={orphans} />
    </div>
  );
}
