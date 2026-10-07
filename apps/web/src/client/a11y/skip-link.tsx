// a11y/skip-link.tsx — skip-to-content link (REQ-A11Y-01).
// Rendered first inside <Shell>; visually hidden until focused, then Enter/click moves focus to
// `#targetId`. An href="#{targetId}" anchor
// scrolls; the onClick focus() also moves focus (an href alone does not always move focus).
import type { ReactElement } from "react";

/** Props for SkipLink. */
export interface SkipLinkProps {
  /** Fragment id of the main content region to jump to. Default "main".
   *  The shell's content outlet MUST carry this id and be programmatically focusable
   *  (tabindex={-1}) so activation moves focus, not just scroll (06-app-shell.md). */
  targetId?: string;
  /** Visible/accessible link text. Default "Skip to content". */
  label?: string;
}

/**
 * Skip-to-content link. Rendered first inside <Shell>. Visually hidden until focused, then
 * Enter/click moves focus to `#targetId`.
 * Uses an href="#{targetId}" anchor plus an onClick that calls `focus()` on the target so the jump
 * both scrolls AND moves focus (an href alone scrolls but does not always move focus).
 */
export function SkipLink(props: SkipLinkProps): ReactElement {
  const targetId = props.targetId ?? "main";
  const label = props.label ?? "Skip to content";

  const onClick = (): void => {
    if (typeof document === "undefined") return;
    const el = document.getElementById(targetId);
    // Target is tabindex={-1} per the shell contract, so focus() moves focus into content.
    // Missing target: default anchor behavior (scroll to fragment, or no-op) applies — no throw.
    if (el !== null) el.focus();
  };

  return (
    <a
      data-slot="skip-link"
      className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-[3px] focus:ring-ring/50"
      href={"#" + targetId}
      onClick={onClick}
    >
      {label}
    </a>
  );
}
