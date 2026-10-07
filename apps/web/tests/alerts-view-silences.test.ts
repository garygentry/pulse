// apps/web/tests/alerts-view-silences.test.ts — the read-only active-silences tab (a DataTable over
// AlertsPayload.silences) and the expire actions. DOM blocks use describeDom (tests/dom.ts), happy-dom
// per file.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ActiveSilence, SilenceMatcher } from "@pulse/web-data/wire";
import type { ReactElement } from "react";
import { describeDom } from "./dom.js";
import { makeAlertsPayload } from "./alerts-fixtures.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";

isolateDomGlobals();

const payload = makeAlertsPayload({ scenario: "mixed" });

function m(isEqual: boolean, isRegex: boolean): SilenceMatcher {
  return { name: "job", value: "node", isEqual, isRegex };
}

describe("matcherExpression (re-exported from SilencesTab)", () => {
  // Dynamic import: loading the ui barrel before happy-dom registers leaks globals into other files.
  test("maps the four (isEqual x isRegex) combinations with a double-quoted value", async () => {
    const { matcherExpression } = await import("../src/client/views/alerts/detail/silences-model.js");
    expect(matcherExpression(m(true, false))).toBe('job="node"');
    expect(matcherExpression(m(false, false))).toBe('job!="node"');
    expect(matcherExpression(m(true, true))).toBe('job=~"node"');
    expect(matcherExpression(m(false, true))).toBe('job!~"node"');
  });
});

describe("SilencesTab source discipline", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/client/views/alerts/silences/SilencesTab.tsx", import.meta.url)),
    "utf8",
  );
  test("no client reordering and no keyboard shortcut wiring", () => {
    expect(src).not.toContain(".sort(");
    expect(src).not.toContain(".reverse(");
    expect(src).not.toContain("registerShortcut");
    expect(src).not.toMatch(/from\s+["'][^"']*keyboard[^"']*["']/);
  });
});

describeDom("SilencesTab", (dom) => {
  async function mountTab(silences: readonly ActiveSilence[]): Promise<HTMLElement> {
    const { createElement: h } = await import("react");
    const { SilencesTab } = await import("../src/client/views/alerts/silences/SilencesTab.js");
    const { container } = await dom.mount(h(SilencesTab, { silences }) as unknown as ReactElement);
    return container;
  }

  function bodyRows(c: HTMLElement): HTMLElement[] {
    return [...c.querySelectorAll<HTMLElement>('[data-slot="data-table"] tbody tr')];
  }

  const cells = (r: HTMLElement): string[] => [...r.querySelectorAll("th, td")].map((cell) => cell.textContent ?? "");

  test("is a DataTable captioned 'Active silences' with Matchers/Creator/Comment/Expiry headers", async () => {
    const c = await mountTab(payload.silences);
    const table = c.querySelector('[data-slot="data-table"] table');
    expect(table?.querySelector("caption")?.textContent).toBe("Active silences");
    expect([...table!.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
      "Matchers",
      "Creator",
      "Comment",
      "Expiry",
    ]);
  });

  test("fixture has the two expected silences", () => {
    expect(payload.silences.length).toBe(2);
  });

  test("renders matchers as <code> match expressions for all four operators", async () => {
    const c = await mountTab(payload.silences);
    const rows = bodyRows(c);
    expect(rows.length).toBe(2);
    const codes = (r: HTMLElement): (string | null)[] =>
      [...r.querySelectorAll("code[data-matcher]")].map((e) => e.textContent);
    expect(codes(rows[0]!)).toEqual(['alertname="BackupTooOld"', 'service="backup"']);
    expect(codes(rows[1]!)).toEqual(['instance=~"lab-.*"', 'env!="prod"', 'team!~"qa|dev"']);
  });

  test("renders createdBy, comment (empty → —), and endsAt with startsAt context", async () => {
    const c = await mountTab(payload.silences);
    const [first, second] = bodyRows(c);
    const a = cells(first!);
    expect(a[1]).toBe("operator@example.test");
    expect(a[2]).toBe("Backup window maintenance");
    expect(first!.querySelector("[data-silence-ends]")?.textContent).toBe("2026-09-22T18:00:00.000Z");
    const starts = first!.querySelector("[data-silence-starts]");
    expect(starts?.textContent).toBe("from 2026-09-22T06:00:00.000Z");
    expect(starts?.getAttribute("title")).toBe("Silence start");
    const b = cells(second!);
    expect(b[1]).toBe("lab-bot");
    expect(b[2]).toBe("—");
    expect(second!.querySelector("[data-silence-ends]")?.textContent).toBe("2026-09-24T00:00:00.000Z");
    expect(second!.querySelector("[data-silence-starts]")?.textContent).toBe(
      "from 2026-09-23T00:00:00.000Z",
    );
  });

  test("empty matchers render —", async () => {
    const s: ActiveSilence = {
      id: "no-matchers",
      matchers: [],
      createdBy: "someone",
      comment: "x",
      startsAt: "2026-09-22T00:00:00.000Z",
      endsAt: "2026-09-22T01:00:00.000Z",
      state: "active",
    };
    const c = await mountTab([s]);
    const [row] = bodyRows(c);
    expect(cells(row!)[0]).toBe("—");
    expect(row!.querySelectorAll("code").length).toBe(0);
  });

  test("row order equals input order (as given and for a swapped copy)", async () => {
    const [a, b] = payload.silences;
    const creators = (c: HTMLElement): string[] =>
      bodyRows(c).map((r) => cells(r)[1] ?? "");
    expect(creators(await mountTab(payload.silences))).toEqual(["operator@example.test", "lab-bot"]);
    expect(creators(await mountTab([b!, a!]))).toEqual(["lab-bot", "operator@example.test"]);
  });

  test("read-only without rowAction: no Actions column and no button, link, or form control", async () => {
    const c = await mountTab(payload.silences);
    expect([...c.querySelectorAll("thead th")].map((th) => th.textContent)).not.toContain("Actions");
    expect(c.querySelectorAll("button, a, input, select, textarea, form").length).toBe(0);
  });

  test("empty slice renders the silences-specific EmptyState, not the generic table one", async () => {
    const c = await mountTab([]);
    const text = c.textContent ?? "";
    expect(text).toContain("No active silences");
    expect(text).toContain("No silences are currently active.");
    expect(text).not.toContain("No rows");
    expect(c.querySelector('[data-slot="empty-state"]')).not.toBeNull();
    expect(c.querySelector("table")).toBeNull();
  });
});

