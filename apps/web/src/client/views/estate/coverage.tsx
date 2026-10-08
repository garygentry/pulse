// src/client/views/estate/coverage.tsx — the `coverage` tab of the /estate landing.
//
// Renders, from one already-narrowed EstatePayload: class totals by collection class, the three
// coverage buckets (covered / gaps / suppressed-with-rationale), and the declared-vs-scraped diff in
// BOTH directions. Each sub-artifact is resolved through degrade.tsx's shared availability classifier
// BEFORE rendering: absent → "re-render to populate", present-but-empty → clean, present-but-stale →
// rendered WITH a StaleNote and every ok glyph downgraded to unknown (never silent-green). Mounted
// inside RegionErrorBoundary region="coverage explorer" by view.tsx; performs no fetch.

import type { ReactElement, ReactNode } from "react";
import { useId, useMemo } from "react";
import type {
  AvailabilitySection,
  DataAvailability,
  DeclaredScrapeComparison,
  EstatePayload,
  TargetStatus,
} from "@pulse/web-data/wire";
import type { CoverageEntry, WebCoverageArtifact } from "@pulse/renderer";

import {
  Badge,
  Button,
  DataTable,
  Icon,
  List,
  ListItem,
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  Section,
  StatGrid,
  StatTile,
  StatusBadge,
  TARGET_STATUS,
  VisuallyHidden,
} from "@/ui";
import type { ColumnDef } from "@/ui";
import { STATUS_LABEL } from "../../a11y/index.js";
import { DIFF_STATUS } from "../../status/target-status.js";
import { AbsentArtifactState, CleanEmptyState, StaleNote } from "./degrade.js";
import { safeCell } from "./error-boundary.js";
import {
  BUCKETS,
  aggregateClassTotals,
  effectiveStatus,
  partitionComparisons,
  rationaleText,
  resolveArtifact,
  toComparisonList,
} from "./coverage-model.js";
import type { BucketSpec, ClassTotals } from "./coverage-model.js";

/** Props for {@link CoverageExplorer}. `payload` is non-null: view.tsx gates on delivery `ready`. */
export interface CoverageExplorerProps {
  readonly payload: EstatePayload;
}

/** A target-status badge: tone/icon/variant from TARGET_STATUS, `data-status` always set. */
function Status(props: { readonly status: TargetStatus; readonly label?: string }): ReactElement {
  const { status } = props;
  const { tone, icon, variant } = TARGET_STATUS[status];
  return (
    <StatusBadge
      tone={tone}
      icon={icon}
      {...(variant !== undefined ? { variant } : {})}
      label={props.label ?? STATUS_LABEL[status]}
      data-status={status}
    />
  );
}

/** A DataTable cell renderer over the row's original value, with the per-cell error containment. */
function cell<Row>(render: (row: Row) => ReactNode): (ctx: { readonly row: { readonly original: Row } }) => ReactNode {
  const safe = safeCell(render);
  return ({ row }) => safe(row.original);
}

const rowKey = (prefix: string) => (_row: unknown, index: number): string => `${prefix}:${index}`;

const NUMERIC = { align: "end", className: "tabular-nums", headerClassName: "text-right" } as const;

// ── Coverage buckets ─────────────────────────────────────────────────────────

/**
 * An entry's artifact count. With artifacts it is a button opening a Popover that lists them (Tab
 * reaches it, Enter/Space opens, Escape closes back to it); with none it is a plain count.
 */
function ArtifactCount(props: { readonly entry: CoverageEntry }): ReactElement {
  const { name, artifacts } = props.entry;
  const titleId = useId();
  const count = String(artifacts.length);
  if (artifacts.length === 0) {
    return (
      <Badge variant="secondary" className="tabular-nums" data-artifacts={0}>
        <Icon name="list" aria-hidden="true" />
        {count}
        <VisuallyHidden> artifacts</VisuallyHidden>
      </Badge>
    );
  }
  const noun = artifacts.length === 1 ? "artifact" : "artifacts";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className="tabular-nums"
          aria-label={`${count} ${noun} for ${name}`}
          data-artifacts={artifacts.length}
        >
          <Icon name="list" aria-hidden="true" />
          {count}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-labelledby={titleId} className="flex w-auto max-w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
        <PopoverHeader>
          <PopoverTitle id={titleId}>{`Artifacts for ${name}`}</PopoverTitle>
        </PopoverHeader>
        <List aria-labelledby={titleId}>
          {artifacts.map((artifact, index) => (
            <ListItem key={`${index}:${artifact}`} title={<code className="font-mono font-normal wrap-anywhere">{artifact}</code>} />
          ))}
        </List>
      </PopoverContent>
    </Popover>
  );
}

