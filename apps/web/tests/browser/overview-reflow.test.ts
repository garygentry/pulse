// apps/web/tests/browser/overview-reflow.test.ts — 08-testing-strategy.md §5.4 (and §5.6 readiness).
//
// At a 375×812 touch viewport the REAL overview composition (overview-fixture.tsx, `status` mode: 4
// hosts, all five statuses) MUST reflow, never side-scroll, in BOTH themes:
//   - the document's scrollWidth stays within 375px and no rendered element box inside `[data-slot="overview-page"]`
//     crosses either viewport edge;
//   - stat/ribbon/grid/control labels are not clipped below their own content width;
//   - every host trigger, service chip, group toggle, layout select, ribbon button and the drawer's
//     close button measures at least the shared 44×44 CSS px touch minimum;
//   - a touch tap on a host trigger opens the drawer for exactly that target without page-level
//     horizontal overflow, and both Escape and the close button return focus to the tapped trigger.
// Plus the kiosk fit: under ?kiosk=1 at 1280×720, 1920×1080, 768×1024 and 375×812 the page root fills
// exactly the viewport space below the chrome above it (the fixture's 56px kiosk top bar), so the
// document never scrolls either way, the compact chrome leaves the tile wall at least two rows, and a
// full page holds exactly columns × rows tiles, none cut off.
// Layout, touch geometry and real tap dispatch are engine properties happy-dom cannot compute.
//
// SELF-SKIPS when Chromium is not provisioned (_harness.browserDescribe); THROWS at collection under
// PULSE_REQUIRE_BROWSER=1 so CI never green-skips it.

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright-core";

import { browserDescribe, type FixturePage, type FixtureTheme } from "./_harness.js";
import {
  buildOverviewFixtures,
  launchOverviewBrowser,
  openOverviewPage,
  OVERVIEW_HOST_TRIGGERS,
  OVERVIEW_SERVICE_CHIPS,
  OVERVIEW_THEMES,
  stopOverviewFixtures,
  type OverviewPageHandle,
} from "./overview-browser.js";

const VIEWPORT = { width: 375, height: 812 } as const;
const TOUCH_MIN_PX = 44;
const DIALOG = "[role=dialog]";
const DRAWER_CLOSE = '[aria-label="Close target details"]';
/** The host whose trigger is tapped in the drawer cases. */
const TAPPED_HOST_ID = "host:host-002";
const TAPPED_TRIGGER = `${OVERVIEW_HOST_TRIGGERS}[data-target-id="${TAPPED_HOST_ID}"]`;

const HOST_NAME = "[data-slot='overview-host-name']";
const CHIP_NAME = "[data-slot='overview-chip-name']";
const GROUP_TOGGLE = "[data-group-toggle]";

/** Text-bearing stat/ribbon/grid/control elements that must not clip their own content. */
const LABEL_SELECTORS = [
  "[data-stat-title]",
  "[data-ribbon] h2",
  "[role='rowgroup'] [role='columnheader'] h2",
  HOST_NAME,
  CHIP_NAME,
  "[data-slot='status-badge'] > span",
  "[data-slot='status-badge']",
  "[data-control] > span",
  "[data-control] [role='radio']",
] as const;

/** Interactive targets that must meet the 44×44 touch minimum in both axes. */
const TOUCH_SELECTORS = [
  OVERVIEW_HOST_TRIGGERS,
  OVERVIEW_SERVICE_CHIPS,
  GROUP_TOGGLE,
  "[data-control] [role='radio']",
  "[data-ribbon-action='alert']",
  "[data-ribbon-action='target']",
] as const;

