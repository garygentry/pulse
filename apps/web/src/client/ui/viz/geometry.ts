/** Shared number helpers for the viz geometry: SVG coordinates are rounded to 0.01 px. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}
