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
  /** Unique across the whole palette: it keys the item and the highlighted row. */
  id: string;
  label: string;
  /** Extra terms that match when typed but are not shown. */
  keywords?: string[];
  icon?: IconName;
  /**
   * Secondary text shown at the end of the row (an address, a kind); also matched when typed.
   * It is plain muted text, not status: a hint carries no tone or icon, so don't put a health or
   * state value here.
   */
  hint?: string;
  onSelect: () => void;
}

export interface CommandPaletteGroup {
  /** Keys the group. Give one when headings can repeat; otherwise the index and heading are used. */
  id?: string;
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
  /**
   * Search text. With `onSearchChange` it is controlled; without it, it only seeds the field each
   * time the palette opens and the field stays editable.
   */
  search?: string | undefined;
  /** Called with the field's text on every change. */
  onSearchChange?: ((search: string) => void) | undefined;
  /**
   * `false` hands filtering and ordering to the caller: every item in `groups` is shown, in the
   * order given (for a caller that ranks and caps its own results). Default `true`: the palette
   * keeps the items whose label, hint or keywords match, best first, using cmdk's scoring.
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
 * Scores an item against the typed text by its label, hint and keywords, never its id: ids only
 * keep items unique (two services may share a name). 0 means no match.
 */
function scoreItem(item: CommandPaletteItem, search: string): number {
  return defaultFilter(item.label, search, [...(item.hint !== undefined ? [item.hint] : []), ...(item.keywords ?? [])]);
}

/**
 * The matching items, best first, and the groups ordered by their best match (cmdk's own order).
 * The palette filters here rather than in cmdk: cmdk re-reads an item's search terms only when its
 * value changes, so an item whose label, hint or keywords change under a stable id would keep
 * matching its old text.
 */
function rankGroups(groups: readonly CommandPaletteGroup[], search: string): CommandPaletteGroup[] {
  return groups
    .map((group, index) => {
      const scored = group.items
        .map((item) => ({ item, score: scoreItem(item, search) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);
      return {
        group: { ...group, id: groupKey(group, index), items: scored.map((entry) => entry.item) },
        best: scored[0]?.score ?? 0,
      };
    })
    .filter((entry) => entry.best > 0)
    .sort((a, b) => b.best - a.best)
    .map((entry) => entry.group);
}

/** A group's React key: its `id`, else its position and heading (headings can repeat). */
function groupKey(group: CommandPaletteGroup, index: number): string {
  return group.id ?? `${index}:${group.heading}`;
}

/**
 * A search-and-jump dialog over data-driven groups. Router-agnostic: each item
 * carries its own `onSelect`. Choosing an item runs it, then closes the dialog.
 * Opening focuses the search field, caret at the end of any text already in it;
 * closing returns focus to whatever had it before opening (Radix only does that for
 * a `DialogTrigger`, and the palette is usually opened by a shortcut or an outside
 * button). Escape, a click outside or the labelled Close button dismisses it.
 */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  title = "Command palette",
  description = "Search for a page or command",
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="command-palette"
        className={cn("overflow-hidden p-0", className)}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <PaletteBody
          onOpenChange={onOpenChange}
          groups={groups}
          title={title}
          placeholder={placeholder}
          emptyText={emptyText}
          search={search}
          onSearchChange={onSearchChange}
          shouldFilter={shouldFilter}
          inputRef={inputRef}
        />
      </DialogContent>
    </Dialog>
  );
}

type PaletteBodyProps = Required<
  Pick<CommandPaletteProps, "onOpenChange" | "groups" | "title" | "placeholder" | "emptyText" | "shouldFilter">
> &
  Pick<CommandPaletteProps, "search" | "onSearchChange"> & { inputRef: React.Ref<HTMLInputElement> };

/**
 * The searchable list. It mounts each time the dialog opens, so its search text and highlighted
 * row start fresh on every open.
 */
function PaletteBody({
  onOpenChange,
  groups,
  title,
  placeholder,
  emptyText,
  search,
  onSearchChange,
  shouldFilter,
  inputRef,
}: PaletteBodyProps) {
  // Controlled only when the caller both passes `search` and listens for changes; `search` alone
  // seeds the field.
  const [ownSearch, setOwnSearch] = React.useState(search ?? "");
  const controlled = search !== undefined && onSearchChange !== undefined;
  const searchText = controlled ? search : ownSearch;
  const changeSearch = (next: string) => {
    if (!controlled) setOwnSearch(next);
    onSearchChange?.(next);
  };

  // Ranked from the current groups on every render, so changed text is searchable at once. cmdk
  // still owns the highlight, keyed by item id, which survives an item's text changing.
  const shown =
    shouldFilter && searchText !== ""
      ? rankGroups(groups, searchText)
      : groups.map((group, index) => ({ ...group, id: groupKey(group, index) }));

  const select = (item: CommandPaletteItem) => {
    item.onSelect();
    onOpenChange(false);
  };

  return (
    <Command
      label={title}
      shouldFilter={false}
      className="**:data-[slot=command-input-wrapper]:h-12 **:data-[slot=command-input-wrapper]:pr-10 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3"
    >
      <CommandInput ref={inputRef} placeholder={placeholder} value={searchText} onValueChange={changeSearch} />
      <CommandList>
        <CommandEmpty>{emptyText}</CommandEmpty>
        {shown.map((group) =>
          group.items.length === 0 ? null : (
            <CommandGroup key={group.id} heading={group.heading}>
              {group.items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.id}
                  // Name the option "label, hint" so the two aren't announced as one run-together word.
                  {...(item.hint !== undefined ? { "aria-label": `${item.label}, ${item.hint}` } : {})}
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
  );
}