/** Rendered elements (non-zero box, not display:none) inside `root` crossing the viewport edges. */
function boxesOutsideViewport(page: Page, root: string): Promise<string[]> {
  return page.evaluate(
    ({ root: rootSelector, width }) => {
      const bad: string[] = [];
      const scope = document.querySelector(rootSelector);
      if (scope === null) return [`${rootSelector} not found`];
      for (const el of [scope, ...Array.from(scope.querySelectorAll("*"))]) {
        if (getComputedStyle(el).display === "none") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > width + 1 || r.left < -1) {
          const cls = typeof el.className === "string" ? el.className : "";
          bad.push(`<${el.tagName.toLowerCase()} class="${cls}"> "${(el.textContent ?? "").trim().slice(0, 40)}" left=${r.left} right=${r.right}`);
        }
      }
      return bad;
    },
    { root, width: VIEWPORT.width },
  );
}

function documentWidth(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

/** Every rendered match of `selectors` smaller than the touch minimum; also counts the matches. */
function undersizedTargets(page: Page, selectors: readonly string[]): Promise<{ checked: Record<string, number>; bad: string[] }> {
  return page.evaluate(
    ({ selectors: list, min }) => {
      const checked: Record<string, number> = {};
      const bad: string[] = [];
      for (const sel of list) {
        checked[sel] = 0;
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (getComputedStyle(el).display === "none") continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          checked[sel] += 1;
          if (r.width < min || r.height < min) {
            bad.push(`${sel} "${(el.textContent ?? "").trim().slice(0, 40)}" ${r.width.toFixed(1)}×${r.height.toFixed(1)}`);
          }
        }
      }
      return { checked, bad };
    },
    { selectors: [...selectors], min: TOUCH_MIN_PX },
  );
}

function activeTargetId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute("data-target-id") ?? null);
}

