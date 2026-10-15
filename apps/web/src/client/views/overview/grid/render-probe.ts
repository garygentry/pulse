// apps/web/src/client/views/overview/grid/render-probe.ts — an optional observer of grid target renders.
//
// The grid's only-changed-cells-re-render contract is verified by counting `HostCellView`,
// `ServiceChipView` and kiosk `KioskTileView` renders per target. React has no public per-component
// render hook, so those views report each render here. No observer is installed in the app; unit tests and the browser
// perf fixture install one around the renders they measure.

/** Which grid target rendered: a desk host cell, a desk service chip, or a kiosk tile. */
export type GridRenderKind = "host" | "service" | "tile";

/** Called once per render of a grid target with its canonical drilldown id. */
export type GridRenderObserver = (kind: GridRenderKind, drilldownId: string) => void;

let observer: GridRenderObserver | null = null;

/** Install `next` (or clear with null) and return the previous observer so callers can restore it. */
export function setGridRenderObserver(next: GridRenderObserver | null): GridRenderObserver | null {
  const previous = observer;
  observer = next;
  return previous;
}

/** Report one render of a grid target. A no-op unless an observer is installed. */
export function reportGridRender(kind: GridRenderKind, drilldownId: string): void {
  observer?.(kind, drilldownId);
}
