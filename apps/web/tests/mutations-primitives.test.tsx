// mutations-primitives.test.tsx — Field / ActionButton / StateBadge / PendingMarker / AckInfo on the @/ui
// library (REQ-UX-03, REQ-UX-04, REQ-A11Y-03, REQ-A11Y-04). Role/aria/data-* queries only.
import { expect, mock, test } from "bun:test";
import { useState } from "react";
import type { ReactElement } from "react";

import { MUTATION_STATE } from "@/ui";
import { ActionButton } from "../src/client/mutations/ActionButton.js";
import { AckInfo } from "../src/client/mutations/AckInfo.js";
import type { AckView } from "../src/client/mutations/AckInfo.js";
import { Checkbox, RadioGroup, TextArea, TextField } from "../src/client/mutations/Field.js";
import { pendingTracker } from "../src/client/mutations/pending.js";
import type { PendingTarget } from "../src/client/mutations/pending.js";
import { PendingMarker, StateBadge } from "../src/client/mutations/StateBadge.js";
import type { ActionState } from "../src/client/mutations/StateBadge.js";
import { PENDING_STALE_MS } from "../src/shared/mutations.js";
import { act, describeUi, render, screen, userEvent, within } from "./rtl.js";

const noop = (): void => undefined;

/** The ids listed in an element's aria-describedby. */
function describedIds(el: Element): string[] {
  return (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
}

describeUi("Field primitives: label, hint, error and counter wiring (REQ-A11Y-03)", () => {
  test("a TextArea with an error is aria-invalid and described by its hint and the ⚠ error line", () => {
    render(<TextArea label="Rationale" name="rationale" value="x" onInput={noop} error="Too short" hint="Visible to all" />);
    const ta = screen.getByRole("textbox", { name: "Rationale" });
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta).toHaveAttribute("aria-invalid", "true");
    const ids = describedIds(ta);
    const err = screen.getByText("Too short").closest("p")!;
    expect(err.id).not.toBe("");
    expect(ids).toContain(err.id);
    expect(err.textContent).toBe("⚠ Too short");
    // The ⚠ glyph is decorative (non-colour cue, aria-hidden).
    expect(err.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(err.firstElementChild!.textContent).toContain("⚠");
    expect(ids[0]).toBe(screen.getByText("Visible to all").id);
    expect(ta).toHaveAccessibleDescription("Visible to all Too short");
    expect(ta.closest("[data-field]")).toHaveAttribute("data-field", "rationale");
  });

  test("a TextArea without an error has no aria-invalid and no error line", () => {
    render(<TextArea label="Note" name="note" value="" onInput={noop} error={null} />);
    const ta = screen.getByRole("textbox", { name: "Note" });
    expect(ta).not.toHaveAttribute("aria-invalid");
    expect(ta).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText("⚠", { exact: false })).toBeNull();
  });

  test("TextArea counter: 'N <unit> left', 'N <unit> over the limit', aria-live polite past 90%", () => {
    const mk = (used: number) =>
      render(<TextArea label="Rationale" name="rationale" value="" onInput={noop} error={null}
        counter={{ used, limit: 100, unit: "bytes" }} />);
    const a = mk(10);
    const ca = screen.getByText("90 bytes left");
    expect(ca).toHaveAttribute("aria-live", "off");
    expect(describedIds(screen.getByRole("textbox", { name: "Rationale" }))).toContain(ca.id);
    a.unmount();

    const b = mk(95);
    expect(screen.getByText("5 bytes left")).toHaveAttribute("aria-live", "polite");
    b.unmount();

    mk(103);
    const cc = screen.getByText("3 bytes over the limit");
    expect(cc).toHaveAttribute("aria-live", "polite");
    expect(cc).toHaveAttribute("data-over", "true");
  });

  test("TextField: '(required)' label, aria-invalid with the error id, input reported", async () => {
    const seen: string[] = [];
    render(<TextField label="Ends at" name="endsAt" value="" onInput={(v) => seen.push(v)} error="In the past" required />);
    const input = screen.getByRole("textbox", { name: "Ends at (required)" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(describedIds(input)).toContain(screen.getByText("In the past").closest("p")!.id);
    expect(input.closest("[data-field]")).toHaveAttribute("data-field", "endsAt");
    await userEvent.type(input, "a");
    expect(seen).toEqual(["a"]);
  });

  test("TextField without an error or hint has neither aria-invalid nor aria-describedby", () => {
    render(<TextField label="Comment" name="comment" value="" onInput={noop} error={null} />);
    const input = screen.getByRole("textbox", { name: "Comment" });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
  });
});

/**
 * An arrow key held across a tick, as a real key press is: Radix roving focus moves focus on a timer after
 * keydown, and a radio only selects on focus while the arrow key is still down.
 */
async function arrow(key: "ArrowDown" | "ArrowUp"): Promise<void> {
  await userEvent.keyboard(`{${key}>}`);
  await act(() => new Promise<void>((r) => setTimeout(r, 0)));
  await userEvent.keyboard(`{/${key}}`);
}

describeUi("Checkbox and RadioGroup (REQ-A11Y-03)", () => {
  test("a locked Checkbox is aria-disabled (not disabled), focusable, described by its reason, and never toggles", async () => {
    const onChange = mock((_v: boolean) => undefined);
    render(<Checkbox label="alertname" checked onChange={onChange} locked lockedReason="alertname is always included" />);
    const box = screen.getByRole("checkbox", { name: "alertname" });
    expect(box).toHaveAttribute("aria-disabled", "true");
    expect(box).not.toHaveAttribute("disabled");
    expect(box).toHaveAttribute("aria-checked", "true");
    act(() => box.focus());
    expect(document.activeElement).toBe(box);
    await userEvent.click(box);
    await userEvent.keyboard(" ");
    await userEvent.click(screen.getByText("alertname"));
    expect(box).toHaveAttribute("aria-checked", "true");
    expect(onChange).not.toHaveBeenCalled();
    expect(box).toHaveAccessibleDescription("alertname is always included");
  });

  test("an unlocked Checkbox reports changes, by click on the box or its label", async () => {
    function Harness(): ReactElement {
      const [on, setOn] = useState(true);
      return <Checkbox label="severity" checked={on} onChange={setOn} />;
    }
    render(<Harness />);
    const box = screen.getByRole("checkbox", { name: "severity" });
    expect(box).not.toHaveAttribute("aria-disabled");
    await userEvent.click(box);
    expect(box).toHaveAttribute("aria-checked", "false");
    await userEvent.click(screen.getByText("severity"));
    expect(box).toHaveAttribute("aria-checked", "true");
  });

  test("a Checkbox error sets aria-invalid and joins aria-describedby", () => {
    render(<Checkbox label="team" checked onChange={noop} error="Cannot be sent" />);
    const box = screen.getByRole("checkbox", { name: "team" });
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(box).toHaveAccessibleDescription("Cannot be sent");
  });

  test("RadioGroup: the visible label names the only group, one option checked, error described, arrow keys move the selection", async () => {
    type D = "1h" | "2h" | "4h";
    function Harness(): ReactElement {
      const [v, setV] = useState<D>("2h");
      return (
        <RadioGroup<D> legend="Duration" name="preset" value={v} onChange={setV} error="Pick one"
          options={[{ value: "1h", label: "1 hour" }, { value: "2h", label: "2 hours" }, { value: "4h", label: "4 hours" }]} />
      );
    }
    render(<Harness />);
    const group = screen.getByRole("radiogroup", { name: "Duration" });
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent).toBe("Duration");
    // One grouping only: no fieldset/group wrapper repeating the radiogroup's name.
    expect(group.closest("fieldset")).toBeNull();
    expect(screen.queryByRole("group", { name: "Duration" })).toBeNull();
    expect(group).toHaveAccessibleDescription("Pick one");
    const radio = (name: string): HTMLElement => within(group).getByRole("radio", { name });
    expect(within(group).getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(within(group).getAllByRole("radio").every((r) => r.getAttribute("aria-invalid") === "true")).toBe(true);

    await userEvent.click(radio("1 hour"));
    expect(radio("1 hour")).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(radio("1 hour"));

    await arrow("ArrowDown");
    expect(radio("2 hours")).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(radio("2 hours"));
    await arrow("ArrowDown");
    expect(radio("4 hours")).toHaveAttribute("aria-checked", "true");
    await arrow("ArrowUp");
    expect(radio("2 hours")).toHaveAttribute("aria-checked", "true");
    expect(radio("4 hours")).toHaveAttribute("aria-checked", "false");
  });

  test("RadioGroup without an error has no aria-describedby and no aria-invalid", () => {
    render(<RadioGroup<"a" | "b"> legend="Pick" name="p" value="a" onChange={noop}
      options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} />);
    const group = screen.getByRole("radiogroup", { name: "Pick" });
    expect(group).not.toHaveAttribute("aria-describedby");
    expect(within(group).getAllByRole("radio").some((r) => r.hasAttribute("aria-invalid"))).toBe(false);
  });
});

describeUi("ActionButton busy/loading state (REQ-UX-03)", () => {
  test("a busy ActionButton is aria-busy + aria-disabled, never disabled, keeps focus, and does not call onClick", async () => {
    const onClick = mock(() => undefined);
    const view = render(<ActionButton onClick={onClick} icon="bell">Silence…</ActionButton>);
    const btn = screen.getByRole("button", { name: "Silence…" });
    expect(btn).not.toHaveAttribute("aria-busy");
    expect(btn).not.toHaveAttribute("aria-disabled");
    act(() => btn.focus());
    expect(document.activeElement).toBe(btn);

    view.rerender(<ActionButton busy onClick={onClick} icon="bell">Silence…</ActionButton>);
    const busy = screen.getByRole("button", { name: "Silence…" });
    expect(busy).toBe(btn);
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).not.toHaveAttribute("disabled");
    expect(document.activeElement).toBe(busy);
    // Every glyph inside is decorative.
    for (const svg of busy.querySelectorAll("svg")) expect(svg).toHaveAttribute("aria-hidden", "true");
    await userEvent.click(busy);
    await userEvent.keyboard("{Enter}");
    expect(onClick).not.toHaveBeenCalled();
  });

  test("a loading ActionButton (lazy chunk) is aria-busy + aria-disabled, focusable, and swallows clicks", async () => {
    const onClick = mock(() => undefined);
    render(<ActionButton loading onClick={onClick}>Acknowledge…</ActionButton>);
    const btn = screen.getByRole("button", { name: "Acknowledge…" });
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn).not.toHaveAttribute("disabled");
    act(() => btn.focus());
    expect(document.activeElement).toBe(btn);
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("an idle ActionButton uses its label override as the name and calls onClick", async () => {
    const onClick = mock(() => undefined);
    render(<ActionButton variant="danger" label="Expire silence s-1" onClick={onClick}>Expire…</ActionButton>);
    const btn = screen.getByRole("button", { name: "Expire silence s-1" });
    expect(btn).not.toHaveAttribute("aria-busy");
    expect(btn).not.toHaveAttribute("disabled");
    expect(btn).toHaveAttribute("data-variant", "destructive");
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("variants map onto the library: primary → default, secondary (the default) → outline", () => {
    render(<><ActionButton variant="primary" onClick={noop}>P</ActionButton><ActionButton onClick={noop}>S</ActionButton></>);
    expect(screen.getByRole("button", { name: "P" })).toHaveAttribute("data-variant", "default");
    expect(screen.getByRole("button", { name: "S" })).toHaveAttribute("data-variant", "outline");
  });
});

describeUi("StateBadge, PendingMarker and AckInfo (REQ-UX-04, REQ-A11Y-04)", () => {
  test("StateBadge renders a distinct glyph + visible label + data-state + tone per state", () => {
    const states: ActionState[] = ["acked", "pending", "failed"];
    const seen: { label: string; svg: string; tone: string }[] = [];
    for (const state of states) {
      const { container, unmount } = render(<StateBadge state={state} />);
      const root = container.querySelector<HTMLElement>(`[data-state="${state}"]`)!;
      expect(root).not.toBeNull();
      const badge = root.querySelector("[data-tone]")!;
      expect(badge.getAttribute("data-tone")).toBe(MUTATION_STATE[state].tone);
      expect(badge.textContent).toBe(MUTATION_STATE[state].label);
      const svg = badge.querySelector("svg")!;
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(within(root).queryByRole("button")).toBeNull();
      seen.push({ label: badge.textContent!, svg: svg.outerHTML, tone: badge.getAttribute("data-tone")! });
      unmount();
    }
    expect(new Set(seen.map((s) => s.label)).size).toBe(3);
    expect(new Set(seen.map((s) => s.svg)).size).toBe(3);
    expect(new Set(seen.map((s) => s.tone)).size).toBe(3);
  });

  test("StateBadge label override and a dismiss button named 'Dismiss: <label>'", async () => {
    const onDismiss = mock(() => undefined);
    const { container } = render(<StateBadge state="failed" label="Already expired" onDismiss={onDismiss} />);
    expect(container.querySelector('[data-state="failed"] [data-tone]')!.textContent).toBe("Already expired");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss: Already expired" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("PendingMarker: nothing → 'Pending' → 'Not yet reflected in live data' → dismissed", async () => {
    const target: PendingTarget = { kind: "alert", fingerprint: "fp-primitives-marker" };
    const { container } = render(<PendingMarker target={target} />);
    expect(container.innerHTML).toBe("");

    act(() => pendingTracker.add({ target, reflected: () => false, since: performance.now() }));
    expect(pendingTracker.stateOf(target, performance.now())).toBe("pending");
    expect(container.querySelector('[data-state="pending"]')!.textContent).toBe("Pending");
    expect(screen.queryByRole("button")).toBeNull();

    // Same-target add replaces the entry; a `since` in the past reaches not-reflected.
    act(() => pendingTracker.add({ target, reflected: () => false, since: performance.now() - PENDING_STALE_MS - 1 }));
    expect(pendingTracker.stateOf(target, performance.now())).toBe("not-reflected");
    expect(container.querySelector('[data-state="pending"] [data-tone]')!.textContent).toBe("Not yet reflected in live data");

    await userEvent.click(screen.getByRole("button", { name: "Dismiss: Not yet reflected in live data" }));
    expect(pendingTracker.stateOf(target, performance.now())).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  test("AckInfo: a labelled region with the acked badge and By / At / Note", () => {
    const ack = { by: "ops@example", at: "2026-10-01T10:00:00Z", note: "line one\nline two" } as AckView;
    render(<AckInfo ack={ack} />);
    const region = screen.getByRole("region", { name: "Acknowledgement" });
    expect(region.querySelector('[data-state="acked"]')).not.toBeNull();
    expect([...region.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["By", "At", "Note"]);
    expect(region.querySelector("time")).toHaveAttribute("datetime", ack.at);
    expect(within(region).getByText("ops@example")).not.toBeNull();
    expect(region.querySelectorAll("dd")[2]!.textContent).toBe("line one\nline two");
  });
});
