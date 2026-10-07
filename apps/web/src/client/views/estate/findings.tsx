// src/client/views/estate/findings.tsx — the `findings` tab of the /estate landing.
//
// Lists loader/renderer findings with severity, code, location (`file` + YAML field `path`),
// message, and inline fix. The wire array arrives sorted by (file,path,code,severity,message) — a
// determinism contract, NOT display order — so rows are re-sorted most-severe-first client-side.
// A Finding carries NO line and is not a WebProvenance: location is plain text, never a provenance
// chip. Severity is NOT TargetStatus: it renders through SeverityLabel (the alert-severity map),
// never a target-status label. Mounted inside RegionErrorBoundary region="findings" by view.tsx;
// performs no fetch.

import type { ReactElement } from "react";
import { useId, useMemo } from "react";
import type { AvailabilitySection } from "@pulse/web-data/wire";
import type { WebFindingsArtifact } from "@pulse/renderer";

import {
  ALERT_SEVERITY,
  Badge,
  Button,
  DataTable,
  EmptyState,
  FilterBar,
  Label,
  Section,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
} from "@/ui";
import type { AlertSeverity, ColumnDef } from "@/ui";
import { announce } from "../../a11y/index.js";
import type { PathRouter } from "../../router.js";
import { estateQueryString } from "./types.js";
import type { EstateQuery } from "./types.js";
import { AbsentArtifactState, CleanEmptyState, StaleNote } from "./degrade.js";
import {
  SEVERITY_PRESENTATION,
  bucketBySeverity,
  distinctCodes,
  filterFindings,
  formatLocation,
} from "./findings-model.js";
import type { Finding, Severity } from "./findings-model.js";

// ── Public surface ───────────────────────────────────────────────────────────

/** Props for {@link FindingsTab}. Read-only — no store writes. */
export interface FindingsTabProps {
  /** `readEstate(store).findings` — may be absent (value:null) on an older tree. */
  readonly findings: AvailabilitySection<WebFindingsArtifact>;
  /** Current landing query; drives the severity/code filter. */
  readonly query: EstateQuery;
  /** Router for URL-synced filter writes. */
  readonly router: PathRouter;
}

/** Finding severity → the alert-severity presentation (tone + glyph). */
const SEVERITY_ALERT: Readonly<Record<Severity, AlertSeverity>> = {
  error: "critical",
  warning: "warning",
  info: "info",
};

/** Severity element: glyph + text label + tone — never colour alone. `data-status` keeps the
 *  target-status token the severity maps to, so grayscale checks can group by it. */
export function SeverityLabel(props: { readonly severity: Severity }): ReactElement {
  const p = SEVERITY_PRESENTATION[props.severity];
  const { tone, icon } = ALERT_SEVERITY[SEVERITY_ALERT[props.severity]];
  return <StatusBadge tone={tone} icon={icon} label={p.label} data-severity={props.severity} data-status={p.token} />;
}

// ── Table columns ────────────────────────────────────────────────────────────

/** Severity first, then code, location, message, and the inline fix. Cells read flat fields only. */
const FINDINGS_COLUMNS: ColumnDef<Finding>[] = [
  { id: "severity", header: "Severity", cell: ({ row }) => <SeverityLabel severity={row.original.severity} /> },
  {
    id: "code",
    header: "Code",
    cell: ({ row }) => (
      <Badge variant="outline" data-code={row.original.code}>
        <code className="font-mono">{row.original.code}</code>
      </Badge>
    ),
  },
  {
    id: "location",
    header: "Location",
    cell: ({ row }) => (
      <code className="font-mono text-xs wrap-anywhere whitespace-normal" data-location="">
        {formatLocation(row.original)}
      </code>
    ),
  },
  {
    id: "message",
    header: "Message",
    cell: ({ row }) => <span className="wrap-anywhere whitespace-normal">{row.original.message}</span>,
  },
  {
    id: "fix",
    header: "Fix",
    cell: ({ row }) => <span className="wrap-anywhere whitespace-normal">{row.original.fix}</span>,
  },
];

const findingRowId = (f: Finding, index: number): string => `${f.file}:${f.path}:${f.code}:${index}`;

// ── Severity & code filter ───────────────────────────────────────────────────

