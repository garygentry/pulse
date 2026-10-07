// apps/web/tests/mutations-dialog-dom.ts — find the lazy mutation dialogs in a happy-dom document.
// Radix portals a dialog into document.body, outside the container a suite mounted, so dialog suites
// query the open `[role=dialog]` / `[role=alertdialog]` by its accessible name instead.
import type { ReactElement } from "react";

const DIALOG = "[role=dialog], [role=alertdialog]";

/** Every open mutation dialog in the document. */
export function openDialogs(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(DIALOG)];
}

/** A dialog's accessible name: the text of its aria-labelledby title. */
export function dialogName(dialog: Element): string {
  const ids = (dialog.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter((x) => x !== "");
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
}

/** The one open dialog, or the open dialog named `name`; throws when there is none. */
export function getDialog(name?: string | RegExp): HTMLElement {
  const all = openDialogs();
  const found = name === undefined
    ? (all.length === 1 ? all[0] : undefined)
    : all.find((d) => (typeof name === "string" ? dialogName(d) === name : name.test(dialogName(d))));
  if (found === undefined) {
    throw new Error(`no open dialog${name !== undefined ? ` named ${String(name)}` : ""} (open: ${JSON.stringify(all.map(dialogName))})`);
  }
  return found;
}

/** The one open dialog, or null when none is open. */
export function queryDialog(): HTMLElement | null {
  return openDialogs()[0] ?? null;
}

interface Mounter { mount(v: ReactElement): Promise<{ container: HTMLElement; unmount(): void }> }

function tick(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Mount a dialog component (open) and return its dialog element as the query root. */
export async function mountDialog(dom: Mounter, vnode: ReactElement): Promise<{ dialog: HTMLElement; container: HTMLElement; unmount(): void }> {
  const m = await dom.mount(vnode);
  await tick();
  return { ...m, dialog: getDialog() };
}

/**
 * Install `requestAnimationFrame`/`cancelAnimationFrame` (happy-dom has neither; a Radix Collapsible, e.g.
 * the ProposalList disclosure, schedules a frame on mount). Returns a restore function.
 */
export function stubAnimationFrame(): () => void {
  const g = globalThis as { requestAnimationFrame?: typeof requestAnimationFrame; cancelAnimationFrame?: typeof cancelAnimationFrame };
  const raf = g.requestAnimationFrame;
  const caf = g.cancelAnimationFrame;
  g.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number) as typeof requestAnimationFrame;
  g.cancelAnimationFrame = ((id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>)) as typeof cancelAnimationFrame;
  return () => {
    if (raf === undefined) delete g.requestAnimationFrame; else g.requestAnimationFrame = raf;
    if (caf === undefined) delete g.cancelAnimationFrame; else g.cancelAnimationFrame = caf;
  };
}
