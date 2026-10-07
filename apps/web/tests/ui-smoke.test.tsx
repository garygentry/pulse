// apps/web/tests/ui-smoke.test.tsx — ported from deck's `ui-smoke` suite (vendored `@/ui`).
import { expect, it, mock } from "bun:test";

import { Button, cn } from "@/ui";

import { describeUi, render, screen, userEvent } from "./rtl.js";

describeUi("@/ui foundation", () => {
  it("renders a Button primitive as an accessible, clickable button", async () => {
    const onClick = mock();
    render(
      <Button variant="outline" size="sm" onClick={onClick}>
        Refresh
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Refresh" });
    expect(button).toHaveAttribute("data-slot", "button");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders Button asChild onto the child element", () => {
    render(
      <Button asChild>
        <a href="/hosts">Hosts</a>
      </Button>,
    );

    expect(screen.getByRole("link", { name: "Hosts" })).toHaveAttribute("data-slot", "button");
  });

  it("cn merges conflicting Tailwind utilities, last one wins", () => {
    expect(cn("px-2 py-1", false && "hidden", "px-4")).toBe("py-1 px-4");
  });
});
