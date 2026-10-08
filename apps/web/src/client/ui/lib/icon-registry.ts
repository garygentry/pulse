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
 * What a lookup found: the component; `"pending"` (not a shell icon and the
 * full set has not loaded yet, so it may still exist); `"unavailable"` (the
 * same, but the last load of the full set failed and a retry is due); or
 * `"unknown"` (the full set has loaded and does not have it).
 */
export type IconLookup = LucideIcon | "pending" | "unavailable" | "unknown";

export interface IconRegistry {
  lookup(name: string): IconLookup;
  /** Register the full curated set; lookups then never return `"pending"`/`"unavailable"`. */
  registerFullSet(icons: Readonly<Record<string, LucideIcon>>): void;
  /** Record that loading the full set failed (until it registers). */
  markUnavailable(): void;
  /** Subscribe to changes (for `useSyncExternalStore`). */
  subscribe(listener: () => void): () => void;
  /** Changes on every change (the `useSyncExternalStore` snapshot). */
  version(): number;
}

export function createIconRegistry(seed: Readonly<Record<string, LucideIcon>>): IconRegistry {
  const icons = new Map<string, LucideIcon>(Object.entries(seed));
  const listeners = new Set<() => void>();
  let state: "pending" | "unavailable" | "full" = "pending";
  let version = 0;
  const notify = (): void => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };
  return {
    lookup(name) {
      return icons.get(name) ?? (state === "full" ? "unknown" : state);
    },
    registerFullSet(set) {
      if (state === "full") return;
      for (const [name, component] of Object.entries(set)) icons.set(name, component);
      state = "full";
      notify();
    },
    markUnavailable() {
      if (state !== "pending") return;
      state = "unavailable";
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}

/** Delays before each retry after a failed load of the full set; after the last, it waits for the
 *  next call (a navigation, or an icon asking). */
export const ICON_LOAD_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

export interface IconSetLoader {
  /** Load the full set once and register it. Rejects when this attempt fails; a retry is scheduled. */
  load(): Promise<void>;
}

/**
 * Loads the full set into `registry`. A failed load marks the registry unavailable (icons render
 * the fallback glyph) and retries on a bounded backoff; any later call also retries at once. When a
 * load succeeds, every icon fills in.
 */
export function createIconSetLoader(
  registry: IconRegistry,
  importSet: () => Promise<{ ICONS: Readonly<Record<string, LucideIcon>> }>,
  schedule: (retry: () => void, ms: number) => unknown = (retry, ms) => setTimeout(retry, ms),
): IconSetLoader {
  let loading: Promise<void> | null = null;
  let loaded = false;
  let failures = 0;
  let retryPending = false;
  const load = (): Promise<void> => {
    if (loaded) return Promise.resolve();
    loading ??= importSet().then(
      (m) => {
        loaded = true;
        registry.registerFullSet(m.ICONS);
      },
      (error: unknown) => {
        loading = null;
        registry.markUnavailable();
        const delay = ICON_LOAD_RETRY_DELAYS_MS[failures];
        failures += 1;
        if (delay !== undefined && !retryPending) {
          retryPending = true;
          schedule(() => {
            retryPending = false;
            load().catch(() => {});
          }, delay);
        }
        throw error;
      },
    );
    return loading;
  };
  return { load };
}

/** The app's registry. */
export const iconRegistry = createIconRegistry(SHELL_ICONS);

/**
 * A browser keeps a failed module fetch in its module map for the page's lifetime, so importing the
 * same chunk again rejects without a request. Chromium and Firefox name the chunk's URL in the
 * error; a retry imports that URL with a fresh query, which is a new module. Where the error has no
 * URL (Safari), the retry repeats the import and icons keep the fallback glyph until a reload.
 */
const CHUNK_URL_IN_ERROR = /\bhttps?:\/\/[^\s'"]+?\.js\b/;
let chunkUrl: string | null = null;
let attempt = 0;
async function importIconSet(): Promise<{ ICONS: Readonly<Record<string, LucideIcon>> }> {
  attempt += 1;
  try {
    if (chunkUrl === null) return await import("@/ui/lib/icons");
    return (await import(/* @vite-ignore */ `${chunkUrl}?retry=${attempt}`)) as typeof import("@/ui/lib/icons");
  } catch (error) {
    chunkUrl ??= CHUNK_URL_IN_ERROR.exec(String(error))?.[0] ?? null;
    throw error;
  }
}

const loader = createIconSetLoader(iconRegistry, importIconSet);

/** Load the full curated set (a lazy chunk) once and register it; failures retry (see above). */
export function loadIconSet(): Promise<void> {
  return loader.load();
}
