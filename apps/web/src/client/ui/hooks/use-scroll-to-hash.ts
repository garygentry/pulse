import { useEffect } from "react";
import { focusElement } from "@/ui/lib/dom";

export interface UseScrollToHashOptions {
  /** Also move focus to the target, so keyboard and screen-reader users land there. Default `true`. */
  focus?: boolean;
  /** `scrollIntoView` block alignment. Default `"start"`. */
  block?: ScrollLogicalPosition;
}

/** The element id named by a URL fragment (`#a%20b` → `a b`), or null. Never throws. */
export function hashTargetId(hash: string): string | null {
  const raw = hash.replace(/^#/, "");
  if (raw === "") return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * On entry, scroll the element named by the URL fragment into view and focus
 * it. The router matches on pathname only and does not do this natively. Runs
 * once on mount, one animation frame late so the page's sections have rendered.
 * A target that is not focusable gets a temporary `tabindex="-1"` so it can take focus.
 */
export function useScrollToHash(options: UseScrollToHashOptions = {}): void {
  const { focus = true, block = "start" } = options;

  useEffect(() => {
    const id = hashTargetId(window.location.hash);
    if (id === null) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(id);
      if (target === null) return;
      target.scrollIntoView?.({ block });
      if (focus) focusElement(target);
    });
    return () => cancelAnimationFrame(frame);
    // Entry only: later hash changes are in-page jumps the browser already handles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
