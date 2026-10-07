import type { ReactNode } from "react";

/**
 * One catalogue group on the workbench. `id` is the in-page anchor; `catalogue`
 * is the group letter (A–G) the section covers, or omitted for the primitives.
 */
export interface WorkbenchSectionDef {
  id: string;
  title: string;
  catalogue?: string;
  Demo: () => ReactNode;
}

/** A labelled frame around one component state ("populated", "empty", …). */
export function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <figcaption className="text-xs font-medium text-muted-foreground">{label}</figcaption>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </figure>
  );
}

/** A placeholder for a group whose components have not landed yet. */
export function Pending({ what }: { what: string }) {
  return (
    <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
      Not built yet: {what}.
    </p>
  );
}
