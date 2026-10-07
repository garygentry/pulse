// src/client/theme/density.ts — the density half of the single document-root switch point
// (REQ-DEN-01/02/03, REQ-THEME-04, §02 §4).
//
// Pure resolution + one attribute write. `?kiosk=1` forces `wallboard` at APPLY time only; it is
// never persisted (kiosk density is transient — REQ-DEN-03). No localStorage is touched here: the
// store owns persistence (REQ-PREF-01).
import type { Density } from "../store/types.js"; // 00 §3 (consumed, not redefined)

/**
 * Resolve the effective density: `?kiosk=1` forces `wallboard`, else the passed preference
 * (REQ-DEN-03). Pure; used by {@link applyDensity} and unit-tested directly.
 *
 * @param d - The stored/selected density.
 * @param search - A `location.search`-style string. Matched by `/(?:^|[?&])kiosk=1(?:&|$)/` so only a
 *   genuine `kiosk=1` param (not, e.g., `nokiosk=1` or `kiosk=10`) forces wallboard.
 * @returns `"wallboard"` when `search` contains `kiosk=1`, else `d`.
 */
export function resolveEffectiveDensity(d: Density, search = ""): Density {
  return /(?:^|[?&])kiosk=1(?:&|$)/.test(search) ? "wallboard" : d;
}

/**
 * Apply the effective density to the single document-root switch point (REQ-THEME-04 / REQ-DEN-01):
 * writes `document.documentElement.dataset.density`. `?kiosk=1` in `search` forces `"wallboard"`
 * regardless of the passed preference and WITHOUT persisting it (REQ-DEN-03). Idempotent.
 *
 * @param d - The stored/selected density preference (`wallboard` | `desk`).
 * @param search - The current `location.search` (test seam). Defaults to `""` (no override).
 */
export function applyDensity(d: Density, search = ""): void {
  document.documentElement.dataset.density = resolveEffectiveDensity(d, search);
}
