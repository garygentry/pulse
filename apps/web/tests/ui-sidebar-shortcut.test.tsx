// apps/web/tests/ui-sidebar-shortcut.test.tsx — the sidebar's Ctrl/Cmd-B toggle stands aside while
// focus is in a text field (input, textarea, select, contenteditable), and still works from buttons
// and the page (issue #12).
import { expect, it } from "bun:test";

import { Button, Input, SidebarProvider, Textarea, useSidebar } from "@/ui";

import { describeUi, render, screen, userEvent } from "./rtl.js";

function State() {
  const { state } = useSidebar();
  return <output aria-label="Sidebar state">{state}</output>;
}

function Harness() {
  return (
    <SidebarProvider defaultOpen>
      <State />
      <Input aria-label="Search" />
      <Textarea aria-label="Notes" />
      <select aria-label="Range">
        <option>1h</option>
      </select>
      <div role="textbox" aria-label="Rich text" contentEditable suppressContentEditableWarning tabIndex={0} />
      <input type="checkbox" aria-label="Pinned" />
      <Button type="button">Plain button</Button>
    </SidebarProvider>
  );
}

describeUi("Sidebar Ctrl/Cmd-B", () => {
  const state = (): string | null => screen.getByRole("status", { name: "Sidebar state" }).textContent;

  it("toggles from the page and from a button", async () => {
    render(<Harness />);
    expect(state()).toBe("expanded");
    await userEvent.keyboard("{Control>}b{/Control}");
    expect(state()).toBe("collapsed");
    screen.getByRole("button", { name: "Plain button" }).focus();
    await userEvent.keyboard("{Meta>}b{/Meta}");
    expect(state()).toBe("expanded");
    screen.getByRole("checkbox", { name: "Pinned" }).focus();
    await userEvent.keyboard("{Control>}b{/Control}");
    expect(state()).toBe("collapsed");
  });

  it("is ignored while focus is in an input, textarea, select or contenteditable", async () => {
    render(<Harness />);
    for (const field of [
      screen.getByRole("textbox", { name: "Search" }),
      screen.getByRole("textbox", { name: "Notes" }),
      screen.getByRole("combobox", { name: "Range" }),
      screen.getByRole("textbox", { name: "Rich text" }),
    ]) {
      field.focus();
      expect(field).toHaveFocus();
      await userEvent.keyboard("{Control>}b{/Control}");
      await userEvent.keyboard("{Meta>}b{/Meta}");
      expect(state()).toBe("expanded");
    }
  });
});
