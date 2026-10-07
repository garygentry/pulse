import type { ComponentProps, ReactNode } from "react";
import { LINK_CLASS } from "@/ui/lib/link";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";

export type SafeRouteLinkProps = Omit<ComponentProps<"a">, "href" | "children"> & {
  /**
   * Builds the in-app href, typically `encodeURIComponent`-ing route params. A
   * param that cannot be encoded (e.g. a lone surrogate) throws `URIError`.
   */
  build: () => string;
  children: ReactNode;
  /** Shown instead of the link when `build` throws `URIError`. */
  fallback?: ReactNode;
};

/**
 * An in-app route link whose href is built defensively. When `build` throws
 * `URIError`, it renders a non-interactive "Invalid entity link" marker (icon +
 * text) instead of a raw unsafe href, and the surrounding page keeps rendering.
 * Any other error is a bug and propagates to the nearest error boundary.
 *
 * It renders a plain `<a href>`: the shell routes same-origin anchor clicks
 * client-side, so the library stays independent of the router.
 */
export function SafeRouteLink({ build, children, fallback, className, ...props }: SafeRouteLinkProps) {
  let href: string;
  try {
    href = build();
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return (
      <span
        data-slot="safe-route-link"
        data-invalid=""
        className={cn("inline-flex items-center gap-1 text-muted-foreground", className)}
      >
        {fallback ?? (
          <>
            <Icon name="link-off" size={14} />
            <span>Invalid entity link</span>
          </>
        )}
      </span>
    );
  }
  return (
    <a data-slot="safe-route-link" href={href} className={cn(LINK_CLASS, className)} {...props}>
      {children}
    </a>
  );
}
