import { useCallback, useEffect, useRef, useState } from "react";

export interface UseShowMoreOptions {
  total: number;
  /** Items visible before any reveal. Default 5. */
  initial?: number | undefined;
  /** Items each "Show N more" reveals; omit to reveal everything at once. */
  step?: number | undefined;
  /**
   * Called once the revealed items have rendered, with the index of the first
   * newly visible one, so the caller can move focus to it.
   */
  onReveal?: ((firstRevealedIndex: number) => void) | undefined;
}

export interface ShowMoreState {
  /** How many items to render (slice `0..visible`). */
  visible: number;
  /** Items still hidden. */
  remaining: number;
  /** Items the next "Show N more" reveals. */
  nextCount: number;
  showMore: () => void;
  showAll: () => void;
}

/** Headless "Show N more / Show all" state for any list, table or grid. */
export function useShowMore({ total, initial = 5, step, onReveal }: UseShowMoreOptions): ShowMoreState {
  const [shown, setShown] = useState(initial);
  const visible = Math.min(shown, total);
  const remaining = total - visible;
  const nextCount = step === undefined ? remaining : Math.min(step, remaining);

  const pending = useRef<number | null>(null);

  useEffect(() => {
    if (pending.current === null) return;
    const first = pending.current;
    pending.current = null;
    onReveal?.(first);
  }, [visible, onReveal]);

  const reveal = useCallback(
    (count: number) => {
      if (count <= 0) return;
      pending.current = visible;
      setShown(visible + count);
    },
    [visible],
  );

  return {
    visible,
    remaining,
    nextCount,
    showMore: () => reveal(nextCount),
    showAll: () => reveal(remaining),
  };
}
