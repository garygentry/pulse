// apps/web/tests/a11y-announcer.test.ts — the singleton aria-live announcer (05 §4, REQ-A11Y-01).
// Wrapped in describeDom (tests/dom.ts) so happy-dom is registered per file.

import { expect, test } from "bun:test";

import { announce, mountAnnouncer } from "../src/client/a11y/announcer.js";
import { describeDom } from "./dom.js";

/** Poll `read()` until it is truthy-equal to `want`, or the budget elapses. The announcer writes on
 *  the next frame, so a plain read right after `announce()` would race. */
async function waitFor(read: () => string | null, want: string, budgetMs = 500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (read() === want) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describeDom("a11y announcer", (dom) => {
  test("mountAnnouncer inserts a single region with polite + assertive sub-regions", () => {
    const doc = dom.win.document;

    const root = mountAnnouncer();
    expect(root).not.toBeNull();
    expect(root!.id).toBe("pulse-a11y-announcer");

    // Idempotent: a second call returns the same node, no duplicate.
    const again = mountAnnouncer();
    expect(again).toBe(root);
    expect(doc.querySelectorAll("#pulse-a11y-announcer").length).toBe(1);

    // Polite + assertive live sub-regions exist.
    const polite = root!.querySelector('[aria-live="polite"]');
    const assertive = root!.querySelector('[aria-live="assertive"]');
    expect(polite).not.toBeNull();
    expect(assertive).not.toBeNull();
    expect(polite!.getAttribute("role")).toBe("status");
    expect(assertive!.getAttribute("role")).toBe("alert");
    expect(polite!.getAttribute("aria-atomic")).toBe("true");

    // Visually hidden via clip, NOT display:none.
    expect(root!.style.cssText).toContain("clip");
    expect(root!.style.cssText).not.toContain("display:none");
  });

  test("announce writes the message into the polite region on the next frame", async () => {
    const doc = dom.win.document;
    mountAnnouncer();

    announce("hello");
    await waitFor(
      () => doc.querySelector('#pulse-a11y-announcer [aria-live="polite"]')?.textContent ?? null,
      "hello",
    );
    expect(
      doc.querySelector('#pulse-a11y-announcer [aria-live="polite"]')!.textContent,
    ).toBe("hello");
  });

  test("announce(msg, 'assertive') writes into the assertive region", async () => {
    const doc = dom.win.document;
    mountAnnouncer();

    announce("urgent", "assertive");
    await waitFor(
      () =>
        doc.querySelector('#pulse-a11y-announcer [aria-live="assertive"]')?.textContent ?? null,
      "urgent",
    );
    expect(
      doc.querySelector('#pulse-a11y-announcer [aria-live="assertive"]')!.textContent,
    ).toBe("urgent");
  });

  test("empty / whitespace-only messages are ignored", async () => {
    const doc = dom.win.document;
    mountAnnouncer();
    const polite = doc.querySelector('#pulse-a11y-announcer [aria-live="polite"]')!;
    polite.textContent = "";

    announce("");
    announce("   ");
    // Give any (non-existent) scheduled write a chance to run.
    await new Promise((r) => setTimeout(r, 30));
    expect(polite.textContent).toBe("");
  });

  test("announce lazily mounts the region when absent", async () => {
    const doc = dom.win.document;
    // Remove any existing region so announce must mount.
    doc.getElementById("pulse-a11y-announcer")?.remove();
    expect(doc.getElementById("pulse-a11y-announcer")).toBeNull();

    announce("lazy");
    await waitFor(
      () => doc.querySelector('#pulse-a11y-announcer [aria-live="polite"]')?.textContent ?? null,
      "lazy",
    );
    expect(doc.getElementById("pulse-a11y-announcer")).not.toBeNull();
    expect(
      doc.querySelector('#pulse-a11y-announcer [aria-live="polite"]')!.textContent,
    ).toBe("lazy");
  });
});
