import * as React from "react";
import { defaultFilter } from "cmdk";
import { cn } from "@/ui/lib/utils";
import type { IconName } from "@/ui/lib/icons";
import { Icon } from "@/ui/patterns/icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/primitives/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/ui/primitives/command";

export interface CommandPaletteItem {
  /** Unique across the whole palette (it is cmdk's item value). */
  id: string;
  label: string;
  /** Extra terms that match when typed but are not shown. */
  keywords?: string[];
  icon?: IconName;
  /** Secondary text shown at the end of the row; also matched when typed. */
  hint?: string;
  onSelect: () => void;
}

export interface CommandPaletteGroup {
  heading: string;
  items: CommandPaletteItem[];
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: readonly CommandPaletteGroup[];
  /** The dialog's accessible name (visually hidden). */
  title?: string;
  /** The dialog's accessible description (visually hidden). */
  description?: string;
  placeholder?: string;
  emptyText?: string;
  className?: string;
  /** Controlled search text. Pair with `onSearchChange`; uncontrolled when omitted. */
  search?: string;
  onSearchChange?: (search: string) => void;
  /**
   * `false` hands filtering and ordering to the caller: every item in `groups` is shown, in the
   * order given (for a caller that ranks and caps its own results). Default `true` (cmdk filters).
   */
  shouldFilter?: boolean;
  /**
   * Where focus returns on close. Default: whatever had focus when the dialog opened. A caller that
   * shows something else first (a loading dialog while this one's code loads) passes the original
   * opener, which that first dialog has since taken focus from.
   */
  returnFocusTo?: HTMLElement | null;
}

/**
 * Matches the typed text against an item's label, hint and keywords, never its
 * id: ids only keep cmdk's values unique (two services may share a name).
 */
function filterItem(_value: string, search: string, keywords?: string[]): number {
  const [label = "", ...rest] = keywords ?? [];
  return defaultFilter(label, search, rest);
}

/**
 * A search-and-jump dialog over data-driven groups. Router-agnostic: each item
 * carries its own `onSelect`. Choosing an item runs it, then closes the dialog.
 * Opening focuses the search field, caret at the end of any text already in it; closing returns focus to whatever had it
 * before opening (Radix only does that for a `DialogTrigger`, and the palette is
 * usually opened by a shortcut or an outside button).
 */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  title = "Command palette",
  description = "Search for a page, host, service or alert",
  placeholder = "Type to search…",
  emptyText = "No results found.",
  className,
  search,
  onSearchChange,
  shouldFilter = true,
  returnFocusTo,
}: CommandPaletteProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  const onOpenAutoFocus = (event: Event) => {
    const active = (event.currentTarget as HTMLElement | null)?.ownerDocument.activeElement;
    returnFocusRef.current = returnFocusTo !== undefined ? returnFocusTo : active instanceof HTMLElement ? active : null;
    event.preventDefault();
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    // Text typed before the dialog mounted (a caller buffering keys) is already in the field: put
    // the caret after it so typing continues where it left off.
    const end = input.value.length;
    input.setSelectionRange(end, end);
  };

  const onCloseAutoFocus = (event: Event) => {
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target === null || !target.isConnected) return;
    event.preventDefault();
    target.focus();
  };

  const select = (item: CommandPaletteItem) => {
    item.onSelect();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="command-palette"
        className={cn("overflow-hidden p-0", className)}
        showCloseButton={false}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Command
          label={title}
          filter={filterItem}
          shouldFilter={shouldFilter}
          className="**:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3"
        >
          <CommandInput
            ref={inputRef}
            placeholder={placeholder}
            {...(search !== undefined ? { value: search } : {})}
            {...(onSearchChange !== undefined ? { onValueChange: onSearchChange } : {})}
          />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {groups.map((group) =>
              group.items.length === 0 ? null : (
                <CommandGroup key={group.heading} heading={group.heading}>
                  {group.items.map((item) => (
                    <CommandItem
                      key={item.id}
                      value={item.id}
                      keywords={[item.label, ...(item.hint !== undefined ? [item.hint] : []), ...(item.keywords ?? [])]}
                      onSelect={() => select(item)}
                    >
                      {item.icon !== undefined ? <Icon name={item.icon} /> : null}
                      <span className="truncate">{item.label}</span>
                      {item.hint !== undefined ? (
                        <CommandShortcut className="tracking-normal">{item.hint}</CommandShortcut>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ),
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

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
 * Turns command-index entries into palette groups (views, hosts, services,
 * alerts; empty groups dropped; entry order kept). Selecting an item calls
 * `navigate` with the entry's path.
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
    return items.length === 0 ? [] : [{ heading, items }];
  });
}
