// mutations-ack-dialog.test.ts — AckDialog and AckInfo (09 §6.1, §6.4, §7.2; REQ-ACK-01, REQ-ACK-05,
// REQ-UX-01, REQ-UX-03, REQ-SEC-07). `globalThis.fetch` is stubbed per test and restored in afterEach.
import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { ReactElement } from "react";
import type { ActiveAlert, AlertsPayload } from "@pulse/web-data/wire";

import AckDialog from "../src/client/mutations/dialogs/AckDialog.js";
import { ackNoteError } from "../src/client/mutations/dialog-models/ack-model.js";
import type { AckDialogProps } from "../src/client/mutations/dialogs/AckDialog.js";
import { AckInfo } from "../src/client/mutations/AckInfo.js";
import type { AckView } from "../src/client/mutations/AckInfo.js";
import { REASON_TEXT } from "../src/client/mutations/client.js";
import { pendingTracker } from "../src/client/mutations/pending.js";
import { createAppStore } from "../src/client/store/index.js";
import type { AppStore } from "../src/client/store/index.js";
import { ACK_NOTE_MAX_CHARS } from "../src/shared/mutations.js";
import { FIXTURE_ACK, makeAlertsPayload } from "./alerts-fixtures.js";
import { describeUi } from "./rtl.js";
import { setInputValue } from "./react-render.js";
import { mountDialog as mountOpenDialog } from "./mutations-dialog-dom.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE = makeAlertsPayload({ scenario: "mixed" });
const TEMPLATE = BASE.alerts[0]!;

function mkAlert(fingerprint: string, ack?: AckView): ActiveAlert {
  const { ack: _drop, ...rest } = TEMPLATE;
  return { ...rest, fingerprint, ...(ack !== undefined ? { ack } : {}) };
}

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------

interface Call { readonly url: string; readonly key: string | null; readonly body: Record<string, unknown> }
type Reply = { readonly status: number; readonly json: unknown };

const realFetch = globalThis.fetch;
let calls: Call[] = [];

function stubFetch(...replies: Reply[]): void {
  calls = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), key: headers.get("idempotency-key"), body: JSON.parse(String(init?.body ?? "null")) });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const ok = (result: unknown): Reply => ({ status: 200, json: { outcome: "succeeded", requestId: "req-ok", result } });
