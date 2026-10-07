// shell/Topbar.tsx — the sticky top bar: sidebar toggle, current view, the health region (estate
// name + live/staleness pill) and the display preferences. Under kiosk only the health region shows:
// no sidebar toggle, no controls.
import type { ReactElement } from "react";

// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { Separator } from "@/ui/primitives/separator";
// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { SidebarTrigger } from "@/ui/primitives/sidebar";

import type { AppStore } from "../store/index.js";
import type { EstateClock } from "../format.js";
import { HealthRegion } from "./HealthRegion.js";
import { DensityMenu, ThemeMenu } from "./ThemeMenu.js";

export interface TopbarProps {
  store: AppStore;
  /** Estate-timezone clock (Shell-owned); `null` until the first snapshot. */
  clock: EstateClock | null;
  /** The current view's label, shown beside the sidebar toggle. */
  title: string | undefined;
  /** Kiosk: health region only. */
  kiosk: boolean;
}

export function Topbar({ store, clock, title, kiosk }: TopbarProps): ReactElement {
  return (
    <header
      aria-label="Pulse"
      data-kiosk={kiosk ? "1" : "0"}
      className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-4"
    >
      {kiosk ? null : (
        <>
          <SidebarTrigger aria-label="Toggle navigation" />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-5" />
          {title === undefined ? null : (
            <span className="hidden shrink-0 text-sm font-medium sm:inline">{title}</span>
          )}
        </>
      )}
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <HealthRegion store={store} clock={clock} />
        {kiosk ? null : (
          <div className="flex shrink-0 items-center">
            <ThemeMenu store={store} />
            <DensityMenu store={store} />
          </div>
        )}
      </div>
    </header>
  );
}
