import type { ComponentProps } from "react";
import { cn } from "@/ui/lib/utils";

// @tailwindcss/typography's colour variables, pointed at theme tokens. The
// tokens already switch under `.dark`, so no `prose-invert` is needed.
const PROSE_TOKENS = cn(
  "[--tw-prose-body:var(--foreground)] [--tw-prose-headings:var(--foreground)]",
  "[--tw-prose-lead:var(--muted-foreground)] [--tw-prose-links:var(--primary)]",
  "[--tw-prose-bold:var(--foreground)] [--tw-prose-counters:var(--muted-foreground)]",
  "[--tw-prose-bullets:var(--muted-foreground)] [--tw-prose-hr:var(--border)]",
  "[--tw-prose-quotes:var(--foreground)] [--tw-prose-quote-borders:var(--border)]",
  "[--tw-prose-captions:var(--muted-foreground)] [--tw-prose-kbd:var(--foreground)]",
  "[--tw-prose-code:var(--foreground)] [--tw-prose-pre-code:var(--foreground)]",
  "[--tw-prose-pre-bg:var(--muted)] [--tw-prose-th-borders:var(--border)]",
  "[--tw-prose-td-borders:var(--border)]",
);

export interface ProseProps extends Omit<ComponentProps<"div">, "children" | "dangerouslySetInnerHTML"> {
  /**
   * Rendered HTML that the caller has ALREADY sanitized (e.g. markdown through
   * DOMPurify). This component does not sanitize: never pass untrusted HTML.
   */
  sanitizedHtml: string;
}

/**
 * Long-form rendered content (markdown documents) styled by
 * `@tailwindcss/typography`, with its palette mapped to theme tokens. Fenced
 * code inside picks up the highlight.js token theme.
 */
export function Prose({ sanitizedHtml, className, ...props }: ProseProps) {
  return (
    <div
      data-slot="prose"
      className={cn(
        "prose prose-sm max-w-none",
        PROSE_TOKENS,
        "prose-a:underline-offset-2 prose-code:font-mono prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:rounded-lg prose-pre:border",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      {...props}
    />
  );
}