function bucketColumns(bucket: BucketSpec, stale: boolean): ColumnDef<CoverageEntry>[] {
  const status = effectiveStatus(bucket.status, stale);
  const columns: ColumnDef<CoverageEntry>[] = [
    { id: "status", header: "Status", cell: () => <Status status={status} /> },
    { id: "name", header: "Entity", cell: cell((row: CoverageEntry) => row.name) },
    { id: "kind", header: "Kind", cell: cell((row: CoverageEntry) => <Badge variant="outline">{row.kind}</Badge>) },
    {
      id: "class",
      header: "Class",
      cell: cell((row: CoverageEntry) => <Badge variant="outline">{row.collectionClass}</Badge>),
    },
    {
      id: "artifacts",
      header: "Artifacts",
      cell: cell((row: CoverageEntry) => <ArtifactCount entry={row} />),
    },
  ];
  if (bucket.id === "suppressed") {
    columns.push({
      id: "rationale",
      header: "Rationale",
      cell: cell((row: CoverageEntry) => (
        <span className="wrap-anywhere whitespace-normal" data-rationale="">
          {rationaleText(row)}
        </span>
      )),
    });
  }
  return columns;
}

function Bucket(props: {
  readonly bucket: BucketSpec;
  readonly entries: readonly CoverageEntry[];
  readonly stale: boolean;
}): ReactElement {
  const { bucket, entries, stale } = props;
  return (
    <Section
      level={3}
      title={`${bucket.title} (${entries.length})`}
      actions={<Status status={effectiveStatus(bucket.status, stale)} />}
      className="min-w-0"
      data-testid="estate-coverage-bucket"
      data-bucket={bucket.id}
    >
      <DataTable
        caption={bucket.title}
        captionHidden
        data={entries}
        columns={bucketColumns(bucket, stale)}
        getRowId={rowKey(bucket.id)}
        empty="No rows"
        rowHeader={false}
        stickyHeader
        virtualize
      />
    </Section>
  );
}

// ── Class totals ─────────────────────────────────────────────────────────────

const CLASS_TOTALS_COLUMNS: ColumnDef<ClassTotals>[] = [
  { id: "class", header: "Class", cell: ({ row }) => row.original.collectionClass },
  { id: "covered", header: "Covered", meta: NUMERIC, cell: ({ row }) => String(row.original.covered) },
  { id: "gaps", header: "Gaps", meta: NUMERIC, cell: ({ row }) => String(row.original.gaps) },
  { id: "suppressed", header: "Suppressed", meta: NUMERIC, cell: ({ row }) => String(row.original.suppressed) },
  { id: "total", header: "Total", meta: NUMERIC, cell: ({ row }) => String(row.original.total) },
];

function ClassTotalsSection(props: { readonly totals: readonly ClassTotals[]; readonly stale: boolean }): ReactElement {
  const { totals, stale } = props;
  const sums = useMemo(
    () =>
      totals.reduce(
        (acc, t) => ({
          covered: acc.covered + t.covered,
          gaps: acc.gaps + t.gaps,
          suppressed: acc.suppressed + t.suppressed,
          total: acc.total + t.total,
        }),
        { covered: 0, gaps: 0, suppressed: 0, total: 0 },
      ),
    [totals],
  );
  return (
    <Section level={3} title="Class totals" className="min-w-0" data-testid="estate-coverage-class-totals">
      <StatGrid>
        {BUCKETS.map((b) => {
          const { tone, icon } = TARGET_STATUS[effectiveStatus(b.status, stale)];
          return (
            <StatTile key={b.id} label={b.title} value={sums[b.id]} tone={tone} icon={icon} />
          );
        })}
        <StatTile label="Total" value={sums.total} icon="list" />
      </StatGrid>
      <DataTable
        caption="Class totals"
        captionHidden
        data={totals}
        columns={CLASS_TOTALS_COLUMNS}
        getRowId={(r) => r.collectionClass}
        empty="No rows"
        stickyHeader
      />
    </Section>
  );
}

// ── Coverage section (class totals + buckets) ────────────────────────────────

const coverageIsEmpty = (a: WebCoverageArtifact): boolean =>
  a.covered.length === 0 && a.gaps.length === 0 && a.suppressed.length === 0;

function CoverageBody(props: {
  readonly artifact: WebCoverageArtifact;
  readonly availability: DataAvailability;
  readonly stale: boolean;
}): ReactElement {
  const { artifact, availability, stale } = props;
  // Memoized on the artifact identity — recomputed only when a new payload lands.
  const totals = useMemo(() => aggregateClassTotals(artifact), [artifact]);
  return (
    <>
      {stale ? <StaleNote availability={availability} /> : null}
      <ClassTotalsSection totals={totals} stale={stale} />
      {BUCKETS.map((b) => (
        <Bucket key={b.id} bucket={b} entries={artifact[b.id]} stale={stale} />
      ))}
    </>
  );
}

