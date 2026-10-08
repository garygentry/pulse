// shell/PaletteDialog.tsx — the command palette's dialog, in its own lazy chunk (cmdk and the
// pattern stay out of the entry). Loaded by CommandPalette.tsx; renders the `@/ui` CommandPalette
// over results the command index already ranked and capped, so the pattern's filter is off. Results
// are grouped by kind, groups ordered by their best match, so the top-ranked entry is first and
// selected; within the list, entries of one kind stay together.
import type { ReactElement } from "react";
import { useMemo } from "react";

// ui-deep-import: through the barrel Bun.build would merge this chunk with every lazy view's @/ui modules
import { CommandPalette, commandGroupsFromIndex } from "@/ui/patterns/command-palette";

import type { PaletteEntry } from "./command-index.js";

export interface PaletteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ranked, capped results (`matchEntries`). */
  results: readonly PaletteEntry[];
  /** Router navigation for a selected entry's path (REQ-CMD-02). */
  navigate: (path: string) => void;
  search: string;
  onSearchChange: (search: string) => void;
  /** The element focused when the palette was opened; focus returns there on close. */
  returnFocusTo: HTMLElement | null;
}

export function PaletteDialog(props: PaletteDialogProps): ReactElement {
  const { open, onOpenChange, results, navigate, search, onSearchChange, returnFocusTo } = props;
  const groups = useMemo(
    () => commandGroupsFromIndex(results, navigate, { groupOrder: "entries" }),
    [results, navigate],
  );
  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      groups={groups}
      title="Command palette"
      description="Search views, hosts, services, and alerts"
      placeholder="Search…"
      emptyText="No results"
      search={search}
      onSearchChange={onSearchChange}
      shouldFilter={false}
      returnFocusTo={returnFocusTo}
    />
  );
}
