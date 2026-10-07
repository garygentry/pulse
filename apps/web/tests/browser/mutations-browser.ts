// apps/web/tests/browser/mutations-browser.ts — shared support for the mutation browser suites
// (10 §6; REQ-A11Y-01..04, REQ-UX-04, SC-06). NOT a test file. Modelled on alerts-browser.ts: names the
// mutation fixture pages (tests/browser/fixtures/mutations-*), builds each via the frozen
// _harness.buildFixturePage in both themes, and opens them in the process-shared Chromium, waiting until
// the real components have painted.
//
// Unlike the read-only alerts pages, these pages are STATEFUL (a dialog opens, a POST lands), so a suite
// asks for a fresh load of a page with `session.fresh(id, theme)` before every scenario.

import { resolve } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright-core";

import { buildFixturePage, type FixturePage, type FixtureTheme, sharedBrowser } from "./_harness.js";

export const MUTATIONS_THEMES: readonly FixtureTheme[] = ["dark", "light"];

/** Matches an open mutation dialog (Expire is a destructive-confirm alertdialog). */
export const DIALOG = '[role="dialog"], [role="alertdialog"]';

/** The four mutation dialogs, each opened from its real trigger. */
export type DialogPageId = "silence" | "expire" | "ack" | "propose";

/** One mutation fixture page (a bundled entry under fixtures/). */
export interface MutationsFixtureDef {
  /** Page id; the entry is `fixtures/mutations-<id>.tsx`. */
  readonly id: DialogPageId | "proposal-list" | "badges";
  /** Selector that proves the page painted. */
  readonly ready: string;
}

/** Every mutation fixture page. */
export const MUTATIONS_FIXTURES: readonly MutationsFixtureDef[] = [
  { id: "silence", ready: 'role=button[name="Silence…"]' },
  { id: "expire", ready: 'role=button[name="Expire silence silence-backup-window"]' },
  { id: "ack", ready: 'role=button[name="Update acknowledgement…"]' },
  { id: "propose", ready: 'role=button[name="Propose edit…"]' },
  { id: "proposal-list", ready: "[data-testid=proposal-list] [data-slot=disclosure] button[aria-expanded]" },
  { id: "badges", ready: '[data-state] > [data-slot="status-badge"]' },
];

/**
 * Per dialog page: the trigger's accessible name (the page's ready selector matches it before any dialog
 * mounts), the dialog's role and accessible name, and its primary (submitting) action.
 */
export const DIALOG_PAGES: Readonly<Record<DialogPageId, {
  readonly triggerName: string; readonly role: "dialog" | "alertdialog"; readonly name: RegExp; readonly submit: string;
}>> = {
  silence: { triggerName: "Silence…", role: "dialog", name: /^Silence /, submit: "Create silence" },
  expire: { triggerName: "Expire silence silence-backup-window", role: "alertdialog", name: /^Expire silence$/, submit: "Expire silence" },
  ack: { triggerName: "Update acknowledgement…", role: "dialog", name: /^Update acknowledgement /, submit: "Replace acknowledgement" },
  propose: { triggerName: "Propose edit…", role: "dialog", name: /^Propose edit: /, submit: "Submit proposal" },
};

export const DIALOG_PAGE_IDS: readonly DialogPageId[] = ["silence", "expire", "ack", "propose"];

/** A valid rationale for every dialog's text field (10–500 code points). */
export const VALID_RATIONALE = "Planned maintenance window for the storage migration.";

/** Absolute path of a fixture page entry. */
export function mutationsFixtureEntry(id: string): string {
  return resolve(import.meta.dir, "fixtures", `mutations-${id}.tsx`);
}

/** A browser context with one tab per (fixture × theme). */
export interface MutationsBrowserSession {
  /** (Re)load the page for (id, theme) and wait until it painted; returns the tab. */
  fresh(id: MutationsFixtureDef["id"], theme: FixtureTheme): Promise<Page>;
  close(): Promise<void>;
}

const jobs = MUTATIONS_FIXTURES.flatMap((def) => MUTATIONS_THEMES.map((theme) => ({ def, theme })));
let builtPagesOnce: Promise<FixturePage[]> | null = null;

function builtPages(): Promise<FixturePage[]> {
  builtPagesOnce ??= Promise.all(
    jobs.map(({ def, theme }) => buildFixturePage(mutationsFixtureEntry(def.id), { theme })),
  );
  return builtPagesOnce;
}

/** Stop the fixture servers. The shared Chromium is never closed here. */
export async function closeMutationsBrowser(): Promise<void> {
  const built = builtPagesOnce === null ? [] : await builtPagesOnce;
  for (const fixture of built) fixture.stop();
  builtPagesOnce = null;
}

process.once("exit", () => {
  void closeMutationsBrowser();
});

/**
 * Build every mutation fixture page (BEFORE launching Chromium, as the harness requires), then open a
 * context. `prepare` runs on each page after every (re)load (e.g. to inject a grayscale filter).
 */
