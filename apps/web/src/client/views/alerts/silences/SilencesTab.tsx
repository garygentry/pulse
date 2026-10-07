// views/alerts/silences/SilencesTab.tsx — the read-only active-silences tab.
//
// Pure prop-driven: reads no store, router, or URL. Rows are rendered verbatim in the data tier's
// start → id order (never reordered here). An optional `rowAction` adds an "Actions" column (view.tsx
// supplies the gated ExpireButton); the tab itself still reads no store. Free text is rendered via
// displayText.
import type { ReactElement } from "react";

import type { ActiveSilence } from "@pulse/web-data/wire";

import { DataTable, EmptyState } from "@/ui";
import type { ColumnDef } from "@/ui";
import { matcherExpression } from "../detail/silences-model.js";
import { displayText } from "../../../mutations/client.js";

/** Props for {@link SilencesTab}. The slice is `AlertsPayload.silences`, passed by view.tsx in the
 *  data tier's start → id order. This component NEVER reorders it. */
export interface SilencesTabProps {
  readonly silences: readonly ActiveSilence[];
  /** Optional per-row action (omitted, the tab renders without an Actions column). The tab stays
   *  pure: it reads no store. */
  readonly rowAction?: (s: ActiveSilence) => ReactElement | null;
}

const EMPTY_CELL = "—";

/** One silences column: a DataTable ColumnDef with a stable id. */
export type SilenceColumn = ColumnDef<ActiveSilence> & { readonly id: string };

/** The active-silences table columns, each mapping to an `ActiveSilence` field. No action column;
 *  see {@link silenceColumns}. Row order is the data tier's, not set here. */
export const SILENCE_COLUMNS: readonly SilenceColumn[] = [
  {
    id: "matchers",
    header: "Matchers",
    // One code-styled match expression per matcher; an empty matcher array → "—".
    cell: ({ row }) =>
      row.original.matchers.length === 0 ? (
        EMPTY_CELL
      ) : (
        <span className="flex flex-wrap gap-1">
          {row.original.matchers.map((m) => (
            <code
              key={`${m.name}:${m.value}:${m.isRegex}:${m.isEqual}`}
              data-matcher=""
              className="rounded-sm bg-muted px-1 font-mono text-xs font-normal text-foreground"
            >
              {matcherExpression(m)}
            </code>
          ))}
        </span>
      ),
  },
  {
    id: "createdBy",
    header: "Creator",
    cell: ({ row }) => displayText(row.original.createdBy),
  },
  {
    id: "comment",
    header: "Comment",
    // Free text rendered as text (never HTML); empty string → "—".
    cell: ({ row }) => (row.original.comment.length > 0 ? displayText(row.original.comment) : EMPTY_CELL),
  },
  {
    id: "endsAt",
    header: "Expiry",
    // Expiry, with `startsAt` as muted secondary context.
    cell: ({ row }) => (
      <span className="flex flex-col">
        <span data-silence-ends="">{row.original.endsAt}</span>
        <span className="text-xs text-muted-foreground" title="Silence start" data-silence-starts="">
          from {row.original.startsAt}
        </span>
      </span>
    ),
  },
];

/** SILENCE_COLUMNS (returned by identity) plus an "Actions" column only when rowAction is given. */
export function silenceColumns(
  rowAction?: (s: ActiveSilence) => ReactElement | null,
): readonly SilenceColumn[] {
  return rowAction === undefined
    ? SILENCE_COLUMNS
    : [
        ...SILENCE_COLUMNS,
        { id: "actions", header: "Actions", cell: ({ row }) => rowAction(row.original) ?? "" },
      ];
}

/**
 * Active silences, one row per `ActiveSilence`, in the data tier's start → id order. Renders a
 * silences-specific `EmptyState` when the slice is empty. The tabpanel wrapper is owned by view.tsx.
 */
export function SilencesTab({ silences, rowAction }: SilencesTabProps): ReactElement {
  if (silences.length === 0) {
    return (
      <EmptyState icon="bell" title="No active silences" description="No silences are currently active." />
    );
  }
  // Rows verbatim — data tier order trusted.
  return (
    <DataTable<ActiveSilence>
      caption="Active silences"
      captionHidden
      columns={[...silenceColumns(rowAction)]}
      data={silences}
      getRowId={(s) => s.id}
    />
  );
}
