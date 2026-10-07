// mutations-silence-dialog.test.ts — matchers.ts, SilenceDialog and ExpireDialog (09 §6.1–§6.3, §6.5; bounds
// per 05; REQ-SIL-01..05, REQ-SIL-07, REQ-SIL-10, REQ-UX-03, REQ-A11Y-03). `globalThis.fetch` is stubbed per
// test and restored in afterEach.
import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { ReactElement } from "react";
import type { ActiveAlert, ActiveSilence, AlertsPayload } from "@pulse/web-data/wire";

import {
  CLIENT_ID_MAX_BYTES, defaultMatchers, matchedCount, matcherIssue, matchesAll, silenceRationaleCounter,
} from "../src/client/mutations/matchers.js";
import SilenceDialog from "../src/client/mutations/dialogs/SilenceDialog.js";
import {
  SILENCE_CAP_MARGIN_MS, SILENCE_CLIENT_MAX_MS, endsAtError, rationaleError,
} from "../src/client/mutations/dialog-models/silence-model.js";
import type { SilenceDialogProps } from "../src/client/mutations/dialogs/SilenceDialog.js";
import ExpireDialog from "../src/client/mutations/dialogs/ExpireDialog.js";
import type { ExpireDialogProps } from "../src/client/mutations/dialogs/ExpireDialog.js";
import { REASON_TEXT } from "../src/client/mutations/client.js";
import { pendingTracker } from "../src/client/mutations/pending.js";
import { createAppStore } from "../src/client/store/index.js";
import type { AppStore } from "../src/client/store/index.js";
import { MUTATION_ID_MAX_BYTES } from "../src/server/mutations/constants.js";
import { SILENCE_MAX_DURATION_MS } from "../src/shared/mutations.js";
import { makeAlertsPayload } from "./alerts-fixtures.js";
import { describeUi } from "./rtl.js";
import { setInputValue } from "./react-render.js";
import { mountDialog } from "./mutations-dialog-dom.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE = makeAlertsPayload({ scenario: "mixed" });
const TEMPLATE = BASE.alerts[0]!;

function mkAlert(fingerprint: string, labels: Record<string, string>): ActiveAlert {
  return { ...TEMPLATE, fingerprint, name: labels["alertname"] ?? "NoName", labels };
}

/** Two alerts sharing alertname + team, differing by host. */
const ALERT_A = mkAlert("fp-sil-a", { alertname: "DiskFull", host: "a", team: "infra" });
const ALERT_B = mkAlert("fp-sil-b", { alertname: "DiskFull", host: "b", team: "infra" });
const PAYLOAD: AlertsPayload = { ...BASE, alerts: [ALERT_A, ALERT_B], silences: [] };

