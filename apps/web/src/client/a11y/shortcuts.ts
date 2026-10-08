// src/client/a11y/shortcuts.ts — the hand-rolled keyboard-shortcut registry (REQ-A11Y-02, 05 §6).
//
// A small global registry mapping normalized key combos to handlers, backing Ctrl/Cmd-K (opens the
// command palette, 07) and any view-registered shortcuts. A SINGLE document-level keydown listener
// normalizes each event to a canonical combo string and dispatches to matching registrations, in
// registration order. Every DOM access is guarded so the module is a benign no-op under SSR /
// pre-mount (05 §1, §6.3) — nothing throws for a missing DOM, and `register` still returns a
// callable no-op disposer.

// ui-deep-import: entry code; the barrel would pull lazy-only @/ui modules into the entry
import { isTextEntryTarget } from "@/ui/lib/dom";

/** A normalized key-combo string, case-insensitive on the key. Modifiers in a fixed order:
 *  "mod" (Cmd on macOS, Ctrl elsewhere), "ctrl", "alt", "shift", then the key. */
export type KeyCombo = string;

/** A shortcut handler. Receives the originating event. */
export type ShortcutHandler = (event: KeyboardEvent) => void;

/** Options per registration. */
export interface ShortcutOptions {
  /** When true (default), the registry calls `event.preventDefault()` before invoking the handler. */
  preventDefault?: boolean;
  /** When false (default), the shortcut does NOT fire while focus is in a text field (text-like
   *  input, textarea, select or contenteditable). */
  allowInInput?: boolean;
}

/** A resolved registration held internally. */
interface Registration {
  combo: string;
  handler: ShortcutHandler;
  preventDefault: boolean;
  allowInInput: boolean;
}

/** Read the live `document` from `globalThis` at call time, or `undefined` when absent (SSR). A bare
 *  `document` in an imported module would bind to a stale window under `bun test` + happy-dom, so the
 *  listener would attach to a document the test no longer dispatches on (mirrors `theme.ts`). */
function getDocument(): Document | undefined {
  return (globalThis as { document?: Document }).document;
}

/** Every distinct live `document` the app might dispatch keydowns from: the `globalThis.document`
 *  AND the module's bare `document` binding. In a real browser these are the SAME object, so this
 *  yields one document. Under `bun test` + happy-dom they can DIVERGE across files — `globalThis`
 *  is reassigned to each file's window while a bare binding sticks to the first-installed one, and a
 *  component may render into (and a test may dispatch on) either. Listening on both means the
 *  registry hears the shortcut regardless of which window the app tree actually lives in. */
function liveDocuments(): Document[] {
  const docs: Document[] = [];
  const global = getDocument();
  if (global) docs.push(global);
  const bare = typeof document !== "undefined" ? document : undefined;
  if (bare && !docs.includes(bare)) docs.push(bare);
  return docs;
}

/** Detect macOS via `navigator.platform` (or `navigator.userAgentData?.platform`), guarding for a
 *  missing `navigator`. Read at CALL time so a happy-dom / SSR swap is respected. */
function isMac(): boolean {
  const nav = (
    globalThis as {
      navigator?: { platform?: string; userAgentData?: { platform?: string } };
    }
  ).navigator;
  if (!nav) return false;
  const platform = nav.platform ?? nav.userAgentData?.platform ?? "";
  return platform.includes("Mac");
}

/** Expand a registered combo to canonical tokens: modifiers in order meta,ctrl,alt,shift then key.
 *  "mod" resolves to "meta" on macOS else "ctrl"; literal "ctrl"/"alt"/"shift"/"meta" pass through. */
function normalizeCombo(combo: KeyCombo): string {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p !== "");

  const mac = isMac();
  let meta = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key = "";

  for (const part of parts) {
    switch (part) {
      case "mod":
        if (mac) meta = true;
        else ctrl = true;
        break;
      case "meta":
      case "cmd":
      case "command":
        meta = true;
        break;
      case "ctrl":
      case "control":
        ctrl = true;
        break;
      case "alt":
      case "option":
        alt = true;
        break;
      case "shift":
        shift = true;
        break;
      default:
        key = part;
        break;
    }
  }
  return joinTokens(meta, ctrl, alt, shift, key);
}

/** Normalize a live keyboard event to the same canonical form. */
function normalizeEvent(event: KeyboardEvent): string {
  return joinTokens(
    event.metaKey,
    event.ctrlKey,
    event.altKey,
    event.shiftKey,
    event.key.toLowerCase(),
  );
}

