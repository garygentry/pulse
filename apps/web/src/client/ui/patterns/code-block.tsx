import { useId, type CSSProperties, type ReactNode } from "react";
import { useCopyToClipboard } from "@/ui/hooks/use-copy-to-clipboard";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";
import { Button } from "@/ui/primitives/button";

export interface CodeBlockProps {
  /** The source text. Always what the copy button copies. */
  code: string;
  /**
   * Pre-highlighted markup for `code`, e.g. highlight.js output. It is injected as
   * HTML, so it must be escaped token markup (highlight.js escapes its input) —
   * never raw user HTML. Omit it to render `code` as plain text.
   */
  highlightedHtml?: string;
  /** Language token; shown in the toolbar and set as `language-*` on the `code` element. */
  language?: string;
  /** Visible caption (file name, command, …); becomes the figure's accessible name. */
  caption?: ReactNode;
  /** Show the copy button (default true). */
  copy?: boolean;
  /** Soft-wrap long lines instead of scrolling horizontally. */
  wrap?: boolean;
  /** Cap the block's height (CSS length or px) and scroll beyond it. */
  maxHeight?: string | number;
  className?: string;
}

const COPY_TEXT = { idle: "Copy", copied: "Copied", failed: "Copy failed" } as const;
const COPY_STATUS = { idle: "", copied: "Copied to clipboard", failed: "Could not copy to clipboard" } as const;

/**
 * A `figure` holding a code listing, with an optional `figcaption`, a language
 * label and a copy button. Token colours come from `styles/hljs.css`, mapped to
 * theme tokens for light and dark. The scrolling `pre` is keyboard-focusable.
 */
export function CodeBlock({
  code,
  highlightedHtml,
  language,
  caption,
  copy = true,
  wrap = false,
  maxHeight,
  className,
}: CodeBlockProps) {
  const captionId = useId();
  const { state, copy: copyText } = useCopyToClipboard();
  const hasToolbar = language !== undefined || copy;
  const style: CSSProperties | undefined = maxHeight === undefined ? undefined : { maxHeight };

  return (
    <figure
      data-slot="code-block"
      aria-labelledby={caption !== undefined ? captionId : undefined}
      className={cn(
        "m-0 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-lg border bg-muted text-foreground",
        className,
      )}
    >
      {caption !== undefined ? (
        <figcaption
          id={captionId}
          className={cn(
            "col-start-1 row-start-1 flex min-w-0 items-center border-b px-3 py-1.5 font-mono text-xs text-muted-foreground",
            !hasToolbar && "col-span-2",
          )}
        >
          <span className="truncate">{caption}</span>
        </figcaption>
      ) : null}
      {hasToolbar ? (
        <div
          className={cn(
            "col-start-2 row-start-1 flex items-center justify-end gap-2 border-b py-1 pr-1.5 pl-3",
            caption === undefined && "col-span-2 col-start-1",
          )}
        >
          {language !== undefined ? (
            <span className="font-mono text-xs text-muted-foreground uppercase">{language}</span>
          ) : null}
          {copy ? (
            <>
              <Button type="button" variant="ghost" size="xs" onClick={() => void copyText(code)}>
                <Icon name={state === "copied" ? "check" : "copy"} />
                {COPY_TEXT[state]}
                {state === "idle" ? <span className="sr-only"> code</span> : null}
              </Button>
              <span role="status" className="sr-only">
                {COPY_STATUS[state]}
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      <pre
        tabIndex={0}
        style={style}
        className={cn(
          "col-span-2 m-0 overflow-auto p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
          wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre",
        )}
      >
        {highlightedHtml !== undefined ? (
          <code
            className={cn("hljs", language !== undefined && `language-${language}`)}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <code className={cn("hljs", language !== undefined && `language-${language}`)}>{code}</code>
        )}
      </pre>
    </figure>
  );
}
