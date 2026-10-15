// apps/web/tests/ui-scroll-region.test.tsx — the pulse-only ScrollRegion pattern (#51): a named,
// focusable region only while its content overflows, and it keeps its tab stop while focused.
import { afterEach, beforeEach, expect, it } from "bun:test";

import { ScrollRegion } from "@/ui";

import { act, describeUi, render, screen } from "./rtl.js";

/** happy-dom lays nothing out, so the scroller's widths come from here. */
const size = { content: 0, box: 0 };
const restore: (() => void)[] = [];

function stubWidth(name: "scrollWidth" | "clientWidth", pick: () => number): void {
  const proto = window.HTMLElement.prototype;
  const own = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, name, {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("data-slot") === "scroll-region" ? pick() : 0;
    },
  });
  restore.push(() => {
    if (own !== undefined) Object.defineProperty(proto, name, own);
    else delete (proto as unknown as Record<string, unknown>)[name];
  });
}

describeUi("ScrollRegion", () => {
  beforeEach(() => {
    stubWidth("scrollWidth", () => size.content);
    stubWidth("clientWidth", () => size.box);
  });
  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
  });

  const chart = (n: number) => (
    <ScrollRegion label="Status chart">
      <svg aria-hidden="true" width={n} />
    </ScrollRegion>
  );

  it("is a plain box (no role, name or tab stop) while the content fits", () => {
    Object.assign(size, { content: 300, box: 400 });
    const { container } = render(chart(300));
    const root = container.querySelector('[data-slot="scroll-region"]')!;
    expect(screen.queryByRole("region")).toBeNull();
    expect(root).not.toHaveAttribute("tabindex");
    expect(root).toHaveAttribute("data-overflowing", "false");
  });

  it("is a named, focusable region while the content overflows, and plain again once it fits", () => {
    Object.assign(size, { content: 560, box: 300 });
    const { rerender } = render(chart(560));
    const region = screen.getByRole("region", { name: "Status chart" });
    expect(region).toHaveAttribute("tabindex", "0");
    Object.assign(size, { content: 560, box: 600 });
    rerender(chart(561)); // a commit re-measures
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("keeps its tab stop while focused when it stops overflowing, and drops it on blur", () => {
    Object.assign(size, { content: 560, box: 300 });
    const { rerender } = render(
      <>
        {chart(560)}
        <button type="button">After</button>
      </>,
    );
    const region = screen.getByRole("region", { name: "Status chart" });
    act(() => region.focus());
    expect(document.activeElement).toBe(region);

    // The pane widens: the chart fits now, but focus must not fall to <body>.
    Object.assign(size, { content: 560, box: 1200 });
    rerender(
      <>
        {chart(561)}
        <button type="button">After</button>
      </>,
    );
    expect(document.activeElement).toBe(region);
    expect(region).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("region", { name: "Status chart" })).toBe(region);

    act(() => screen.getByRole("button", { name: "After" }).focus());
    expect(region).not.toHaveAttribute("tabindex");
    expect(screen.queryByRole("region")).toBeNull();
  });
});
