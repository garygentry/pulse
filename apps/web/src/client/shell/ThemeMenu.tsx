// shell/ThemeMenu.tsx — the top bar's display preferences: theme (light/dark/system) and density
// (desk/wallboard). Each control only writes its store signal; persistence and the document-root
// switch belong to the store and `useTheme`. Not rendered under kiosk, which forces wallboard.
import type { ReactElement } from "react";
import { useSignals } from "@preact/signals-react/runtime";

// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import type { IconName } from "@/ui/lib/icons";
// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { Icon } from "@/ui/patterns/icon";
// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { Button } from "@/ui/primitives/button";
// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/primitives/dropdown-menu";

import type { AppStore } from "../store/index.js";
import type { Density, Theme } from "../store/types.js";

interface Option<T extends string> {
  value: T;
  label: string;
  icon: IconName;
}

const THEMES: readonly Option<Theme>[] = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "System", icon: "monitor" },
];

const DENSITIES: readonly Option<Density>[] = [
  { value: "desk", label: "Desk", icon: "layout-grid" },
  { value: "wallboard", label: "Wallboard", icon: "maximize" },
];

/** One preference menu: an icon trigger named after the current value, and a radio list. */
function PreferenceMenu<T extends string>(props: {
  name: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (next: T) => void;
}): ReactElement {
  const { name, value, options, onChange } = props;
  const current = options.find((option) => option.value === value) ?? options[0]!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`${name}: ${current.label}`}>
          <Icon name={current.icon} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{name}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const option = options.find((o) => o.value === next);
            if (option !== undefined) onChange(option.value);
          }}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <Icon name={option.icon} />
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface PreferenceMenuProps {
  store: AppStore;
}

/** Theme picker: the trigger names the current preference ("Theme: Dark"). */
export function ThemeMenu({ store }: PreferenceMenuProps): ReactElement {
  useSignals();
  return (
    <PreferenceMenu
      name="Theme"
      value={store.theme.value}
      options={THEMES}
      onChange={(next) => {
        store.theme.value = next;
      }}
    />
  );
}

/** Density picker: desk or wallboard ("Density: Desk"). */
export function DensityMenu({ store }: PreferenceMenuProps): ReactElement {
  useSignals();
  return (
    <PreferenceMenu
      name="Density"
      value={store.density.value}
      options={DENSITIES}
      onChange={(next) => {
        store.density.value = next;
      }}
    />
  );
}
