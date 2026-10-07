// src/client/views/estate/entity-page.tsx — the per-entity pages `/estate/host/:name` and
// `/estate/service/:host/:name`.
//
// view.tsx dispatches here with a typed EntityRouteTarget built from `store.route.value.params`, so
// this module never parses a path. It resolves the declared model entity by its own identity fields,
// joins its live EstateTargetState by exact TargetIdentity `{kind, id === drilldownId}` (drilldownId
// is opaque — compared, never parsed), and renders declared facts, live state, monitoring artifacts,
// and a compact attributed-alert list. A declared-but-not-live entity maps to `unknown`, never `ok`.
// Credentials render as their `display` string only.

import type { ReactNode, ReactElement } from "react";
import { useEffect } from "react";
import type {
  WebCredentialReference,
  WebEndpointAlert,
  WebEstateHostV2,
  WebEstateServiceV2,
  WebScrapeTarget,
} from "@pulse/renderer";
import type { TargetIdentity, TargetStatus } from "@pulse/web-data/wire";

import {
  Badge,
  DataTable,
  EmptyState,
  Icon,
  KeyValue,
  KeyValueList,
  List,
  ListItem,
  PageHeader,
  Section,
  StatusBadge,
  TARGET_STATUS,
  VisuallyHidden,
  usePageHeadingId,
} from "@/ui";
import type { BreadcrumbEntry, ColumnDef, KeyValueItem } from "@/ui";
import type { AppStore } from "../../store/index.js";
import type { PathRouter } from "../../router.js";
import { canAct } from "../../mutations/gating.js";
import { ensureSession } from "../../mutations/session.js";
import { ProposeEditAction } from "../../mutations/ProposeEditAction.js";
import { ProposalList } from "../../mutations/proposals/ProposalList.js";
import { RegionErrorBoundary, safeCell, safeNavigate } from "./error-boundary.js";
import { ProvenanceChip } from "./provenance-chip.js";
import { alertAge, resolveAndJoin, toAttributedAlertRows } from "./entity-model.js";
import type { AttributedAlertRow, EntityRouteTarget, JoinedEntity } from "./entity-model.js";
import { statusLabel } from "./status.js";
import { readEstate } from "./types.js";
import { useSignals } from "@preact/signals-react/runtime";

// ── Route descriptor & props ─────────────────────────────────────────────────

/** Props for the entity page. */
export interface EntityPageProps {
  /** Signals store; the page reads `store.estate` via `readEstate`. */
  readonly store: AppStore;
  /** Router; used only for the attributed-alert deep links. */
  readonly router: PathRouter;
  /** The addressed entity (host or service). */
  readonly target: EntityRouteTarget;
}

// ── Resolution & the declared↔live join ──────────────────────────────────────

/** The joined entity's TargetIdentity — what an M2 proposed edit would target. */
function identityOf(joined: JoinedEntity): TargetIdentity {
  return joined.declared.kind === "host"
    ? { kind: "host", id: joined.declared.host.drilldownId }
    : { kind: "service", id: joined.declared.service.drilldownId };
}

// ── Page frame ───────────────────────────────────────────────────────────────

/** Estate → (owning host) → this entity. */
function breadcrumbsFor(target: EntityRouteTarget): readonly BreadcrumbEntry[] {
  return target.kind === "host"
    ? [{ label: "Estate", href: "/estate" }, { label: target.name }]
    : [
        { label: "Estate", href: "/estate" },
        { label: target.host, href: `/estate/host/${encodeURIComponent(target.host)}` },
        { label: target.name },
      ];
}

/** A target-status badge: tone/icon/variant from TARGET_STATUS, `data-status` always set. */
function TargetBadge(props: { readonly status: TargetStatus }): ReactElement {
  const { tone, icon, variant } = TARGET_STATUS[props.status];
  return (
    <StatusBadge
      tone={tone}
      icon={icon}
      {...(variant !== undefined ? { variant } : {})}
      label={statusLabel(props.status)}
      data-status={props.status}
    />
  );
}

