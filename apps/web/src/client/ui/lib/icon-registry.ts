/**
 * Where `<Icon>` looks names up. It starts with the shell's icons
 * (`icons-shell.ts`, on the initial route) and gains the full curated set
 * (`icons.ts`) when that lazy chunk loads. `ViewHost` loads it alongside every
 * view chunk, so a view renders with its icons already registered; importing
 * `icons.ts` (the `@/ui` barrel does, so tests do) registers it synchronously.
 */
import type { LucideIcon } from "lucide-react";
import { SHELL_ICONS } from "@/ui/lib/icons-shell";

/**
 * What a lookup found: the component, `"pending"` (not a shell icon and the full
 * set has not loaded, so it may still exist), or `"unknown"` (the full set has
 * loaded and does not have it).
 */
export type IconLookup = LucideIcon | "pending" | "unknown";

export interface IconRegistry {
  lookup(name: string): IconLookup;
  /** Register the full curated set; lookups then never return `"pending"`. */
  registerFullSet(icons: Readonly<Record<string, LucideIcon>>): void;
  /** Subscribe to registration (for `useSyncExternalStore`). */
  subscribe(listener: () => void): () => void;
  /** Changes on every registration (the `useSyncExternalStore` snapshot). */
  version(): number;
}

export function createIconRegistry(seed: Readonly<Record<string, LucideIcon>>): IconRegistry {
  const icons = new Map<string, LucideIcon>(Object.entries(seed));
  const listeners = new Set<() => void>();
  let full = false;
  let version = 0;
  return {
    lookup(name) {
      return icons.get(name) ?? (full ? "unknown" : "pending");
    },
    registerFullSet(set) {
      if (full) return;
      for (const [name, component] of Object.entries(set)) icons.set(name, component);
      full = true;
      version += 1;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}

/** The app's registry. */
export const iconRegistry = createIconRegistry(SHELL_ICONS);

let loading: Promise<void> | null = null;

/** Load the full curated set (a lazy chunk) once and register it. A failed load can be retried. */
export function loadIconSet(): Promise<void> {
  loading ??= import("@/ui/lib/icons").then(
    (m) => iconRegistry.registerFullSet(m.ICONS),
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}
