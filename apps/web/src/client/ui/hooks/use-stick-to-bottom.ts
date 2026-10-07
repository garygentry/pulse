import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

/** How close (px) to the bottom still counts as "at the bottom". */
const THRESHOLD = 8;

/**
 * Keep a scroll container pinned to its bottom as `content` grows, unless the
 * user has scrolled up to read; scrolling back to the bottom re-pins it.
 * Attach `ref` and `onScroll` to the scrolling element.
 */
export function useStickToBottom<T extends HTMLElement>(
  content: unknown,
): { ref: RefObject<T | null>; onScroll: () => void } {
  const ref = useRef<T | null>(null);
  const pinned = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el === null) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD;
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el !== null && pinned.current) el.scrollTop = el.scrollHeight;
  }, [content]);

  return { ref, onScroll };
}
