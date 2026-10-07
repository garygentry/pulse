import { useCallback, useRef, type ReactNode } from "react";
import { useShowMore, type ShowMoreState } from "@/ui/hooks/use-show-more";
import { cn } from "@/ui/lib/utils";
import { Button } from "@/ui/primitives/button";

export interface ShowMoreControlsProps {
  state: ShowMoreState;
  /** Plural noun for the button text ("Show 3 more findings"). */
  noun?: string | undefined;
  className?: string;
}

/**
 * The "Show N more" / "Show all" buttons for a {@link useShowMore} list. Renders
 * nothing once every item is visible. "Show all" appears only when it reveals
 * more than "Show N more" would.
 */
export function ShowMoreControls({ state, noun, className }: ShowMoreControlsProps) {
  if (state.remaining <= 0) return null;
  const suffix = noun === undefined ? "" : ` ${noun}`;
  return (
    <div data-slot="show-more-controls" className={cn("flex flex-wrap items-center gap-2", className)}>
      <Button type="button" variant="outline" size="sm" onClick={state.showMore} className="tabular-nums">
        Show {state.nextCount} more{suffix}
      </Button>
      {state.remaining > state.nextCount ? (
        <Button type="button" variant="ghost" size="sm" onClick={state.showAll} className="tabular-nums">
          Show all {state.visible + state.remaining}
          {suffix}
        </Button>
      ) : null}
    </div>
  );
}

export interface ShowMoreProps<T> {
  items: readonly T[];
  renderItem: (item: T, index: number) => ReactNode;
  getKey?: (item: T, index: number) => string | number;
  /** Items visible before any reveal. Default 5. */
  initial?: number;
  /** Items each "Show N more" reveals; omit to reveal the rest at once. */
  step?: number;
  /**
   * Called after a reveal with the first newly visible index. When omitted,
   * focus moves to that item so keyboard users continue where the list grew.
   */
  onReveal?: (firstRevealedIndex: number) => void;
  noun?: string;
  /** Accessible name for the list. */
  label?: string;
  className?: string;
  listClassName?: string;
}

/**
 * A `ul` that shows the first `initial` items, with {@link ShowMoreControls}
 * below it. For tables or grids, use {@link useShowMore} + `ShowMoreControls`.
 */
export function ShowMore<T>({
  items,
  renderItem,
  getKey,
  initial,
  step,
  onReveal,
  noun,
  label,
  className,
  listClassName,
}: ShowMoreProps<T>) {
  const itemRefs = useRef(new Map<number, HTMLLIElement>());
  const focusRevealed = useCallback((index: number) => itemRefs.current.get(index)?.focus(), []);
  const state = useShowMore({ total: items.length, initial, step, onReveal: onReveal ?? focusRevealed });

  return (
    <div data-slot="show-more" className={cn("flex flex-col gap-3", className)}>
      <ul aria-label={label} className={cn("m-0 flex list-none flex-col gap-2 p-0", listClassName)}>
        {items.slice(0, state.visible).map((item, index) => (
          <li
            key={getKey?.(item, index) ?? index}
            tabIndex={-1}
            className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            ref={(el) => {
              if (el === null) itemRefs.current.delete(index);
              else itemRefs.current.set(index, el);
            }}
          >
            {renderItem(item, index)}
          </li>
        ))}
      </ul>
      <ShowMoreControls state={state} noun={noun} />
    </div>
  );
}