/** Patch the filter axes onto the FULL query, navigate, and announce the change. */
export function navigateFilter(
  router: PathRouter,
  query: EstateQuery,
  patch: Partial<Pick<EstateQuery, "sev" | "code">>,
): void {
  const next: EstateQuery = { ...query, ...patch };
  const qs = estateQueryString(next);
  router.navigate(qs === "" ? "/estate" : `/estate?${qs}`);
  const parts: string[] = [];
  if (patch.sev !== undefined) parts.push(patch.sev === "" ? "severity filter cleared" : `severity filter: ${patch.sev}`);
  if (patch.code !== undefined) parts.push(patch.code === "" ? "code filter cleared" : `code filter: ${patch.code}`);
  announce(`Findings ${parts.join(", ")}`);
}

/** Radix Select items cannot carry "": this sentinel stands for "no filter" and matches no finding code. */
const ALL = "__all__";
const toSelect = (value: string): string => (value === "" ? ALL : value);
const fromSelect = (value: string): string => (value === ALL ? "" : value);

function FilterSelect(props: {
  readonly label: string;
  readonly testId: string;
  readonly value: string;
  readonly allLabel: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground">
        {props.label}
      </Label>
      <Select value={toSelect(props.value)} onValueChange={(v) => props.onChange(fromSelect(v))}>
        <SelectTrigger id={id} size="sm" className="min-w-40 max-w-full" data-testid={props.testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{props.allLabel}</SelectItem>
          {props.options.map((o) => (
            <SelectItem value={o.value} key={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const SEVERITY_OPTIONS = (["error", "warning", "info"] as const).map((s) => ({
  value: s,
  label: SEVERITY_PRESENTATION[s].label,
}));

// ── The tab ──────────────────────────────────────────────────────────────────

const NO_FINDINGS: readonly Finding[] = [];

/** The findings tab: absent / clean / stale / filtered-empty / populated states. */
export function FindingsTab(props: FindingsTabProps): ReactElement {
  const { findings, query, router } = props;
  const artifact = findings.value;
  const all = artifact?.findings ?? NO_FINDINGS;

  // Hooks first (rules-of-hooks): every branch below runs after these.
  const rows = useMemo(() => bucketBySeverity(filterFindings(all, query)), [all, query.sev, query.code]);
  const codeOptions = useMemo(
    () => distinctCodes(bucketBySeverity(all)).map((c) => ({ value: c, label: c })),
    [all],
  );

  if (artifact === null) {
    return (
      <Section title="Findings">
        <AbsentArtifactState artifact="Findings" reason={findings.availability.message} />
      </Section>
    );
  }

  const stale = findings.availability.state === "stale" || findings.availability.state === "unavailable";

  if (all.length === 0 && !stale) {
    return (
      <Section title="Findings">
        <CleanEmptyState
          title="No findings"
          description="The rendered estate loaded with no loader or renderer findings."
        />
      </Section>
    );
  }

  const filtered = query.sev !== "" || query.code !== "";

  return (
    <Section title="Findings" className="min-w-0" data-testid="estate-findings">
      {stale ? <StaleNote availability={findings.availability} /> : null}
      <FilterBar
        label="Filter findings"
        resultCount={
          filtered && all.length > 0 ? (
            // Plain text, not a live region: navigateFilter already announces each filter change.
            <p data-result-count="" className="text-sm text-muted-foreground tabular-nums">
              Showing {rows.length} of {all.length} findings; {all.length - rows.length} hidden by filters.
            </p>
          ) : null
        }
      >
        <FilterSelect
          label="Severity"
          testId="estate-findings-sev"
          value={query.sev}
          allLabel="All severities"
          options={SEVERITY_OPTIONS}
          onChange={(sev) => navigateFilter(router, query, { sev })}
        />
        <FilterSelect
          label="Code"
          testId="estate-findings-code"
          value={query.code}
          allLabel="All codes"
          options={codeOptions}
          onChange={(code) => navigateFilter(router, query, { code })}
        />
      </FilterBar>
      {all.length === 0 ? (
        // Stale-but-empty: never the reassuring clean state.
        <div data-testid="estate-findings-stale-empty" data-status="unknown">
          <EmptyState icon="circle-help" title="No findings in the last available render" />
        </div>
      ) : rows.length === 0 ? (
        <div data-testid="estate-findings-no-matches" data-status="unknown">
          <EmptyState
            icon="search"
            title="No findings match the current filter"
            description="Clear the severity or code filter to see all findings."
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigateFilter(router, query, { sev: "", code: "" })}
              >
                Clear filters
              </Button>
            }
          />
        </div>
      ) : (
        <DataTable
          caption="Findings"
          captionHidden
          data={rows}
          columns={FINDINGS_COLUMNS}
          getRowId={findingRowId}
          rowHeader={false}
        />
      )}
    </Section>
  );
}
