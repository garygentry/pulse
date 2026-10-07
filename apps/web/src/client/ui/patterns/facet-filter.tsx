import * as React from "react";
import type { IconName } from "@/ui/lib/icons";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";
import { Badge } from "@/ui/primitives/badge";
import { Button } from "@/ui/primitives/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/ui/primitives/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/primitives/popover";
import { Separator } from "@/ui/primitives/separator";
import { ToggleGroup, ToggleGroupItem } from "@/ui/primitives/toggle-group";

export interface FacetOption {
  value: string;
  label: string;
  /** How many items carry this value; shown beside the label. */
  count?: number;
  icon?: IconName;
}

export interface FacetFilterProps {
  /** The facet's name ("Status"): trigger text / group label. */
  title: string;
  options: readonly FacetOption[];
  selected: ReadonlySet<string>;
  /** Raised with the complete next selection. */
  onSelectedChange: (next: Set<string>) => void;
  /**
   * `popover` = trigger + searchable multi-select list; `inline` = a row of
   * toggle chips. `auto` (default) picks `inline` for ≤ 4 options.
   */
  variant?: "auto" | "popover" | "inline";
  /** Popover only: whether the list has a search field (default: more than 7 options). */
  searchable?: boolean;
  /** Popover only: seed the open state (workbench/tests). */
  defaultOpen?: boolean;
  className?: string;
}

function OptionCount({ count }: { count: number | undefined }) {
  if (count === undefined) return null;
  return <span className="ml-auto pl-2 font-mono text-xs text-muted-foreground tabular-nums">{count}</span>;
}

function InlineFacet({ title, options, selected, onSelectedChange, className }: FacetFilterProps) {
  const labelId = React.useId();
  return (
    <div
      data-slot="facet-filter"
      data-variant="inline"
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      <span id={labelId} className="text-sm font-medium text-muted-foreground">
        {title}
      </span>
      <ToggleGroup
        type="multiple"
        variant="outline"
        size="sm"
        spacing={1}
        aria-labelledby={labelId}
        value={[...selected]}
        onValueChange={(values) => onSelectedChange(new Set(values))}
        className="flex-wrap"
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value} className="rounded-full">
            {option.icon ? <Icon name={option.icon} /> : null}
            {option.label}
            <OptionCount count={option.count} />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function PopoverFacet({
  title,
  options,
  selected,
  onSelectedChange,
  searchable = options.length > 7,
  defaultOpen,
  className,
}: FacetFilterProps) {
  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onSelectedChange(next);
  };
  const listRef = React.useRef<HTMLDivElement>(null);
  const chosen = options.filter((option) => selected.has(option.value));

  return (
    <Popover defaultOpen={defaultOpen ?? false}>
      <PopoverTrigger asChild>
        <Button
          data-slot="facet-filter"
          data-variant="popover"
          variant="outline"
          size="sm"
          className={cn("border-dashed", className)}
        >
          <Icon name="circle-plus" />
          {title}
          {selected.size > 0 ? (
            <>
              <Separator orientation="vertical" className="mx-1 h-4" />
              <Badge variant="secondary" className="rounded-sm px-1 font-normal tabular-nums">
                {selected.size}
                <span className="sr-only"> selected</span>
              </Badge>
              <span className="hidden gap-1 lg:flex" aria-hidden="true">
                {chosen.length <= 2
                  ? chosen.map((option) => (
                      <Badge key={option.value} variant="secondary" className="rounded-sm px-1 font-normal">
                        {option.label}
                      </Badge>
                    ))
                  : null}
              </span>
            </>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-60 p-0"
        align="start"
        onOpenAutoFocus={(event) => {
          // Without a search field, focus the listbox so the arrow keys and Enter work.
          if (!searchable) {
            event.preventDefault();
            listRef.current?.focus();
          }
        }}
      >
        {/* cmdk overrides aria-label on its parts: `label` names the input, the list's `label` the listbox.
            cmdk drives aria-selected from its keyboard cursor, so the listbox stays single-select
            (no aria-multiselectable) and each option's chosen state is aria-checked. */}
        <Command label={`Filter ${title} options`}>
          {searchable ? <CommandInput placeholder={title} /> : null}
          <CommandList
            ref={listRef}
            label={title}
            className="outline-none"
          >
            <CommandEmpty>No matching options.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = selected.has(option.value);
                return (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    keywords={[option.label]}
                    aria-checked={isSelected}
                    onSelect={() => toggle(option.value)}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-4 items-center justify-center rounded-sm border border-primary",
                        isSelected
                          ? "bg-primary text-primary-foreground"
                          : "opacity-50 [&_svg]:invisible",
                      )}
                    >
                      <Icon name="check" size={12} className="text-current" />
                    </span>
                    {option.icon ? <Icon name={option.icon} /> : null}
                    <span className="truncate">{option.label}</span>
                    <OptionCount count={option.count} />
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {selected.size > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="__clear__"
                    keywords={["clear"]}
                    onSelect={() => onSelectedChange(new Set())}
                    className="justify-center text-center"
                  >
                    Clear {title} filter
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A multi-select filter for one facet, with per-option counts. The popover
 * variant is shadcn's data-table faceted filter (trigger shows the selected
 * count; options are `role=option` with `aria-checked`); the inline variant is
 * a toolbar of `aria-pressed` toggle chips.
 */
export function FacetFilter({ variant = "auto", ...props }: FacetFilterProps) {
  const inline = variant === "inline" || (variant === "auto" && props.options.length <= 4);
  return inline ? <InlineFacet {...props} /> : <PopoverFacet {...props} />;
}
