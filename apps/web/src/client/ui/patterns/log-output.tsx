import { useId, type CSSProperties, type ReactNode } from "react";
import { useStickToBottom } from "@/ui/hooks/use-stick-to-bottom";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";

export interface LogOutputProps {
  stdout?: string;
  stderr?: string;
  /** Output is still arriving: sets `aria-busy` and shows a "Streaming" marker. */
  streaming?: boolean;
  /** Visible heading; also names the log region. */
  label?: ReactNode;
  /** Cap each stream's height (CSS length or px) and scroll beyond it. Default `20rem`. */
  maxHeight?: string | number;
  className?: string;
}

const STREAM =
  "m-0 overflow-auto p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset";

/**
 * A streamed stdout/stderr panel. The streams sit in a `role="log"` live region
 * (`aria-live="polite"`, `aria-busy` while streaming); each stream autoscrolls
 * to the bottom as it grows unless the reader has scrolled up. stderr gets its
 * own labelled block in the danger tone (icon + text, not colour alone).
 */
export function LogOutput({
  stdout = "",
  stderr = "",
  streaming = false,
  label = "Output",
  maxHeight = "20rem",
  className,
}: LogOutputProps) {
  const labelId = useId();
  const out = useStickToBottom<HTMLPreElement>(stdout);
  const err = useStickToBottom<HTMLPreElement>(stderr);
  const style: CSSProperties = { maxHeight };

  return (
    <div
      data-slot="log-output"
      data-state={streaming ? "streaming" : "done"}
      className={cn("flex min-w-0 flex-col overflow-hidden rounded-lg border bg-muted text-foreground", className)}
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
        <span id={labelId} className="font-medium text-muted-foreground">
          {label}
        </span>
        {streaming ? (
          <span className="flex items-center gap-1.5 text-status-pending-fg">
            <Icon name="circle-dashed" size={14} className="motion-safe:animate-spin" />
            Streaming
          </span>
        ) : null}
      </div>
      <div role="log" aria-live="polite" aria-busy={streaming} aria-labelledby={labelId}>
        <pre
          ref={out.ref}
          onScroll={out.onScroll}
          tabIndex={0}
          style={style}
          data-stream="stdout"
          className={STREAM}
        >
          {stdout !== "" ? (
            stdout
          ) : (
            <span className="text-muted-foreground italic">{streaming ? "Waiting for output…" : "No output."}</span>
          )}
        </pre>
        {stderr !== "" ? (
          <div data-stream="stderr" className="border-t border-status-danger-border bg-status-danger-bg">
            <p className="m-0 flex items-center gap-1.5 px-3 pt-2 text-xs font-medium text-status-danger-fg">
              <Icon name="triangle-alert" size={14} />
              Standard error
            </p>
            <pre
              ref={err.ref}
              onScroll={err.onScroll}
              tabIndex={0}
              style={style}
              className={cn(STREAM, "text-status-danger-fg")}
            >
              {stderr}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}
