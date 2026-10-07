// src/client/a11y/announcer.ts — the singleton aria-live announcer region (REQ-A11Y-01, 05 §4).
//
// A single, shell-owned live region announces transient messages (Toast content, status-change
// notifications) to screen readers WITHOUT moving focus. The region is mounted once (by the shell,
// or lazily by the first `announce`) and matched by the fixed id below, so it survives HMR/test
// re-runs. Every DOM access is guarded so the module is a benign no-op under SSR / pre-mount (05 §1,
// §4.3) — no primitive throws for a missing DOM.
//
// `document` (and the frame scheduler) are read via `globalThis` at CALL time, never as bare
// identifiers: under `bun test` + happy-dom a bare `document` in an imported module binds to whatever
// window existed at module instantiation (a stale, closed window across test files), so the region
// would be appended to a document the test can no longer query. The live read mirrors `theme.ts`.

/** aria-live politeness. "polite" waits for a pause (default); "assertive" interrupts. */
export type Politeness = "polite" | "assertive";

/** Stable id of the singleton announcer root — the match key that guarantees one region. */
const ROOT_ID = "pulse-a11y-announcer";
/** Data attribute marking each nested sub-region by its politeness. */
const REGION_ATTR = "data-politeness";

/** Visually-hidden styling via off-screen CLIP (NOT display:none — display:none is not announced). */
const VISUALLY_HIDDEN =
  "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;" +
  "clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0";

/** Read the live `document` from `globalThis` at call time, or `undefined` when absent (SSR). */
function getDocument(): Document | undefined {
  return (globalThis as { document?: Document }).document;
}

/** Schedule `cb` on the next frame. Prefer the live window's `requestAnimationFrame` (via the
 *  document's `defaultView`, so it is never a closed happy-dom window's dead scheduler), then the
 *  global one, then `queueMicrotask`, then a synchronous call. If a `requestAnimationFrame` throws
 *  (a detached window does), fall through rather than propagate. */
function nextFrame(doc: Document, cb: () => void): void {
  const raf =
    doc.defaultView?.requestAnimationFrame?.bind(doc.defaultView) ??
    (globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number })
      .requestAnimationFrame;
  if (typeof raf === "function") {
    try {
      raf(() => cb());
      return;
    } catch {
      /* fall through to the microtask/synchronous fallbacks */
    }
  }
  const micro = (globalThis as { queueMicrotask?: (cb: () => void) => void }).queueMicrotask;
  if (typeof micro === "function") {
    micro(cb);
    return;
  }
  cb();
}

/**
 * Mount the singleton announcer region into `document.body` if not already present, and return it.
 * Idempotent: repeated calls return the existing region (matched by {@link ROOT_ID}). Returns `null`
 * when `document` (or `document.body`) is unavailable — never appends, never throws (05 §4.3).
 *
 * The region is visually hidden off-screen (clip, not display:none) and contains two nested live
 * regions: one `aria-live="polite"` `role="status"` and one `aria-live="assertive"` `role="alert"`,
 * both `aria-atomic="true"`.
 *
 * @returns The announcer root element, or `null` when `document` is unavailable (SSR).
 */
export function mountAnnouncer(): HTMLElement | null {
  const doc = getDocument();
  if (!doc || !doc.body) return null;

  const existing = doc.getElementById(ROOT_ID);
  if (existing) return existing;

  const root = doc.createElement("div");
  root.id = ROOT_ID;
  root.style.cssText = VISUALLY_HIDDEN;

  root.appendChild(makeRegion(doc, "polite", "status"));
  root.appendChild(makeRegion(doc, "assertive", "alert"));

  doc.body.appendChild(root);
  return root;
}

/** Build one nested live sub-region. */
function makeRegion(doc: Document, politeness: Politeness, role: "status" | "alert"): HTMLElement {
  const region = doc.createElement("div");
  region.setAttribute(REGION_ATTR, politeness);
  region.setAttribute("aria-live", politeness);
  region.setAttribute("role", role);
  region.setAttribute("aria-atomic", "true");
  return region;
}

/**
 * Announce `message` to assistive tech via the singleton region. Lazily mounts the region when
 * absent (so a call before the shell mounts still works — REQ-A11Y-01). Empty/whitespace-only
 * messages are ignored. No `document` → no-op. Never moves focus; never throws (05 §4.2/§4.3).
 *
 * The sub-region is cleared then, on the next frame, set to `message` — the clear-then-set forces AT
 * to re-read even a repeated string.
 *
 * @param message - The text to announce. Empty/whitespace-only messages are ignored.
 * @param politeness - Which live region to write into. Default "polite".
 */
export function announce(message: string, politeness: Politeness = "polite"): void {
  const doc = getDocument();
  if (!doc) return;
  if (message.trim() === "") return;

  // Re-resolve from the live DOM each call (no stale module-level refs — survives happy-dom window
  // resets between test files).
  let root = doc.getElementById(ROOT_ID);
  if (!root) root = mountAnnouncer();
  if (!root) return;

  const region = root.querySelector<HTMLElement>(`[${REGION_ATTR}="${politeness}"]`);
  if (!region) return;

  region.textContent = "";
  nextFrame(doc, () => {
    region.textContent = message;
  });
}
