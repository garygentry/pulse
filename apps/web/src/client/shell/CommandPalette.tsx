// shell/CommandPalette.tsx — the shell's command palette (REQ-CMD-03, REQ-KIOSK-02).
//
// The Shell does not MOUNT it under kiosk, so kiosk has no palette and no Ctrl/Cmd-K shortcut. While
// mounted it registers mod+k (a11y shortcut registry) to toggle open, keeps the query, and ranks and
// caps results with the pure command index (`matchEntries`, REQ-SCALE-01). The dialog itself (the
// `@/ui` CommandPalette on cmdk) is a lazy chunk, prefetched when the browser is idle so the first
// Ctrl/Cmd-K opens at once; opening before the prefetch lands loads it then. Selecting navigates
// through the router, which carries kiosk/rotate; the dialog returns focus to the opener on close.
// Until the chunk lands an open palette is a small entry-side dialog: a loading state while the
// import is in flight, and an error state if it failed. Browsers cache a failed dynamic import for
// the life of the document (a second import() of the same chunk rejects without a request), so the
// error state's recovery is a page reload through the shared once-only `reloadOnce`, not an in-page
// re-import. A deploy that removed the chunk is also covered by live-state's version-skew reload.
import type { ComponentType, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useComputed } from "@preact/signals-react";
import { useSignals } from "@preact/signals-react/runtime";

import type { AppStore } from "../store/index.js";
import type { PathRouter } from "../router.js";
import { registerShortcut } from "../a11y/index.js";
// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { ErrorState } from "@/ui/patterns/error-state";
// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { LoadingState } from "@/ui/patterns/loading-state";
// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { Dialog as DialogRoot, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ui/primitives/dialog";
import { buildIndex, matchEntries, type PaletteEntry } from "./command-index.js";
import type { PaletteDialogProps } from "./PaletteDialog.js";

export interface CommandPaletteProps {
  /** The application store — its `snapshot`/`alerts` signals drive the reactive index. */
  store: AppStore;
  /** The router — `navigate` is called on selection (REQ-CMD-02). */
  router: PathRouter;
  /** The shared once-only reload (`LiveStateHandle.reloadOnce`): the chunk-failure state's action. */
  reloadOnce: () => void;
  /** Loads the palette's dialog chunk. Default: the lazy `./PaletteDialog.js` import. Tests inject a
   *  rejecting loader to drive the error state. */
  loadDialog?: () => Promise<ComponentType<PaletteDialogProps>>;
}

const loadPaletteDialog = (): Promise<ComponentType<PaletteDialogProps>> =>
  import("./PaletteDialog.js").then((m) => m.PaletteDialog);

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

export function CommandPalette({
  store,
  router,
  reloadOnce,
  loadDialog = loadPaletteDialog,
}: CommandPaletteProps): ReactElement | null {
  useSignals();
  const [open, setOpenState] = useState(false);
  const [query, setQuery] = useState("");
  const openRef = useRef(open);
  openRef.current = open;

  // The lazily loaded dialog, imported at most once: the in-flight mark is never cleared, because
  // the browser would only replay a failed import's rejection. A failure is recorded for the open
  // palette to show.
  const [Dialog, setDialog] = useState<ComponentType<PaletteDialogProps> | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const loading = useRef(false);
  const loadDialogRef = useRef(loadDialog);
  loadDialogRef.current = loadDialog;
  const load = useCallback((): void => {
    if (loading.current) return;
    loading.current = true;
    loadDialogRef.current().then(
      (component) => setDialog(() => component),
      () => setLoadFailed(true),
    );
  }, []);
  useEffect(() => whenIdle(load), [load]);

  // Opening starts from an empty query and records the opener: focus returns to it on close, from
  // the loading/error dialog or the palette, even when the palette replaces the loading dialog while
  // open (by then the loading dialog holds focus, so the palette cannot read the opener itself).
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const setOpen = useCallback(
    (next: boolean): void => {
      if (next) load();
      if (next && !openRef.current) {
        setQuery("");
        const active = globalThis.document?.activeElement;
        setOpener(active instanceof HTMLElement && active !== active.ownerDocument.body ? active : null);
      }
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

  if (Dialog === null) {
    return (
      <PaletteLoadDialog
        open={open}
        onOpenChange={setOpen}
        failed={loadFailed}
        onReload={reloadOnce}
        returnFocusTo={opener}
      />
    );
  }
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      results={results}
      navigate={navigate}
      search={query}
      onSearchChange={setQuery}
      returnFocusTo={opener}
    />
  );
}

/** The open palette before its chunk has loaded: a loading state, or an error state whose action
 *  reloads the page. Like the palette, it returns focus to the opener itself (a controlled Radix
 *  Dialog with no trigger would drop it on `<body>`). */
function PaletteLoadDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  failed: boolean;
  onReload: () => void;
  returnFocusTo: HTMLElement | null;
}): ReactElement {
  return (
    <DialogRoot open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        data-slot="command-palette-loader"
        onCloseAutoFocus={(event) => {
          const target = props.returnFocusTo;
          if (target === null || !target.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>Search views, hosts, services, and alerts</DialogDescription>
        </DialogHeader>
        {props.failed ? (
          <ErrorState
            title="The command palette could not be loaded."
            message="Check the connection to the Pulse server, then reload the page to try again."
            onRetry={props.onReload}
            retryLabel="Reload page"
          />
        ) : (
          <LoadingState label="Loading the command palette…" rows={2} />
        )}
      </DialogContent>
    </DialogRoot>
  );
}
