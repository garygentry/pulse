// apps/web/tests/mutations-dialog-frame.test.tsx — the Radix frame of the lazy mutation dialogs: accessible
// name, focus return to the invoking trigger on Esc / Cancel (also when the parent unmounts the dialog on
// close), and no dismissal while a submit is in flight.
import { afterEach, expect, it } from "bun:test";
import { useState } from "react";
import type { ReactElement } from "react";
import type { ActiveAlert, ActiveSilence } from "@pulse/web-data/wire";

import AckDialog from "../src/client/mutations/dialogs/AckDialog.js";
import ExpireDialog from "../src/client/mutations/dialogs/ExpireDialog.js";
import { ActionButton } from "../src/client/mutations/ActionButton.js";
import { MutationDialogFrame } from "../src/client/mutations/dialog-frame.js";
import { pendingTracker } from "../src/client/mutations/pending.js";
import { createAppStore } from "../src/client/store/index.js";
import type { AppStore } from "../src/client/store/index.js";
import { makeAlertsPayload } from "./alerts-fixtures.js";
import { getDialog, queryDialog } from "./mutations-dialog-dom.js";
import { describeUi, render, screen, userEvent, waitFor } from "./rtl.js";

type Role = "dialog" | "alertdialog";

/** The trigger pattern the views use: the dialog is rendered only while open, so closing unmounts it. */
function UnmountingHarness(p: { readonly role: Role }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      {open ? (
        <MutationDialogFrame open role={p.role} title="Frame title" onClose={() => setOpen(false)}
          actions={<ActionButton onClick={() => setOpen(false)}>Cancel</ActionButton>}>
          <label>Note <input name="note" /></label>
        </MutationDialogFrame>
      ) : null}
    </>
  );
}

/** A frame that stays mounted and is opened and closed by its `open` prop. */
function ToggleHarness(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      <MutationDialogFrame open={open} title="Frame title" onClose={() => setOpen(false)}
        actions={<ActionButton onClick={() => setOpen(false)}>Cancel</ActionButton>}>
        <label>Note <input name="note" /></label>
      </MutationDialogFrame>
    </>
  );
}

async function openFrom(name = "Open"): Promise<HTMLElement> {
  const trigger = screen.getByRole("button", { name });
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  return trigger;
}

describeUi("MutationDialogFrame: name, initial focus and focus return", () => {
  for (const role of ["dialog", "alertdialog"] as const) {
    it(`${role}: titled by its heading, focus moves inside on open`, async () => {
      render(<UnmountingHarness role={role} />);
      await openFrom();
      const dialog = await screen.findByRole(role, { name: "Frame title" });
      expect(screen.getByRole("heading", { level: 2, name: "Frame title" })).toBeInTheDocument();
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    });

    it(`${role}: Esc closes and returns focus to the element focused when it opened`, async () => {
      render(<UnmountingHarness role={role} />);
      const trigger = await openFrom();
      await screen.findByRole(role, { name: "Frame title" });
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
      await waitFor(() => expect(trigger).toHaveFocus());
    });

    it(`${role}: Cancel closes and returns focus to the element focused when it opened`, async () => {
      render(<UnmountingHarness role={role} />);
      const trigger = await openFrom();
      const dialog = await screen.findByRole(role, { name: "Frame title" });
      await userEvent.click(buttonIn(dialog, "Cancel"));
      await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
      await waitFor(() => expect(trigger).toHaveFocus());
    });
  }

  it("a frame kept mounted and toggled by `open` also returns focus on Esc", async () => {
    render(<ToggleHarness />);
    const trigger = await openFrom();
    await screen.findByRole("dialog", { name: "Frame title" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

function buttonIn(root: HTMLElement, name: string): HTMLButtonElement {
  const b = [...root.querySelectorAll("button")].find((x) => x.textContent?.trim() === name);
  if (b === undefined) throw new Error(`no button "${name}"`);
  return b;
}

// ---------------------------------------------------------------------------
// In flight: not dismissable
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let release: (() => void) | null = null;

/** Every POST hangs until `release()`; then it answers with `result`. */
function gateFetch(result: unknown): void {
  globalThis.fetch = (async () => {
    await new Promise<void>((r) => { release = r; });
    return new Response(JSON.stringify({ outcome: "succeeded", requestId: "r", result }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  release?.();
  release = null;
  globalThis.fetch = realFetch;
});

/** Poll on real timers, outside act(). */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error("until: condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function newStore(): AppStore {
  return createAppStore({ storage: null, initialQuery: {} });
}

const ALERT: ActiveAlert = (() => {
  const { ack: _drop, ...rest } = makeAlertsPayload({ scenario: "mixed" }).alerts[0]!;
  return { ...rest, fingerprint: "fp-frame-busy" };
})();

const SILENCE: ActiveSilence = {
  id: "sil-frame-busy",
  matchers: [{ name: "alertname", value: "DiskFull", isRegex: false, isEqual: true }],
  createdBy: "someone",
  comment: "",
  startsAt: "2026-09-22T11:00:00.000Z",
  endsAt: "2026-09-22T13:00:00.000Z",
  state: "active",
};

function BusyHarness(p: { readonly which: "ack" | "expire"; readonly onClose: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const close = (): void => { p.onClose(); setOpen(false); };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      {open && p.which === "ack"
        ? <AckDialog store={newStore()} alert={ALERT} open onClose={close} onDone={() => undefined} /> : null}
      {open && p.which === "expire"
        ? <ExpireDialog store={newStore()} silence={SILENCE} open onClose={close} onDone={() => undefined} /> : null}
    </>
  );
}

describeUi("mutation dialogs are not dismissable while a submit is in flight", () => {
  const cases = [
    { which: "ack", role: "dialog", name: `Acknowledge ${ALERT.name}`, submit: "Acknowledge",
      result: { fingerprint: ALERT.fingerprint, at: "2026-09-22T12:00:00.000Z" }, target: { kind: "alert", fingerprint: ALERT.fingerprint } },
    { which: "expire", role: "alertdialog", name: "Expire silence", submit: "Expire silence",
      result: { silenceId: SILENCE.id }, target: { kind: "silence", silenceId: SILENCE.id } },
  ] as const;

  for (const c of cases) {
    it(`${c.which}: Esc does not close while busy; it closes after the reply and focus returns`, async () => {
      gateFetch(c.result);
      let closed = 0;
      render(<BusyHarness which={c.which} onClose={() => { closed += 1; }} />);
      const trigger = await openFrom();
      await until(() => queryDialog() !== null);
      const dialog = getDialog(c.name);
      expect(dialog.getAttribute("role")).toBe(c.role);
      const submit = buttonIn(dialog, c.submit);
      submit.focus();
      await userEvent.keyboard("{Enter}");
      await until(() => submit.getAttribute("aria-busy") === "true");

      await userEvent.keyboard("{Escape}");
      await new Promise((r) => setTimeout(r, 20));
      expect(queryDialog()).toBe(dialog);
      expect(closed).toBe(0);

      release?.();
      await until(() => queryDialog() === null);
      expect(closed).toBe(1);
      await until(() => document.activeElement === trigger);
      pendingTracker.dismiss(c.target);
    });
  }
});
