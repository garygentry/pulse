// apps/web/tests/ui-primitives-pulse.test.tsx — pulse-only primitives (RadioGroup, Textarea, Kbd)
// and the Button `loading` state.
import { expect, it, mock } from "bun:test";
import { useState } from "react";

import { Button, Kbd, KbdGroup, RadioGroup, RadioGroupItem, Textarea } from "@/ui";

import { describeUi, render, screen, userEvent, waitFor } from "./rtl.js";

describeUi("RadioGroup", () => {
  function Density({ onValueChange }: { onValueChange?: (value: string) => void }) {
    return (
      <form aria-label="settings">
        <RadioGroup
          aria-label="Density"
          name="density"
          defaultValue="comfortable"
          {...(onValueChange !== undefined ? { onValueChange } : {})}
        >
          <RadioGroupItem value="compact" aria-label="Compact" />
          <RadioGroupItem value="comfortable" aria-label="Comfortable" />
          <RadioGroupItem value="spacious" aria-label="Spacious" />
        </RadioGroup>
      </form>
    );
  }

  it("renders a radiogroup with the default value checked", () => {
    render(<Density />);
    const group = screen.getByRole("radiogroup", { name: "Density" });
    expect(group).toHaveAttribute("data-slot", "radio-group");
    expect(screen.getByRole("radio", { name: "Comfortable" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Compact" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Compact" })).toHaveAttribute("value", "compact");
  });

  it("uses a roving tabindex and selects with the arrow keys", async () => {
    const onValueChange = mock();
    render(<Density onValueChange={onValueChange} />);

    await userEvent.tab();
    const comfortable = screen.getByRole("radio", { name: "Comfortable" });
    expect(comfortable).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Compact" })).toHaveAttribute("tabindex", "-1");

    // Radix checks the item focused while an arrow key is held down; focus moves on a timer.
    await userEvent.keyboard("{ArrowDown>}");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Spacious" })).toHaveFocus());
    await userEvent.keyboard("{/ArrowDown}");
    const spacious = screen.getByRole("radio", { name: "Spacious" });
    expect(spacious).toHaveFocus();
    expect(spacious).toBeChecked();
    expect(onValueChange).toHaveBeenLastCalledWith("spacious");

    await userEvent.keyboard("{ArrowUp>}");
    await waitFor(() => expect(comfortable).toHaveFocus());
    await userEvent.keyboard("{/ArrowUp}");
    expect(comfortable).toBeChecked();
    expect(onValueChange).toHaveBeenLastCalledWith("comfortable");
  });

  it("submits its name/value with the form", async () => {
    render(<Density />);
    await userEvent.click(screen.getByRole("radio", { name: "Compact" }));
    const form = screen.getByRole("form", { name: "settings" }) as HTMLFormElement;
    const input = form.querySelector('input[name="density"]:checked') as HTMLInputElement | null;
    expect(input?.value).toBe("compact");
  });
});

describeUi("Textarea", () => {
  it("is a controlled textbox", async () => {
    const seen: string[] = [];
    function Notes() {
      const [value, setValue] = useState("");
      return (
        <Textarea
          aria-label="Notes"
          value={value}
          onChange={(event) => {
            seen.push(event.target.value);
            setValue(event.target.value.toUpperCase());
          }}
        />
      );
    }
    render(<Notes />);
    const box = screen.getByRole("textbox", { name: "Notes" });
    expect(box.tagName).toBe("TEXTAREA");
    expect(box).toHaveAttribute("data-slot", "textarea");
    await userEvent.type(box, "ab");
    expect(box).toHaveValue("AB");
    expect(seen).toEqual(["a", "Ab"]);
  });
});

describeUi("Kbd", () => {
  it("renders <kbd> elements, grouped by KbdGroup", () => {
    render(
      <KbdGroup data-testid="combo">
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>,
    );
    const key = screen.getByText("K");
    expect(key.tagName).toBe("KBD");
    expect(key).toHaveAttribute("data-slot", "kbd");
    const group = screen.getByTestId("combo");
    expect(group.tagName).toBe("KBD");
    expect(group).toHaveAttribute("data-slot", "kbd-group");
  });
});

describeUi("Button loading", () => {
  it("keeps focus, exposes aria-busy/aria-disabled, shows a spinner and swallows clicks", async () => {
    const onClick = mock();
    const { rerender } = render(<Button onClick={onClick}>Acknowledge</Button>);
    const button = screen.getByRole("button", { name: "Acknowledge" });
    button.focus();
    expect(document.activeElement).toBe(button);

    rerender(
      <Button onClick={onClick} loading>
        Acknowledge
      </Button>,
    );
    const busy = screen.getByRole("button", { name: "Acknowledge" });
    expect(busy).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(busy).not.toHaveAttribute("disabled");
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).toHaveAttribute("data-loading");
    const spinner = busy.querySelector('[data-slot="button-spinner"]');
    expect(spinner).not.toBeNull();
    expect(spinner).toHaveAttribute("aria-hidden", "true");

    await userEvent.click(busy);
    await userEvent.keyboard("{Enter}");
    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);

    rerender(<Button onClick={onClick}>Acknowledge</Button>);
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not submit its form while loading", async () => {
    const onSubmit = mock((event: { preventDefault(): void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading>
          Save
        </Button>
      </form>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("leaves a non-loading Button unchanged", async () => {
    const onClick = mock();
    render(
      <Button onClick={onClick} loading={false}>
        Refresh
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Refresh" });
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).not.toHaveAttribute("data-loading");
    expect(button.querySelector('[data-slot="button-spinner"]')).toBeNull();
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