function CoverageSection({ section }: { readonly section: AvailabilitySection<WebCoverageArtifact> }): ReactElement {
  const state = resolveArtifact(section, coverageIsEmpty);
  return (
    <Section level={2} title="Coverage" className="min-w-0 gap-4" data-section="coverage">
      {state.kind === "absent" ? (
        <AbsentArtifactState artifact="Coverage" reason={state.message} />
      ) : state.kind === "empty" ? (
        <CleanEmptyState
          title="No declared entities"
          description="The estate declares no hosts or services to report coverage for."
        />
      ) : (
        <CoverageBody artifact={state.value} availability={section.availability} stale={state.stale} />
      )}
    </Section>
  );
}

// ── Declared-vs-scraped diff — BOTH directions ───────────────────────────────

function diffColumns(stale: boolean): ColumnDef<DeclaredScrapeComparison>[] {
  return [
    {
      id: "status",
      header: "Status",
      cell: cell((r: DeclaredScrapeComparison) => (
        <Status status={effectiveStatus(DIFF_STATUS[r.state] ?? "unknown", stale)} />
      )),
    },
    { id: "entity", header: "Declared entity", cell: cell((r: DeclaredScrapeComparison) => r.drilldownId) },
    {
      id: "scrape",
      header: "Scrape target",
      cell: cell((r: DeclaredScrapeComparison) => r.scrapeTarget ?? "— (none declared)"),
    },
    {
      id: "detail",
      header: "Detail",
      meta: { className: "whitespace-normal wrap-anywhere" },
      cell: cell((r: DeclaredScrapeComparison) => r.message || "—"),
    },
  ];
}

function DiffTable(props: {
  readonly direction: "missing" | "unexpected";
  readonly title: string;
  readonly rows: readonly DeclaredScrapeComparison[];
  readonly columns: ColumnDef<DeclaredScrapeComparison>[];
}): ReactElement {
  const { direction, title, rows, columns } = props;
  return (
    <Section
      level={3}
      title={`${title} (${rows.length})`}
      className="min-w-0"
      data-testid={`estate-diff-${direction}`}
      data-direction={direction}
    >
      <DataTable
        caption={title}
        captionHidden
        data={rows}
        columns={columns}
        getRowId={rowKey(direction)}
        empty="No rows"
        rowHeader={false}
        stickyHeader
        virtualize
      />
    </Section>
  );
}

function DiffBody(props: {
  readonly list: readonly DeclaredScrapeComparison[];
  readonly availability: DataAvailability;
  readonly stale: boolean;
}): ReactElement {
  const { list, availability, stale } = props;
  const parts = useMemo(() => partitionComparisons(list), [list]);
  const columns = diffColumns(stale);
  return (
    <>
      {stale ? <StaleNote availability={availability} /> : null}
      <div className="flex flex-wrap gap-2">
        <span data-testid="estate-diff-matched-count">
          <Status status={effectiveStatus(DIFF_STATUS.matched, stale)} label={`${parts.matched.length} matched`} />
        </span>
        <span data-testid="estate-diff-unknown-count">
          <Status status="unknown" label={`${parts.unknown.length} unknown`} />
        </span>
      </div>
      <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-4">
        <DiffTable
          direction="missing"
          title="Missing — declared, not scraped"
          rows={parts.missing}
          columns={columns}
        />
        <DiffTable
          direction="unexpected"
          title="Unexpected — scraped, not declared"
          rows={parts.unexpected}
          columns={columns}
        />
      </div>
    </>
  );
}

function DiffSection({
  section,
}: {
  readonly section: AvailabilitySection<readonly DeclaredScrapeComparison[]>;
}): ReactElement {
  const state = resolveArtifact(section, (v) => toComparisonList(v).length === 0);
  return (
    <Section level={2} title="Declared vs scraped" className="min-w-0 gap-4" data-section="diff">
      {state.kind === "absent" ? (
        <AbsentArtifactState artifact="Declared-vs-scraped diff" reason={state.message} />
      ) : state.kind === "empty" ? (
        <CleanEmptyState title="Declared and scraped agree" description="No gaps or unexpected targets." />
      ) : (
        <DiffBody list={toComparisonList(state.value)} availability={section.availability} stale={state.stale} />
      )}
    </Section>
  );
}

// ── Composition ──────────────────────────────────────────────────────────────

/** The coverage tab body: class totals + buckets, then the both-directions diff. */
export function CoverageExplorer(props: CoverageExplorerProps): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="estate-coverage">
      <CoverageSection section={props.payload.coverage} />
      <DiffSection section={props.payload.declaredVersusScraped} />
    </div>
  );
}