/** Join modifier flags + key into the canonical "meta+ctrl+alt+shift+key" form. */
function joinTokens(
  meta: boolean,
  ctrl: boolean,
  alt: boolean,
  shift: boolean,
  key: string,
): string {
  const tokens: string[] = [];
  if (meta) tokens.push("meta");
  if (ctrl) tokens.push("ctrl");
  if (alt) tokens.push("alt");
  if (shift) tokens.push("shift");
  if (key !== "") tokens.push(key);
  return tokens.join("+");
}

/** True when focus is currently in a text field: a text-like input, textarea, select (its type-ahead
 *  owns printable keys) or contenteditable — the shared `@/ui` text-entry guard. */
function isInInput(): boolean {
  const doc = getDocument();
  if (!doc) return false;
  return isTextEntryTarget(doc.activeElement);
}

/**
 * The keyboard-shortcut registry. A module-level singleton instance backs `registerShortcut`; the
 * class is exported so the shell can own an instance and tests can construct an isolated one.
 */
export class ShortcutRegistry {
  private registrations: Registration[] = [];
  private started = false;
  /** Every document the keydown listener is attached to, so `stop()` detaches from each. Usually one
   *  (real browser); more only under the bun+happy-dom multi-window test hazard (see liveDocuments). */
  private readonly boundDocs = new Set<Document>();
  private readonly listener = (event: KeyboardEvent): void => this.handleKeydown(event);

  /** Attach the single keydown listener to every live document not already bound. No-op when no
   *  `document` is available (SSR). Idempotent per document, and safe to call repeatedly — each
   *  `register` calls it so a newly-installed test window (a diverged `globalThis.document`) is
   *  picked up without dropping the previously-bound one (mirrors the theme.ts stale-window hazard). */
  start(): void {
    for (const doc of liveDocuments()) {
      if (this.boundDocs.has(doc)) continue;
      try {
        doc.addEventListener("keydown", this.listener as EventListener);
        this.boundDocs.add(doc);
      } catch {
        /* a closed happy-dom window may reject listeners — best-effort */
      }
    }
    if (this.boundDocs.size > 0) this.started = true;
  }

  /** Detach the listener from every bound document and clear all registrations. */
  stop(): void {
    for (const doc of this.boundDocs) {
      try {
        doc.removeEventListener("keydown", this.listener as EventListener);
      } catch {
        /* best-effort — the document may be a closed happy-dom window */
      }
    }
    this.boundDocs.clear();
    this.started = false;
    this.registrations = [];
  }

  /**
   * Register `handler` for `combo`. Lazily arms the listener if not started. Returns an idempotent
   * disposer that removes exactly this registration (safe to call twice, and after `stop()`). No
   * `document` → still returns a callable no-op disposer; never throws.
   */
  register(combo: KeyCombo, handler: ShortcutHandler, options?: ShortcutOptions): () => void {
    const registration: Registration = {
      combo: normalizeCombo(combo),
      handler,
      preventDefault: options?.preventDefault ?? true,
      allowInInput: options?.allowInInput ?? false,
    };
    this.registrations.push(registration);
    // Always (re)check the live document — start() is idempotent for the same document but re-binds
    // if the document changed since the last attach (test-isolation robustness).
    this.start();

    let disposed = false;
    return (): void => {
      if (disposed) return;
      disposed = true;
      const idx = this.registrations.indexOf(registration);
      if (idx !== -1) this.registrations.splice(idx, 1);
    };
  }

  private handleKeydown(event: KeyboardEvent): void {
    const combo = normalizeEvent(event);
    // Snapshot: a disposer/register from within a handler must not perturb this dispatch.
    const matches = this.registrations.filter((r) => r.combo === combo);
    for (const registration of matches) {
      if (!registration.allowInInput && isInInput()) continue;
      if (registration.preventDefault) event.preventDefault();
      try {
        registration.handler(event);
      } catch (err) {
        console.error("[a11y/shortcuts] handler threw", err);
      }
    }
  }
}

/** Lazily-constructed module-level singleton backing `registerShortcut`. */
let sharedRegistry: ShortcutRegistry | null = null;

function getSharedRegistry(): ShortcutRegistry {
  if (sharedRegistry === null) sharedRegistry = new ShortcutRegistry();
  return sharedRegistry;
}

/**
 * Register a shortcut on the shared singleton registry (used by the palette and views). The
 * listener is started on first `register`.
 *
 * @returns A disposer function that unregisters this shortcut.
 */
export function registerShortcut(
  combo: KeyCombo,
  handler: ShortcutHandler,
  options?: ShortcutOptions,
): () => void {
  return getSharedRegistry().register(combo, handler, options);
}