/** The page frame: a region named by the single h1 (the entity name), with breadcrumbs. */
function EntityFrame(props: {
  readonly target: EntityRouteTarget;
  readonly testid: string;
  readonly kind?: "host" | "service";
  readonly meta?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  const headingId = usePageHeadingId();
  return (
    <section
      data-slot="estate-page"
      data-testid={props.testid}
      data-kind={props.kind}
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-6"
    >
      <PageHeader id={headingId} title={props.target.name} breadcrumbs={breadcrumbsFor(props.target)} meta={props.meta} />
      {props.children}
    </section>
  );
}

// ── Not found (distinct from the delivery-state degrades) ───────────────────

function NotFound(props: { readonly target: EntityRouteTarget }): ReactElement {
  const { target } = props;
  const label =
    target.kind === "host"
      ? `Host "${target.name}"`
      : `Service "${target.name}" on host "${target.host}"`;
  return (
    <EntityFrame target={target} testid="estate-entity-not-found">
      <EmptyState
        icon="search"
        title="Not in the current estate"
        description={
          `${label} is not present in the currently rendered estate model. ` +
          `It may have been removed, renamed, or never declared. This is not a load ` +
          `failure — the estate loaded successfully and does not contain this entity.`
        }
      />
    </EntityFrame>
  );
}

/** The not-found state for an entity absent from a successfully loaded model. */
export function renderNotFound(target: EntityRouteTarget): ReactElement {
  return <NotFound target={target} />;
}

// ── M2 mutation seam ─────────────────────────────────────────────────────────

/** Props for the declared-facts `actions` slot component. */
export interface EntityActionsProps {
  readonly store: AppStore;
  readonly identity: TargetIdentity;
  /** The declared entity used to prefill `seen` and filter fields by kind/class. */
  readonly declared: WebEstateHostV2 | WebEstateServiceV2;
}

function EntityActionsInner(p: EntityActionsProps & { readonly kind: "host" | "service" }): ReactElement {
  const target = { kind: p.kind, id: p.identity.id };
  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      <ProposeEditAction store={p.store} target={target} declared={p.declared} />
      <ProposalList target={target} />
    </div>
  );
}

/**
 * Capability-gated propose-edit affordance + proposal list, mounted in the declared-facts header
 * `actions` slot. The outer `canAct` wrapper is a kept seam: it returns null when
 * `proposeEstateEdit` is false/absent or on wallboard / ?kiosk=1.
 * The gate is hook-free (tests call it as a plain function); `EntityActions` subscribes to the
 * signals it reads. The session-loading effect lives in DeclaredFactsPanel.
 */
export function entityActionsGate(props: EntityActionsProps): ReactElement | null {
  const kind = props.identity.kind;
  if (kind !== "host" && kind !== "service") return null; // proposals target hosts/services only
  return canAct(props.store, "proposeEstateEdit") ? <EntityActionsInner {...props} kind={kind} /> : null;
}

/** The propose-edit slot: subscribes to the signals {@link entityActionsGate} reads, then applies it. */
export function EntityActions(props: EntityActionsProps): ReactElement | null {
  useSignals();
  return entityActionsGate(props);
}

// ── Declared facts ───────────────────────────────────────────────────────────

/** One term/definition pair in a facts list. */
interface Fact {
  readonly term: string;
  readonly value: ReactNode;
}

/** A credential reference rendered as its display form ONLY — never resolved. */
function credentialText(ref: WebCredentialReference | null): string {
  return ref === null ? "none" : ref.display;
}

const yesNo = (b: boolean): string => (b ? "yes" : "no");

