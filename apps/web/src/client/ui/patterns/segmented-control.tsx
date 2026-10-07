import type * as React from "react";
import type { IconName } from "@/ui/lib/icons";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";
import { ToggleGroup, ToggleGroupItem } from "@/ui/primitives/toggle-group";

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: React.ReactNode;
  icon?: IconName;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string = string> {
  /** Accessible name of the radio group ("Source"). */
  label: string;
  options: readonly SegmentedOption<V>[];
  value: V;
  onValueChange: (value: V) => void;
  size?: "sm" | "default";
  className?: string;
}

/**
 * A single-select pill group: a `radiogroup` of `radio`s with `aria-checked`,
 * arrow-key roving focus. The active option cannot be deselected.
 */
export function SegmentedControl<V extends string = string>({
  label,
  options,
  value,
  onValueChange,
  size = "sm",
  className,
}: SegmentedControlProps<V>) {
  return (
    <ToggleGroup
      data-slot="segmented-control"
      type="single"
      size={size}
      spacing={1}
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        // Radix clears the value when the active item is clicked again; ignore that.
        if (next !== "") onValueChange(next as V);
      }}
      className={cn("rounded-lg bg-muted p-0.5", className)}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className="text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs"
        >
          {option.icon ? <Icon name={option.icon} /> : null}
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
