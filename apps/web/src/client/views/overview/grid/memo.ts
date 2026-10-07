// apps/web/src/client/views/overview/grid/memo.ts — explicit-equality memoization for grid targets.
//
// `React.memo` with an explicit equality function: a parent re-render skips the wrapped component
// while `equal(previous, next)` holds. The wrapped function component owns every hook, so its own
// state updates (e.g. a change-marker timer) still re-render it directly.

import { memo } from "react";
import type { FunctionComponent, NamedExoticComponent } from "react";

/** Wrap `render` so a parent re-render skips it while `equal(previous, next)` holds. */
export function memoWithEquality<P extends object>(
  render: FunctionComponent<P>,
  equal: (previous: Readonly<P>, next: Readonly<P>) => boolean,
): NamedExoticComponent<P> {
  const memoized = memo(render, equal);
  memoized.displayName = `Memo(${render.displayName ?? render.name})`;
  return memoized;
}

/** Shallow props equality: same key set and `Object.is` on every value. */
export function shallowEqualProps(previous: object, next: object): boolean {
  const before = previous as Readonly<Record<string, unknown>>;
  const after = next as Readonly<Record<string, unknown>>;
  const keys = Object.keys(before);
  if (keys.length !== Object.keys(after).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(after, key) && Object.is(before[key], after[key]));
}
