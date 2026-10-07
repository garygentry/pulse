// apps/web/src/client/store/preferences.ts — guarded localStorage wrapper (REQ-STORE-04/07).
//
// Every localStorage access is inside a try/catch that returns a default: Safari private mode,
// storage policy, and quota errors all throw synchronously. Never throws.

import type { Density, Theme } from "./types.js";

/** Minimal string storage the store persists through. */
export interface PreferenceStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Namespaced localStorage keys. */
export const PREF_KEYS = {
  theme: "pulse.web.theme",
  density: "pulse.web.density",
} as const;

/** Defaults. */
export const DEFAULT_THEME: Theme = "system";
export const DEFAULT_DENSITY: Density = "desk";

/** Probe key written and removed once, at construction. Namespaced so a residual value (a crash
 *  between set and remove) is recognisable and harmless. */
const PROBE_KEY = "pulse.web.__probe" as const;

const THEMES: readonly Theme[] = ["system", "dark", "light"];
const DENSITIES: readonly Density[] = ["wallboard", "desk"];

/**
 * Wrap `win.localStorage`. Every call is try/catch. Returns `null` when the API is absent or the
 * probe write/remove throws (private browsing, policy, quota) — the store then runs on in-memory
 * defaults for the session. Never throws.
 */
export function createPreferenceStorage(
  win: Pick<Window, "localStorage"> | undefined = (globalThis as { window?: Window }).window,
): PreferenceStorage | null {
  try {
    const ls = win?.localStorage;
    if (ls === undefined || ls === null) return null;
    if (typeof ls.getItem !== "function" || typeof ls.setItem !== "function") return null;
    ls.setItem(PROBE_KEY, "1");
    ls.removeItem(PROBE_KEY);
    return {
      get(key: string): string | null {
        try {
          return ls.getItem(key);
        } catch {
          return null;
        }
      },
      set(key: string, value: string): void {
        try {
          ls.setItem(key, value);
        } catch {
          /* storage went away mid-session: drop the write */
        }
      },
    };
  } catch {
    return null;
  }
}

/** Read + validate against the union members; missing/malformed/unknown → the default. Never throws. */
export function readTheme(storage: PreferenceStorage | null): Theme {
  const raw = storage === null ? null : safeGet(storage, PREF_KEYS.theme);
  return THEMES.includes(raw as Theme) ? (raw as Theme) : DEFAULT_THEME;
}

/** Read + validate against the union members; missing/malformed/unknown → the default. Never throws. */
export function readDensity(storage: PreferenceStorage | null): Density {
  const raw = storage === null ? null : safeGet(storage, PREF_KEYS.density);
  return DENSITIES.includes(raw as Density) ? (raw as Density) : DEFAULT_DENSITY;
}

/** A foreign `PreferenceStorage.get` may throw; the built-in wrapper never does. */
function safeGet(storage: PreferenceStorage, key: string): string | null {
  try {
    return storage.get(key);
  } catch {
    return null;
  }
}
