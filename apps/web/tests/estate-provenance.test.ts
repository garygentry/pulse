// apps/web/tests/estate-provenance.test.ts — the estate file:line provenance copy chip (spec 06 §2,
// 09). Wrapped in describeDom so happy-dom is registered per file; navigator.clipboard is stubbed.

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import type { ReactElement } from "react";
import type { WebProvenance } from "@pulse/renderer";

import { mountAnnouncer } from "../src/client/a11y/announcer.js";
import { act } from "./react-render.js";
import { installUiStubs } from "./rtl.js";
import { copyProvenance, ProvenanceChip } from "../src/client/views/estate/provenance-chip.js";
import { provenanceRef } from "../src/client/views/estate/provenance.js";
import { describeDom } from "./dom.js";

const PROV: WebProvenance = { file: "estate/hosts.yaml", path: "hosts[2].collection_class", line: 42, col: 7 };
const REF = "estate/hosts.yaml:42";

/** Swap `navigator.clipboard` on the live global navigator; returns a restore thunk. */
function stubClipboard(value: unknown): () => void {
  const nav = (globalThis as { navigator: object }).navigator;
  const prev = Object.getOwnPropertyDescriptor(nav, "clipboard");
  Object.defineProperty(nav, "clipboard", { configurable: true, value });
  return () => {
    if (prev) Object.defineProperty(nav, "clipboard", prev);
    else delete (nav as { clipboard?: unknown }).clipboard;
  };
}

async function waitFor(read: () => string | null, want: string, budgetMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (read() === want) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Read the live document via globalThis at call time — a bare `document` can bind to a stale
 *  window across test files under the full suite (see a11y/announcer.ts header). */
const politeText = (): string | null =>
  (globalThis as { document: Document }).document.querySelector('#pulse-a11y-announcer [aria-live="polite"]')?.textContent ?? null;

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describeDom("estate provenance chip", (dom) => {
  test("renders a focusable <button> whose text is file:line (not the YAML path)", async () => {
    const { container, unmount } = await dom.mount(createElement(ProvenanceChip, { provenance: PROV }) as ReactElement);
    const btn = container.querySelector("button[data-provenance-file]") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("type")).toBe("button");
    expect(btn.getAttribute("data-provenance-file")).toBe(PROV.file);
    expect(btn.textContent).toBe(REF);
    expect(provenanceRef(PROV)).toBe(REF);
    expect(btn.getAttribute("aria-label")).toBe(`Provenance ${REF}. Activate to copy to clipboard.`);
    btn.focus();
    expect(btn.ownerDocument.activeElement === btn).toBe(true);
    unmount();
  });

  test("the optional className prop is passed through to the chip button", async () => {
    const { container, unmount } = await dom.mount(
      createElement(ProvenanceChip, { provenance: PROV, className: "extra" }) as ReactElement,
    );
    expect(container.querySelector("button[data-provenance-file]")!.classList.contains("extra")).toBe(true);
    unmount();
  });

  test("focusing the chip opens a tooltip naming the YAML path and the copy action", async () => {
    // Radix portals the tooltip into document.body once its layout effect runs: stubs before mount.
    const restoreUi = installUiStubs();
    const doc = (globalThis as { document: Document }).document;
    try {
      const { container, unmount } = await dom.mount(createElement(ProvenanceChip, { provenance: PROV }) as ReactElement);
      expect(doc.querySelector('[role="tooltip"]')).toBeNull();
      await act(async () => {
        (container.querySelector("button[data-provenance-file]") as HTMLButtonElement).focus();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(doc.querySelector('[role="tooltip"]')?.textContent).toBe(`${PROV.path} — activate to copy ${REF}`);
      unmount();
    } finally {
      restoreUi();
    }
  });

  test("activation writes exactly file:line to the clipboard, then announces", async () => {
    const calls: string[] = [];
    restore = stubClipboard({
      writeText: (s: string) => {
        calls.push(s);
        return Promise.resolve();
      },
    });
    mountAnnouncer();
    const { container, unmount } = await dom.mount(createElement(ProvenanceChip, { provenance: PROV }) as ReactElement);
    (container.querySelector("button") as HTMLButtonElement).click();
    const want = `Copied ${REF} to clipboard`;
    await waitFor(politeText, want);
    expect(calls).toEqual([REF]);
    expect(politeText()).toBe(want);
    unmount();
  });

  test("a rejected writeText is caught silently and announces nothing", async () => {
    const calls: string[] = [];
    restore = stubClipboard({
      writeText: (s: string) => {
        calls.push(s);
        return Promise.reject(new Error("denied"));
      },
    });
    mountAnnouncer();
    const before = politeText();
    await expect(copyProvenance({ ...PROV, line: 9 })).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual(["estate/hosts.yaml:9"]);
    expect(politeText()).toBe(before);
  });

  test("a missing Clipboard API (or non-function writeText) is a benign no-op", async () => {
    restore = stubClipboard(undefined);
    await expect(copyProvenance(PROV)).resolves.toBeUndefined();
    restore();
    restore = stubClipboard({ writeText: "nope" });
    await expect(copyProvenance(PROV)).resolves.toBeUndefined();
    const { container, unmount } = await dom.mount(createElement(ProvenanceChip, { provenance: PROV }) as ReactElement);
    expect(() => (container.querySelector("button") as HTMLButtonElement).click()).not.toThrow();
    unmount();
  });

  test("source performs no fetch/file access and adds no icon", () => {
    const src = readFileSync(
      new URL("../src/client/views/estate/provenance-chip.tsx", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|node:fs|window\.open|icons\./);
  });
});
