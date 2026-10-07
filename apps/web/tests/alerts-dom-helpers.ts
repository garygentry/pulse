// apps/web/tests/alerts-dom-helpers.ts — DOM helpers for the alerts firing-tab suites: layout stubs
// for the virtualized triage DataTable, polling, and facet-control queries.
//
// happy-dom has no layout: the DataTable viewport's geometry (offsetHeight/clientHeight/scrollHeight,
// which the virtualizer reads) is stubbed, and `scrollTo` fires `scroll` on the next task as a
// browser does. Call inside a DOM test (after happy-dom is registered); the returned function
// restores the prototype.

/** Viewport height in px used by the stub: 10 rows of the 36px compact row height. */
export const VIEWPORT_HEIGHT = 360;

export function stubVirtualViewport(rowHeight: number, viewportHeight: number = VIEWPORT_HEIGHT): () => void {
  const undo: (() => void)[] = [];
  const proto = (globalThis as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype;
  const isViewport = (el: HTMLElement): boolean => el.getAttribute("data-slot") === "data-table-viewport";
  const stubs: Record<string, (el: HTMLElement) => number> = {
    offsetHeight: () => viewportHeight,
    clientHeight: () => viewportHeight,
    scrollHeight: (el) => Number(el.querySelector("table")?.getAttribute("aria-rowcount") ?? 0) * rowHeight,
  };
  for (const [name, value] of Object.entries(stubs)) {
    const original = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: HTMLElement) {
        return isViewport(this) ? value(this) : (original?.get?.call(this) ?? 0);
      },
    });
    undo.push(() => {
      if (original !== undefined) Object.defineProperty(proto, name, original);
      else delete (proto as unknown as Record<string, unknown>)[name];
    });
  }
  const scrollTo = proto.scrollTo;
  proto.scrollTo = function (this: HTMLElement, ...args: Parameters<HTMLElement["scrollTo"]>) {
    const before = this.scrollTop;
    (scrollTo as (...a: unknown[]) => void).apply(this, args);
    if (this.scrollTop === before) return;
    const view = this.ownerDocument.defaultView as unknown as { Event: typeof Event };
    setTimeout(() => this.dispatchEvent(new view.Event("scroll")), 0);
  } as HTMLElement["scrollTo"];
  undo.push(() => {
    proto.scrollTo = scrollTo;
  });
  return () => {
    while (undo.length > 0) undo.pop()!();
  };
}

/** Poll `check` (a few ms apart) until it passes or `timeoutMs` elapses; rethrows the last failure. */
export async function eventually(check: () => void, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > end) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

/** The inline facet toolbar (FacetFilter variant inline) whose title is `title`, or null. */
export function facetToolbar(root: ParentNode, title: string): HTMLElement | null {
  for (const facet of root.querySelectorAll<HTMLElement>('[data-slot="facet-filter"][data-variant="inline"]')) {
    const group = facet.querySelector<HTMLElement>('[role="toolbar"][aria-labelledby]');
    const labelId = group?.getAttribute("aria-labelledby");
    const label = labelId ? facet.ownerDocument.getElementById(labelId)?.textContent : null;
    if (label === title) return group;
  }
  return null;
}

/** The aria-pressed toggles of an inline facet. */
export function facetToggles(root: ParentNode, title: string): HTMLButtonElement[] {
  return [...(facetToolbar(root, title)?.querySelectorAll<HTMLButtonElement>("button[aria-pressed]") ?? [])];
}

/** The trigger of a popover facet (FacetFilter variant popover) whose title is `title`, or null. */
export function facetPopoverTrigger(root: ParentNode, title: string): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>('button[data-slot="facet-filter"][data-variant="popover"]')].find((b) =>
      b.textContent?.startsWith(title),
    ) ?? null
  );
}

/** Open a popover facet and return its value options (portalled: queried on the document). The
 *  trailing "Clear <title> filter" row is an action, not a value, and is excluded. */
export async function openFacetOptions(root: ParentNode, title: string): Promise<HTMLElement[]> {
  const trigger = facetPopoverTrigger(root, title);
  if (trigger === null) throw new Error(`no popover facet "${title}"`);
  const doc = trigger.ownerDocument;
  const list = (): HTMLElement | null => doc.querySelector<HTMLElement>(`[role="listbox"][aria-label="${title}"]`);
  if (list() === null) trigger.click();
  await eventually(() => {
    if (list() === null) throw new Error(`facet "${title}" did not open`);
  });
  return [...list()!.querySelectorAll<HTMLElement>('[role="option"]')].filter((o) => !o.textContent?.startsWith("Clear "));
}

/** The removable active-filter chips ("Remove <facet> filter <value>"). */
export function activeFilterChips(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('[data-slot="active-filters"] button[aria-label^="Remove "]')];
}

/** The alerts detail Sheet (Radix portals it into document.body, outside any mount container). */
export function detailDialog(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>('[role="dialog"][data-alerts-detail]');
}

/** A dialog's accessible name: the text of its aria-labelledby title. */
export function dialogTitle(dialog: Element): string {
  const ids = (dialog.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter((x) => x !== "");
  return ids.map((id) => dialog.ownerDocument.getElementById(id)?.textContent ?? "").join(" ").trim();
}

/** The detail section (`section[aria-labelledby]`) whose heading text is `name`, or null. */
export function detailSection(root: ParentNode, name: string): HTMLElement | null {
  for (const section of root.querySelectorAll<HTMLElement>("section[aria-labelledby]")) {
    const heading = section.ownerDocument.getElementById(section.getAttribute("aria-labelledby") ?? "");
    if (heading?.textContent === name) return section;
  }
  return null;
}

/** The alerts page tab named `name` (Radix Tabs trigger, role=tab). */
export function alertsTab(root: ParentNode, name: string): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) => t.textContent?.trim() === name) ?? null
  );
}

/** The visible tabpanel (Radix keeps the inactive panels in the DOM, empty and `hidden`). */
export function activeTabPanel(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
}

/** Activate a Radix tab as a pointer does: a primary-button mousedown (Radix selects on mousedown,
 *  not click), then the click. */
export function selectTab(tab: HTMLElement): void {
  const view = tab.ownerDocument.defaultView as unknown as { MouseEvent: typeof MouseEvent };
  tab.dispatchEvent(new view.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  tab.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}
