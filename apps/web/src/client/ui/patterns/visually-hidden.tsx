import type { ComponentProps } from "react";
import { cn } from "@/ui/lib/utils";

export type VisuallyHiddenProps = Omit<ComponentProps<"span">, "ref"> & {
  /** Render as a block element, e.g. for a live region that holds a sentence. */
  as?: "span" | "div" | "p";
};

/**
 * Text for assistive technology only (Tailwind `sr-only`). Use it for live
 * regions (`aria-live`), extra link context ("(opens in new tab)") and any label
 * whose visible form is an icon. Plain `className="sr-only"` is fine for one-offs.
 */
export function VisuallyHidden({ as: Tag = "span", className, ...props }: VisuallyHiddenProps) {
  return <Tag data-slot="visually-hidden" className={cn("sr-only", className)} {...props} />;
}