browserDescribe()("browser: overview 375px reflow, touch targets and touch drawer, both themes (08 §5.4)", () => {
  let browser: Browser;
  let fixtures: Map<FixtureTheme, FixturePage> | undefined;
  const handles: OverviewPageHandle[] = [];

  async function open(theme: FixtureTheme): Promise<OverviewPageHandle> {
    const handle = await openOverviewPage(browser, fixtures!, { theme, mode: "status", viewport: VIEWPORT, hasTouch: true });
    handles.push(handle);
    return handle;
  }

  /** Tap the fixed host trigger and wait for its drawer; returns the dialog text and drawer target. */
  async function tapOpenDrawer(page: Page): Promise<{ dialogText: string; drawerTarget: string | null; hostName: string }> {
    const trigger = page.locator(TAPPED_TRIGGER);
    const hostName = ((await trigger.locator(HOST_NAME).textContent()) ?? "").trim();
    await trigger.tap();
    await page.waitForSelector(DIALOG);
    return page.evaluate(
      ({ dialog, name }) => {
        const el = document.querySelector(dialog);
        return {
          dialogText: el?.textContent ?? "",
          drawerTarget: el?.querySelector("[data-drawer-target]")?.getAttribute("data-drawer-target") ?? null,
          hostName: name,
        };
      },
      { dialog: DIALOG, name: hostName },
    );
  }

  beforeAll(async () => {
    // Build BEFORE launching Chromium (see _harness.buildFixturePage).
    fixtures = await buildOverviewFixtures();
    browser = await launchOverviewBrowser();
  }, 180_000);

  afterAll(async () => {
    for (const handle of handles) await handle.close();
    stopOverviewFixtures(fixtures);
  }, 60_000);

  for (const theme of OVERVIEW_THEMES) {
    test(`no horizontal document overflow and no element box crosses the 375px viewport (${theme})`, async () => {
      const handle = await open(theme);
      try {
        const { page } = handle;
        const width = await documentWidth(page);
        expect(width.scrollWidth, `documentElement overflows: ${JSON.stringify(width)}`).toBeLessThanOrEqual(VIEWPORT.width);
        const outside = await boxesOutsideViewport(page, '[data-slot="overview-page"]');
        expect(outside, `element boxes crossing the 375px viewport:\n${outside.join("\n")}`).toEqual([]);
      } finally {
        await handle.close();
      }
    }, 60_000);

    test(`stat/ribbon/grid/control labels are not clipped at 375px (${theme})`, async () => {
      const handle = await open(theme);
      try {
        const result = await handle.page.evaluate((selectors) => {
          const bad: string[] = [];
          const counts: Record<string, number> = {};
          for (const sel of selectors) {
            counts[sel] = 0;
            for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[data-slot="overview-page"] ${sel}`))) {
              if (getComputedStyle(el).display === "none") continue;
              counts[sel] += 1;
              if (el.scrollWidth > el.clientWidth + 1) {
                bad.push(`${sel} "${(el.textContent ?? "").trim().slice(0, 40)}" scrollWidth=${el.scrollWidth} clientWidth=${el.clientWidth}`);
              }
            }
          }
          return { bad, counts };
        }, [...LABEL_SELECTORS]);
        // The grid and control labels must actually be present, or the check proves nothing.
        expect(result.counts[HOST_NAME], JSON.stringify(result.counts)).toBe(4);
        expect(result.counts[CHIP_NAME], JSON.stringify(result.counts)).toBeGreaterThan(0);
        expect(result.counts["[data-control] > span"], JSON.stringify(result.counts)).toBe(2);
        expect(result.counts["[data-stat-title]"], JSON.stringify(result.counts)).toBe(5);
        expect(result.counts["[data-slot='status-badge']"], JSON.stringify(result.counts)).toBeGreaterThan(0);
        expect(result.bad, `clipped labels at 375px:\n${result.bad.join("\n")}`).toEqual([]);
      } finally {
        await handle.close();
      }
    }, 60_000);

    test(`host, service, group, control and ribbon targets are at least 44×44 CSS px (${theme})`, async () => {
      const handle = await open(theme);
      try {
        const { checked, bad } = await undersizedTargets(handle.page, TOUCH_SELECTORS);
        expect(checked[OVERVIEW_HOST_TRIGGERS], JSON.stringify(checked)).toBe(4);
        expect(checked[OVERVIEW_SERVICE_CHIPS], JSON.stringify(checked)).toBeGreaterThan(0);
        expect(checked["[data-control] [role='radio']"], JSON.stringify(checked)).toBe(6);
        expect(checked[GROUP_TOGGLE], JSON.stringify(checked)).toBeGreaterThan(0);
        expect(checked["[data-ribbon-action='alert']"]! + checked["[data-ribbon-action='target']"]!, JSON.stringify(checked)).toBeGreaterThan(0);
        expect(bad, `touch targets below ${TOUCH_MIN_PX}×${TOUCH_MIN_PX} (checked ${JSON.stringify(checked)}):\n${bad.join("\n")}`).toEqual([]);
      } finally {
        await handle.close();
      }
    }, 60_000);

    test(`a touch tap opens the tapped host's drawer without side-scroll; Escape restores focus (${theme})`, async () => {
      const handle = await open(theme);
      try {
        const { page } = handle;
        const opened = await tapOpenDrawer(page);
        expect(opened.hostName).not.toBe("");
        expect(opened.dialogText).toContain(opened.hostName);
        expect(opened.drawerTarget).toBe(TAPPED_HOST_ID);

        const width = await documentWidth(page);
        expect(width.scrollWidth, `open drawer overflows the page: ${JSON.stringify(width)}`).toBeLessThanOrEqual(VIEWPORT.width);

        // The modal lock writes pointer-events and a gap variable on <body>; neither may cascade into the
        // page, so opening the drawer never restyles the whole grid (the input-response perf budget).
        const lock = await page.evaluate(() => {
          const root = document.querySelector("[data-slot=overview-page]")!;
          const prop = "--removed-body-scroll-bar-size";
          return {
            bodyPointer: getComputedStyle(document.body).pointerEvents,
            rootPointer: getComputedStyle(root).pointerEvents,
            bodyGap: getComputedStyle(document.body).getPropertyValue(prop).trim(),
            // A sentinel on body must not reach the root: the gap variable is registered non-inherited.
            rootGap: (() => {
              const saved = document.body.style.getPropertyValue(prop);
              document.body.style.setProperty(prop, "123px");
              const value = getComputedStyle(root).getPropertyValue(prop).trim();
              if (saved === "") document.body.style.removeProperty(prop);
              else document.body.style.setProperty(prop, saved);
              return value;
            })(),
          };
        });
        expect(lock.bodyPointer, "the modal lock should disable body pointer events").toBe("none");
        expect(lock.rootPointer).toBe("auto");
        expect(lock.bodyGap, "the scroll lock should set its gap variable on body").not.toBe("");
        expect(lock.rootGap, "the scroll-lock gap variable must not inherit into the page").toBe("0px");

        const close = await undersizedTargets(page, [DRAWER_CLOSE]);
        expect(close.checked[DRAWER_CLOSE]).toBe(1);
        expect(close.bad, `drawer close below ${TOUCH_MIN_PX}×${TOUCH_MIN_PX}:\n${close.bad.join("\n")}`).toEqual([]);

        await page.keyboard.press("Escape");
        await page.waitForSelector(DIALOG, { state: "detached" });
        expect(await activeTargetId(page)).toBe(TAPPED_HOST_ID);
      } finally {
        await handle.close();
      }
    }, 60_000);

    test(`tapping the drawer close button closes it and restores focus to the tapped trigger (${theme})`, async () => {
      const handle = await open(theme);
      try {
        const { page } = handle;
        const opened = await tapOpenDrawer(page);
        expect(opened.drawerTarget).toBe(TAPPED_HOST_ID);
        await page.locator(`${DIALOG} ${DRAWER_CLOSE}`).tap();
        await page.waitForSelector(DIALOG, { state: "detached" });
        expect(await activeTargetId(page)).toBe(TAPPED_HOST_ID);
        const width = await documentWidth(page);
        expect(width.scrollWidth, `document overflows after closing: ${JSON.stringify(width)}`).toBeLessThanOrEqual(VIEWPORT.width);
      } finally {
        await handle.close();
      }
    }, 60_000);
  }
});

/** The fixture's stand-in for the shell's kiosk top bar (overview-fixture.tsx). */
const KIOSK_CHROME = "[data-fixture-chrome]";
const KIOSK_VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 375, height: 812 },
] as const;

/** Badges in the kiosk stat strip that are not wholly inside it (clipped or pushed out of view). */
function stripClipped(page: Page): Promise<{ clipped: string[]; badges: number; scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>("[data-stat-strip]");
    const box = strip?.getBoundingClientRect();
    const badges = Array.from(strip?.querySelectorAll<HTMLElement>('[data-slot="status-badge"], [data-slot="badge"]') ?? []);
    const clipped = badges
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const inner = el.querySelector<HTMLElement>(":scope > span");
        const truncated = inner !== null && inner.scrollWidth > inner.clientWidth + 1;
        return box === undefined || r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.right > window.innerWidth || truncated;
      })
      .map((el) => el.textContent ?? "");
    return { clipped, badges: badges.length, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
  });
}

