// apps/web/tests/browser/mutations-keyboard.test.ts — REQ-A11Y-02, REQ-A11Y-03 (10 §6; 09 §9.2).
//
// Drives every mutation dialog with the keyboard only, in a real Chromium:
//   - the trigger is reached with Tab and opened with Enter (the lazy chunk mounts a dialog / alertdialog);
//   - focus moves into the dialog and is trapped there (Tab and Shift+Tab cycle inside it);
//   - Esc closes it and focus returns to the invoking control;
//   - while a submit is in flight, neither Esc nor an outside click closes it;
//   - Tab to the primary action + Enter submits (the scripted POST lands);
//   - the announcer's polite region receives the success text and its assertive region the failure text.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe); THROWS at collection under
// PULSE_REQUIRE_BROWSER=1.

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright-core";

import { browserDescribe } from "./_harness.js";
import {
  DIALOG, DIALOG_PAGES, DIALOG_PAGE_IDS, VALID_RATIONALE, activeInfo, announcerText, dialogOf, openMutationsPages, posts,
  releaseHeldPost, setReply, type DialogPageId, type MutationsBrowserSession,
} from "./mutations-browser.js";

const TRAP_PRESSES = 40; // more than any dialog's tabbable count, so the cycle wraps several times

/** Tab from the top of a freshly loaded page to the trigger; the trigger is the page's first tabbable. */
async function tabToTrigger(page: Page, id: DialogPageId): Promise<void> {
  await page.keyboard.press("Tab");
  const active = await activeInfo(page);
  expect(active.tag).toBe("button");
  expect(active.name ?? active.text).toBe(DIALOG_PAGES[id].triggerName);
  await page.evaluate(() => document.activeElement?.setAttribute("data-kb-trigger", ""));
}

/** Enter on the focused trigger, then wait for the lazy dialog and for focus to land inside it. */
async function enterOpens(page: Page, id: DialogPageId): Promise<void> {
  await page.keyboard.press("Enter");
  await dialogOf(page, id).waitFor();
  await page.waitForFunction((sel) => document.activeElement?.closest(sel) !== null, DIALOG);
}

/** Focus returns to the trigger once the dialog unmounts (Radix restores it on the next task). */
async function focusReturnsToTrigger(page: Page): Promise<void> {
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-kb-trigger") === true, undefined, { timeout: 3000 });
}

/** Tab (forward, or backward with Shift) until the dialog's primary action has focus. */
async function tabToSubmit(page: Page, id: DialogPageId): Promise<void> {
  for (let i = 0; i < TRAP_PRESSES; i += 1) {
    const a = await activeInfo(page);
    if (a.tag === "button" && a.inDialog && a.text === DIALOG_PAGES[id].submit) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`never reached "${DIALOG_PAGES[id].submit}" by Tab`);
}

/** The announcer sets text on the next frame; poll until the region holds non-empty text. */
async function waitForAnnouncement(page: Page, politeness: "polite" | "assertive"): Promise<string> {
  await page.waitForFunction(
    (p) => (document.querySelector(`[data-politeness="${p}"]`)?.textContent ?? "").trim() !== "",
    politeness,
  );
  return announcerText(page, politeness);
}

