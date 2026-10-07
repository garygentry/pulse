// src/client/theme/theme.ts — resolve, apply, and follow-OS logic for the theme half of the single
// document-root switch point (REQ-THEME-01/02/04, REQ-A11Y-07, §02 §3).
//
// Persistence is NOT here: `store.theme` is already persisted by an effect() inside createAppStore
// (web-foundation). This module only *resolves* a preference to an appearance and *applies* it to
// `<html>` (the `.dark` class + `color-scheme`); it never touches localStorage (REQ-PREF-01, §02 §3.3).
import { useEffect } from "react";
import { effect } from "@preact/signals-core";

import type { AppStore } from "../store/index.js"; // 00 §8 (consumed)
import type { Theme } from "../store/types.js"; // 00 §3 (consumed, not redefined)
import { applyDensity } from "./density.js";

/** The resolved appearance actually applied to `<html>`. `system` collapses to one of these. */
export type EffectiveTheme = "dark" | "light";

/** Read `matchMedia` from `globalThis` at CALL time, returning `undefined` when the API is absent
 *  (SSR/headless — REQ-ROBUST-01). Accessing it via `globalThis` rather than as a bare identifier is
 *  the SSR-safe pattern (`globalThis.matchMedia === matchMedia` in a browser) and is a live read: a
 *  bare reference in an imported module binds to whatever `matchMedia` was at instantiation under
 *  `bun test` + happy-dom, which is neither the production nor the test-controlled value. */
function getMatchMedia(): typeof globalThis.matchMedia | undefined {
  const mm = (globalThis as { matchMedia?: typeof globalThis.matchMedia }).matchMedia;
  return typeof mm === "function" ? mm : undefined;
}

/**
 * Resolve a stored {@link Theme} preference to the concrete appearance to apply.
 *
 * - `"dark"` / `"light"` → returned as-is.
 * - `"system"` → resolved from the OS via `prefers-color-scheme`, defaulting to **`"dark"`** when the
 *   OS reports *no* preference (REQ-THEME-01: dark is the default NOC appearance; `00 §3`).
 *
 * "No preference" is detected by querying both `(prefers-color-scheme: dark)` and
 * `(prefers-color-scheme: light)`: if neither matches, the environment has no signal → `"dark"`. A
 * single `dark` query cannot distinguish "prefers light" from "no preference", so both are queried.
 *
 * @param theme - The stored preference (`system` | `dark` | `light`).
 * @param mql - Optional pre-resolved `MediaQueryList` for `(prefers-color-scheme: dark)` (test seam /
 *   reuse of the subscribed list). When omitted, `matchMedia` is queried directly if available.
 * @returns The concrete `"dark" | "light"` appearance. Never throws; returns `"dark"` when
 *   `matchMedia` is unavailable (SSR/headless without the API) — REQ-ROBUST-01.
 */
export function resolveEffectiveTheme(theme: Theme, mql?: MediaQueryList): EffectiveTheme {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  // theme === "system"
  const mm = getMatchMedia();
  if (mm === undefined) return "dark"; // no API → default NOC appearance
  // A matchMedia that THROWS is treated as unavailable → default NOC appearance (REQ-ROBUST-01).
  // Under bun+happy-dom a closed window leaves `matchMedia` a function that throws when called
  // (see item 004 gotcha); the Shell effect must never surface that as an unhandled error.
  try {
    const prefersDark = (mql ?? mm("(prefers-color-scheme: dark)")).matches;
    if (prefersDark) return "dark";
    const prefersLight = mm("(prefers-color-scheme: light)").matches;
    return prefersLight ? "light" : "dark"; // neither → no preference → dark
  } catch {
    return "dark";
  }
}

/**
 * Apply the resolved appearance to the single document-root switch point (REQ-THEME-04): toggles the
 * `.dark` class on `<html>` (theme.css's dark tokens) and sets its `color-scheme`, so form controls
 * and scrollbars match. Re-themes the whole app via CSS cascade (§02). Idempotent; safe to call on
 * every signal change.
 *
 * @param effective - The concrete appearance from {@link resolveEffectiveTheme}.
 */
export function applyTheme(effective: EffectiveTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", effective === "dark");
  root.style.colorScheme = effective;
}

/**
 * Install the single document-root switch point (REQ-THEME-04). Called once by `<Shell/>`
 * (`06-app-shell.md`). Wires ONE `effect()` that maps `store.theme` / `store.density` to the two
 * attribute writes, plus a `matchMedia` subscription so a `system` preference tracks live OS changes
 * (REQ-THEME-02, REQ-A11Y-07). Returns nothing; tears down the effect and the media subscription on
 * unmount.
 *
 * @param store - The consumed AppStore (theme/density signals). Persistence is the store's own
 *   concern; this hook only *applies* state, never writes storage (§02 §3.3).
 */
export function useTheme(store: AppStore): void {
  useEffect(() => {
    const mm = getMatchMedia();
    let mql: MediaQueryList | undefined;
    try {
      mql = mm?.("(prefers-color-scheme: dark)");
    } catch {
      // A broken/closed-window implementation is equivalent to an unavailable API.
      mql = undefined;
    }

    // ONE effect: the whole-app switch point. Re-runs when theme or density signals change.
    const dispose = effect(() => {
      applyTheme(resolveEffectiveTheme(store.theme.value, mql));
      const search =
        store.route.value.query.kiosk === "1"
          ? "?kiosk=1"
          : typeof location !== "undefined"
            ? location.search
            : "";
      applyDensity(store.density.value, search);
    });

    // Live OS follow: only re-apply for `system`; explicit dark/light ignore OS changes.
    const onOsChange = (): void => {
      if (store.theme.peek() === "system") applyTheme(resolveEffectiveTheme("system", mql));
    };
    mql?.addEventListener("change", onOsChange);

    return () => {
      dispose();
      mql?.removeEventListener("change", onOsChange);
    };
  }, [store]);
}
