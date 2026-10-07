import { useId, type ElementType, type ReactNode } from "react";
import type { IconName } from "@/ui/lib/icons";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";

type LinkComponent = ElementType<{ href: string; className?: string; children?: ReactNode }>;

export interface LinkTileProps {
  title: ReactNode;
  description?: ReactNode;
  /** A curated icon name, or any decorative node (e.g. a service logo). */
  icon?: IconName | ReactNode;
  /** Top-right status (e.g. a StatusBadge). Must not be interactive. */
  status?: ReactNode;
  /** Footer facts (e.g. a FreshnessBadge). Must not be interactive. */
  meta?: ReactNode;
  /** The destination. Without it (or with `disabled`) the tile is a non-interactive `article`. */
  href?: string;
  /** Opens in a new tab (`target=_blank`, `rel=noopener noreferrer`), with an icon and an sr-only note. */
  external?: boolean;
  /** Link component for internal links (e.g. the router's link); defaults to `<a>`. */
  linkAs?: LinkComponent;
  /** Renders the tile inert and muted: no link, nothing focusable. */
  disabled?: boolean;
  /** Why the tile is disabled; shown in place of `description`'s footer slot. */
  disabledReason?: ReactNode;
  className?: string;
}

/**
 * A whole-card link: a single `<a>` wrapping icon, title, description, status
 * and meta, so there is exactly one tab stop and nothing interactive nested
 * inside. Disabled tiles are a plain `article` (no fake focusable element).
 */
export function LinkTile({
  title,
  description,
  icon,
  status,
  meta,
  href,
  external = false,
  linkAs: LinkAs = "a",
  disabled = false,
  disabledReason,
  className,
}: LinkTileProps) {
  const inert = disabled || href === undefined;
  const base = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const ids = { title: `${base}-title`, note: `${base}-note`, description: `${base}-desc`, status: `${base}-status`, meta: `${base}-meta` };
  // The link's name is its title (plus the new-tab note); everything else describes it.
  const labelledBy = external ? `${ids.title} ${ids.note}` : ids.title;
  const describedBy =
    [description != null && ids.description, status != null && ids.status, meta != null && ids.meta]
      .filter(Boolean)
      .join(" ") || undefined;
  const body = (
    <>
      <div className="flex items-start gap-3">
        {icon != null ? (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            {typeof icon === "string" ? <Icon name={icon} size={18} /> : icon}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 font-medium">
            <span id={ids.title} className="truncate">
              {title}
            </span>
            {external && !inert ? (
              <>
                <Icon name="external-link" size={14} className="shrink-0 text-muted-foreground" />
                <span id={ids.note} className="sr-only">
                  (opens in new tab)
                </span>
              </>
            ) : null}
          </span>
          {description != null ? <span id={ids.description} className="line-clamp-2 text-sm text-muted-foreground">{description}</span> : null}
        </div>
        {status != null ? (
          <span id={ids.status} className="shrink-0">
            {status}
          </span>
        ) : null}
      </div>
      {meta != null || (disabled && disabledReason != null) ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground tabular-nums">
          {disabled && disabledReason != null ? <span>{disabledReason}</span> : null}
          {meta != null ? <span id={ids.meta}>{meta}</span> : null}
        </div>
      ) : null}
    </>
  );

  const tileClass = cn("block rounded-lg border bg-card p-4 text-sm text-card-foreground", className);

  if (inert) {
    return (
      <article data-slot="link-tile" data-disabled={disabled ? "" : undefined} className={cn(tileClass, disabled && "opacity-60")}>
        {body}
      </article>
    );
  }

  const linkClass = cn(
    tileClass,
    "transition-colors outline-none hover:border-ring/60 hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50",
  );
  if (external) {
    return (
      <a
        data-slot="link-tile"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        className={linkClass}
      >
        {body}
      </a>
    );
  }
  return (
    <LinkAs href={href} className={linkClass} {...{ "data-slot": "link-tile", "aria-labelledby": labelledBy, "aria-describedby": describedBy }}>
      {body}
    </LinkAs>
  );
}
