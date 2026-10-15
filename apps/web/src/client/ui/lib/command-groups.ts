import type { IconName } from "@/ui/lib/icons";
import type { CommandPaletteGroup, CommandPaletteItem } from "@/ui/patterns/command-palette";

/** The shape of a command-index entry; the shell's index entries satisfy it as they are. */
export interface CommandIndexEntry {
  kind: "view" | "host" | "service" | "alert";
  id: string;
  label: string;
  sublabel?: string;
  navPath: string;
}

const INDEX_GROUPS: readonly { kind: CommandIndexEntry["kind"]; heading: string; icon: IconName }[] = [
  { kind: "view", heading: "Views", icon: "layout-grid" },
  { kind: "host", heading: "Hosts", icon: "server" },
  { kind: "service", heading: "Services", icon: "boxes" },
  { kind: "alert", heading: "Alerts", icon: "bell" },
];

export interface CommandGroupsOptions {
  /**
   * `"kind"` (default): groups in the fixed order views, hosts, services, alerts.
   * `"entries"`: groups in the order their first entry appears, so a ranked entry
   * list keeps its best match first.
   */
  groupOrder?: "kind" | "entries";
}

/**
 * Turns command-index entries into `CommandPalette` groups (views, hosts, services,
 * alerts; empty groups dropped; entry order kept). Selecting an item calls
 * `navigate` with the entry's path. Each group carries its kind as `id`.
 */
export function commandGroupsFromIndex(
  entries: readonly CommandIndexEntry[],
  navigate: (path: string) => void,
  options: CommandGroupsOptions = {},
): CommandPaletteGroup[] {
  const groupKinds =
    options.groupOrder === "entries"
      ? [...new Set(entries.map((entry) => entry.kind))].map(
          (kind) => INDEX_GROUPS.find((group) => group.kind === kind)!,
        )
      : INDEX_GROUPS;
  return groupKinds.flatMap(({ kind, heading, icon }) => {
    const items = entries
      .filter((entry) => entry.kind === kind)
      .map(
        (entry): CommandPaletteItem => ({
          id: `${entry.kind}:${entry.id}`,
          label: entry.label,
          icon,
          ...(entry.sublabel !== undefined ? { hint: entry.sublabel } : {}),
          onSelect: () => navigate(entry.navPath),
        }),
      );
    return items.length === 0 ? [] : [{ id: kind, heading, items }];
  });
}
