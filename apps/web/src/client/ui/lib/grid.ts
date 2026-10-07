/**
 * The column count of a wrapped (auto-fill) grid, from each item's top offset
 * in visual order: the number of items sharing the first item's row. Pure.
 * Always at least 1 (an empty grid counts as one column).
 */
export function columnsFromOffsets(tops: readonly number[]): number {
  if (tops.length === 0) return 1;
  const first = tops[0]!;
  let columns = 0;
  // Sub-pixel tolerance: items in one row can differ by rounding.
  while (columns < tops.length && Math.abs(tops[columns]! - first) < 1) columns += 1;
  return Math.max(1, columns);
}
