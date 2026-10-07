import { useCallback, useEffect, useRef, useState } from "react";

export type CopyState = "idle" | "copied" | "failed";

/**
 * Copy text to the clipboard and report the outcome for a moment
 * (`copied`/`failed`), then fall back to `idle`.
 */
export function useCopyToClipboard(resetMs = 2000): {
  state: CopyState;
  copy: (text: string) => Promise<void>;
} {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string) => {
      let next: CopyState = "failed";
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          next = "copied";
        }
      } catch {
        // Permission denied or insecure context: report failure below.
      }
      setState(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), resetMs);
    },
    [resetMs],
  );

  return { state, copy };
}