const SILENCE: ActiveSilence = {
  id: "sil-expire-1",
  matchers: [{ name: "alertname", value: "DiskFull", isRegex: false, isEqual: true }],
  createdBy: "someone-else",
  comment: "maintenance <b>x</b>",
  startsAt: "2026-09-22T11:00:00.000Z",
  endsAt: "2026-09-22T13:00:00.000Z",
  state: "active",
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------

interface Call { readonly url: string; readonly key: string | null; readonly body: Record<string, unknown> }
type Reply = { readonly status: number; readonly json: unknown } | Promise<{ readonly status: number; readonly json: unknown }>;

const realFetch = globalThis.fetch;
let calls: Call[] = [];

/** Install a fetch stub answering mutation POSTs from `replies` (last reply repeats). */
function stubFetch(...replies: Reply[]): void {
  calls = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, key: headers.get("idempotency-key"), body: JSON.parse(String(init?.body ?? "null")) });
    const r = await replies[Math.min(i++, replies.length - 1)]!;
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const ok = (result: unknown): Reply => ({ status: 201, json: { outcome: "succeeded", requestId: "req-ok", result } });
const refusal = (status: number, reason: string, fields?: string): Reply => ({
  status,
  json: { code: "INVALID_REQUEST", message: "catalog text", details: { reason, requestId: "req-bad", ...(fields !== undefined ? { fields } : {}) } },
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

function newStore(payload: AlertsPayload | null = PAYLOAD): AppStore {
  const store = createAppStore({ storage: null, initialQuery: {} });
  store.alerts.value = payload;
  return store;
}

interface Spies { done: unknown[]; closed: number }

function silenceProps(store: AppStore, alert: ActiveAlert, spies: Spies): SilenceDialogProps {
  return { store, alert, open: true, onClose: () => { spies.closed += 1; }, onDone: (r) => { spies.done.push(r); } };
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const b = [...root.querySelectorAll("button")].find((x) => x.textContent?.trim() === text);
  if (b === undefined) throw new Error(`no button "${text}"`);
  return b as HTMLButtonElement;
}

/** Radix checkboxes/radios are `button[role=checkbox|radio]`; their state is aria-checked. */
function isChecked(el: Element): boolean {
  return el.getAttribute("aria-checked") === "true";
}

function checkboxFor(root: ParentNode, name: string): HTMLElement {
  const cb = [...root.querySelectorAll<HTMLElement>("[role=checkbox]")].find((x) => {
    const label = root.querySelector(`label[for="${x.id}"]`);
    return label?.querySelector("code")?.textContent === name;
  });
  if (cb === undefined) throw new Error(`no checkbox for ${name}`);
  return cb;
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  setInputValue(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function chooseRadio(root: ParentNode, label: string): void {
  const input = [...root.querySelectorAll<HTMLElement>("[role=radio]")]
    .find((r) => root.querySelector(`label[for="${r.id}"]`)?.textContent?.trim() === label);
  if (input === undefined) throw new Error(`no radio ${label}`);
  input.click();
}

/** "YYYY-MM-DDTHH:mm" in local time (mirrors the dialog's datetime-local formatting). */
function toLocalInput(ms: number): string {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** The matched-count text, found through the matcher fieldset's aria-describedby. */
function countText(dialog: HTMLElement): string {
  const fs = [...dialog.querySelectorAll("fieldset")].find((f) => f.querySelector("legend")?.textContent?.startsWith("Labels to match"));
  const id = fs?.getAttribute("aria-describedby") ?? "";
  return document.getElementById(id)?.textContent ?? "";
}

function region(politeness: "polite" | "assertive"): string {
  return document.querySelector(`[data-politeness="${politeness}"]`)?.textContent ?? "";
}

const VALID_RATIONALE = "Planned disk replacement on host a.";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("matchers.ts: default matchers, issues, matching (REQ-SIL-01, REQ-SIL-02, REQ-SIL-03)", () => {
  test("defaultMatchers puts alertname first, then sorts by name (REQ-SIL-01)", () => {
    const a = mkAlert("fp", { zeta: "1", alertname: "X", beta: "2" });
    expect(defaultMatchers(a).map((m) => m.name)).toEqual(["alertname", "beta", "zeta"]);
  });

  test("matcherIssue enforces label-name grammar, name ≤ 128 B and value 1–256 B (REQ-SIL-02)", () => {
    expect(matcherIssue({ name: "host", value: "a" })).toBeNull();
    expect(matcherIssue({ name: "9bad", value: "a" })).not.toBeNull();
    expect(matcherIssue({ name: "bad-name", value: "a" })).not.toBeNull();
    expect(matcherIssue({ name: "a".repeat(128), value: "a" })).toBeNull();
    expect(matcherIssue({ name: "a".repeat(129), value: "a" })).not.toBeNull();
    expect(matcherIssue({ name: "host", value: "" })).not.toBeNull();
    expect(matcherIssue({ name: "host", value: "v".repeat(256) })).toBeNull();
    expect(matcherIssue({ name: "host", value: "v".repeat(257) })).not.toBeNull();
    expect(matcherIssue({ name: "host", value: "é".repeat(129) })).not.toBeNull(); // 258 bytes
  });

  test("matchesAll treats a missing label as \"\" and matchedCount counts every row (REQ-SIL-03)", () => {
    expect(matchesAll({ a: "1" }, [{ name: "a", value: "1" }])).toBe(true);
    expect(matchesAll({ a: "1" }, [{ name: "b", value: "" }])).toBe(true);
    expect(matchesAll({ a: "1" }, [{ name: "b", value: "x" }])).toBe(false);
    expect(matchedCount(PAYLOAD, [{ name: "alertname", value: "DiskFull" }])).toBe(2);
    expect(matchedCount(PAYLOAD, [{ name: "alertname", value: "DiskFull" }, { name: "host", value: "a" }])).toBe(1);
  });

  test("the client id limit is pinned to the server MUTATION_ID_MAX_BYTES (REQ-SIL-07)", () => {
    expect(CLIENT_ID_MAX_BYTES).toBe(MUTATION_ID_MAX_BYTES);
  });
});

describe("rationaleError and endsAtError (REQ-SIL-04, REQ-SIL-05)", () => {
  test("silenceRationaleCounter (create + expire) reports the binding limit: characters, or bytes once they bind", () => {
    expect(silenceRationaleCounter("")).toEqual({ used: 0, limit: 500, unit: "characters" });
    expect(silenceRationaleCounter("  " + "a".repeat(500) + "  ")).toEqual({ used: 500, limit: 500, unit: "characters" });
    // 250 × "é" = 500 bytes + 8 prefix: 4 bytes left vs 250 characters left → bytes bind.
    expect(silenceRationaleCounter("é".repeat(250))).toEqual({ used: 508, limit: 512, unit: "bytes" });
  });
  test("9 code points error, 10 accepted; emoji count as code points (REQ-SIL-05)", () => {
    expect(rationaleError("123456789")).not.toBeNull();
    expect(rationaleError("1234567890")).toBeNull();
    expect(rationaleError("  1234567890  ")).toBeNull(); // trimmed
    expect(rationaleError("😀".repeat(9))).not.toBeNull(); // 18 UTF-16 units, 9 code points
    expect(rationaleError("😀".repeat(10))).toBeNull();
  });

  test("500 ASCII accepted, 501 refused; > 504 UTF-8 bytes refused (\"[pulse] \" + text ≤ 512) (REQ-SIL-05)", () => {
    expect(rationaleError("a".repeat(500))).toBeNull();
    expect(rationaleError("a".repeat(501))).not.toBeNull();
    expect(rationaleError("é".repeat(252))).toBeNull(); // 504 bytes
    expect(rationaleError("é".repeat(253))).toContain("Too long"); // 506 bytes, 253 code points
  });

  test("control characters other than \\n are refused (REQ-SIL-05)", () => {
    expect(rationaleError("line one\nline two")).toBeNull();
    expect(rationaleError("tab\there and more")).not.toBeNull();
    expect(rationaleError("bell\u0007 and more text")).not.toBeNull();
  });

  test("endsAtError: past/now refused, ≤ 7 d − 60 s accepted, beyond refused (REQ-SIL-04)", () => {
    const now = 1_000_000_000_000;
    expect(SILENCE_CLIENT_MAX_MS).toBe(SILENCE_MAX_DURATION_MS - SILENCE_CAP_MARGIN_MS);
    expect(SILENCE_CAP_MARGIN_MS).toBe(60_000);
    expect(endsAtError(now, now)).not.toBeNull();
    expect(endsAtError(now - 1, now)).not.toBeNull();
    expect(endsAtError(now + 1, now)).toBeNull();
    expect(endsAtError(now + SILENCE_CLIENT_MAX_MS, now)).toBeNull();
    expect(endsAtError(now + SILENCE_CLIENT_MAX_MS + 1, now)).not.toBeNull();
    expect(endsAtError(Number.NaN, now)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SilenceDialog
// ---------------------------------------------------------------------------

describeUi("SilenceDialog labels and matched count (REQ-SIL-01, REQ-SIL-02, REQ-SIL-03)", (dom) => {
  test("every sendable label is checked by default (REQ-SIL-01)", async () => {
    const spies: Spies = { done: [], closed: 0 };
    const { dialog, unmount } = await mountDialog(dom, createElement(SilenceDialog, silenceProps(newStore(), ALERT_A, spies)) as ReactElement);
    await flush();
    const boxes = [...dialog.querySelectorAll<HTMLElement>("[role=checkbox]")];
    expect(boxes.length).toBe(3);
    expect(boxes.every(isChecked)).toBe(true);
    unmount();
  });

  test("alertname is locked: neither a click nor Space unchecks it (REQ-SIL-02)", async () => {
    stubFetch(ok({ silenceId: "s-new", endsAt: "x" }));
    const spies: Spies = { done: [], closed: 0 };
    const { dialog, unmount } = await mountDialog(dom, createElement(SilenceDialog, silenceProps(newStore(), ALERT_A, spies)) as ReactElement);
    await flush();
    const an = checkboxFor(dialog, "alertname");
    expect(an.getAttribute("aria-disabled")).toBe("true");
    expect(an.hasAttribute("disabled")).toBe(false); // still focusable / announced
    an.click();
    await flush();
    expect(isChecked(checkboxFor(dialog, "alertname"))).toBe(true);
    // Keyboard: Space on a focused checkbox fires keydown/keyup then the browser's synthetic click.
    an.focus();
    an.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }));
    an.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true }));
    an.click();
    await flush();
    expect(isChecked(checkboxFor(dialog, "alertname"))).toBe(true);
    // The body still carries the alertname matcher.
    typeInto(dialog.querySelector("textarea")!, VALID_RATIONALE);
    await flush();
    buttonByText(dialog, "Create silence").click();
    await flush(10);
    expect(calls.length).toBe(1);
    expect((calls[0]!.body["matchers"] as { name: string }[]).map((m) => m.name)).toContain("alertname");
    pendingTracker.dismiss({ kind: "silence", silenceId: "s-new" });
    unmount();
  });

  test("a label value > 256 bytes starts unchecked with an error and is never sent (REQ-SIL-02)", async () => {
    stubFetch(ok({ silenceId: "s-big", endsAt: "x" }));
    const big = mkAlert("fp-big", { alertname: "Big", host: "a", blob: "v".repeat(257) });
    const spies: Spies = { done: [], closed: 0 };
    const { dialog, unmount } = await mountDialog(dom, createElement(SilenceDialog, silenceProps(newStore(), big, spies)) as ReactElement);
    await flush();
    const blob = checkboxFor(dialog, "blob");
    expect(isChecked(blob)).toBe(false);
    expect(blob.getAttribute("aria-invalid")).toBe("true");
    const errId = (blob.getAttribute("aria-describedby") ?? "").split(" ").find((id) => id.endsWith("-err"));
    expect(errId).toBeDefined();
    expect(document.getElementById(errId!)!.textContent).toContain("longer than 256 bytes");
    expect(isChecked(checkboxFor(dialog, "host"))).toBe(true);
    typeInto(dialog.querySelector("textarea")!, VALID_RATIONALE);
    await flush();
    buttonByText(dialog, "Create silence").click();
    await flush(10);
    expect(calls.length).toBe(1);
    expect((calls[0]!.body["matchers"] as { name: string }[]).map((m) => m.name)).toEqual(["alertname", "host"]);
    pendingTracker.dismiss({ kind: "silence", silenceId: "s-big" });
    unmount();
  });

  test("the matched-count text updates when a label is unchecked (REQ-SIL-03)", async () => {
    const spies: Spies = { done: [], closed: 0 };
    const { dialog, unmount } = await mountDialog(dom, createElement(SilenceDialog, silenceProps(newStore(), ALERT_A, spies)) as ReactElement);
    await flush();
    const count = (): string => countText(dialog);
    expect(count()).toBe("Would silence 1 currently firing alert.");
    checkboxFor(dialog, "host").click();
    await flush();
    expect(isChecked(checkboxFor(dialog, "host"))).toBe(false);
    expect(count()).toBe("Would silence 2 currently firing alerts.");
    unmount();
  });

  test("no live alerts payload → the count is shown as unknown (REQ-SIL-03)", async () => {
    const spies: Spies = { done: [], closed: 0 };
    const { dialog, unmount } = await mountDialog(dom, createElement(SilenceDialog, silenceProps(newStore(null), ALERT_A, spies)) as ReactElement);
    await flush();
    expect(countText(dialog)).toContain("unknown");
    unmount();
  });
});

describeUi("SilenceDialog duration presets and custom end time (REQ-SIL-04)", (dom) => {
  async function submitWith(setup: (c: HTMLElement) => Promise<void> | void): Promise<{ before: number; after: number }> {
    stubFetch(ok({ silenceId: "s-dur", endsAt: "x" }));
    const spies: Spies = { done: [], closed: 0 };
    const { dialog, unmount } = await mountDialog(dom, createElement(SilenceDialog, silenceProps(newStore(), ALERT_A, spies)) as ReactElement);
    await flush();
    await setup(dialog);
    typeInto(dialog.querySelector("textarea")!, VALID_RATIONALE);
    await flush();
    const before = Date.now();
    buttonByText(dialog, "Create silence").click();
    const after = Date.now();
    await flush(10);
    pendingTracker.dismiss({ kind: "silence", silenceId: "s-dur" });
    unmount();
    return { before, after };
  }

  test("the default preset is 2 hours and sends endsAt = now + 2 h (REQ-SIL-04)", async () => {
    const t = await submitWith((c) => {
      const checked = c.querySelector<HTMLElement>("[role=radio][aria-checked=true]")!;
      expect(c.querySelector(`label[for="${checked.id}"]`)!.textContent?.trim()).toBe("2 hours");
    });
    expect(calls.length).toBe(1);
    const ends = Date.parse(String(calls[0]!.body["endsAt"]));
    expect(ends).toBeGreaterThanOrEqual(t.before + 2 * HOUR);
    expect(ends).toBeLessThanOrEqual(t.after + 2 * HOUR);
  });

  test("the 7 d preset sends endsAt = now + 7 d − 60 s (REQ-SIL-04)", async () => {
    const t = await submitWith(async (c) => {
      chooseRadio(c, "7 days");
      await flush();
    });
    expect(calls.length).toBe(1);
    const ends = Date.parse(String(calls[0]!.body["endsAt"]));
    expect(ends).toBeGreaterThanOrEqual(t.before + 7 * DAY - 60_000);
    expect(ends).toBeLessThanOrEqual(t.after + 7 * DAY - 60_000);
  });

  for (const [what, offset] of [["a past", -HOUR], ["a > 7 d", 8 * DAY]] as const) {
    test(`${what} custom end time blocks submit: no fetch, an endsAt error (REQ-SIL-04)`, async () => {
      stubFetch(ok({ silenceId: "never", endsAt: "x" }));
      const spies: Spies = { done: [], closed: 0 };
      const { dialog, unmount } = await mountDialog(dom, createElement(SilenceDialog, silenceProps(newStore(), ALERT_A, spies)) as ReactElement);
      await flush();
      chooseRadio(dialog, "Custom end time");
      await flush();
      const input = dialog.querySelector<HTMLInputElement>("input[type=datetime-local]")!;
      typeInto(input, toLocalInput(Date.now() + offset));
      typeInto(dialog.querySelector("textarea")!, VALID_RATIONALE);
      await flush();
      buttonByText(dialog, "Create silence").click();
      await flush(10);
      expect(calls.length).toBe(0);
      expect(dialog.querySelector<HTMLInputElement>("input[type=datetime-local]")!.getAttribute("aria-invalid")).toBe("true");
      expect(spies.done.length).toBe(0);
      unmount();
    });
  }
});

describeUi("SilenceDialog rationale counter (REQ-SIL-05)", (dom) => {
  test("counts characters for plain text; switches to bytes once > 504 UTF-8 bytes bind, and submit is blocked (REQ-SIL-05)", async () => {
    stubFetch(ok({ silenceId: "never", endsAt: "x" }));
    const spies: Spies = { done: [], closed: 0 };
    const { dialog, unmount } = await mountDialog(dom, createElement(SilenceDialog, silenceProps(newStore(), ALERT_A, spies)) as ReactElement);
    await flush();
    const counter = (): string => dialog.querySelector("[data-field='rationale'] [aria-live]")!.textContent ?? "";
    expect(counter()).toBe("500 characters left");
    typeInto(dialog.querySelector("textarea")!, "a".repeat(498)); // 506 bytes with "[pulse] ": characters still bind
    await flush();
    expect(counter()).toBe("2 characters left");
    typeInto(dialog.querySelector("textarea")!, "é".repeat(253)); // 506 bytes → 514 total
    await flush();
    expect(counter()).toBe("2 bytes over the limit");
    buttonByText(dialog, "Create silence").click();
    await flush(10);
    expect(calls.length).toBe(0);
    expect(dialog.querySelector("textarea")!.getAttribute("aria-invalid")).toBe("true");
    unmount();
  });
});

describeUi("SilenceDialog submit, idempotency and announcements (REQ-UX-03, REQ-A11Y-03)", (dom) => {
  async function mountFilled(): Promise<{ dialog: HTMLElement; unmount(): void; spies: Spies }> {
    const spies: Spies = { done: [], closed: 0 };
    const m = await mountDialog(dom, createElement(SilenceDialog, silenceProps(newStore(), ALERT_A, spies)) as ReactElement);
    await flush();
    typeInto(m.dialog.querySelector("textarea")!, VALID_RATIONALE);
    await flush();
    return { ...m, spies };
  }

  test("a double-clicked submit issues exactly one fetch (REQ-UX-03)", async () => {
    const gate = Promise.withResolvers<{ status: number; json: unknown }>();
    stubFetch(gate.promise);
    const { dialog, unmount } = await mountFilled();
    const btn = buttonByText(dialog, "Create silence");
    btn.click();
    btn.click();
    await flush();
    buttonByText(dialog, "Create silence").click();
    expect(buttonByText(dialog, "Create silence").getAttribute("aria-busy")).toBe("true");
    gate.resolve({ status: 201, json: { outcome: "succeeded", requestId: "r", result: { silenceId: "s-dbl", endsAt: "x" } } });
    await flush(10);
    expect(calls.length).toBe(1);
    pendingTracker.dismiss({ kind: "silence", silenceId: "s-dbl" });
    unmount();
  });

  test("resubmit after invalid-body reuses the Idempotency-Key; server field 'rationale' marks the textarea (REQ-UX-03, REQ-A11Y-03)", async () => {
    stubFetch(refusal(400, "invalid-body", "rationale"));
    const { dialog, unmount } = await mountFilled();
    buttonByText(dialog, "Create silence").click();
    await flush(10);
    const ta = dialog.querySelector("textarea")!;
    expect(ta.getAttribute("aria-invalid")).toBe("true");
    const ids = (ta.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    const err = [...dialog.querySelectorAll<HTMLElement>("[data-field='rationale'] p")].find((x) => x.textContent?.startsWith("⚠"))!;
    expect(err.textContent).toContain("Rationale refused by the server.");
    expect(ids).toContain(err.id);
    expect(dialog.querySelector("[data-mut-result] [data-state='failed']")).not.toBeNull();
    buttonByText(dialog, "Create silence").click();
    await flush(10);
    expect(calls.length).toBe(2);
    expect(calls[0]!.key).not.toBeNull();
    expect(calls[1]!.key).toBe(calls[0]!.key);
    unmount();
  });

  test("retry after a network error resends the identical body (preset endsAt pinned) under the same key (REQ-UX-03)", async () => {
    const offline = Promise.reject(new TypeError("network down"));
    offline.catch(() => {});
    stubFetch(offline as unknown as Reply, ok({ silenceId: "s-retry", endsAt: "x" }));
    const { dialog, unmount } = await mountFilled();
    buttonByText(dialog, "Create silence").click();
    await flush(30); // a later retry must not recompute now + preset
    buttonByText(dialog, "Create silence").click();
    await flush(10);
    expect(calls.length).toBe(2);
    expect(calls[1]!.key).toBe(calls[0]!.key);
    expect(calls[1]!.body).toEqual(calls[0]!.body);
    unmount();
  });

  test("a retry after the replay window is a new action: new key and a fresh preset endsAt (never a shorter silence)", async () => {
    const offline = Promise.reject(new TypeError("network down"));
    offline.catch(() => {});
    stubFetch(offline as unknown as Reply, ok({ silenceId: "s-late", endsAt: "x" }));
    const realNow = Date.now;
    try {
      const { dialog, unmount } = await mountFilled();
      buttonByText(dialog, "Create silence").click();
      await flush(10);
      const t0 = realNow();
      Date.now = () => t0 + 61 * 60_000; // an hour later, past the window
      buttonByText(dialog, "Create silence").click();
      await flush(10);
      expect(calls.length).toBe(2);
      expect(calls[1]!.key).not.toBe(calls[0]!.key);
      expect(Date.parse(String(calls[1]!.body["endsAt"]))).toBeGreaterThan(Date.parse(String(calls[0]!.body["endsAt"])) + 60 * 60_000);
      unmount();
    } finally {
      Date.now = realNow;
    }
  });

  test("resubmit after upstream-timeout uses a new Idempotency-Key (REQ-UX-03)", async () => {
    stubFetch(refusal(504, "upstream-timeout"));
    const { dialog, unmount } = await mountFilled();
    buttonByText(dialog, "Create silence").click();
    await flush(10);
    buttonByText(dialog, "Create silence").click();
    await flush(10);
    expect(calls.length).toBe(2);
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
    unmount();
  });

  test("success: pending tracker entry, polite announcement, onDone then onClose (REQ-A11Y-03)", async () => {
    stubFetch(ok({ silenceId: "s-ok", endsAt: "2026-09-22T14:00:00.000Z" }));
    const { dialog, unmount, spies } = await mountFilled();
    buttonByText(dialog, "Create silence").click();
    await flush(50);
    expect(calls[0]!.url).toBe("/api/mutations/silences");
    expect(calls[0]!.body).toMatchObject({ fingerprint: ALERT_A.fingerprint, rationale: VALID_RATIONALE });
    expect(spies.done).toEqual([{ silenceId: "s-ok", endsAt: "2026-09-22T14:00:00.000Z" }]);
    expect(spies.closed).toBe(1);
    expect(pendingTracker.stateOf({ kind: "silence", silenceId: "s-ok" }, performance.now())).toBe("pending");
    expect(region("polite")).toContain("Silence created");
    pendingTracker.dismiss({ kind: "silence", silenceId: "s-ok" });
    unmount();
  });

  test("failure: failed badge + REASON_TEXT, assertive announcement, dialog stays open (REQ-A11Y-03)", async () => {
    stubFetch(refusal(502, "upstream-transport"));
    const { dialog, unmount, spies } = await mountFilled();
    buttonByText(dialog, "Create silence").click();
    await flush(50);
    const result = dialog.querySelector("[data-mut-result]")!;
    expect(result.textContent).toContain(REASON_TEXT["upstream-transport"]);
    expect(result.textContent).toContain("req-bad");
    expect(region("assertive")).toContain(REASON_TEXT["upstream-transport"]);
    expect(spies.closed).toBe(0);
    expect(spies.done.length).toBe(0);
    unmount();
  });

  test("a client-invalid form never POSTs and announces the fix count assertively (REQ-A11Y-03)", async () => {
    stubFetch(ok({ silenceId: "never", endsAt: "x" }));
    const spies: Spies = { done: [], closed: 0 };
    const { dialog, unmount } = await mountDialog(dom, createElement(SilenceDialog, silenceProps(newStore(), ALERT_A, spies)) as ReactElement);
    await flush();
    buttonByText(dialog, "Create silence").click(); // empty rationale
    await flush(50);
    expect(calls.length).toBe(0);
    expect(region("assertive")).toBe("Fix 1 field.");
    unmount();
  });
});

// ---------------------------------------------------------------------------
// ExpireDialog
// ---------------------------------------------------------------------------

describeUi("ExpireDialog (REQ-SIL-07, REQ-SIL-10)", (dom) => {
  function expireProps(store: AppStore, spies: Spies, silence: ActiveSilence = SILENCE): ExpireDialogProps {
    return { store, silence, open: true, onClose: () => { spies.closed += 1; }, onDone: (r) => { spies.done.push(r); } };
  }

  test("shows read-only matchers and inert creator/comment; an empty rationale is omitted from the body (REQ-SIL-07)", async () => {
    stubFetch({ status: 200, json: { outcome: "succeeded", requestId: "r", result: { silenceId: SILENCE.id } } });
    const spies: Spies = { done: [], closed: 0 };
    const { dialog, unmount } = await mountDialog(dom, createElement(ExpireDialog, expireProps(newStore(), spies)) as ReactElement);
    await flush();
    expect(dialog.querySelector("code")!.textContent).toBe('alertname="DiskFull"');
    expect(dialog.textContent).toContain("maintenance <b>x</b>");
    expect(dialog.querySelector("b")).toBeNull();
    buttonByText(dialog, "Expire silence").click();
    await flush(50);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("/api/mutations/silences/expire");
    expect(calls[0]!.body).toEqual({ silenceId: SILENCE.id });
    expect(spies.done).toEqual([{ silenceId: SILENCE.id }]);
    expect(spies.closed).toBe(1);
    expect(pendingTracker.stateOf({ kind: "silence", silenceId: SILENCE.id }, performance.now())).toBe("pending");
    expect(region("polite")).toContain("Silence expired");
    pendingTracker.dismiss({ kind: "silence", silenceId: SILENCE.id });
    unmount();
  });

  test("a non-empty rationale is validated and sent trimmed (REQ-SIL-07)", async () => {
    stubFetch({ status: 200, json: { outcome: "succeeded", requestId: "r", result: { silenceId: SILENCE.id } } });
    const spies: Spies = { done: [], closed: 0 };
    const { dialog, unmount } = await mountDialog(dom, createElement(ExpireDialog, expireProps(newStore(), spies)) as ReactElement);
    await flush();
    typeInto(dialog.querySelector("textarea")!, "bad\u0001text");
    await flush();
    buttonByText(dialog, "Expire silence").click();
    await flush(10);
    expect(calls.length).toBe(0);
    expect(dialog.querySelector("textarea")!.getAttribute("aria-invalid")).toBe("true");
    typeInto(dialog.querySelector("textarea")!, `  ${VALID_RATIONALE}  `);
    await flush();
    buttonByText(dialog, "Expire silence").click();
    await flush(50);
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toEqual({ silenceId: SILENCE.id, rationale: VALID_RATIONALE });
    pendingTracker.dismiss({ kind: "silence", silenceId: SILENCE.id });
    unmount();
  });

  test("the optional rationale has no minimum: a short note is sent (server accepts 0–500)", async () => {
    stubFetch({ status: 200, json: { outcome: "succeeded", requestId: "r", result: { silenceId: SILENCE.id } } });
    const spies: Spies = { done: [], closed: 0 };
    const { dialog, unmount } = await mountDialog(dom, createElement(ExpireDialog, expireProps(newStore(), spies)) as ReactElement);
    await flush();
    typeInto(dialog.querySelector("textarea")!, "resolved");
    await flush();
    buttonByText(dialog, "Expire silence").click();
    await flush(50);
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toEqual({ silenceId: SILENCE.id, rationale: "resolved" });
    pendingTracker.dismiss({ kind: "silence", silenceId: SILENCE.id });
    unmount();
  });

  test("a silence id > 128 bytes is refused client-side (REQ-SIL-07)", async () => {
    stubFetch({ status: 200, json: { outcome: "succeeded", requestId: "r", result: { silenceId: "x" } } });
    const spies: Spies = { done: [], closed: 0 };
    const long = { ...SILENCE, id: "s".repeat(CLIENT_ID_MAX_BYTES + 1) };
    const { dialog, unmount } = await mountDialog(dom, createElement(ExpireDialog, expireProps(newStore(), spies, long)) as ReactElement);
    await flush();
    buttonByText(dialog, "Expire silence").click();
    await flush(10);
    expect(calls.length).toBe(0);
    unmount();
  });

  test("silence-gone shows 'Already expired' and only Close remains, announced assertively (REQ-SIL-10)", async () => {
    stubFetch(refusal(404, "silence-gone"));
    const spies: Spies = { done: [], closed: 0 };
    const { dialog, unmount } = await mountDialog(dom, createElement(ExpireDialog, expireProps(newStore(), spies)) as ReactElement);
    await flush();
    buttonByText(dialog, "Expire silence").click();
    await flush(50);
    const badge = dialog.querySelector("[data-mut-result] [data-state='failed']")!;
    expect(badge.textContent).toContain("Already expired");
    expect(dialog.querySelector("[data-mut-result]")!.textContent).toContain(REASON_TEXT["silence-gone"]);
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    const buttons = [...dialog.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).toEqual(["Close"]);
    expect(region("assertive")).toContain(REASON_TEXT["silence-gone"]);
    buttonByText(dialog, "Close").click();
    expect(spies.closed).toBe(1);
    expect(spies.done.length).toBe(0);
    unmount();
  });
});
