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
// While the import is in flight, keys typed into the open palette are not lost: a capture-phase
// listener (attached synchronously as Ctrl/Cmd-K opens it) buffers printable input, including
// Alt/AltGr/Option characters and pasted text, into the query, so it shows in the search field,
// caret at the end, when the dialog mounts. Backspace edits the buffer, Escape closes, navigation
// keys are held off the page; F-keys and Ctrl/Cmd chords (Ctrl/Cmd-K, reload, new tab) pass through.
// A failed import drops the buffer and stops listening, so the error state's Reload button gets
// Tab/Enter/Space.
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
  const loaded = useRef(false);
  const failed = useRef(false);

  // Key buffering while the chunk loads (see the header). `stopBuffering` is idempotent.
  const bufferStop = useRef<(() => void) | null>(null);
  const stopBuffering = useCallback((): void => {
    bufferStop.current?.();
    bufferStop.current = null;
  }, []);
  const closeRef = useRef<() => void>(() => {});
  const startBuffering = useCallback((): void => {
    if (bufferStop.current !== null || loaded.current || failed.current) return;
    const doc = (globalThis as { document?: Document }).document;
    if (doc === undefined) return;
    const append = (text: string): void => setQuery((q) => q + text);
    const swallow = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      // IME composition: nothing sensible to buffer; keep it out of any page field.
      if (event.isComposing || event.key === "Process" || event.keyCode === 229) return swallow(event);
      // Ctrl/Cmd chords pass: Ctrl/Cmd-K closes, browser shortcuts work, paste fires its own event.
      // Ctrl+Alt is AltGr on Windows, so it is character input, not a chord.
      if (event.metaKey || (event.ctrlKey && !event.altKey)) return;
      if ([...event.key].length === 1) {
        swallow(event);
        append(event.key);
        return;
      }
      switch (event.key) {
        case "Escape":
          swallow(event);
          closeRef.current();
          return;
        case "Backspace":
          swallow(event);
          setQuery((q) => [...q].slice(0, -1).join(""));
          return;
        case "Enter":
        case "Tab":
        case "Dead":
        case "Delete":
        case "ArrowUp":
        case "ArrowDown":
        case "ArrowLeft":
        case "ArrowRight":
        case "Home":
        case "End":
        case "PageUp":
        case "PageDown":
          swallow(event);
          return;
        default:
          // F-keys, modifiers, media keys: the browser's.
          return;
      }
    };
    const onPaste = (event: ClipboardEvent): void => {
      swallow(event);
      const text = event.clipboardData?.getData("text") ?? "";
      if (text !== "") append(text.replace(/\s+/g, " "));
    };
    // Belt and braces: any text insertion that slipped past keydown stays out of page fields.
    const onBeforeInput = (event: Event): void => swallow(event);
    doc.addEventListener("keydown", onKeyDown, true);
    doc.addEventListener("paste", onPaste, true);
    doc.addEventListener("beforeinput", onBeforeInput, true);
    bufferStop.current = () => {
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("paste", onPaste, true);
      doc.removeEventListener("beforeinput", onBeforeInput, true);
    };
  }, []);
  useEffect(() => stopBuffering, [stopBuffering]);

  const load = useCallback((): void => {
    if (loading.current) return;
    loading.current = true;
    loadDialogRef.current().then(
      (component) => {
        // Buffering stops once the dialog has mounted and focused its field (the effect below).
        loaded.current = true;
        setDialog(() => component);
      },
      () => {
        // Nothing to type into: drop the buffer, and let the error state have the keyboard.
        failed.current = true;
        stopBuffering();
        setQuery("");
        setLoadFailed(true);
      },
    );
  }, [stopBuffering]);
  useEffect(() => whenIdle(load), [load]);
  // Child effects (Radix's focus into the search field) run first, so keys typed from here on reach it.
  useEffect(() => {
    if (Dialog !== null) stopBuffering();
  }, [Dialog, stopBuffering]);

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
        // Synchronously, so the keys typed in the frame before the loading dialog renders are kept.
        startBuffering();
      }
      if (!next) stopBuffering();
      setOpenState(next);
    },
    [load, startBuffering, stopBuffering],
  );
  closeRef.current = () => setOpen(false);

  // Register mod+k for as long as the palette is MOUNTED. allowInInput so the toggle still fires when
  // focus is in a text field (including the palette's own, to close it).
  useEffect(
    () => registerShortcut("mod+k", () => setOpen(!openRef.current), {
        allowInInput: true,
        allowDefaultPrevented: true,
      }),
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
  // A failure while open: focus sat on the dialog itself (the loading state has no control), so move
  // it to the Reload button, the one thing to do here.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.failed) return;
    const content = contentRef.current;
    const active = content?.ownerDocument.activeElement ?? null;
    if (content === null || (active !== content && active !== content.ownerDocument.body)) return;
    content.querySelector<HTMLElement>("[data-slot=error-state] button")?.focus();
  }, [props.failed]);
  return (
    <DialogRoot open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        ref={contentRef}
        data-slot="command-palette-loader"
        onCloseAutoFocus={(event) => {
          // Unmounted while still open: the loaded palette replaced it and already holds focus (with
          // any buffered text, caret at the end). Moving focus away now would make the palette's
          // focus trap pull it back with the field's text all selected, so the next key replaced it.
          if (props.open) {
            event.preventDefault();
            return;
          }
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
