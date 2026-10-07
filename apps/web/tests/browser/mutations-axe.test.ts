// apps/web/tests/browser/mutations-axe.test.ts — SC-06, REQ-A11Y-01 (10 §6; 09 §9.2).
//
// Runs @axe-core/playwright (axe-core 4.13, which carries the wcag22aa tag) over every mutation surface —
// each of the four dialogs (Silence, Expire, Ack on an acked alert, Propose) open AND with validation
// errors shown, the ProposalList disclosure (pending / applied / rejected) and the three action-state
// badges — in BOTH themes, asserting ZERO wcag2a / wcag2aa / wcag21aa / wcag22aa violations.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe); THROWS at collection under
// PULSE_REQUIRE_BROWSER=1.

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright-core";

import { browserDescribe } from "./_harness.js";
import {
  DIALOG_PAGE_IDS, MUTATIONS_THEMES, dialogOf, openDialog, openMutationsPages, showValidationErrors,
  type MutationsBrowserSession,
} from "./mutations-browser.js";

const TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

async function expectNoViolations(page: Page): Promise<void> {
  const { AxeBuilder } = await import("@axe-core/playwright");
  const results = await new AxeBuilder({ page }).options({ resultTypes: ["violations"] }).withTags(TAGS).analyze();
  const summary = results.violations.map((v) => ({
    id: v.id,
    nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
  }));
  expect(results.violations, JSON.stringify(summary, null, 2)).toEqual([]);
}

browserDescribe()("browser: mutation UI axe zero WCAG 2.2 AA violations, both themes (SC-06, REQ-A11Y-01)", () => {
  let session: MutationsBrowserSession;

  beforeAll(async () => {
    session = await openMutationsPages();
  }, 600_000);

  afterAll(async () => {
    await session?.close();
  }, 60_000);

  for (const theme of MUTATIONS_THEMES) {
    for (const id of DIALOG_PAGE_IDS) {
      test(`${id} dialog open: zero violations in ${theme} theme (REQ-A11Y-01)`, async () => {
        const page = await session.fresh(id, theme);
        await openDialog(page, id);
        await expectNoViolations(page);
      }, 60_000);

      test(`${id} dialog with validation errors shown: zero violations in ${theme} theme (REQ-A11Y-01, REQ-A11Y-03)`, async () => {
        const page = await session.fresh(id, theme);
        await openDialog(page, id);
        await showValidationErrors(page, id);
        expect(await dialogOf(page, id).locator('[aria-invalid="true"]').count()).toBeGreaterThan(0);
        await expectNoViolations(page);
      }, 60_000);
    }

    test(`ProposalList (pending / applied / rejected, expanded): zero violations in ${theme} theme (REQ-A11Y-01, REQ-UX-04)`, async () => {
      const page = await session.fresh("proposal-list", theme);
      await page.locator("[data-testid=proposal-list] [data-slot=disclosure] button[aria-expanded]").click();
      await page.waitForSelector('[data-testid=proposal-list] [data-proposal-id] [data-state="rejected"]');
      const states = await page.locator("[data-testid=proposal-list] [data-proposal-id] [data-state]").evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-state")));
      for (const s of ["pending", "applied", "rejected"]) expect(states).toContain(s);
      await expectNoViolations(page);
    }, 60_000);

    test(`StateBadge ×3 (acked / pending / failed): zero violations in ${theme} theme (REQ-A11Y-01, REQ-A11Y-04)`, async () => {
      const page = await session.fresh("badges", theme);
      expect(await page.locator('[data-state] > [data-slot="status-badge"]').count()).toBe(3);
      await expectNoViolations(page);
    }, 60_000);
  }
});