// ── M2: expire on every listed silence (mutation-foundation 09 §7.3–§7.4) ─────────────────────────────

/** A silence with a given id/creator/comment, cloned from the fixture shape. */
function silence(id: string, createdBy: string, comment: string): ActiveSilence {
  return { ...payload.silences[0]!, id, createdBy, comment };
}

describe("silenceColumns", () => {
  test("silenceColumns(undefined) is SILENCE_COLUMNS by identity; a rowAction appends an 'Actions' column", async () => {
    const { SILENCE_COLUMNS, silenceColumns } = await import("../src/client/views/alerts/silences/SilencesTab.js");
    expect(silenceColumns(undefined)).toBe(SILENCE_COLUMNS);
    expect(silenceColumns()).toBe(SILENCE_COLUMNS);
    const cols = silenceColumns(() => null);
    expect(cols.length).toBe(SILENCE_COLUMNS.length + 1);
    expect(cols.slice(0, -1)).toEqual([...SILENCE_COLUMNS]);
    expect(cols[cols.length - 1]!.header).toBe("Actions");
    expect(SILENCE_COLUMNS.map((col) => col.id)).toEqual(["matchers", "createdBy", "comment", "endsAt"]);
  });

  test("view.tsx wires the ExpireButton as the SilencesTab rowAction", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/client/views/alerts/view.tsx", import.meta.url)), "utf8");
    expect(src).toContain(
      "<SilencesTab silences={payload.silences} rowAction={(s) => <ExpireButton silence={s} store={store} />} />",
    );
  });
});

