// src/client/theme/index.ts — the theme barrel (00 §01 import surface).
//
// The theme and density runtime the shell consumes, plus convenience type re-exports. Token values
// live in styles/theme.css and styles/theme-pulse.css.

/** Theme runtime (item 004, §02 §3): resolve/apply appearance + the Shell-facing switch-point hook. */
export { resolveEffectiveTheme, applyTheme, useTheme } from "./theme.js";
export type { EffectiveTheme } from "./theme.js";

/** Density runtime (item 004, §02 §4): kiosk-aware resolution + the density half of the switch point. */
export { applyDensity, resolveEffectiveDensity } from "./density.js";

/** Closed union of curated lucide icon names (00 §2.3, applied to ViewDefinition.icon). */
// ui-deep-import: type-only; the shell (entry code) keeps deep imports so the barrel stays lazy.
export type { IconName } from "../ui/lib/icons.js";

/** Consumed domain unions, owned by web-foundation (00 §3) — re-exported for convenience. */
export type { Theme, Density } from "../store/types.js";
