// apps/web/tests/alerts-view-keyboard.test.ts — j/k/Enter/Escape triage loop on the DataTable handle.
// Wrapped in describeDom (tests/dom.ts) so happy-dom is registered per file.

import { expect, test } from "bun:test";

import type { ActiveAlert } from "@pulse/web-data/wire";
import type { ReactElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { firingRows } from "../src/client/views/alerts/model.js";
import { TRIAGE_ROW_HEIGHT } from "../src/client/views/alerts/table/TriageTable.js";
import type { DataTableHandle } from "@/ui";
import { describeDom } from "./dom.js";
import { eventually, stubVirtualViewport } from "./alerts-dom-helpers.js";
import { makeAlertsPayload } from "./alerts-fixtures.js";

const rows: readonly ActiveAlert[] = firingRows(makeAlertsPayload({ scenario: "mixed" }));

describeDom("triage keyboard", (dom) => {
  interface Harness {
    container: HTMLElement;
    selectedIndex: { value: number };
    scrolls: number[];
    opened: string[];
    closes: number;
    state: { firing: boolean; paneOpen: boolean };
    dispose: () => void;
    unmount: () => void;
  }

  async function setup(tableRows: readonly ActiveAlert[] = rows): Promise<Harness> {
    const { createElement: h, createRef } = await import("react");
    const { signal } = await import("@preact/signals-core");
    const { TriageTable } = await import("../src/client/views/alerts/table/TriageTable.js");
    const { installTriageKeyboard } = await import("../src/client/views/alerts/keyboard.js");
    const selectedIndex = signal(-1);
    const containerRef = createRef<HTMLDivElement>();
    const tableRef = createRef<DataTableHandle>();
    const { container, unmount } = await dom.mount(
      h(TriageTable, {
        rows: tableRows,
        selectedIndex,
        onOpenAlert: () => {},
        sourcesCurrent: true,
        containerRef,
        tableRef,
      }) as unknown as ReactElement,
    );
    const hn: Harness = {
      container,
      selectedIndex,
      scrolls: [],
      opened: [],
      closes: 0,
      state: { firing: true, paneOpen: false },
      dispose: () => {},
      unmount,
    };
    liveDoc = container.ownerDocument;
    hn.dispose = installTriageKeyboard({
      selectedIndex,
      rows: () => tableRows,
      container: () => containerRef.current,
      scrollToIndex: (index) => {
        hn.scrolls.push(index);
        tableRef.current?.scrollToIndex(index);
      },
      isFiringTabActive: () => hn.state.firing,
      isPaneOpen: () => hn.state.paneOpen,
      openAlert: (fp) => hn.opened.push(fp),
      closePane: () => {
        hn.closes += 1;
      },
    });
    return hn;
  }

  // Under bun + happy-dom the bare `document` (which dom.mount renders into) and globalThis.document
  // can diverge across files; the shortcut registry listens on both, so dispatch and read focus on
  // the document the table actually lives in.
  let liveDoc: Document | null = null;

  function press(key: string): KeyboardEvent {
    const doc = liveDoc ?? (dom.win.document as unknown as Document);
    const view = doc.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent };
    const ev = new view.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    doc.dispatchEvent(ev);
    return ev;
  }

  function focusedFp(): string | null {
    return (liveDoc?.activeElement as HTMLElement | null | undefined)?.getAttribute("data-triage-open") ?? null;
  }

  test("j/k move selectedIndex (clamped) and focus the row's open control", async () => {
    const hn = await setup();
    try {
      press("j");
      expect(hn.selectedIndex.value).toBe(0);
      expect(focusedFp()).toBe(rows[0]!.fingerprint);
      press("j");
      expect(hn.selectedIndex.value).toBe(1);
      expect(focusedFp()).toBe(rows[1]!.fingerprint);
      const current = [...hn.container.querySelectorAll("[aria-current]")];
      expect(current.map((e) => e.getAttribute("data-triage-open"))).toEqual([rows[1]!.fingerprint]);
      press("k");
      press("k");
      press("k");
      expect(hn.selectedIndex.value).toBe(0);
      expect(focusedFp()).toBe(rows[0]!.fingerprint);
      for (let i = 0; i < rows.length + 3; i++) press("j");
      expect(hn.selectedIndex.value).toBe(rows.length - 1);
      expect(focusedFp()).toBe(rows[rows.length - 1]!.fingerprint);
    } finally {
      hn.dispose();
      hn.unmount();
    }
  });

  /** 5,000 rows, virtualized, in a stubbed 10-row viewport. */
  const many: ActiveAlert[] = Array.from({ length: 5000 }, (_, index) => ({
    ...rows[0]!,
    fingerprint: `virtual-${index}`,
    name: `Virtual alert ${index}`,
  }));

  const rendered = (hn: Harness): string[] =>
    [...hn.container.querySelectorAll("[data-triage-open]")].map((el) => el.getAttribute("data-triage-open")!);

  test("j walks focus across the virtualized window boundary (rows render as focus moves)", async () => {
    const restoreViewport = stubVirtualViewport(TRIAGE_ROW_HEIGHT);
    const hn = await setup(many);
    try {
      expect(hn.container.querySelector('[data-slot="data-table"][data-virtualized]')).not.toBeNull();
      const initial = rendered(hn);
      expect(initial.length).toBeLessThan(300);
      const beyond = initial.length + 5; // a row outside the first rendered window
      expect(initial).not.toContain(`virtual-${beyond}`);
      for (let index = 0; index <= beyond; index += 1) {
        press("j");
        await eventually(() => expect(focusedFp()).toBe(`virtual-${index}`));
      }
      expect(hn.selectedIndex.value).toBe(beyond);
      expect([...hn.container.querySelectorAll("[aria-current]")].map((e) => e.getAttribute("data-triage-open"))).toEqual([
        `virtual-${beyond}`,
      ]);
      expect(rendered(hn).length).toBeLessThan(300);
    } finally {
      hn.dispose();
      hn.unmount();
      restoreViewport();
    }
  });

  test("a row outside the window is scrolled in through the DataTable handle, then focused on a later frame", async () => {
    const restoreViewport = stubVirtualViewport(TRIAGE_ROW_HEIGHT);
    const originalRaf = globalThis.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }) as typeof requestAnimationFrame;
    const hn = await setup(many);
    try {
      hn.selectedIndex.value = 3999; // cursor far down (e.g. restored after a re-window)
      expect(rendered(hn)).not.toContain("virtual-4000");
      press("j");
      expect(hn.selectedIndex.value).toBe(4000);
      expect(hn.scrolls).toEqual([4000]); // handle.scrollToIndex, not a scrollTop guess
      expect(frames.length).toBe(1); // focus retries on the next frame
      // The DataTable renders the scrolled-to row once the viewport reports the scroll.
      await eventually(() => expect(rendered(hn)).toContain("virtual-4000"));
      expect(rendered(hn).length).toBeLessThan(300);
      expect(focusedFp()).toBeNull();
      frames.shift()!(0);
      expect(focusedFp()).toBe("virtual-4000");
      expect([...hn.container.querySelectorAll("[aria-current]")]).toHaveLength(1);
      // The table owns the scroll position: the viewport moved to the row.
      const viewport = hn.container.querySelector<HTMLElement>('[data-slot="data-table-viewport"]')!;
      expect(viewport.scrollTop).toBeGreaterThan(3900 * TRIAGE_ROW_HEIGHT);
    } finally {
      if (originalRaf === undefined) delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame;
      else globalThis.requestAnimationFrame = originalRaf;
      hn.dispose();
      hn.unmount();
      restoreViewport();
    }
  });

  test("a pending focus retry yields to a newer cursor move", async () => {
    const restoreViewport = stubVirtualViewport(TRIAGE_ROW_HEIGHT);
    const originalRaf = globalThis.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }) as typeof requestAnimationFrame;
    const hn = await setup(many);
    try {
      hn.selectedIndex.value = 3999;
      press("j"); // → 4000, not rendered: retry scheduled
      hn.selectedIndex.value = 0;
      press("k"); // → 0, rendered: focused at once
      expect(focusedFp()).toBe("virtual-0");
      await eventually(() => expect(rendered(hn)).toContain("virtual-4000"));
      for (const frame of frames.splice(0)) frame(0);
      expect(focusedFp()).toBe("virtual-0");
      expect([...hn.container.querySelectorAll("[aria-current]")].map((e) => e.getAttribute("data-triage-open"))).toEqual([
        "virtual-0",
      ]);
    } finally {
      if (originalRaf === undefined) delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame;
      else globalThis.requestAnimationFrame = originalRaf;
      hn.dispose();
      hn.unmount();
      restoreViewport();
    }
  });

  test("k from an unset cursor lands on row 0", async () => {
    const hn = await setup();
    try {
      press("k");
      expect(hn.selectedIndex.value).toBe(0);
    } finally {
      hn.dispose();
      hn.unmount();
    }
  });

  test("Enter opens the selected row exactly once when focus is off a control; no-op with nothing selected", async () => {
    const hn = await setup();
    try {
      press("Enter");
      expect(hn.opened).toEqual([]);
      press("j");
      press("j");
      (liveDoc?.activeElement as HTMLElement | null | undefined)?.blur();
      const ev = press("Enter");
      expect(ev.defaultPrevented).toBe(false);
      expect(hn.opened).toEqual([rows[1]!.fingerprint]);
    } finally {
      hn.dispose();
      hn.unmount();
    }
  });

  // Dispatch a keydown ON `el` (bubbling to the document listener), as a real focused control would.
  function pressOn(el: Element, key: string): KeyboardEvent {
    const view = el.ownerDocument.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent };
    const ev = new view.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  }

  test("Enter on a focused row-open button is not cancelled and does not open a different row", async () => {
    const hn = await setup();
    try {
      hn.selectedIndex.value = 0; // cursor on row 0, focus on row 2's control
      const btn = [...hn.container.querySelectorAll<HTMLElement>("[data-triage-open]")].find(
        (el) => el.getAttribute("data-triage-open") === rows[2]!.fingerprint,
      )!;
      btn.focus();
      const ev = pressOn(btn, "Enter");
      expect(ev.defaultPrevented).toBe(false);
      expect(hn.opened).toEqual([]); // native activation (click) handles it, not the shortcut
    } finally {
      hn.dispose();
      hn.unmount();
    }
  });

  test("Enter on a focused facet chip is not cancelled and does not call openAlert", async () => {
    const hn = await setup();
    const doc = hn.container.ownerDocument;
    const chip = doc.createElement("button");
    chip.type = "button";
    chip.setAttribute("aria-pressed", "false");
    doc.body.appendChild(chip);
    try {
      hn.selectedIndex.value = 1;
      chip.focus();
      const ev = pressOn(chip, "Enter");
      expect(ev.defaultPrevented).toBe(false);
      expect(hn.opened).toEqual([]);
    } finally {
      chip.remove();
      hn.dispose();
      hn.unmount();
    }
  });

  test("Enter inside the open detail Sheet (focus on the dialog itself) does not switch alerts", async () => {
    const hn = await setup();
    const doc = hn.container.ownerDocument;
    const sheet = doc.createElement("div");
    sheet.setAttribute("role", "dialog");
    sheet.tabIndex = -1;
    sheet.appendChild(doc.createElement("p"));
    doc.body.appendChild(sheet);
    try {
      hn.state.paneOpen = true;
      hn.selectedIndex.value = 0; // cursor on row 0, pane showing another alert
      sheet.focus();
      pressOn(sheet, "Enter");
      pressOn(sheet.firstElementChild!, "Enter");
      expect(hn.opened).toEqual([]);
    } finally {
      sheet.remove();
      hn.dispose();
      hn.unmount();
    }
  });

  test("Escape is never preventDefault'ed (the detail Sheet handles its own Escape)", async () => {
    const hn = await setup();
    hn.state.paneOpen = true;
    try {
      const ev = press("Escape");
      expect(ev.defaultPrevented).toBe(false);
      expect(hn.closes).toBe(1);
    } finally {
      hn.dispose();
      hn.unmount();
    }
  });

  test("Escape closes the pane only when it is open", async () => {
    const hn = await setup();
    try {
      press("Escape");
      expect(hn.closes).toBe(0);
      hn.state.paneOpen = true;
      press("Escape");
      expect(hn.closes).toBe(1);
    } finally {
      hn.dispose();
      hn.unmount();
    }
  });

  test("an Escape already consumed by an open dialog (defaultPrevented) does not close the pane again", async () => {
    const hn = await setup();
    hn.state.paneOpen = true;
    const doc = liveDoc ?? (dom.win.document as unknown as Document);
    // A capture listener stands in for the Sheet / a nested dialog dismissing on Escape.
    const consume = (e: Event): void => e.preventDefault();
    doc.addEventListener("keydown", consume, { capture: true });
    try {
      press("Escape");
      expect(hn.closes).toBe(0);
    } finally {
      doc.removeEventListener("keydown", consume, { capture: true });
      hn.dispose();
      hn.unmount();
    }
  });

  test("j/k/Enter no-op off the firing tab", async () => {
    const hn = await setup();
    try {
      hn.state.firing = false;
      press("j");
      press("k");
      expect(hn.selectedIndex.value).toBe(-1);
      hn.selectedIndex.value = 0;
      press("Enter");
      expect(hn.opened).toEqual([]);
    } finally {
      hn.dispose();
      hn.unmount();
    }
  });

  test("j/k no-op on an empty list", async () => {
    const hn = await setup([]);
    try {
      press("j");
      expect(hn.selectedIndex.value).toBe(-1);
    } finally {
      hn.dispose();
      hn.unmount();
    }
  });

  test("shortcuts stay quiet while focus is in a text input", async () => {
    const hn = await setup();
    // isInInput() reads globalThis.document.activeElement — focus an input there.
    const gdoc = (globalThis as unknown as { document: Document }).document;
    const input = gdoc.createElement("input");
    gdoc.body.appendChild(input);
    try {
      input.focus();
      press("j");
      expect(hn.selectedIndex.value).toBe(-1);
    } finally {
      input.remove();
      hn.dispose();
      hn.unmount();
    }
  });

  test("the disposer removes all four shortcuts", async () => {
    const hn = await setup();
    hn.state.paneOpen = true;
    hn.dispose();
    try {
      press("j");
      press("k");
      hn.selectedIndex.value = 0;
      press("Enter");
      press("Escape");
      expect(hn.selectedIndex.value).toBe(0);
      expect(hn.opened).toEqual([]);
      expect(hn.closes).toBe(0);
    } finally {
      hn.unmount();
    }
  });

  test("registers every combo with allowInInput: false; Enter/Escape without preventDefault", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/client/views/alerts/keyboard.ts", import.meta.url)),
      "utf8",
    );
    const combos = [...src.matchAll(/registerShortcut\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(combos).toEqual(["j", "k", "enter", "escape"]);
    expect(src.match(/\{ allowInInput: false(, preventDefault: false)? \}/g)).toHaveLength(4);
    // Enter/Escape must not cancel native activation of buttons/links (the registry listens on document).
    expect(src.match(/\{ allowInInput: false, preventDefault: false \}/g)).toHaveLength(2);
  });

  test("TriageKeyboardHints renders Kbd hints for each combo in a labelled note", async () => {
    const { createElement: h } = await import("react");
    const { TriageKeyboardHints } = await import("../src/client/views/alerts/keyboard.js");
    const { container, unmount } = await dom.mount(h(TriageKeyboardHints, {}) as unknown as ReactElement);
    try {
      const kbds = [...container.querySelectorAll('kbd[data-slot="kbd"]')];
      expect(kbds.map((k) => k.textContent)).toEqual(["J", "K", "Enter", "Esc"]);
      const note = container.querySelector('[role="note"]')!;
      expect(note.getAttribute("aria-label")).toBe("Keyboard shortcuts");
      expect(note.textContent).toBe("J / K moveEnter openEsc close");
    } finally {
      unmount();
    }
  });
});