describeDom("Silences tab expire action", (dom) => {
  type Store = import("../src/client/store/index.js").AppStore;

  /** A store with a seeded session (so ensureSession never fetches), desk density by default. */
  async function store(silenceCap: boolean): Promise<Store> {
    const { createAppStore } = await import("../src/client/store/index.js");
    const s = createAppStore({ storage: null, initialQuery: {} });
    s.session.value = { identity: null, authMode: "proxy-header", capabilities: { silence: silenceCap, ack: false, proposeEstateEdit: false } };
    s.density.value = "desk";
    return s;
  }

  /** Mount the tab exactly as view.tsx does: rowAction renders an ExpireButton per silence. */
  async function mountWired(silences: readonly ActiveSilence[], st: Store): Promise<{ c: HTMLElement; unmount(): void }> {
    const { createElement: h } = await import("react");
    const { SilencesTab } = await import("../src/client/views/alerts/silences/SilencesTab.js");
    const { ExpireButton } = await import("../src/client/mutations/ExpireButton.js");
    const { container, unmount } = await dom.mount(
      h(SilencesTab, { silences, rowAction: (s: ActiveSilence) => h(ExpireButton, { silence: s, store: st }) as unknown as ReactElement }) as unknown as ReactElement,
    );
    return { c: container, unmount };
  }

  const expireButtons = (c: HTMLElement): HTMLButtonElement[] =>
    [...c.querySelectorAll<HTMLButtonElement>("button")].filter((b) => (b.textContent ?? "").includes("Expire…"));

  test("capability true on desk: every row (any creator, pulse-prefixed or not) has 'Expire silence <id>'", async () => {
    const rows = [...payload.silences, silence("pulse-made", "Gary Gentry", "[pulse] maintenance window")];
    const { c, unmount } = await mountWired(rows, await store(true));
    const btns = expireButtons(c);
    expect(btns.map((b) => b.getAttribute("aria-label"))).toEqual(rows.map((s) => `Expire silence ${s.id}`));
    expect(btns.every((b) => !b.disabled)).toBe(true);
    expect([...c.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
      "Matchers",
      "Creator",
      "Comment",
      "Expiry",
      "Actions",
    ]);
    unmount();
  });

  test("no Expire button on wallboard, under ?kiosk=1, or with the silence capability false", async () => {
    const wall = await store(true);
    wall.density.value = "wallboard";
    const kiosk = await store(true);
    kiosk.route.value = { ...kiosk.route.value, query: { kiosk: "1" } };
    for (const st of [wall, kiosk, await store(false)]) {
      const { c, unmount } = await mountWired(payload.silences, st);
      expect(c.querySelectorAll("button").length).toBe(0);
      // The Actions column is gated on rowAction being given, not on what it renders.
      expect([...c.querySelectorAll("thead th")].map((th) => th.textContent)).toContain("Actions");
      unmount();
    }
  });

  test("ExpireButton with the silence capability false renders nothing (no disabled button)", async () => {
    const { createElement: h } = await import("react");
    const { ExpireButton } = await import("../src/client/mutations/ExpireButton.js");
    const st = await store(false);
    const { container, unmount } = await dom.mount(
      h(ExpireButton, { silence: payload.silences[0]!, store: st }) as unknown as ReactElement,
    );
    expect(container.innerHTML).toBe("");
    unmount();
  });

  test("a comment containing '<b>x</b>' and a control char renders literally", async () => {
    const { c, unmount } = await mountWired([silence("s-html", "<i>me</i>", "<b>x</b>\u0007")], await store(true));
    const cells = [...c.querySelectorAll("tbody th, tbody td")].map((cell) => cell.textContent ?? "");
    expect(cells[1]).toBe("<i>me</i>");
    expect(cells[2]).toBe("<b>x</b>�");
    expect(c.querySelector("tbody b, tbody i")).toBeNull();
    unmount();
  });
});

describeDom("detail Silences expire action", (dom) => {
  type Store = import("../src/client/store/index.js").AppStore;

  async function store(silenceCap: boolean): Promise<Store> {
    const { createAppStore } = await import("../src/client/store/index.js");
    const s = createAppStore({ storage: null, initialQuery: {} });
    s.session.value = { identity: null, authMode: "proxy-header", capabilities: { silence: silenceCap, ack: false, proposeEstateEdit: false } };
    s.density.value = "desk";
    return s;
  }

  const silenced = payload.alerts.find((a) => a.silencedBy.length > 0)!;

  async function mountDetail(silences: readonly ActiveSilence[], st?: Store): Promise<{ c: HTMLElement; unmount(): void }> {
    const { createElement: h } = await import("react");
    const { Silences } = await import("../src/client/views/alerts/detail/Silences.js");
    const alert = { ...silenced, silencedBy: silences.map((s) => s.id) };
    const p = { ...payload, silences: [...silences] };
    const props = st === undefined ? { alert, payload: p } : { alert, payload: p, store: st };
    const { container, unmount } = await dom.mount(h(Silences, props) as unknown as ReactElement);
    return { c: container, unmount };
  }

  test("without a store no Expire button renders (existing callers unchanged)", async () => {
    const { c, unmount } = await mountDetail(payload.silences);
    expect(c.querySelectorAll('[data-slot="list-item"]').length).toBe(payload.silences.length);
    expect(c.querySelectorAll("button").length).toBe(0);
    unmount();
  });

  test("with a store and silence true on desk each listed silence (any creator) has 'Expire silence <id>'", async () => {
    const rows = [silence("other-user", "alice@example.test", "manual"), silence("pulse-made", "Gary Gentry", "[pulse] window")];
    const { c, unmount } = await mountDetail(rows, await store(true));
    const arts = [...c.querySelectorAll('[data-slot="list-item"]')];
    expect(arts.length).toBe(2);
    arts.forEach((a, i) => {
      const b = a.querySelector("button");
      expect(b?.getAttribute("aria-label")).toBe(`Expire silence ${rows[i]!.id}`);
      expect(b?.textContent).toContain("Expire…");
    });
    expect(c.textContent).toContain("[pulse] window"); // prefix shown as plain text, not used for gating
    unmount();
  });

  test("with a store but silence false no Expire button renders", async () => {
    const { c, unmount } = await mountDetail(payload.silences, await store(false));
    expect(c.querySelectorAll("button").length).toBe(0);
    unmount();
  });

  test("creator and comment with markup and a control char render literally", async () => {
    const { c, unmount } = await mountDetail([silence("s-html", "<i>me</i>", "<b>x</b>\u0007")], await store(true));
    const dds = [...c.querySelectorAll("dd")].map((d) => d.textContent);
    expect(dds[0]).toBe("<i>me</i>");
    expect(dds[1]).toBe("<b>x</b>�");
    expect(c.querySelector("dd b, dd i")).toBeNull();
    unmount();
  });
});