const refusal = (status: number, code: string, reason: string, fields?: string): Reply => ({
  status,
  json: { code, message: "catalog text", details: { reason, requestId: "req-bad", ...(fields !== undefined ? { fields } : {}) } },
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function flush(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function newStore(payload: AlertsPayload | null = BASE): AppStore {
  const store = createAppStore({ storage: null, initialQuery: {} });
  store.alerts.value = payload;
  return store;
}

interface Spies { done: unknown[]; closed: number }

function props(alert: ActiveAlert, spies: Spies): AckDialogProps {
  return { store: newStore(), alert, open: true, onClose: () => { spies.closed += 1; }, onDone: (r) => { spies.done.push(r); } };
}

function buttonTexts(root: ParentNode): string[] {
  return [...root.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "").filter((t) => t !== "");
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const b = [...root.querySelectorAll("button")].find((x) => x.textContent?.trim() === text);
  if (b === undefined) throw new Error(`no button "${text}"`);
  return b as HTMLButtonElement;
}

function typeInto(el: HTMLTextAreaElement, value: string): void {
  setInputValue(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function region(politeness: "polite" | "assertive"): string {
  return document.querySelector(`[data-politeness="${politeness}"]`)?.textContent ?? "";
}

async function mountDialog(dom: { mount(v: ReactElement): Promise<{ container: HTMLElement; unmount(): void }> }, alert: ActiveAlert) {
  const spies: Spies = { done: [], closed: 0 };
  const m = await mountOpenDialog(dom, createElement(AckDialog, props(alert, spies)) as ReactElement);
  return { ...m, spies };
}

// ---------------------------------------------------------------------------
// Pure rule
// ---------------------------------------------------------------------------

describe("ackNoteError — ≤ 280 code points, no control chars but \\n (REQ-ACK-01)", () => {
  test("empty and 280-code-point notes pass; 281 fails; emoji count as one", () => {
    expect(ackNoteError("")).toBeNull();
    expect(ackNoteError("a".repeat(ACK_NOTE_MAX_CHARS))).toBeNull();
    expect(ackNoteError("a".repeat(ACK_NOTE_MAX_CHARS + 1))).not.toBeNull();
    expect(ackNoteError("😀".repeat(ACK_NOTE_MAX_CHARS))).toBeNull();
    expect(ackNoteError(`  ${"a".repeat(ACK_NOTE_MAX_CHARS)}  `)).toBeNull(); // trimmed
  });
  test("\\n is allowed; \\t and U+0007 are refused", () => {
    expect(ackNoteError("line one\nline two")).toBeNull();
    expect(ackNoteError("tab\there")).not.toBeNull();
    expect(ackNoteError("bell\u0007")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AckInfo
// ---------------------------------------------------------------------------

describeUi("AckInfo renders inert text (REQ-ACK-01, REQ-SEC-07)", (dom) => {
  test("undefined ack renders nothing", async () => {
    const { container, unmount } = await dom.mount(createElement(AckInfo, { ack: undefined }) as ReactElement);
    expect(container.innerHTML).toBe("");
    unmount();
  });

  test("a note containing <b>x</b> renders as literal text; control chars become U+FFFD", async () => {
    const ack: AckView = { by: "Gary <b>x</b>", at: "2026-09-22T12:00:00.000Z", note: "see <b>x</b>\u0007\nline two" };
    const { container, unmount } = await dom.mount(createElement(AckInfo, { ack }) as ReactElement);
    expect(container.querySelector("b")).toBeNull();
    const note = [...container.querySelectorAll("dt")].find((d) => d.textContent === "Note")!.nextElementSibling!;
    expect(note.textContent).toBe("see <b>x</b>�\nline two");
    expect(container.textContent).toContain("Gary <b>x</b>");
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(ack.at);
    expect(container.querySelector("[data-state='acked']")).not.toBeNull();
    unmount();
  });

  test("a null note renders no Note row", async () => {
    const { container, unmount } = await dom.mount(createElement(AckInfo, { ack: { ...FIXTURE_ACK, note: null } }) as ReactElement);
    expect([...container.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["By", "At"]);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// AckDialog
// ---------------------------------------------------------------------------

describeUi("AckDialog set, remove and failures (REQ-ACK-01, REQ-ACK-05, REQ-UX-01, REQ-UX-03)", (dom) => {
  test("set ack POSTs /api/mutations/acks with fingerprint and omits an empty note; success adds a pending entry (REQ-UX-01)", async () => {
    const alert = mkAlert("fp-ack-set");
    stubFetch(ok({ fingerprint: alert.fingerprint, at: "2026-09-22T12:00:00.000Z" }));
    const { dialog, unmount, spies } = await mountDialog(dom, alert);
    expect(buttonTexts(dialog)).not.toContain("Remove acknowledgement");
    typeInto(dialog.querySelector("textarea")!, "   ");
    await flush();
    buttonByText(dialog, "Acknowledge").click();
    await flush(50);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("/api/mutations/acks");
    expect(calls[0]!.body).toEqual({ fingerprint: alert.fingerprint });
    expect(calls[0]!.key).not.toBeNull();
    expect(pendingTracker.stateOf({ kind: "alert", fingerprint: alert.fingerprint }, performance.now())).toBe("pending");
    expect(spies.done).toEqual([{ fingerprint: alert.fingerprint, at: "2026-09-22T12:00:00.000Z" }]);
    expect(spies.closed).toBe(1);
    expect(region("polite")).toContain("Alert acknowledged");
    pendingTracker.dismiss({ kind: "alert", fingerprint: alert.fingerprint });
    unmount();
  });

  test("a non-empty note is sent trimmed", async () => {
    const alert = mkAlert("fp-ack-note");
    stubFetch(ok({ fingerprint: alert.fingerprint, at: "2026-09-22T12:00:00.000Z" }));
    const { dialog, unmount } = await mountDialog(dom, alert);
    typeInto(dialog.querySelector("textarea")!, "  looking into it\nwill update  ");
    await flush();
    buttonByText(dialog, "Acknowledge").click();
    await flush(50);
    expect(calls[0]!.body).toEqual({ fingerprint: alert.fingerprint, note: "looking into it\nwill update" });
    pendingTracker.dismiss({ kind: "alert", fingerprint: alert.fingerprint });
    unmount();
  });

  test("a note > 280 code points blocks submit (no fetch) and marks the textarea invalid", async () => {
    const alert = mkAlert("fp-ack-long");
    stubFetch(ok({ fingerprint: alert.fingerprint, at: "2026-09-22T12:00:00.000Z" }));
    const { dialog, unmount, spies } = await mountDialog(dom, alert);
    typeInto(dialog.querySelector("textarea")!, "a".repeat(ACK_NOTE_MAX_CHARS + 1));
    await flush();
    buttonByText(dialog, "Acknowledge").click();
    await flush(20);
    expect(calls.length).toBe(0);
    expect(dialog.querySelector("textarea")!.getAttribute("aria-invalid")).toBe("true");
    expect(region("assertive")).toContain("Fix 1 field");
    expect(spies.closed).toBe(0);
    unmount();
  });

  test("double-clicked submit issues exactly one fetch (REQ-UX-03)", async () => {
    const alert = mkAlert("fp-ack-dbl");
    stubFetch(ok({ fingerprint: alert.fingerprint, at: "2026-09-22T12:00:00.000Z" }));
    const { dialog, unmount } = await mountDialog(dom, alert);
    const b = buttonByText(dialog, "Acknowledge");
    b.click();
    b.click();
    await flush(50);
    expect(calls.length).toBe(1);
    pendingTracker.dismiss({ kind: "alert", fingerprint: alert.fingerprint });
    unmount();
  });

  test("acked: shows AckInfo, and remove POSTs /acks/remove with a different Idempotency-Key than set (REQ-ACK-05)", async () => {
    const alert = mkAlert("fp-ack-rm", { by: "Gary Gentry", at: "2026-09-22T11:00:00.000Z", note: "earlier note" });
    // First replace fails with a non-stored reason (key kept), then remove succeeds.
    stubFetch(refusal(400, "INVALID_REQUEST", "invalid-body", "note"), ok({ fingerprint: alert.fingerprint, removed: true }));
    const { dialog, unmount, spies } = await mountDialog(dom, alert);
    expect(dialog.querySelector('section[aria-label="Acknowledgement"]')?.textContent).toContain("earlier note");
    buttonByText(dialog, "Replace acknowledgement").click();
    await flush(50);
    expect(calls[0]!.url).toBe("/api/mutations/acks");
    buttonByText(dialog, "Remove acknowledgement").click();
    await flush(50);
    expect(calls.length).toBe(2);
    expect(calls[1]!.url).toBe("/api/mutations/acks/remove");
    expect(calls[1]!.body).toEqual({ fingerprint: alert.fingerprint });
    expect(calls[1]!.key).not.toBeNull();
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
    expect(pendingTracker.stateOf({ kind: "alert", fingerprint: alert.fingerprint }, performance.now())).toBe("pending");
    expect(spies.done).toEqual([{ fingerprint: alert.fingerprint, removed: true }]);
    expect(spies.closed).toBe(1);
    pendingTracker.dismiss({ kind: "alert", fingerprint: alert.fingerprint });
    unmount();
  });

  test("replace after invalid-body reuses the set key and flags the note field (REQ-UX-03)", async () => {
    const alert = mkAlert("fp-ack-retry", FIXTURE_ACK);
    stubFetch(refusal(400, "INVALID_REQUEST", "invalid-body", "note"));
    const { dialog, unmount } = await mountDialog(dom, alert);
    buttonByText(dialog, "Replace acknowledgement").click();
    await flush(50);
    expect(dialog.querySelector("textarea")!.getAttribute("aria-invalid")).toBe("true");
    buttonByText(dialog, "Replace acknowledgement").click();
    await flush(50);
    expect(calls.length).toBe(2);
    expect(calls[1]!.key).toBe(calls[0]!.key);
    unmount();
  });

  test("removed:false announces there was nothing to remove and adds no pending entry", async () => {
    const alert = mkAlert("fp-ack-none", FIXTURE_ACK);
    stubFetch(ok({ fingerprint: alert.fingerprint, removed: false }));
    const { dialog, unmount, spies } = await mountDialog(dom, alert);
    buttonByText(dialog, "Remove acknowledgement").click();
    await flush(50);
    expect(region("polite")).toContain("There was no acknowledgement to remove.");
    expect(pendingTracker.stateOf({ kind: "alert", fingerprint: alert.fingerprint }, performance.now())).toBeNull();
    expect(spies.closed).toBe(1);
    unmount();
  });

  test("alert-not-firing shows the failure and leaves only Close", async () => {
    const alert = mkAlert("fp-ack-gone");
    stubFetch(refusal(404, "TARGET_NOT_FOUND", "alert-not-firing"));
    const { dialog, unmount, spies } = await mountDialog(dom, alert);
    buttonByText(dialog, "Acknowledge").click();
    await flush(50);
    const result = dialog.querySelector("[data-mut-result]")!;
    expect(result.textContent).toContain(REASON_TEXT["alert-not-firing"]);
    expect(result.querySelector("[data-state='failed']")).not.toBeNull();
    expect(region("assertive")).toContain(REASON_TEXT["alert-not-firing"]);
    const actionButtons = buttonTexts(dialog).filter((t) => t !== "" && !t.startsWith("Dismiss"));
    expect(actionButtons).toContain("Close");
    expect(actionButtons).not.toContain("Acknowledge");
    expect(actionButtons).not.toContain("Cancel");
    expect(dialog.querySelector("textarea")).toBeNull();
    expect(spies.closed).toBe(0);
    buttonByText(dialog, "Close").click();
    expect(spies.closed).toBe(1);
    unmount();
  });
});
