// apps/web/src/client/views/overview/preference-storage.ts — the browser-storage adapter injected
// into preferences.ts. Kept apart so preferences.ts itself never touches a browser global.

import type { OverviewPreferenceStorage } from "./model.js";

/**
 * Guarded adapter over `window.localStorage`: every access is wrapped independently, so a
 * missing, disabled or quota-exceeded storage degrades to defaults / in-memory choices.
 */
export function browserPreferenceStorage(): OverviewPreferenceStorage | null {
  let storage: Storage | null | undefined;
  try {
    storage = (globalThis as { window?: { localStorage?: Storage | null } }).window?.localStorage;
  } catch {
    return null;
  }
  if (storage === null || storage === undefined) return null;
  const local = storage;
  return {
    get(key) {
      try {
        return local.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        local.setItem(key, value);
      } catch {
        // Absorbed: the mounted session keeps its in-memory choices.
      }
    },
    remove(key) {
      try {
        local.removeItem(key);
      } catch {
        // Best-effort cleanup.
      }
    },
  };
}
