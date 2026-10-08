/**
 * Shared `@tanstack/react-virtual` helpers for the virtualized patterns (`DataTable`, `TreeView`).
 */

/**
 * `observeElementRect` over the scroll element's client box (inside its borders and scrollbars)
 * instead of the library's border box. A content-box ResizeObserver also fires when a scrollbar
 * appears or goes, which changes the client box without changing the border box.
 */
export function observeClientRect(
  instance: { scrollElement: HTMLDivElement | null },
  cb: (rect: { width: number; height: number }) => void,
): (() => void) | undefined {
  const element = instance.scrollElement;
  if (element === null) return undefined;
  const report = () => cb({ width: element.clientWidth, height: element.clientHeight });
  report();
  const Observer = element.ownerDocument.defaultView?.ResizeObserver;
  if (Observer === undefined) return () => {};
  const observer = new Observer(report);
  observer.observe(element);
  return () => observer.disconnect();
}
