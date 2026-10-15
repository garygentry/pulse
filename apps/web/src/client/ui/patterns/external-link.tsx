import type { ComponentProps } from "react";
import { LINK_CLASS } from "@/ui/lib/link";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";
import { VisuallyHidden } from "@/ui/patterns/visually-hidden";

export type ExternalLinkProps = Omit<ComponentProps<"a">, "target" | "rel"> & {
  href: string;
  /** Show the trailing external-link glyph (default true). The sr text is always present. */
  showIcon?: boolean;
  /**
   * Leave out the inline text-link look, for an anchor its host styles (a sidebar menu button
   * rendering it `asChild`). The new-tab semantics, glyph and sr text stay.
   */
  plain?: boolean;
};

/**
 * A link that opens in a new tab: `target="_blank" rel="noopener noreferrer"`,
 * a trailing external glyph, and a visually hidden "(opens in new tab)" so the
 * accessible name warns about the context change.
 */
export function ExternalLink({ children, showIcon = true, plain = false, className, ...props }: ExternalLinkProps) {
  return (
    <a
      data-slot="external-link"
      target="_blank"
      rel="noopener noreferrer"
      className={plain ? className : cn(LINK_CLASS, "inline-flex items-center gap-1", className)}
      {...props}
    >
      {children}
      {showIcon ? <Icon name="external-link" size={14} className="shrink-0" /> : null}
      <VisuallyHidden> (opens in new tab)</VisuallyHidden>
    </a>
  );
}
