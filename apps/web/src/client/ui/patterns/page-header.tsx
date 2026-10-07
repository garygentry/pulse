import { Fragment, isValidElement, type ReactNode } from "react";
import { usePageHeadingId } from "@/ui/hooks/use-page-heading-id";
import { cn } from "@/ui/lib/utils";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/ui/primitives/breadcrumb";

/** One breadcrumb step; the last one is the current page and takes no `href`. */
export interface BreadcrumbEntry {
  label: string;
  href?: string;
}

export interface PageHeaderProps {
  /** The page title, rendered as the page's single heading. */
  title: ReactNode;
  /**
   * The heading id. Defaults to one derived from a string `title`
   * (`usePageHeadingId(title)`), or a generated one for a ReactNode title.
   */
  id?: string;
  description?: ReactNode;
  /** Trailing status slot beside the title (FreshnessBadge, StatusBadge, …). */
  meta?: ReactNode;
  /** Page-level actions, right-aligned (wrap below on narrow screens). */
  actions?: ReactNode;
  /** Breadcrumb trail above the title: entries, or a composed `Breadcrumb`. */
  breadcrumbs?: readonly BreadcrumbEntry[] | ReactNode;
  /**
   * Heading level. Pages leave it at 1 (the single `h1`); a non-page context
   * (the `/_ui` workbench, a dialog) may demote it so it doesn't compete with
   * the real page heading.
   */
  level?: 1 | 2 | 3;
  className?: string;
}

/**
 * The top of a page: optional breadcrumbs, the page heading with a stable id,
 * a `meta` status slot, a description and right-aligned actions. It renders the
 * heading, not the surrounding `section`: the page wraps it in
 * `<section aria-labelledby={usePageHeadingId(title)}>`.
 */
export function PageHeader({
  title,
  id,
  description,
  meta,
  actions,
  breadcrumbs,
  level = 1,
  className,
}: PageHeaderProps) {
  const derivedId = usePageHeadingId(typeof title === "string" ? title : undefined);
  const headingId = id ?? derivedId;
  const Heading = `h${level}` as const;

  return (
    <header data-slot="page-header" className={cn("flex flex-col gap-2", className)}>
      {breadcrumbs != null && <PageBreadcrumbs breadcrumbs={breadcrumbs} />}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Heading id={headingId} className="text-2xl font-semibold tracking-tight">
              {title}
            </Heading>
            {meta != null && (
              <div data-slot="page-header-meta" className="flex flex-wrap items-center gap-2">
                {meta}
              </div>
            )}
          </div>
          {description != null && (
            <p data-slot="page-header-description" className="max-w-prose text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions != null && (
          <div data-slot="page-header-actions" className="flex flex-wrap items-center gap-2">
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}

function isEntryList(value: unknown): value is readonly BreadcrumbEntry[] {
  return Array.isArray(value) && value.every((v) => !isValidElement(v) && typeof v === "object" && v !== null && "label" in v);
}

function PageBreadcrumbs({ breadcrumbs }: { breadcrumbs: readonly BreadcrumbEntry[] | ReactNode }) {
  if (!isEntryList(breadcrumbs)) return <>{breadcrumbs}</>;
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {breadcrumbs.map((entry, index) => {
          const last = index === breadcrumbs.length - 1;
          return (
            <Fragment key={`${index}-${entry.label}`}>
              <BreadcrumbItem>
                {last || entry.href === undefined ? (
                  <BreadcrumbPage>{entry.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink href={entry.href}>{entry.label}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!last && <BreadcrumbSeparator />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