/** Class-specific, non-secret host detail per collectionClass. */
function hostDetailFacts(host: WebEstateHostV2): readonly Fact[] {
  switch (host.collectionClass) {
    case "managed-linux": {
      const d = host.detail;
      return [
        {
          term: "Exporter ports",
          value: d.exporterPorts.length > 0 ? d.exporterPorts.join(", ") : "none",
        },
        { term: "cAdvisor", value: yesNo(d.cadvisor) },
        { term: "Heartbeat", value: yesNo(d.heartbeat) },
        { term: "Delivery form", value: d.deliveryForm },
        {
          term: "Command signals",
          value:
            d.commandSignals.length === 0 ? (
              "none"
            ) : (
              <ul className="m-0 flex list-disc flex-col gap-1 ps-4 wrap-anywhere" data-testid="estate-entity-command-signals">
                {d.commandSignals.map((s) => (
                  <li key={s.name}>
                    <span className="font-semibold">{s.name}</span> every {s.interval} —{" "}
                    <code className="font-mono">{s.command}</code>
                    {s.credential !== null ? (
                      <>
                        {" "}
                        (credential <code className="font-mono">{credentialText(s.credential)}</code>)
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            ),
        },
      ];
    }
    case "hypervisor-api":
      return [
        { term: "API endpoint", value: host.detail.apiEndpoint },
        { term: "Credential", value: <code className="font-mono">{credentialText(host.detail.credential)}</code> },
      ];
    case "nas-api":
      return host.detail.apiEndpoint === null
        ? [{ term: "API", value: "not configured" }]
        : [
            { term: "API endpoint", value: host.detail.apiEndpoint },
            { term: "Credential", value: <code className="font-mono">{credentialText(host.detail.credential)}</code> },
          ];
    case "probe-only":
      return [
        { term: "Probe kind", value: host.detail.probe.kind },
        { term: "Probe target", value: host.detail.probe.target },
        { term: "Probe expects", value: host.detail.probe.expect ?? "none" },
      ];
    case "excluded":
      return [];
  }
}

/** Service-specific, non-secret detail. */
function serviceDetailFacts(svc: WebEstateServiceV2): readonly Fact[] {
  const facts: Fact[] = [
    { term: "Managed", value: yesNo(svc.managed) },
    { term: "Deep health", value: yesNo(svc.deepHealth) },
  ];
  if (svc.ingressUrl !== undefined) facts.push({ term: "Ingress", value: svc.ingressUrl });
  const dh = svc.deepHealthDetail;
  if (dh !== null) {
    facts.push(
      { term: "Health endpoint", value: dh.endpoint },
      { term: "Health metrics", value: dh.metrics.length > 0 ? dh.metrics.join(", ") : "none" },
      { term: "Health credential", value: <code className="font-mono">{credentialText(dh.credential)}</code> },
    );
  }
  const bf = svc.backupFreshness;
  facts.push({
    term: "Backup freshness",
    value:
      bf === null
        ? "not declared"
        : `${bf.signal} within ${bf.threshold} (checked every ${bf.interval}` +
          `${bf.hasCommand ? ", with delivery command" : ""})`,
  });
  return facts;
}

const toItems = (facts: readonly Fact[]): KeyValueItem[] =>
  facts.map((f) => ({ id: f.term, label: f.term, value: f.value }));

/** Declared facts: identity, class/kind, provenance, suppression, class-specific detail. */
function DeclaredFactsPanel(props: {
  readonly joined: JoinedEntity;
  readonly store: AppStore;
}): ReactElement {
  // Lazy session load for the actions slot. It lives here, in a rendered component, because
  // EntityActions must stay hook-free; ensureSession never overwrites a seeded session.
  useEffect(() => {
    void ensureSession(props.store);
  }, [props.store]);
  const d = props.joined.declared;
  const entity = d.kind === "host" ? d.host : d.service;
  const identity: Fact[] =
    d.kind === "host"
      ? [
          { term: "Host", value: d.host.name },
          { term: "Collection class", value: d.host.collectionClass },
          {
            term: "Addresses",
            value: d.host.addresses.length > 0 ? d.host.addresses.join(", ") : "none",
          },
        ]
      : [
          { term: "Service", value: d.service.name },
          { term: "Host", value: d.service.host },
          { term: "Kind", value: d.service.kind },
        ];
  const detail = d.kind === "host" ? hostDetailFacts(d.host) : serviceDetailFacts(d.service);

  return (
    <Section
      title="Declared"
      variant="card"
      actions={
        <div data-testid="estate-entity-actions" className="contents">
          <EntityActions store={props.store} identity={identityOf(props.joined)} declared={entity} />
        </div>
      }
    >
      <KeyValueList items={toItems(identity)} data-testid="estate-entity-identity">
        <KeyValue label="Declared at">
          <ProvenanceChip provenance={entity.provenance} />
        </KeyValue>
        {entity.suppressed !== null ? (
          <KeyValue label="Suppression" data-testid="estate-entity-suppression">
            <span className="flex flex-wrap items-center gap-2">
              <TargetBadge status="suppressed" />
              <span>
                {entity.suppressed.class}: {entity.suppressed.rationale}
              </span>
            </span>
          </KeyValue>
        ) : null}
      </KeyValueList>
      {detail.length > 0 ? <KeyValueList items={toItems(detail)} data-testid="estate-entity-detail" /> : null}
    </Section>
  );
}

// ── Live state ───────────────────────────────────────────────────────────────

function LiveStatePanel(props: { readonly joined: JoinedEntity }): ReactElement {
  const { status, staleNote, live } = props.joined;
  return (
    <Section title="Live state" variant="card">
      <p className="m-0 flex flex-wrap items-center gap-2 text-sm" data-testid="estate-entity-live-status">
        <TargetBadge status={status} />
        {staleNote !== null ? <span className="text-muted-foreground">{staleNote}</span> : null}
      </p>
      {live === null ? (
        <p className="m-0 text-sm" data-testid="estate-entity-no-live">
          No live state has been reported for this entity yet.
        </p>
      ) : (
        <p className="m-0">
          <Badge variant="secondary">
            <Icon name="bell" />
            {live.alertFingerprints.length} attributed
          </Badge>
        </p>
      )}
    </Section>
  );
}

// ── Monitoring artifacts ─────────────────────────────────────────────────────

/** A DataTable cell renderer over the row's original value, with the per-cell error containment. */
function cell<Row>(render: (row: Row) => ReactNode): (ctx: { readonly row: { readonly original: Row } }) => ReactNode {
  const safe = safeCell(render);
  return ({ row }) => safe(row.original);
}

const SCRAPE_COLUMNS: ColumnDef<WebScrapeTarget>[] = [
  { id: "job", header: "Job", cell: cell((t: WebScrapeTarget) => t.job) },
  { id: "instance", header: "Instance", cell: cell((t: WebScrapeTarget) => t.instance) },
];

const scrapeRowId = (t: WebScrapeTarget, index: number): string => `${t.job}:${t.instance}:${index}`;

const NoneDeclared = (): ReactElement => <p className="m-0 text-sm text-muted-foreground">None declared.</p>;

/** A titled string list; an empty list is a declared fact ("none declared"), not a blank region. */
function ArtifactList(props: {
  readonly title: string;
  readonly items: readonly string[];
  readonly testid: string;
}): ReactElement {
  return (
    <Section title={props.title} level={3} data-testid={props.testid}>
      {props.items.length === 0 ? (
        <NoneDeclared />
      ) : (
        <List aria-label={props.title}>
          {props.items.map((item) => (
            <ListItem key={item} title={<code className="font-mono font-normal wrap-anywhere">{item}</code>} />
          ))}
        </List>
      )}
    </Section>
  );
}

/** Summarize one declared endpoint-alert config (a config, not a runtime alert instance). */
function describeEndpointAlert(a: WebEndpointAlert): string {
  const parts: string[] = [];
  if (a.enabled !== undefined) parts.push(a.enabled ? "enabled" : "disabled");
  if (a.failureThreshold !== undefined) parts.push(`fails after ${a.failureThreshold}`);
  if (a.successThreshold !== undefined) parts.push(`recovers after ${a.successThreshold}`);
  if (a.sendOnResolved !== undefined) parts.push(a.sendOnResolved ? "notifies on resolve" : "silent on resolve");
  if (a.description !== undefined) parts.push(a.description);
  return parts.length > 0 ? `${a.type} — ${parts.join(", ")}` : a.type;
}

function MonitoringArtifacts(props: { readonly joined: JoinedEntity }): ReactElement {
  const d = props.joined.declared;
  return (
    <Section title="Monitoring artifacts" variant="card">
      {d.kind === "host" ? (
        <Section title="Scrape targets" level={3} data-testid="estate-entity-scrape-targets">
          {d.host.scrapeTargets.length === 0 ? (
            <NoneDeclared />
          ) : (
            <DataTable
              caption="Scrape targets"
              captionHidden
              data={d.host.scrapeTargets}
              columns={SCRAPE_COLUMNS}
              getRowId={scrapeRowId}
              empty="No rows"
              virtualize
            />
          )}
        </Section>
      ) : (
        <>
          <ArtifactList
            title="Gatus endpoints"
            items={d.service.gatusEndpoints}
            testid="estate-entity-gatus"
          />
          <ArtifactList
            title="Declared endpoint alerts"
            items={d.service.alerts.map(describeEndpointAlert)}
            testid="estate-entity-declared-alerts"
          />
        </>
      )}
      <ArtifactList
        title="Rendered artifacts"
        items={d.kind === "host" ? d.host.artifacts : d.service.artifacts}
        testid="estate-entity-rendered-artifacts"
      />
    </Section>
  );
}

// ── Attributed alerts ────────────────────────────────────────────────────────

/** Compact list; each row deep-links to /alerts/:fingerprint (safe even if that route is unregistered). */
function AttributedAlerts(props: {
  readonly rows: readonly AttributedAlertRow[];
  readonly router: PathRouter;
}): ReactElement {
  return (
    <Section title="Attributed alerts" variant="card">
      {props.rows.length === 0 ? (
        <EmptyState
          icon="bell"
          title="No attributed alerts"
          description="No alerts are currently attributed to this entity."
        />
      ) : (
        <List variant="card" aria-label="Attributed alerts">
          {props.rows.map((row) => {
            const age = alertAge(row.firedAt);
            const label = row.name ?? row.fingerprint;
            const status = row.severity ?? "unknown";
            return (
              <ListItem
                key={row.fingerprint}
                onSelect={() => safeNavigate(props.router, `/alerts/${encodeURIComponent(row.fingerprint)}`)}
                leading={<TargetBadge status={status} />}
                title={
                  <span data-testid="estate-entity-alert-row" data-fingerprint={row.fingerprint}>
                    <VisuallyHidden>Open alert </VisuallyHidden>
                    <code className="font-mono wrap-anywhere">{label}</code>
                    <VisuallyHidden> in triage</VisuallyHidden>
                  </span>
                }
                meta={
                  <>
                    {age !== null ? <span data-alert-age="">{age}</span> : null}
                    <Icon name="external-link" />
                  </>
                }
              />
            );
          })}
        </List>
      )}
    </Section>
  );
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/** The per-entity page: resolve + join declared/live state, then render inside a region boundary. */
export function EntityPage(props: EntityPageProps): ReactElement {
  useSignals();
  const payload = readEstate(props.store);
  // view.tsx has already gated delivery state; a null payload here is defensive only.
  if (payload === null) return renderNotFound(props.target);
  const joined = resolveAndJoin(payload, props.target);
  if (joined === null) return renderNotFound(props.target);

  return (
    <EntityFrame
      target={props.target}
      testid="estate-entity"
      kind={joined.declared.kind}
      meta={<TargetBadge status={joined.status} />}
    >
      <RegionErrorBoundary region="entity page">
        <DeclaredFactsPanel joined={joined} store={props.store} />
        <LiveStatePanel joined={joined} />
        <MonitoringArtifacts joined={joined} />
        <AttributedAlerts rows={toAttributedAlertRows(joined.live)} router={props.router} />
      </RegionErrorBoundary>
    </EntityFrame>
  );
}
