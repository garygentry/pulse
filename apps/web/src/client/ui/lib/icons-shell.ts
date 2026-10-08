/**
 * The shell's icons: the part of the curated set (`icons.ts`) that ships on the
 * initial route. `<Icon>` resolves these synchronously from the first paint;
 * the rest of the set loads as a lazy chunk alongside the first view.
 *
 * An icon belongs here when entry code (the shell, the router, the view
 * registry and the library modules they import) can render it before any view
 * has loaded: nav icons, the theme menu, the health region, and the icons of
 * the patterns the shell renders (Callout, ErrorState, Button's spinner). The
 * build budget test fails if an icon token in an initial-route module is
 * missing from this map. Aliases of a shell icon are listed too: they cost
 * nothing once the component ships.
 *
 * Import each Lucide icon by name here or in `icons.ts`, and nowhere else.
 */
import {
  Activity,
  Circle,
  CircleCheck,
  Clock,
  Hourglass,
  Info,
  LayoutGrid,
  Loader,
  Maximize,
  Monitor,
  Moon,
  Network,
  OctagonAlert,
  Server,
  Sun,
  TriangleAlert,
  Wifi,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";

export const SHELL_ICONS = {
  // Navigation (the view registry) and the sidebar's fallback.
  activity: Activity,
  "alert-triangle": TriangleAlert,
  server: Server,
  network: Network,
  clock: Clock,
  circle: Circle,

  // Theme and layout menus.
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  "layout-grid": LayoutGrid,
  maximize: Maximize,

  // Health region.
  wifi: Wifi,
  "wifi-off": WifiOff,
  loader: Loader,

  // Callout tones and dismiss, ErrorState.
  "circle-check": CircleCheck,
  "check-circle": CircleCheck,
  "triangle-alert": TriangleAlert,
  "octagon-alert": OctagonAlert,
  "alert-octagon": OctagonAlert,
  info: Info,
  hourglass: Hourglass,
  x: X,

  // Legacy unicode glyphs for the components above.
  "✕": X,
  "⚠": TriangleAlert,
  "○": Circle,
  ℹ: Info,
  "☀": Sun,
  "☾": Moon,
} as const satisfies Record<string, LucideIcon>;

/** The neutral glyph rendered for an unknown token (e.g. a typo in estate config). */
export const FALLBACK_ICON: LucideIcon = Circle;
