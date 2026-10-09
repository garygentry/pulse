// apps/web/tests/visual/scenario.ts — the pinned instants and scenario of the visual suite, shared by
// the Playwright config (server launch) and visual-kit.ts (browser clock). No imports.

/** The app's "now": the dev server's frozen wall clock (PULSE_VISUAL_NOW) and the browser clock. */
export const FROZEN_NOW_ISO = "2026-10-01T12:00:00.000Z";
/** The pinned scenario start (`--clock`): 15 minutes before FROZEN_NOW, so its timeline has played out. */
export const SCENARIO_CLOCK_ISO = "2026-10-01T11:45:00.000Z";
/** The pinned mock scenario: every status state, a silenced alert, a failing check. */
export const SCENARIO = "degraded-mix";
