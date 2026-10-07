// apps/web/tests/timeline-queries.ts — role/name/data-* queries shared by the timeline DOM suites.

/** Accessible name of a button: its aria-label, else its trimmed text. */
function buttonName(b: Element): string {
  return b.getAttribute("aria-label") ?? (b.textContent ?? "").trim();
}

/** The first `<button>` under `root` whose accessible name is exactly `name`, or null. */
export function buttonNamed(root: ParentNode, name: string): HTMLButtonElement | null {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) => buttonName(b) === name) ?? null;
}

/** The URL-notices callout: the role=status region that holds `[data-notice-key]` paragraphs, or null. */
export function noticesBox(root: ParentNode): HTMLElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLElement>('[role="status"]')).find(
      (r) => r.querySelector("[data-notice-key]") !== null,
    ) ?? null
  );
}

/** The "Time range" radiogroup, or null. */
export function rangeGroup(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Time range"]');
}

/** Text of the checked "Time range" radio, or null. */
export function checkedRange(root: ParentNode): string | null {
  return rangeGroup(root)?.querySelector('[role="radio"][aria-checked="true"]')?.textContent ?? null;
}

/** The page's level-1 headings. */
export function pageHeadings(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("h1"));
}
