// shell/CommandPalette.tsx — the shell's command palette (REQ-CMD-03, REQ-KIOSK-02).
//
// The Shell does not MOUNT it under kiosk, so kiosk has no palette and no Ctrl/Cmd-K shortcut. While
// mounted it registers mod+k (a11y shortcut registry) to toggle open, keeps the query, and ranks and
// caps results with the pure command index (`matchEntries`, REQ-SCALE-01). The dialog itself (the
// `@/ui` CommandPalette on cmdk) is a lazy chunk, prefetched when the browser is idle so the first
// Ctrl/Cmd-K opens at once; opening before the prefetch lands loads it then. Selecting navigates
// through the router, which carries kiosk/rotate; the dialog returns focus to the opener on close.
import type { ComponentType, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useComputed } from "@preact/signals-react";
import { useSignals } from "@preact/signals-react/runtime";

import type { AppStore } from "../store/index.js";
import type { PathRouter } from "../router.js";
import { registerShortcut } from "../a11y/index.js";
import { buildIndex, matchEntries, type PaletteEntry } from "./command-index.js";
import type { PaletteDialogProps } from "./PaletteDialog.js";

export interface CommandPaletteProps {
  /** The application store — its `snapshot`/`alerts` signals drive the reactive index. */
  store: AppStore;
  /** The router — `navigate` is called on selection (REQ-CMD-02). */
  router: PathRouter;
}

/** Idle-time prefetch with a timer fallback where `requestIdleCallback` is missing. */
function whenIdle(run: () => void): () => void {
  const w = globalThis as {
    requestIdleCallback?: (cb: () => void) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === "function" && typeof w.cancelIdleCallback === "function") {
    const id = w.requestIdleCallback(run);
    return () => w.cancelIdleCallback?.(id);
  }
  const timer = setTimeout(run, 1_000);
  return () => clearTimeout(timer);
}

export function CommandPalette({ store, router }: CommandPaletteProps): ReactElement | null {
  useSignals();
  const [open, setOpenState] = useState(false);
  const [query, setQuery] = useState("");
  const openRef = useRef(open);
  openRef.current = open;

  // The lazily loaded dialog. A failed load clears the in-flight mark so the next open retries.
  const [Dialog, setDialog] = useState<ComponentType<PaletteDialogProps> | null>(null);
  const loading = useRef(false);
  const load = useCallback((): void => {
    if (loading.current) return;
    loading.current = true;
    import("./PaletteDialog.js").then(
      (m) => setDialog(() => m.PaletteDialog),
      () => {
        // Nothing to show: drop the open state so the next Ctrl/Cmd-K opens (and retries) at once.
        loading.current = false;
        setOpenState(false);
      },
    );
  }, []);
  useEffect(() => whenIdle(load), [load]);

  // Opening starts from an empty query.
  const setOpen = useCallback(
    (next: boolean): void => {
      if (next) load();
      if (next && !openRef.current) setQuery("");
      setOpenState(next);
    },
    [load],
  );

  // Register mod+k for as long as the palette is MOUNTED. allowInInput so the toggle still fires when
  // focus is in a text field (including the palette's own, to close it).
  useEffect(
    () => registerShortcut("mod+k", () => setOpen(!openRef.current), { allowInInput: true }),
    [setOpen],
  );

  // Reactive index — rebuilds ONLY when store.snapshot / store.alerts change (buildIndex peeks, so the
  // dependency is established here, once, deliberately).
  const index = useComputed<PaletteEntry[]>(() => {
    void store.snapshot.value;
    void store.alerts.value;
    return buildIndex(store);
  });
  // Read (and so subscribe to) the index only while open: a closed palette must not rebuild it or
  // re-render on every live snapshot. Opening re-renders, and the computed catches up then.
  const entries = open ? index.value : null;
  const results = useMemo(() => (entries !== null ? matchEntries(entries, query) : []), [entries, query]);
  const navigate = useCallback((path: string) => router.navigate(path), [router]);

  if (Dialog === null) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      results={results}
      navigate={navigate}
      search={query}
      onSearchChange={setQuery}
    />
  );
}
