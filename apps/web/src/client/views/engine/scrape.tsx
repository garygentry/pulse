// apps/web/src/client/views/engine/scrape.tsx — problem-first scrape jobs with per-job target tables.
import type { ReactElement } from "react";
import { useId, useMemo, useState } from "react";
import type { HostStatus } from "@pulse/web-data/wire";
import { DataTable, EmptyState, Section } from "@/ui";
import type { ColumnDef } from "@/ui";
import type { EstateClock } from "../../format.js";
import type { EngineSection, ScrapeJobRow, ScrapeTarget } from "./model.js"; // ScrapeTarget: /wire does not export the target type
import { toStatus } from "./labels.js";
import { estateHostPath, matchScrapeInstanceToHost } from "./scrape-match.js";
import { orderTargets, targetHealth } from "./scrape-model.js";
import { EngineStatusBadge, ErrorDetail, ErrorText, SourceDegradedBadge } from "./components.js";
import { GroupHeader } from "./group-header.js";
import { healthText } from "./presentation.js";

/** Props for {@link ScrapeJobs}. */
export interface ScrapeJobsProps {
  /** `scrapeSection(engine, observation)`: state, problem-first rows, discovery availability. */
  readonly section: EngineSection<ScrapeJobRow>;
  /** Snapshot hosts for REQ-ELINK-02 matching; empty when the snapshot is null. */
  readonly hosts: readonly HostStatus[];
  /** Estate clock. */
  readonly clock: EstateClock;
  /** Kiosk: healthy rows are non-interactive and there is no error disclosure (REQ-KIOSK-02). */
  readonly kiosk: boolean;
}

/** Props for {@link ScrapeJob}. */
export interface ScrapeJobProps {
  /** The prepared job row. */ readonly row: ScrapeJobRow;
  /** Whether the target table is shown. */ readonly expanded: boolean;
  /** Disclosure toggle; null renders a non-interactive header (kiosk). */ readonly onToggle: (() => void) | null;
  /** True when discovery is not current (section availability not current, REQ-SCRAPE-04). */ readonly discoveryStale: boolean;
  /** Snapshot hosts for matching. */ readonly hosts: readonly HostStatus[];
  /** Estate clock. */ readonly clock: EstateClock;
  /** Kiosk flag. */ readonly kiosk: boolean;
}

/** Scrape targets grouped by job (REQ-SCRAPE-01..04). */
export function ScrapeJobs({ section, hosts, clock, kiosk }: ScrapeJobsProps): ReactElement {
  const [override, setOverride] = useState<ReadonlyMap<string, boolean>>(new Map());
  const discoveryStale = section.availability.state !== "current";

  return (
    <Section title="Scrape targets" level={2}>
      <SourceDegradedBadge availability={section.availability} clock={clock} />
      {discoveryStale && section.state === "rows" ? (
        <p className="text-sm text-muted-foreground" data-discovery-notice="">Jobs read unknown until target discovery recovers.</p>
      ) : null}
      {section.state === "empty" ? <EmptyState icon="circle-help" title="No scrape jobs reported" /> : null}
      {section.state === "rows" ? (
        <ul role="list" className="m-0 flex list-none flex-col gap-3 p-0">
          {section.rows.map((row) => {
            const job = row.job.job;
            const expanded = kiosk ? row.problem : override.get(job) ?? row.problem;
            return (
              <li key={job} className="flex min-w-0 flex-col gap-2" data-job={job} data-problem={row.problem ? "true" : "false"}>
                <ScrapeJob
                  row={row}
                  expanded={expanded}
                  onToggle={kiosk ? null : () => setOverride(new Map(override).set(job, !expanded))}
                  discoveryStale={discoveryStale}
                  hosts={hosts}
                  clock={clock}
                  kiosk={kiosk}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
    </Section>
  );
}

/** One scrape job: its header and, when expanded, a DataTable of its targets. */
export function ScrapeJob({ row, expanded, onToggle, discoveryStale, hosts, clock, kiosk }: ScrapeJobProps): ReactElement {
  const bodyId = `${useId()}-targets`;
  const errorDetailId = `${bodyId}-error`;
  const [openError, setOpenError] = useState<string | null>(null); // instance whose full error is open
  const { up, down, unknown } = row.counts;
  const job = row.job.job;

  // Host matching runs only for expanded jobs, memoized per (targets, hosts) identity (REQ-SCALE-02).
  const hostByInstance = useMemo(() => {
    const m = new Map<string, string | null>();
    if (!expanded) return m;
    for (const t of row.job.targets) {
      if (!m.has(t.instance)) m.set(t.instance, matchScrapeInstanceToHost(t.instance, hosts));
    }
    return m;
  }, [expanded, row.job.targets, hosts]);

  const targets = useMemo(() => orderTargets(row.job.targets), [row.job.targets]);

  // scrapeUrl is never rendered: it may carry credentials, and `instance` identifies the target (REQ-SEC-03).
  const columns: ColumnDef<ScrapeTarget>[] = [
    {
      id: "instance",
      header: "Instance",
      cell: ({ row: { original: t } }) => {
        const host = hostByInstance.get(t.instance) ?? null;
        return host === null ? (
          t.instance
        ) : (
          <a className="text-primary underline-offset-4 hover:underline" href={estateHostPath(host)}>{t.instance}</a>
        );
      },
    },
    {
      id: "health",
      header: "Health",
      cell: ({ row: { original: t } }) => {
        const h = targetHealth(t.health);
        return discoveryStale ? (
          <EngineStatusBadge status="unknown" label={`${h.text} (last known)`} />
        ) : (
          <EngineStatusBadge status={h.status} label={h.text} />
        );
      },
    },
    {
      id: "last-scrape",
      header: "Last scrape",
      cell: ({ row: { original: t } }) => (t.lastScrapeAt === null ? "never" : clock.format(t.lastScrapeAt)),
    },
    {
      id: "last-error",
      header: "Last error",
      cell: ({ row: { original: t } }) =>
        t.lastError === null ? (
          "none"
        ) : (
          <ErrorText
            text={t.lastError}
            expanded={openError === t.instance}
            detailId={errorDetailId}
            onToggle={kiosk ? null : () => setOpenError(openError === t.instance ? null : t.instance)}
          />
        ),
    },
  ];

  const openTarget = openError === null ? undefined : targets.find((t) => t.instance === openError);
  const label = row.problem ? job : `${job} — ${up} up`;

  return (
    <>
      <GroupHeader label={label} expanded={expanded} bodyId={bodyId} onToggle={onToggle}>
        <EngineStatusBadge status={toStatus(row.effectiveState)} label={healthText(row.effectiveState)} />
        <span className="text-sm text-muted-foreground tabular-nums" data-counts="">{`${up} up · ${down} down · ${unknown} unknown`}</span>
      </GroupHeader>
      <div id={bodyId} className="flex min-w-0 flex-col gap-2" hidden={!expanded}>
        {expanded ? (
          <DataTable
            columns={columns}
            data={targets}
            caption={`${job} targets`}
            captionHidden
            getRowId={(t, i) => `${i}:${t.instance}`}
            rowHeader={false}
            empty="No targets reported"
            focusable={!kiosk}
          />
        ) : null}
        {expanded && openTarget !== undefined && openTarget.lastError !== null ? (
          <ErrorDetail id={errorDetailId} owner={openTarget.instance} text={openTarget.lastError} />
        ) : null}
      </div>
    </>
  );
}
