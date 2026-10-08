import { useEffect, useSyncExternalStore } from "react";
import type { LucideProps } from "lucide-react";
import { iconRegistry, loadIconSet } from "@/ui/lib/icon-registry";
import type { IconName } from "@/ui/lib/icons";
import { FALLBACK_ICON } from "@/ui/lib/icons-shell";

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
 *
 * Names resolve through `icon-registry.ts`: the shell's icons are there from the
 * first paint, the rest once the lazy icon chunk has loaded (`ViewHost` loads it
 * with every view). A name asked for before then renders an empty svg of the
 * same size, so nothing shifts, and fills in when the chunk arrives.
 */
export function Icon({ name, size = 16, ...props }: IconProps) {
  useSyncExternalStore(iconRegistry.subscribe, iconRegistry.version, iconRegistry.version);
  const found = iconRegistry.lookup(name);
  const pending = found === "pending";
  useEffect(() => {
    if (pending) loadIconSet().catch(() => {});
  }, [pending]);

  if (pending) {
    const { absoluteStrokeWidth: _absolute, ...svgProps } = props;
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        data-slot="icon"
        {...svgProps}
      />
    );
  }

  let Component = FALLBACK_ICON;
  if (found !== "unknown") {
    Component = found;
  } else if (import.meta.env.DEV && !warned.has(name)) {
    warned.add(name);
    console.warn(`[pulse] Unknown icon "${name}"; rendering the fallback icon.`);
  }
  return <Component aria-hidden="true" focusable="false" size={size} data-slot="icon" {...props} />;
}
