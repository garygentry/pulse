// apps/web/tests/alerts-view-detail.test.ts — the composed detail pane: a Radix Sheet opened iff `sel`
// is set. DOM blocks use describeDom (tests/dom.ts), happy-dom per file; installUiStubs makes Radix
// Portal/FocusScope work under happy-dom. The Sheet is portalled, so it is queried on `document`.
// globalThis.fetch is stubbed so the History section (the only on-demand fetch) never reaches the
// network.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import type { AlertsPayload } from "@pulse/web-data/wire";
import type { ReactElement } from "react";
import { createAppStore } from "../src/client/store/index.js";
import type { AppStore } from "../src/client/store/index.js";
import type { SessionState } from "../src/client/store/types.js";
import { describeDom } from "./dom.js";
import { act } from "./react-render.js";
import { installUiStubs } from "./rtl.js";
import { detailDialog, detailSection, dialogTitle, eventually } from "./alerts-dom-helpers.js";
import {
  FIXTURE_FINGERPRINTS,
  UNKNOWN_SEL_FINGERPRINT,
  makeAlertsPayload,
  makeHistoryPayload,
  makeSession,
} from "./alerts-fixtures.js";

const payload = makeAlertsPayload({ scenario: "mixed" });

function seededStore(): AppStore {
  const s = makeSession();
  const session: SessionState = { identity: null, authMode: s.authMode, capabilities: { ...s.capabilities } };
  const store = createAppStore({ storage: null, initialQuery: {} });
  store.session.value = session;
  return store;
}

