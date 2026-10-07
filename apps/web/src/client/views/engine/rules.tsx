// apps/web/src/client/views/engine/rules.tsx — problem-first vmalert rule groups with per-group rule
// tables.
import type { ReactElement } from "react";
import { useId, useState } from "react";
import type { RuleState } from "@pulse/web-data/wire";
import { DataTable, EmptyState, Section } from "@/ui";
import type { ColumnDef } from "@/ui";
import type { EstateClock } from "../../format.js";
import type { EngineSection, RuleGroupRow } from "./model.js";
import { toStatus } from "./labels.js";
import { EngineStatusBadge, ErrorDetail, ErrorText, NotReported, SourceDegradedBadge } from "./components.js";
import { GroupHeader } from "./group-header.js";
import { healthText } from "./presentation.js";

/** Rule rows link to the alert-triage catalog tab. Per-rule focus is not available in M1 (REQ-ELINK-03). */
export const RULE_CATALOG_HREF = "/alerts?tab=catalog" as const;

/** Props for {@link RuleGroups}. */
export interface RuleGroupsProps {
  /** `ruleSection(engine)`: state, problem-first rows, vmalert availability. */
  readonly section: EngineSection<RuleGroupRow>;
  /** Estate clock. */
  readonly clock: EstateClock;
  /** Kiosk: healthy rows are non-interactive (REQ-KIOSK-02). */
  readonly kiosk: boolean;
}

/** Props for {@link RuleGroup}. */
export interface RuleGroupProps {
  /** The prepared group row. */ readonly row: RuleGroupRow;
  /** Whether the rule table is shown. */ readonly expanded: boolean;
  /** Disclosure toggle; null = non-interactive header (kiosk). */ readonly onToggle: (() => void) | null;
  /** True when the vmalert source is not current; health then reads unknown "(last known)". */ readonly sourceStale: boolean;
  /** Estate clock. */ readonly clock: EstateClock;
  /** Kiosk flag. */ readonly kiosk: boolean;
}

/** vmalert rule groups (REQ-RULE-01..03). */
export function RuleGroups({ section, clock, kiosk }: RuleGroupsProps): ReactElement {
  const [override, setOverride] = useState<ReadonlyMap<string, boolean>>(new Map());
  const sourceStale = section.availability.state !== "current";
  return (
    <Section title="Rule groups" level={2}>
      <SourceDegradedBadge availability={section.availability} clock={clock} />
      {section.state === "empty" ? <EmptyState icon="circle-help" title="No rule groups reported" /> : null}
      {section.state === "rows" ? (
        <ul role="list" className="m-0 flex list-none flex-col gap-3 p-0">
          {section.rows.map((row) => {
            const name = row.group.group;
            const expanded = kiosk ? row.problem : override.get(name) ?? row.problem;
            return (
              <li key={name} className="flex min-w-0 flex-col gap-2" data-group={name} data-problem={row.problem ? "true" : "false"}>
                <RuleGroup
                  row={row}
                  expanded={expanded}
                  onToggle={kiosk ? null : () => setOverride(new Map(override).set(name, !expanded))}
                  sourceStale={sourceStale}
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

/** A rule paired with its position in the group (the error-detail key). */
interface IndexedRule {
  readonly rule: RuleState;
  readonly index: number;
}

/** One rule group: its header and, when expanded, a DataTable of its rules. There is no duration
 *  column: the data tier provides none and the view never fabricates one (REQ-RULE-03). */
export function RuleGroup({ row, expanded, onToggle, sourceStale, clock, kiosk }: RuleGroupProps): ReactElement {
  const bodyId = `${useId()}-rules`;
  const errorDetailId = `${bodyId}-error`;
  const [openError, setOpenError] = useState<number | null>(null); // index of the rule whose error is open
  const g = row.group;
  const n = g.rules.length;
  const indexed = g.rules.map((rule, index) => ({ rule, index }));

  const columns: ColumnDef<IndexedRule>[] = [
    {
      id: "rule",
      header: "Rule",
      cell: ({ row: { original: { rule } } }) => (
        <a className="text-primary underline-offset-4 hover:underline" href={RULE_CATALOG_HREF}>{rule.name}</a>
      ),
    },
    { id: "state", header: "State", cell: ({ row: { original: { rule } } }) => rule.state },
    {
      id: "health",
      header: "Health",
      cell: ({ row: { original: { rule } } }) =>
        sourceStale ? (
          <EngineStatusBadge status="unknown" label={`${healthText(rule.health)} (last known)`} />
        ) : (
          <EngineStatusBadge status={toStatus(rule.health)} label={healthText(rule.health)} />
        ),
    },
    {
      id: "last-error",
      header: "Last error",
      cell: ({ row: { original: { rule, index } } }) =>
        rule.lastError === null ? (
          "none"
        ) : (
          <ErrorText
            text={rule.lastError}
            expanded={openError === index}
            detailId={errorDetailId}
            onToggle={kiosk ? null : () => setOpenError(openError === index ? null : index)}
          />
        ),
    },
  ];

  const open = openError === null ? undefined : g.rules[openError];
  const label = row.problem ? g.group : `${g.group} — ${n} ${n === 1 ? "rule" : "rules"}`;

  return (
    <>
      <GroupHeader label={label} expanded={expanded} bodyId={bodyId} onToggle={onToggle}>
        <EngineStatusBadge
          status={sourceStale ? "unknown" : toStatus(g.health)}
          label={sourceStale ? `${healthText(g.health)} (last known)` : healthText(g.health)}
        />
        <span className="text-sm text-muted-foreground" data-last-eval="">
          Last evaluated {g.lastEvaluationAt === null ? <NotReported /> : clock.format(g.lastEvaluationAt)}
        </span>
      </GroupHeader>
      <div id={bodyId} className="flex min-w-0 flex-col gap-2" hidden={!expanded}>
        {expanded ? (
          <DataTable
            columns={columns}
            data={indexed}
            caption={`${g.group} rules`}
            captionHidden
            getRowId={(r) => String(r.index)}
            rowHeader={false}
            empty="No rules reported"
            focusable={!kiosk}
          />
        ) : null}
        {expanded && open !== undefined && open.lastError !== null ? (
          <ErrorDetail id={errorDetailId} owner={open.name} text={open.lastError} />
        ) : null}
      </div>
    </>
  );
}