browserDescribe()("browser: mutation dialogs are fully keyboard-operable (REQ-A11Y-02, REQ-A11Y-03)", () => {
  let session: MutationsBrowserSession;

  beforeAll(async () => {
    session = await openMutationsPages();
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  for (const id of DIALOG_PAGE_IDS) {
    test(`${id}: Tab + Enter opens, focus is trapped, Esc closes, focus returns to the trigger (REQ-A11Y-02)`, async () => {
      const page = await session.fresh(id, "dark");
      await tabToTrigger(page, id);
      await enterOpens(page, id);

      // Focus trap: every Tab / Shift+Tab stop stays inside the dialog, and the cycle wraps.
      const seen = new Set<string>();
      for (let i = 0; i < TRAP_PRESSES; i += 1) {
        await page.keyboard.press("Tab");
        const a = await activeInfo(page);
        expect(a.inDialog, `Tab #${i + 1} left the dialog: ${JSON.stringify(a)}`).toBe(true);
        seen.add(`${a.tag}:${a.name ?? a.text}`);
      }
      expect(seen.size).toBeGreaterThan(1);
      for (let i = 0; i < TRAP_PRESSES / 2; i += 1) {
        await page.keyboard.press("Shift+Tab");
        const a = await activeInfo(page);
        expect(a.inDialog, `Shift+Tab #${i + 1} left the dialog: ${JSON.stringify(a)}`).toBe(true);
      }

      // Esc closes; focus goes back to the invoking control.
      await page.keyboard.press("Escape");
      await page.waitForSelector(DIALOG, { state: "detached" });
      await focusReturnsToTrigger(page);
      expect(await posts(page)).toEqual([]);

      // Re-opening from the returned focus works with Enter alone.
      await enterOpens(page, id);
      await page.keyboard.press("Escape");
      await page.waitForSelector(DIALOG, { state: "detached" });
    }, 60_000);
  }

  for (const id of ["silence", "ack", "expire"] as const) {
    test(`${id}: Enter on the primary action submits; success is announced politely and focus returns (REQ-A11Y-02, REQ-A11Y-03)`, async () => {
      const page = await session.fresh(id, "dark");
      await setReply(page, "success");
      await tabToTrigger(page, id);
      await enterOpens(page, id);
      const field = id === "ack" ? "note" : "rationale";
      await dialogOf(page, id).locator(`textarea[name="${field}"]`).focus();
      await page.keyboard.type(VALID_RATIONALE);
      await tabToSubmit(page, id);
      await page.keyboard.press("Enter");

      await page.waitForSelector(DIALOG, { state: "detached" });
      const sent = await posts(page);
      expect(sent.length).toBe(1);
      expect(sent[0]!.body[field]).toBe(VALID_RATIONALE);
      const polite = await waitForAnnouncement(page, "polite");
      expect(polite).toMatch(/Pending until live data/);
      expect(await announcerText(page, "assertive")).toBe("");
      await focusReturnsToTrigger(page);
    }, 60_000);
  }

  for (const id of ["silence", "ack", "expire"] as const) {
    test(`${id}: a refused submit is announced assertively and focus moves to the invalid field (REQ-A11Y-03)`, async () => {
      const page = await session.fresh(id, "dark");
      await setReply(page, "refuse");
      await tabToTrigger(page, id);
      await enterOpens(page, id);
      const field = id === "ack" ? "note" : "rationale";
      await dialogOf(page, id).locator(`textarea[name="${field}"]`).focus();
      await page.keyboard.type(VALID_RATIONALE);
      await tabToSubmit(page, id);
      await page.keyboard.press("Enter");

      const assertive = await waitForAnnouncement(page, "assertive");
      expect(assertive).toMatch(/^Some values are invalid\. Check the highlighted fields\./);
      expect(await page.locator(DIALOG).count()).toBe(1);
      await page.waitForFunction(
        (f) => document.activeElement?.getAttribute("name") === f
          && document.activeElement.getAttribute("aria-invalid") === "true",
        field,
      );
      const describedBy = await dialogOf(page, id).locator(`textarea[name="${field}"]`).getAttribute("aria-describedby");
      const errorText = await page.evaluate(
        (ids) => (ids ?? "").split(" ").map((i) => document.getElementById(i)?.textContent ?? "").join(" "),
        describedBy,
      );
      expect(errorText).toMatch(/refused by the server/);
    }, 60_000);
  }

  test("propose: submitting with nothing included announces the client errors assertively (REQ-A11Y-03)", async () => {
    const page = await session.fresh("propose", "dark");
    await tabToTrigger(page, "propose");
    await enterOpens(page, "propose");
    await tabToSubmit(page, "propose");
    await page.keyboard.press("Enter");
    const assertive = await waitForAnnouncement(page, "assertive");
    expect(assertive).toMatch(/^Fix \d+ fields?\.$/);
    expect(await posts(page)).toEqual([]);
    expect(await dialogOf(page, "propose").locator('[aria-invalid="true"]').count()).toBeGreaterThan(0);
  }, 60_000);

  for (const id of ["silence", "ack", "expire"] as const) {
    test(`${id}: while the submit is in flight, Esc and an outside click do not close it`, async () => {
      const page = await session.fresh(id, "dark");
      await setReply(page, "hold");
      await tabToTrigger(page, id);
      await enterOpens(page, id);
      const field = id === "ack" ? "note" : "rationale";
      await dialogOf(page, id).locator(`textarea[name="${field}"]`).focus();
      await page.keyboard.type(VALID_RATIONALE);
      await tabToSubmit(page, id);
      await page.keyboard.press("Enter");
      const submit = dialogOf(page, id).getByRole("button", { name: DIALOG_PAGES[id].submit });
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-busy") === "true");

      await page.keyboard.press("Escape");
      await page.mouse.click(4, 4); // the overlay, outside the dialog panel
      await page.waitForTimeout(150);
      expect(await page.locator(DIALOG).count()).toBe(1);
      expect(await submit.getAttribute("aria-busy")).toBe("true");

      await releaseHeldPost(page);
      await page.waitForSelector(DIALOG, { state: "detached" });
      expect((await posts(page)).length).toBe(1);
      await focusReturnsToTrigger(page);
    }, 60_000);
  }

  test("silence: when not in flight, an outside click closes it and focus returns to the trigger", async () => {
    const page = await session.fresh("silence", "dark");
    await tabToTrigger(page, "silence");
    await enterOpens(page, "silence");
    await page.mouse.click(4, 4);
    await page.waitForSelector(DIALOG, { state: "detached" });
    await focusReturnsToTrigger(page);
  }, 60_000);
});