/** Radix arms its dismiss listeners and moves focus a tick after (un)mounting. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

const originalFetch = globalThis.fetch;
let fetchCalls: string[] = [];

describeDom("DetailPane", (dom) => {
  let restoreStubs: (() => void) | null = null;
  beforeAll(() => {
    restoreStubs = installUiStubs();
  });
  afterAll(() => restoreStubs?.());

  const mounted: (() => void)[] = [];
  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      fetchCalls.push(String(input));
      return Promise.resolve({ json: () => Promise.resolve(makeHistoryPayload({ kind: "ready" })) });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    for (const u of mounted.splice(0)) u();
    globalThis.fetch = originalFetch;
  });

  interface MountOpts {
    readonly selected: string | null;
    readonly payload?: AlertsPayload | null;
    readonly onClose?: () => void;
    readonly onSelect?: (fp: string) => void;
  }

  async function mountPane(opts: MountOpts): Promise<{ container: HTMLElement; dialog: HTMLElement | null }> {
    const { createElement: h } = await import("react");
    const { DetailPane } = await import("../src/client/views/alerts/detail/DetailPane.js");
    let m!: { container: HTMLElement; unmount(): void };
    await act(async () => {
      m = await dom.mount(
        h(DetailPane, {
          store: seededStore(),
          payload: opts.payload === undefined ? payload : opts.payload,
          selected: opts.selected,
          onClose: opts.onClose ?? (() => {}),
          ...(opts.onSelect !== undefined ? { onSelect: opts.onSelect } : {}),
        }) as unknown as ReactElement,
      );
    });
    mounted.push(m.unmount);
    await settle();
    return { container: m.container, dialog: detailDialog() };
  }

  /** A harness owning `selected` like view.tsx does: a row-open button sets it, onClose clears it. */
  async function mountHarness(): Promise<{
    opener: HTMLButtonElement;
    closes: () => number;
  }> {
    const React = await import("react");
    const { DetailPane } = await import("../src/client/views/alerts/detail/DetailPane.js");
    const store = seededStore();
    let closes = 0;
    function Harness(): ReactElement {
      const [selected, setSelected] = React.useState<string | null>(null);
      return React.createElement(
        "div",
        null,
        React.createElement(
          "button",
          { type: "button", "data-triage-open": FIXTURE_FINGERPRINTS.hostDown, onClick: () => setSelected(FIXTURE_FINGERPRINTS.hostDown) },
          "HostDown",
        ),
        React.createElement(DetailPane, {
          store,
          payload,
          selected,
          onClose: () => {
            closes += 1;
            setSelected(null);
          },
        }),
      ) as unknown as ReactElement;
    }
    let m!: { container: HTMLElement; unmount(): void };
    await act(async () => {
      m = await dom.mount(React.createElement(Harness) as unknown as ReactElement);
    });
    mounted.push(m.unmount);
    const opener = m.container.querySelector<HTMLButtonElement>("[data-triage-open]")!;
    return { opener, closes: () => closes };
  }

  async function openFrom(opener: HTMLButtonElement): Promise<HTMLElement> {
    opener.focus();
    await act(async () => opener.click());
    // Initial focus is the dialog itself (named by its title).
    await eventually(() => {
      const dialog = detailDialog();
      if (dialog === null || document.activeElement !== dialog) throw new Error("Sheet not open/focused");
    }, 15_000);
    await settle(); // Radix arms its dismiss listeners a tick after mounting
    return detailDialog()!;
  }

  test("renders nothing when selected is null", async () => {
    const { dialog } = await mountPane({ selected: null });
    expect(dialog).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });

  test("opens a modal Sheet titled by alert.name and composes the sections in order", async () => {
    const { container, dialog } = await mountPane({ selected: FIXTURE_FINGERPRINTS.hostDown });
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    expect(dialog!.getAttribute("data-slot")).toBe("sheet-content");
    expect(container.contains(dialog)).toBe(false); // portalled
    expect(dialogTitle(dialog!)).toBe("HostDown");
    const title = dialog!.querySelector("[data-slot=sheet-title]");
    expect(title?.tagName).toBe("H2");
    // One visible close control with an accessible name.
    const closes = dialog!.querySelectorAll('button[aria-label="Close alert details"]');
    expect(closes.length).toBe(1);
    expect(closes[0]!.textContent).toContain("Close");
    // Regions in order, each an h3-headed Section named as before.
    const names = ["Labels and annotations", "Routing", "Firing history", "Related alerts on this target", "Actions"];
    const all = [...dialog!.querySelectorAll("*")];
    const order = names.map((name) => {
      const section = detailSection(dialog!, name);
      expect(section).not.toBeNull();
      const heading = document.getElementById(section!.getAttribute("aria-labelledby")!);
      expect(heading?.tagName).toBe("H3");
      return all.indexOf(section!);
    });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(detailSection(dialog!, "Actions")!.querySelector('[data-action-slot="silence"]')).not.toBeNull();
    expect(dialog!.querySelector("[data-history-state]")).not.toBeNull();
  });

  test("labels/annotations render with a safe runbook link", async () => {
    const { dialog } = await mountPane({ selected: FIXTURE_FINGERPRINTS.hostDown });
    const section = detailSection(dialog!, "Labels and annotations")!;
    const link = section.querySelector<HTMLAnchorElement>('a[data-slot="external-link"]');
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("https://runbooks.example.test/host-down");
    expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(section.querySelector('[data-slot="key-value-list"] [data-kind="label"]')).not.toBeNull();
  });

  test("an unsafe runbook scheme renders inert text, never a link", async () => {
    const { dialog } = await mountPane({ selected: FIXTURE_FINGERPRINTS.diskFull });
    const section = detailSection(dialog!, "Labels and annotations")!;
    expect(section.querySelector("a")).toBeNull();
    expect(section.querySelector('[data-runbook="unsafe"] code')?.textContent).toBe("javascript:alert(1)");
    for (const a of dialog!.querySelectorAll("a")) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    }
  });

  test("routing explanation is present with intended policy and actual receivers", async () => {
    const { dialog } = await mountPane({ selected: FIXTURE_FINGERPRINTS.hostDown });
    const section = detailSection(dialog!, "Routing")!;
    expect(section.querySelector('[data-slot="key-value-list"][data-routing="intent"]')).not.toBeNull();
    expect(section.querySelector('[role="group"][aria-label="Actual receivers"]')).not.toBeNull();
  });

  test("matching silences are listed for a silenced alert (unresolved ids surfaced)", async () => {
    const { dialog } = await mountPane({ selected: FIXTURE_FINGERPRINTS.backupAge });
    const section = detailSection(dialog!, "Matching silences")!;
    expect(section.querySelectorAll('[data-slot="list"][data-variant="card"] [data-slot="list-item"]').length).toBe(1);
    expect(section.querySelector("[data-unresolved-count]")?.getAttribute("data-unresolved-count")).toBe("1");
    // Silences sits between Routing and History.
    const all = [...dialog!.querySelectorAll("*")];
    const idx = (el: Element | null): number => all.indexOf(el!);
    expect(idx(detailSection(dialog!, "Routing"))).toBeLessThan(idx(section));
    expect(idx(section)).toBeLessThan(idx(dialog!.querySelector("[data-history-state]")));
  });

  test("an alert that is not silenced has no silences section", async () => {
    const { dialog } = await mountPane({ selected: FIXTURE_FINGERPRINTS.hostDown });
    expect(detailSection(dialog!, "Matching silences")).toBeNull();
  });

  test("related-by-target lists exact-target siblings (not self) and wires onSelect", async () => {
    const picked: string[] = [];
    const { dialog } = await mountPane({
      selected: FIXTURE_FINGERPRINTS.hostDown,
      onSelect: (fp) => picked.push(fp),
    });
    const section = detailSection(dialog!, "Related alerts on this target")!;
    const rows = [...section.querySelectorAll<HTMLButtonElement>("button[data-related]")];
    expect(rows.map((r) => r.lastElementChild?.textContent)).toEqual(["DiskAlmostFull", "LoadHigh"]);
    await act(async () => rows[0]!.click());
    expect(picked).toEqual([FIXTURE_FINGERPRINTS.diskFull]);
  });

  test("a target-less alert shows the distinct 'No target' related state", async () => {
    const { dialog } = await mountPane({ selected: FIXTURE_FINGERPRINTS.unattributed });
    const section = detailSection(dialog!, "Related alerts on this target")!;
    expect(section.querySelector('[data-slot="empty-state"]')?.textContent ?? "").toContain("No target");
  });

  test("an unknown/churned sel renders the 'no longer firing' state inside the Sheet", async () => {
    const unknownPayload = makeAlertsPayload({ scenario: "unknown-sel" });
    const { dialog } = await mountPane({
      selected: UNKNOWN_SEL_FINGERPRINT,
      payload: unknownPayload,
    });
    expect(dialog).not.toBeNull();
    const empty = dialog!.querySelector('[data-slot="empty-state"][role="status"]');
    expect(empty?.textContent ?? "").toContain("This alert is no longer firing");
    expect(dialogTitle(dialog!)).toBe("Alert");
    expect(dialog!.querySelectorAll("section[aria-labelledby]").length).toBe(0);
    expect(dialog!.querySelector('button[aria-label="Close alert details"]')).not.toBeNull();
    expect(fetchCalls.length).toBe(0);
  });

  test("a set sel with a not-yet-loaded payload is still graceful (not blank)", async () => {
    const { dialog } = await mountPane({ selected: FIXTURE_FINGERPRINTS.hostDown, payload: null });
    expect(dialog?.textContent ?? "").toContain("This alert is no longer firing");
  });

  test("Close and Escape each call onClose once and return focus to the row-open control", async () => {
    const { opener, closes } = await mountHarness();

    let dialog = await openFrom(opener);
    await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="Close alert details"]')!.click());
    await eventually(() => {
      if (detailDialog() !== null || document.activeElement !== opener) throw new Error("not closed / focus not returned");
    }, 15_000);
    expect(closes()).toBe(1);

    dialog = await openFrom(opener);
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => {
      dialog.dispatchEvent(esc);
    });
    await eventually(() => {
      if (detailDialog() !== null || document.activeElement !== opener) throw new Error("not closed / focus not returned");
    }, 15_000);
    // The Sheet consumed the key (so the triage shortcut skips it): one Escape, one close.
    expect(esc.defaultPrevented).toBe(true);
    expect(closes()).toBe(2);
  }, 60_000);
});

test("DetailPane never navigates directly (no router import)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../src/client/views/alerts/detail/DetailPane.tsx", import.meta.url),
    "utf8",
  );
  expect(src).not.toMatch(/router|navigate\(/);
});

test("detail/*.tsx import library code only from the @/ui barrel", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("../src/client/views/alerts/detail/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), "utf8");
    expect(src, f).not.toMatch(/from "[^"]*ui\/(kit|icons)\.js"/);
    expect(src, f).not.toMatch(/from "[^"]*\/viz\//);
    expect(src, f).not.toMatch(/from "@\/ui\//);
    expect(src, f).not.toMatch(/pulse-view-alert[s]|dangerouslySetInnerHTML/);
  }
});
