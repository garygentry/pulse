// a11y/index.ts  (a11y-primitives) — the wave-3 import surface (01-architecture-layout.md §3, 05 §1).
export { rovingTabindex } from "./roving-tabindex.js";
export { announce, mountAnnouncer } from "./announcer.js";
export { SkipLink } from "./skip-link.js"; // skip-link.tsx compiles to .js
export { registerShortcut, ShortcutRegistry } from "./shortcuts.js";
export { STATUS_LABEL, cellLabel, serviceLabel } from "./status-labels.js";
export type { RovingController, RovingOptions } from "./roving-tabindex.js";
export type { Politeness } from "./announcer.js";
export type { ShortcutHandler, KeyCombo } from "./shortcuts.js";
