/**
 * The curated icon set: every icon deck renders, keyed by the string token that
 * estate config, `registerPage` and feature state maps use.
 *
 * Import each Lucide icon by name here (or, for an icon the shell renders, in
 * `icons-shell.ts`) and nowhere else. Never use `lucide-react/dynamic` or a
 * namespace import: either one ships the whole set.
 *
 * This module is a lazy chunk: `ViewHost` loads it alongside each view, and
 * evaluating it registers the set with `<Icon>` (`icon-registry.ts`). Only the
 * shell's icons ship on the initial route.
 *
 * Aliases (`check-circle` ≡ `circle-check`, Lucide's older names, and the
 * literal unicode glyphs legacy state maps still use) resolve to the same
 * component, so existing tokens keep working while features migrate.
 */
import {
  Archive,
  Ban,
  BookOpen,
  Boxes,
  CalendarClock,
  ChartPie,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleMinus,
  CirclePlay,
  CirclePlus,
  CircleQuestionMark,
  CircleSlash,
  CircleStop,
  CircleX,
  ClockAlert,
  CloudOff,
  Contrast,
  Copy,
  DatabaseCheck,
  DatabaseX,
  Diamond,
  ExternalLink,
  EyeOff,
  File,
  FileCog,
  FileDigit,
  FileQuestionMark,
  Folder,
  FolderOpen,
  Gauge,
  GitCompareArrows,
  House,
  Inbox,
  Link,
  Link2Off,
  Minus,
  Play,
  RefreshCw,
  Search,
  SearchX,
  Slash,
  SunMoon,
  Triangle,
  Zap,
  type LucideIcon,
} from "lucide-react";
// pulse additions: the shell and pulse views' icons deck's set lacks.
import {
  Bell,
  ChevronLeft,
  ChevronUp,
  CircleAlert,
  Command,
  Keyboard,
  List,
  Menu,
  PanelRight,
  TrendingUp,
} from "lucide-react";
import { iconRegistry } from "@/ui/lib/icon-registry";
import { SHELL_ICONS } from "@/ui/lib/icons-shell";

export const ICONS = {
  // The shell's icons ship on the initial route (icons-shell.ts); the rest load lazily.
  ...SHELL_ICONS,
  // Status.
  "database-check": DatabaseCheck,
  "circle-x": CircleX,
  "x-circle": CircleX,
  "circle-minus": CircleMinus,
  "minus-circle": CircleMinus,
  minus: Minus,
  "circle-help": CircleQuestionMark,
  "circle-question-mark": CircleQuestionMark,
  slash: Slash,
  "circle-slash": CircleSlash,
  "circle-stop": CircleStop,
  "circle-dashed": CircleDashed,
  "clock-alert": ClockAlert,
  "calendar-clock": CalendarClock,
  ban: Ban,

  // Objects and actions.
  inbox: Inbox,
  "database-off": DatabaseX,
  "database-x": DatabaseX,
  "cloud-off": CloudOff,
  link: Link,
  "link-off": Link2Off,
  unlink: Link2Off,
  file: File,
  "file-digit": FileDigit,
  "file-binary": FileDigit,
  "file-question": FileQuestionMark,
  "file-question-mark": FileQuestionMark,
  folder: Folder,
  "folder-open": FolderOpen,
  "external-link": ExternalLink,
  "search-x": SearchX,
  play: Play,
  "circle-play": CirclePlay,
  "play-circle": CirclePlay,
  archive: Archive,
  "eye-off": EyeOff,
  "chevron-right": ChevronRight,
  "chevron-down": ChevronDown,
  copy: Copy,
  check: Check,
  "refresh-cw": RefreshCw,

  // Navigation (page registrations and the shell).
  boxes: Boxes,
  "git-compare": GitCompareArrows,
  zap: Zap,
  "book-open": BookOpen,
  "file-cog": FileCog,
  house: House,
  gauge: Gauge,

  // Theme.
  "sun-moon": SunMoon,

  // Filtering and search.
  search: Search,
  "circle-plus": CirclePlus,
  "plus-circle": CirclePlus,

  // Legacy unicode glyphs from pre-migration state maps.
  "✓": Check,
  "▲": Triangle,
  "◆": Diamond,
  "◐": Contrast,
  "◔": ChartPie,
  "∅": Ban,

  // pulse additions.
  bell: Bell,
  "chevron-left": ChevronLeft,
  "chevron-up": ChevronUp,
  "circle-alert": CircleAlert,
  command: Command,
  keyboard: Keyboard,
  list: List,
  menu: Menu,
  "panel-right": PanelRight,
  "trending-up": TrendingUp,
  triangle: Triangle,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export { FALLBACK_ICON } from "@/ui/lib/icons-shell";

export function isIconName(name: string): name is IconName {
  return Object.hasOwn(ICONS, name);
}

// Whoever imports the full set (the `@/ui` barrel, the lazy load in `loadIconSet`) registers it.
iconRegistry.registerFullSet(ICONS);