export async function openMutationsPages(opts: {
  readonly viewport?: { width: number; height: number };
  readonly prepare?: (page: Page) => Promise<void>;
} = {}): Promise<MutationsBrowserSession> {
  const [built, browser] = await Promise.all([builtPages(), sharedBrowser()]);
  const context: BrowserContext = await browser.newContext(
    opts.viewport !== undefined ? { viewport: opts.viewport } : {},
  );
  context.setDefaultTimeout(30_000);
  const pages = new Map<string, Page>();

  return {
    async fresh(id, theme) {
      const i = jobs.findIndex((j) => j.def.id === id && j.theme === theme);
      if (i < 0) throw new Error(`no mutations fixture page ${id} (${theme})`);
      const key = `${id}\0${theme}`;
      let page = pages.get(key);
      if (page === undefined) {
        page = await context.newPage();
        pages.set(key, page);
      }
      await page.bringToFront(); // announcements and effects run on rAF; keep the tab in the foreground
      await page.goto(built[i]!.url, { waitUntil: "load" });
      await page.waitForSelector("html[data-fixture-ready]");
      await page.waitForSelector(jobs[i]!.def.ready);
      if (opts.prepare !== undefined) await opts.prepare(page);
      return page;
    },
    async close() {
      await context.close();
    },
  };
}

// ── Page drivers ─────────────────────────────────────────────────────────────

/** Script the next POST /api/mutations/* replies ("success" | "refuse" | "hold", see mutations-render.tsx). */
export async function setReply(page: Page, mode: "success" | "refuse" | "hold"): Promise<void> {
  await page.evaluate((m) => {
    (window as unknown as { __pulseMutationReply: string }).__pulseMutationReply = m;
  }, mode);
}

/** The POSTs the page has sent so far. */
export function posts(page: Page): Promise<Array<{ path: string; body: Record<string, unknown> }>> {
  return page.evaluate(
    () => (window as unknown as { __pulseMutationPosts: Array<{ path: string; body: Record<string, unknown> }> })
      .__pulseMutationPosts,
  );
}

/** Answer a POST held by the "hold" reply mode. */
export async function releaseHeldPost(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof (window as unknown as { __pulseMutationRelease?: () => void }).__pulseMutationRelease === "function");
  await page.evaluate(() => (window as unknown as { __pulseMutationRelease: () => void }).__pulseMutationRelease());
}

/** The page's trigger for its dialog, by role and accessible name. */
export function triggerOf(page: Page, id: DialogPageId): Locator {
  return page.getByRole("button", { name: DIALOG_PAGES[id].triggerName, exact: true });
}

/** The page's open dialog, by role and accessible name. */
export function dialogOf(page: Page, id: DialogPageId): Locator {
  return page.getByRole(DIALOG_PAGES[id].role, { name: DIALOG_PAGES[id].name });
}

/** Open a page's dialog by clicking its trigger and wait for the lazy chunk's dialog. */
export async function openDialog(page: Page, id: DialogPageId): Promise<void> {
  await triggerOf(page, id).click();
  await dialogOf(page, id).waitFor();
}

/** Click a dialog's primary action. */
export async function clickSubmit(page: Page, id: DialogPageId): Promise<void> {
  await dialogOf(page, id).getByRole("button", { name: DIALOG_PAGES[id].submit }).click();
}

/**
 * Bring an open dialog into its "validation errors shown" state:
 *  - silence / expire / ack: a valid text entry, then a scripted server `invalid-body` refusal naming the
 *    text field → the field is aria-invalid with its error line, and a failed StateBadge shows;
 *  - propose: submit with no change included and no rationale → the client-side count + rationale errors.
 * Resolves once an `[aria-invalid="true"]` field is present.
 */
export async function showValidationErrors(page: Page, id: DialogPageId): Promise<void> {
  const dialog = dialogOf(page, id);
  if (id === "propose") {
    await clickSubmit(page, id);
  } else {
    const field = id === "ack" ? "note" : "rationale";
    await dialog.locator(`textarea[name="${field}"]`).fill(VALID_RATIONALE);
    await setReply(page, "refuse");
    await clickSubmit(page, id);
    await dialog.locator('[data-mut-result] [data-state="failed"]').waitFor();
  }
  await dialog.locator('[aria-invalid="true"]').first().waitFor();
}

/** Describe document.activeElement (tag, text, whether it is inside the open dialog). */
export function activeInfo(page: Page): Promise<{ tag: string; text: string; inDialog: boolean; name: string | null }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName.toLowerCase() ?? "",
      text: el?.textContent?.trim() ?? "",
      name: el?.getAttribute("aria-label") ?? null,
      inDialog: el !== null && el.closest('[role="dialog"], [role="alertdialog"]') !== null,
    };
  });
}

/** Text currently in the announcer's polite / assertive region. */
export function announcerText(page: Page, politeness: "polite" | "assertive"): Promise<string> {
  return page.evaluate(
    (p) => document.querySelector(`[data-politeness="${p}"]`)?.textContent?.trim() ?? "",
    politeness,
  );
}