browserDescribe()("browser: overview kiosk page fits below the chrome and pages by columns × rows (no page scroll)", () => {
  let browser: Browser;
  let fixtures: Map<FixtureTheme, FixturePage> | undefined;

  beforeAll(async () => {
    fixtures = await buildOverviewFixtures();
    browser = await launchOverviewBrowser();
  }, 180_000);

  afterAll(async () => {
    stopOverviewFixtures(fixtures);
  }, 60_000);

  for (const viewport of KIOSK_VIEWPORTS) {
    test(`kiosk at ${viewport.width}×${viewport.height}: root spans chrome bottom → viewport bottom, document does not scroll`, async () => {
      const handle = await openOverviewPage(browser, fixtures!, { theme: "dark", mode: "kiosk", viewport });
      try {
        const { page } = handle;
        await page.waitForSelector('[data-slot="overview-kiosk-page"]');
        const geometry = await page.evaluate((chrome) => {
          const scroller = document.scrollingElement ?? document.documentElement;
          const root = document.querySelector<HTMLElement>('[data-slot="overview-page"][data-kiosk="true"]');
          const bar = document.querySelector<HTMLElement>(chrome);
          const kiosk = document.querySelector<HTMLElement>('[data-slot="overview-kiosk"]');
          const rootBox = root?.getBoundingClientRect();
          const kioskBox = kiosk?.getBoundingClientRect();
          const region = document.querySelector<HTMLElement>('[data-slot="overview-kiosk-region"]')?.getBoundingClientRect();
          const list = document.querySelector<HTMLElement>('[data-slot="overview-kiosk-page"] ul[role="list"]');
          const tiles = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="overview-kiosk-tile"]')).map((el) => el.getBoundingClientRect());
          const style = list === null ? null : getComputedStyle(list);
          const columns = style === null ? 0 : style.gridTemplateColumns.split(" ").filter((t) => t.endsWith("px")).length;
          const rowHeight = style === null ? 0 : Number.parseFloat(style.gridAutoRows);
          const rowGap = style === null ? 0 : Number.parseFloat(style.rowGap) || 0;
          const indicator = document.querySelector('[data-slot="overview-kiosk-indicator"]')?.textContent ?? "1 / 1";
          const strip = document.querySelector<HTMLElement>("[data-stat-strip]");
          // One line = the box is no taller than its tallest visible child.
          const lines = (box: HTMLElement | null): number => {
            if (box === null) return 0;
            const kids = Array.from(box.children).filter((el) => el.getBoundingClientRect().height > 0);
            const tallest = Math.max(...kids.map((el) => el.getBoundingClientRect().height));
            return Math.round(box.getBoundingClientRect().height / tallest);
          };
          // Every chip's status word (the badge's last text span) shows in full.
          const clippedWords = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="overview-kiosk-chip-status"]'))
            .map((el) => el.parentElement!)
            .filter((el) => el.scrollWidth > el.clientWidth + 1)
            .map((el) => el.textContent);
          return {
            stripRows: lines(strip),
            ribbonRows: lines(document.querySelector<HTMLElement>("[data-ribbon='kiosk']")),
            clippedWords,
            zoneWidth: document.querySelector('[data-slot="overview-kiosk-footer"] [data-zone]')?.getBoundingClientRect().width ?? 0,
            chipWords: document.querySelectorAll('[data-slot="overview-kiosk-chip-status"]').length,
            scrollWidth: scroller.scrollWidth,
            innerWidth: window.innerWidth,
            regionTop: region?.top ?? null,
            regionBottom: region?.bottom ?? null,
            regionHeight: region?.height ?? null,
            tileCount: tiles.length,
            tilesBottom: tiles.length === 0 ? null : Math.max(...tiles.map((r) => r.bottom)),
            tilesRight: tiles.length === 0 ? null : Math.max(...tiles.map((r) => r.right)),
            columns,
            rows: region === undefined || rowHeight <= 0 ? 0 : Math.floor((region.height + rowGap) / (rowHeight + rowGap)),
            pages: Number(/\/\s*(\d+)/.exec(indicator)?.[1] ?? "1"),
            scrollHeight: scroller.scrollHeight,
            innerHeight: window.innerHeight,
            chromeBottom: bar?.getBoundingClientRect().bottom ?? null,
            rootTop: rootBox?.top ?? null,
            rootBottom: rootBox?.bottom ?? null,
            kioskBottom: kioskBox?.bottom ?? null,
            kioskHeight: kioskBox?.height ?? null,
            offsetVar: root?.style.getPropertyValue("--overview-kiosk-top") ?? null,
          };
        }, KIOSK_CHROME);
        const detail = JSON.stringify(geometry);
        expect(geometry.scrollHeight, `kiosk page scrolls: ${detail}`).toBeLessThanOrEqual(geometry.innerHeight);
        expect(geometry.chromeBottom, detail).not.toBeNull();
        // The root starts under the chrome and ends at the viewport bottom (within a pixel of rounding).
        expect(Math.abs(geometry.rootTop! - geometry.chromeBottom!), detail).toBeLessThanOrEqual(1);
        expect(Math.abs(geometry.rootBottom! - geometry.innerHeight), detail).toBeLessThanOrEqual(1);
        expect(geometry.offsetVar, detail).toBe(`${Math.ceil(geometry.rootTop!)}px`);
        // The paged grid gets real height and stays inside the viewport.
        expect(geometry.kioskHeight!, detail).toBeGreaterThan(100);
        expect(geometry.kioskBottom!, detail).toBeLessThanOrEqual(geometry.innerHeight + 1);
        // No horizontal page scroll at any kiosk width (phones included).
        expect(geometry.scrollWidth, `kiosk page scrolls sideways: ${detail}`).toBeLessThanOrEqual(geometry.innerWidth);
        // The compact chrome leaves the tile wall at least two rows, and the page is filled by plain
        // columns × rows arithmetic: a full page (the fixture has 100 hosts) shows exactly that many
        // tiles, every one inside the region — nothing clipped, no lost row or column.
        expect(geometry.rows, detail).toBeGreaterThanOrEqual(2);
        expect(geometry.columns, detail).toBeGreaterThanOrEqual(1);
        expect(geometry.pages, detail).toBeGreaterThan(1);
        expect(geometry.tileCount, detail).toBe(geometry.columns * geometry.rows);
        expect(geometry.tilesBottom!, detail).toBeLessThanOrEqual(geometry.regionBottom! + 0.5);
        expect(geometry.tilesRight!, detail).toBeLessThanOrEqual(geometry.innerWidth);
        // At wallboard widths the stat strip (from `xl`) and the alert line (from `sm`) are each
        // exactly one line — the 100-host fixture has every status — so their height never moves the
        // tile region.
        if (viewport.width >= 1280) expect(geometry.stripRows, detail).toBe(1);
        if (viewport.width >= 640) expect(geometry.ribbonRows, detail).toBe(1);
        // No strip badge is clipped or pushed out of view at any width (it wraps instead).
        const strip = await stripClipped(page);
        expect(strip.badges, JSON.stringify(strip)).toBeGreaterThanOrEqual(5);
        expect(strip.clipped, JSON.stringify(strip)).toEqual([]);
        // The estate zone stays visible in the footer.
        expect(geometry.zoneWidth, detail).toBeGreaterThan(0);
        // Service chips truncate the name, never the status word.
        expect(geometry.chipWords, detail).toBeGreaterThan(0);
        expect(geometry.clippedWords, detail).toEqual([]);
      } finally {
        await handle.close();
      }
    }, 90_000);
  }

  test("kiosk at 1280×720 with thousands of services: compact counts, Coverage and Engine in view, nothing clipped", async () => {
    const handle = await openOverviewPage(browser, fixtures!, { theme: "dark", mode: "kiosk", viewport: { width: 1280, height: 720 }, scale: "large" });
    try {
      const { page } = handle;
      await page.waitForSelector('[data-slot="overview-kiosk-tile"]');
      const strip = await stripClipped(page);
      const detail = JSON.stringify(strip);
      expect(strip.clipped, detail).toEqual([]);
      expect(strip.scrollWidth, detail).toBeLessThanOrEqual(strip.innerWidth);
      const text = await page.evaluate(() => document.querySelector("[data-stat-strip]")?.textContent ?? "");
      expect(text, detail).toMatch(/\d(\.\d)?K/); // compact visible count
      expect(text, detail).toMatch(/\d,?\d{3} services/); // exact count for assistive technology
      for (const stat of ["coverage", "engine"]) {
        const visible = await page.evaluate((s) => {
          const el = document.querySelector<HTMLElement>(`[data-stat-strip] [data-stat="${s}"]`);
          const r = el?.getBoundingClientRect();
          return r !== undefined && r.width > 0 && r.right <= window.innerWidth;
        }, stat);
        expect(visible, `${stat} not in view: ${detail}`).toBe(true);
      }
    } finally {
      await handle.close();
    }
  }, 90_000);
});
