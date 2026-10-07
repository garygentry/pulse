// apps/web/tests/a11y-shortcuts.test.ts — the keyboard-shortcut registry (05 §6, REQ-A11Y-02).
// Wrapped in describeDom (tests/dom.ts) so happy-dom is registered per file.

import { expect, test } from "bun:test";

import { ShortcutRegistry } from "../src/client/a11y/shortcuts.js";
import { describeDom } from "./dom.js";

/** Detect macOS the same way the registry does, so the "mod" test dispatches the right modifier. */
function detectMac(win: { navigator?: { platform?: string } }): boolean {
  const platform = win.navigator?.platform ?? "";
  return platform.includes("Mac");
}

describeDom("a11y shortcuts", (dom) => {
  test("register('ctrl+k') fires on Ctrl-K; disposer unregisters exactly that handler", () => {
    const doc = dom.win.document;
    const registry = new ShortcutRegistry();
    registry.start();

    let fires = 0;
    const dispose = registry.register("ctrl+k", () => {
      fires += 1;
    });

    doc.dispatchEvent(new dom.win.KeyboardEvent("keydown", { ctrlKey: true, key: "k" }));
    expect(fires).toBe(1);

    dispose();
    // Idempotent disposer.
    dispose();

    doc.dispatchEvent(new dom.win.KeyboardEvent("keydown", { ctrlKey: true, key: "k" }));
    expect(fires).toBe(1);

    registry.stop();
  });

  test("a throwing handler is caught; later handlers on the same combo still run", () => {
    const doc = dom.win.document;
    const registry = new ShortcutRegistry();
    registry.start();

    // Silence the expected console.error from the throwing handler.
    const originalError = console.error;
    console.error = () => {};

    let secondRan = false;
    registry.register("ctrl+j", () => {
      throw new Error("boom");
    });
    registry.register("ctrl+j", () => {
      secondRan = true;
    });

    doc.dispatchEvent(new dom.win.KeyboardEvent("keydown", { ctrlKey: true, key: "j" }));
    console.error = originalError;

    expect(secondRan).toBe(true);
    registry.stop();
  });

  test("shortcuts do not fire in an input unless allowInInput is set", () => {
    const doc = dom.win.document;
    const registry = new ShortcutRegistry();
    registry.start();

    const input = doc.createElement("input");
    doc.body.appendChild(input);
    input.focus();
    expect(doc.activeElement).toBe(input);

    let guarded = 0;
    let allowed = 0;
    registry.register("ctrl+k", () => {
      guarded += 1;
    });
    registry.register("ctrl+l", () => {
      allowed += 1;
    }, { allowInInput: true });

    doc.dispatchEvent(new dom.win.KeyboardEvent("keydown", { ctrlKey: true, key: "k" }));
    doc.dispatchEvent(new dom.win.KeyboardEvent("keydown", { ctrlKey: true, key: "l" }));

    expect(guarded).toBe(0); // skipped while focus is in the input
    expect(allowed).toBe(1); // allowInInput overrides the guard

    input.remove();
    registry.stop();
  });

  test("'mod+k' fires with the platform-appropriate modifier", () => {
    const doc = dom.win.document;
    const registry = new ShortcutRegistry();
    registry.start();

    let fires = 0;
    registry.register("mod+k", () => {
      fires += 1;
    });

    const mac = detectMac(dom.win as unknown as { navigator?: { platform?: string } });
    const init = mac ? { metaKey: true, key: "k" } : { ctrlKey: true, key: "k" };
    doc.dispatchEvent(new dom.win.KeyboardEvent("keydown", init));

    expect(fires).toBe(1);
    registry.stop();
  });

  test("stop() clears registrations and detaches the listener", () => {
    const doc = dom.win.document;
    const registry = new ShortcutRegistry();
    registry.start();

    let fires = 0;
    registry.register("ctrl+m", () => {
      fires += 1;
    });
    registry.stop();

    doc.dispatchEvent(new dom.win.KeyboardEvent("keydown", { ctrlKey: true, key: "m" }));
    expect(fires).toBe(0);
  });
});
