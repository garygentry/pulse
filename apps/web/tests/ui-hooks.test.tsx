// apps/web/tests/ui-hooks.test.tsx — ported from deck's `ui-hooks` suite (vendored `@/ui`).
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { useRef, useState } from "react";

import {
  cssEscape,
  formatDocumentTitle,
  hashTargetId,
  Input,
  isEditableTarget,
  useDocumentTitle,
  useListNavigation,
  useScrollToHash,
  type UseListNavigationOptions,
  type UseScrollToHashOptions,
} from "@/ui";

import { act, cleanup, describeUi, fireEvent, render, screen } from "./rtl.js";

describeUi("@/ui hooks", () => {
  // ---------------------------------------------------------------------------
  // useListNavigation — mounted behaviour (re-expresses the Hosts/Services list
  // window-listener tests, the portal mounted test, and the Portal/Monitoring
  // guard gap).
  // ---------------------------------------------------------------------------

  type FixtureProps = Partial<UseListNavigationOptions> & {
    names?: readonly string[];
    withSearch?: boolean;
    onOpen?: (name: string) => void;
  };

  function Fixture({ names = ["alpha", "bravo", "charlie"], withSearch = true, onOpen, ...options }: FixtureProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    useListNavigation({
      getItems: () => listRef.current?.querySelectorAll<HTMLElement>("a") ?? [],
      containerRef,
      ...(withSearch ? { getSearch: () => searchRef.current } : {}),
      ...options,
    });
    return (
      <>
        <button type="button">Outside</button>
        <div ref={containerRef}>
          <input type="search" aria-label="Search hosts" ref={searchRef} />
          <input type="checkbox" aria-label="fresh" />
          <ul ref={listRef}>
            {names.map((name) => (
              <li key={name}>
                <a
                  href={`/hosts/${name}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpen?.(name);
                  }}
                >
                  {name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </>
    );
  }

  /** Press a key on the focused element (or `target`); returns whether it was consumed. */
  function press(k: string, init: Partial<KeyboardEventInit> = {}, target?: Element): boolean {
    const el = target ?? document.activeElement ?? document.body;
    let consumed = false;
    act(() => {
      consumed = !fireEvent.keyDown(el, { key: k, ...init });
    });
    return consumed;
  }

  const active = (): string | null => document.activeElement?.textContent ?? null;
  const search = (): HTMLElement => screen.getByRole("searchbox", { name: "Search hosts" });

  describe("useListNavigation (window scope, vim)", () => {
    it("moves real DOM focus with arrows, j/k, Home, End and gg/G", () => {
      render(<Fixture />);
      expect(press("ArrowDown")).toBe(true);
      expect(active()).toBe("alpha");
      press("j");
      expect(active()).toBe("bravo");
      press("ArrowUp");
      expect(active()).toBe("alpha");
      press("End");
      expect(active()).toBe("charlie");
      press("Home");
      expect(active()).toBe("alpha");
      press("G");
      expect(active()).toBe("charlie");
      press("g");
      press("g");
      expect(active()).toBe("alpha");
    });

    it("uses no roving tabindex: items keep their own tab order", () => {
      render(<Fixture />);
      press("j");
      for (const link of screen.getAllByRole("link")) expect(link).not.toHaveAttribute("tabindex");
    });

    it("focuses the search field with / and Ctrl/Cmd-K from any state", () => {
      render(<Fixture />);
      expect(press("/")).toBe(true);
      expect(document.activeElement).toBe(search());
      press("j");
      expect(document.activeElement).toBe(search()); // typing stays in the field
      act(() => screen.getByRole("link", { name: "alpha" }).focus());
      press("k", { ctrlKey: true });
      expect(document.activeElement).toBe(search());
      press("K", { metaKey: true });
      expect(document.activeElement).toBe(search());
    });

    it("does not consume typing in the search field", () => {
      render(<Fixture />);
      act(() => search().focus());
      for (const k of ["a", "j", "/", "g", "G", "ArrowDown", "Home", "End"]) {
        expect(press(k)).toBe(false);
      }
      expect(document.activeElement).toBe(search());
    });

    it("runs onEscape from the search field and from the list", () => {
      const onEscape = mock();
      render(<Fixture onEscape={onEscape} />);
      act(() => search().focus());
      expect(press("Escape")).toBe(true);
      act(() => screen.getByRole("link", { name: "bravo" }).focus());
      expect(press("Escape")).toBe(true);
      expect(onEscape).toHaveBeenCalledTimes(2);
    });

    it("does not consume Escape when onEscape reports nothing to clear", () => {
      render(<Fixture onEscape={() => false} />);
      expect(press("Escape")).toBe(false);
    });

    it("opens the focused item on Enter, and the first item from search when enabled", () => {
      const onOpen = mock();
      render(<Fixture onOpen={onOpen} activateFirstFromSearch />);
      press("End");
      expect(press("Enter")).toBe(true);
      expect(onOpen).toHaveBeenLastCalledWith("charlie");
      press("/");
      expect(press("Enter")).toBe(true);
      expect(onOpen).toHaveBeenLastCalledWith("alpha");
    });

    it("leaves Enter in the search field alone unless activateFirstFromSearch is set", () => {
      const onOpen = mock();
      render(<Fixture onOpen={onOpen} />);
      press("/");
      expect(press("Enter")).toBe(false);
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("uses onActivate instead of click when given", () => {
      const onActivate = mock();
      const onOpen = mock();
      render(<Fixture onActivate={onActivate} onOpen={onOpen} />);
      press("j");
      press("j");
      press("Enter");
      expect(onActivate).toHaveBeenCalledWith(screen.getByRole("link", { name: "bravo" }), 1);
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("does not claim Enter when no item has focus", () => {
      const onOpen = mock();
      render(<Fixture onOpen={onOpen} />);
      expect(press("Enter")).toBe(false);
      act(() => screen.getByRole("button", { name: "Outside" }).focus());
      expect(press("Enter")).toBe(false);
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("stands aside for keys inside other controls, and never traps Tab", () => {
      render(<Fixture />);
      press("j");
      expect(active()).toBe("alpha");
      const checkbox = screen.getByRole("checkbox", { name: "fresh" });
      expect(press("ArrowDown", {}, checkbox)).toBe(false);
      expect(press(" ", {}, checkbox)).toBe(false);
      expect(active()).toBe("alpha");
      expect(press("Tab")).toBe(false);
    });

    it("has the editable guard built in with no search field (Portal/Monitoring gap)", () => {
      render(<Fixture withSearch={false} />);
      const field = screen.getByRole("searchbox", { name: "Search hosts" });
      act(() => field.focus());
      expect(press("j")).toBe(false);
      expect(press("/")).toBe(false);
      expect(press("k", { ctrlKey: true })).toBe(false);
      expect(document.activeElement).toBe(field);
    });

    it("passes modifier chords through", () => {
      render(<Fixture />);
      expect(press("a", { ctrlKey: true })).toBe(false);
      expect(press("j", { metaKey: true })).toBe(false);
      expect(press("j", { altKey: true })).toBe(false);
      expect(document.activeElement).toBe(document.body);
    });

    it("skips events another handler already consumed", () => {
      render(<Fixture />);
      const event = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
      event.preventDefault();
      act(() => void document.body.dispatchEvent(event));
      expect(document.activeElement).toBe(document.body);
    });

    it("treats movement and Enter as unclaimed no-ops over an empty list", () => {
      const onOpen = mock();
      render(<Fixture names={[]} onOpen={onOpen} />);
      expect(press("j")).toBe(false);
      expect(document.activeElement).toBe(document.body);
      expect(press("Enter")).toBe(false);
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("removes its window listener on unmount", () => {
      const spy = spyOn(window, "removeEventListener");
      const { unmount } = render(<Fixture />);
      unmount();
      expect(spy).toHaveBeenCalledWith("keydown", expect.any(Function));
      spy.mockRestore();
    });

    it("does nothing when disabled", () => {
      render(<Fixture enabled={false} />);
      expect(press("j")).toBe(false);
      expect(document.activeElement).toBe(document.body);
    });
  });

  describe("useListNavigation (grid)", () => {
    it("moves within a row with h/l and ←/→, and by a row with ↑/↓", () => {
      const names = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"];
      render(<Fixture names={names} grid={{ columns: () => 3 }} />);
      press("l");
      expect(active()).toBe("c1"); // first move lands on the first card
      press("ArrowRight");
      expect(active()).toBe("c2");
      press("ArrowDown");
      expect(active()).toBe("c5");
      press("ArrowDown"); // 8 is past the end: stay put
      expect(active()).toBe("c5");
      press("h");
      expect(active()).toBe("c4");
      press("ArrowUp");
      expect(active()).toBe("c1");
    });
  });

  describe("useListNavigation (element scope, arrows)", () => {
    it("handles keys only inside the container", () => {
      render(<Fixture keys="arrows" scope="element" />);
      const outside = screen.getByRole("button", { name: "Outside" });
      act(() => outside.focus());
      expect(press("ArrowDown")).toBe(false);
      expect(document.activeElement).toBe(outside);
      act(() => screen.getByRole("link", { name: "alpha" }).focus());
      expect(press("ArrowDown")).toBe(true);
      expect(active()).toBe("bravo");
    });

    it("activates with Space, and leaves g/G to the browser", () => {
      const onOpen = mock();
      render(<Fixture keys="arrows" scope="element" onOpen={onOpen} />);
      act(() => screen.getByRole("link", { name: "bravo" }).focus());
      expect(press(" ")).toBe(true);
      expect(onOpen).toHaveBeenCalledWith("bravo");
      expect(press("G")).toBe(false);
      expect(active()).toBe("bravo");
    });

    it("expands, collapses and toggles tree items", () => {
      const onExpand = mock();
      const onCollapse = mock();
      const onToggle = mock();
      render(
        <Fixture
          keys="arrows"
          scope="element"
          onExpand={onExpand}
          onCollapse={onCollapse}
          onToggle={onToggle}
        />,
      );
      const bravo = screen.getByRole("link", { name: "bravo" });
      act(() => bravo.focus());
      press("ArrowRight");
      press("ArrowLeft");
      press(" ");
      expect(onExpand).toHaveBeenCalledWith(bravo, 1);
      expect(onCollapse).toHaveBeenCalledWith(bravo, 1);
      expect(onToggle).toHaveBeenCalledWith(bravo, 1);
    });

    it("does not claim ← when only expansion is handled", () => {
      render(<Fixture keys="arrows" scope="element" onExpand={() => {}} />);
      act(() => screen.getByRole("link", { name: "alpha" }).focus());
      expect(press("ArrowLeft")).toBe(false);
    });

    it("treats an item that is itself a button as part of the list", () => {
      function Buttons() {
        const ref = useRef<HTMLDivElement>(null);
        useListNavigation({
          keys: "arrows",
          scope: "element",
          containerRef: ref,
          getItems: () => ref.current?.querySelectorAll<HTMLElement>("button") ?? [],
        });
        return (
          <div ref={ref}>
            <button type="button">one</button>
            <button type="button">two</button>
          </div>
        );
      }
      render(<Buttons />);
      act(() => screen.getByRole("button", { name: "one" }).focus());
      expect(press("ArrowDown")).toBe(true);
      expect(active()).toBe("two");
    });
  });

  // ---------------------------------------------------------------------------
  // isEditableTarget / cssEscape
  // ---------------------------------------------------------------------------

  describe("isEditableTarget", () => {
    it("is true for form controls and editable content", () => {
      const html = `
        <input id="i" /><input id="c" type="checkbox" /><select id="s"></select>
        <textarea id="t"></textarea><button id="b">b</button>
        <details><summary id="m">m</summary></details>
        <div contenteditable="true"><span id="e">x</span></div>`;
      document.body.innerHTML = html;
      for (const id of ["i", "c", "s", "t", "b", "m", "e"]) {
        expect(isEditableTarget(document.getElementById(id))).toBe(true);
      }
      document.body.innerHTML = "";
    });

    it("is true inside a listbox or menu, which own their keys", () => {
      document.body.innerHTML = `
        <div role="listbox" tabindex="-1" id="l"><div role="option" id="o">o</div></div>
        <div role="menu"><div role="menuitem" id="n">n</div></div>`;
      for (const id of ["l", "o", "n"]) {
        expect(isEditableTarget(document.getElementById(id))).toBe(true);
      }
      document.body.innerHTML = "";
    });

    it("is false for links, plain elements, the window and null", () => {
      document.body.innerHTML = `<a id="a" href="/x">x</a><div id="d" contenteditable="false">d</div>`;
      expect(isEditableTarget(document.getElementById("a"))).toBe(false);
      expect(isEditableTarget(document.getElementById("d"))).toBe(false);
      expect(isEditableTarget(document.body)).toBe(false);
      expect(isEditableTarget(window)).toBe(false);
      expect(isEditableTarget(null)).toBe(false);
      document.body.innerHTML = "";
    });
  });

  describe("cssEscape", () => {
    // Skipped: happy-dom's selector parser does not unescape `\"` / `\\` inside a quoted attribute
    // value, so `[data-nav-id="a\"b\\c"]` never matches even though it is valid CSS (it matches in
    // jsdom and browsers). The escaped string itself is checked below instead.
    it.skip("makes an odd id safe inside an attribute selector", () => {
      document.body.innerHTML = `<p data-nav-id='a"b\\c'>x</p>`;
      const id = 'a"b\\c';
      expect(document.querySelector(`[data-nav-id="${cssEscape(id)}"]`)).not.toBeNull();
      document.body.innerHTML = "";
    });

    it("backslash-escapes the quote and backslash of an odd id (pulse addition)", () => {
      expect(cssEscape('a"b\\c')).toBe('a\\"b\\\\c');
    });
  });

  // ---------------------------------------------------------------------------
  // useScrollToHash
  // ---------------------------------------------------------------------------

  describe("useScrollToHash", () => {
    const scrollIntoView = mock();
    // Stub the frame globals (and scrollIntoView) per test; restore them by hand.
    const g = globalThis as Record<string, unknown>;
    let saved: { scrollIntoView: unknown; raf: unknown; caf: unknown } | null = null;

    beforeEach(() => {
      scrollIntoView.mockClear();
      saved = {
        scrollIntoView: Element.prototype.scrollIntoView,
        raf: g["requestAnimationFrame"],
        caf: g["cancelAnimationFrame"],
      };
      Element.prototype.scrollIntoView = scrollIntoView;
      g["requestAnimationFrame"] = (cb: FrameRequestCallback): number => {
        cb(0);
        return 1;
      };
      g["cancelAnimationFrame"] = (): void => {};
    });

    afterEach(() => {
      if (saved !== null) {
        Element.prototype.scrollIntoView = saved.scrollIntoView as Element["scrollIntoView"];
        g["requestAnimationFrame"] = saved.raf;
        g["cancelAnimationFrame"] = saved.caf;
        saved = null;
      }
      window.history.replaceState(null, "", "/");
    });

    function Page(options: UseScrollToHashOptions) {
      useScrollToHash(options);
      return (
        <section id="alerts section" aria-label="Alerts">
          <h2>Alerts</h2>
        </section>
      );
    }

    it("scrolls to and focuses the fragment target on entry", () => {
      window.history.replaceState(null, "", "/monitoring#alerts%20section");
      render(<Page />);
      const target = screen.getByRole("region", { name: "Alerts" });
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
      expect(target).toHaveAttribute("tabindex", "-1");
      expect(document.activeElement).toBe(target);
    });

    it("only scrolls when focus is off", () => {
      window.history.replaceState(null, "", "/monitoring#alerts%20section");
      render(<Page focus={false} block="center" />);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
      expect(document.activeElement).toBe(document.body);
    });

    it("does nothing without a fragment or a matching element", () => {
      render(<Page />);
      cleanup();
      window.history.replaceState(null, "", "/monitoring#missing");
      render(<Page />);
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("decodes the fragment and never throws on a malformed one", () => {
      expect(hashTargetId("")).toBeNull();
      expect(hashTargetId("#")).toBeNull();
      expect(hashTargetId("#a%20b")).toBe("a b");
      expect(hashTargetId("#%E0%A4")).toBe("%E0%A4");
      expect(hashTargetId("plain")).toBe("plain");
    });
  });

  // ---------------------------------------------------------------------------
  // useDocumentTitle
  // ---------------------------------------------------------------------------

  describe("useDocumentTitle", () => {
    function Titled({ page }: { page: string | null }) {
      useDocumentTitle(page);
      return null;
    }

    it('sets "{page} · Pulse", follows changes, and restores on unmount', () => {
      document.title = "Before";
      const { rerender, unmount } = render(<Titled page="Hosts" />);
      expect(document.title).toBe("Hosts · Pulse");
      rerender(<Titled page="Drift" />);
      expect(document.title).toBe("Drift · Pulse");
      unmount();
      expect(document.title).toBe("Before");
    });

    it('falls back to "Pulse" without a page title', () => {
      expect(formatDocumentTitle(null)).toBe("Pulse");
      expect(formatDocumentTitle(undefined)).toBe("Pulse");
      expect(formatDocumentTitle("  ")).toBe("Pulse");
      expect(formatDocumentTitle(" Hosts ")).toBe("Hosts · Pulse");
    });
  });

  // ---------------------------------------------------------------------------
  // Workbench demo
  // ---------------------------------------------------------------------------

  // Deck renders its `_ui` workbench "hooks" section (`src/features/_ui/sections/hooks.tsx`); pulse
  // does not vendor the workbench, so this is a minimal copy of that section's `ListNavigationDemo`
  // (element scope, `arrows` keys, an editable field, a status line) without its styling.
  const DEMO_ITEMS = ["alpha.invalid", "bravo.invalid", "charlie.invalid", "delta.invalid"] as const;

  function ListNavigationDemo() {
    const containerRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const [activated, setActivated] = useState<string | null>(null);
    useListNavigation({
      keys: "arrows",
      scope: "element",
      containerRef,
      getItems: () => listRef.current?.querySelectorAll<HTMLElement>("button") ?? [],
    });
    return (
      <div ref={containerRef}>
        <Input aria-label="Editable field (keys pass through)" placeholder="Type j, k, Home…" />
        <ul ref={listRef} aria-label="Demo hosts">
          {DEMO_ITEMS.map((name) => (
            <li key={name}>
              <button type="button" onClick={() => setActivated(name)}>
                {name}
              </button>
            </li>
          ))}
        </ul>
        <p role="status">{activated === null ? "Nothing activated yet." : `Activated ${activated}.`}</p>
      </div>
    );
  }

  describe("hooks workbench section", () => {
    it("drives its demo list inside its own frame only", () => {
      render(<ListNavigationDemo />);
      const first = screen.getByRole("button", { name: "alpha.invalid" });
      // A key on the page body is not handled: element scope.
      expect(press("ArrowDown", {}, document.body)).toBe(false);
      act(() => first.focus());
      press("ArrowDown");
      expect(active()).toBe("bravo.invalid");
      press("Enter");
      expect(screen.getByRole("status")).toHaveTextContent("Activated bravo.invalid.");
      // The text field keeps its keys.
      const field = screen.getByRole("textbox", { name: /editable field/i });
      act(() => field.focus());
      expect(press("ArrowDown")).toBe(false);
      expect(document.activeElement).toBe(field);
    });
  });
});
