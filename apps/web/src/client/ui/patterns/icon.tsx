import type { LucideProps } from "lucide-react";
import { FALLBACK_ICON, ICONS, isIconName, type IconName } from "@/ui/lib/icons";

export interface IconProps extends Omit<LucideProps, "ref"> {
  /** A curated `IconName`, or a config-supplied token that may not be one. */
  name: IconName | (string & {});
  /** Pixel size; defaults to 16. */
  size?: number;
}

const warned = new Set<string>();

/**
 * A decorative icon from the curated set. Always `aria-hidden`: the adjacent
 * text is the accessible label, so an icon is never the only signal. An unknown
 * token renders a neutral circle (and warns once in development) rather than an
 * empty box or the raw token text.
 */
export function Icon({ name, size = 16, ...props }: IconProps) {
  let Component = FALLBACK_ICON;
  if (isIconName(name)) {
    Component = ICONS[name];
  } else if (import.meta.env.DEV && !warned.has(name)) {
    warned.add(name);
    console.warn(`[pulse] Unknown icon "${name}"; rendering the fallback icon.`);
  }
  return <Component aria-hidden="true" focusable="false" size={size} data-slot="icon" {...props} />;
}
