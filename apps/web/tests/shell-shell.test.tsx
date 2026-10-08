// apps/web/tests/shell-shell.test.tsx — the app shell: deck's frame over the view registry.
//  • nav model: order (nav.order asc, nav-less last, registry tiebreak) and the sidebar groups;
//  • frame: skip link first, focusing <main id="main">; grouped nav links with aria-current; the page
//    title in the top bar and the document title;
//  • health region: estate name and the live/staleness pill; the stale-data callout;
//  • display preferences: theme and density menus write the store;
//  • kiosk: no sidebar, top-bar controls or palette;
//  • palette: Ctrl/Cmd-K opens it over the ranked index; Enter navigates; Escape closes; a failed
//    chunk load shows an error state (with the shared reload) inside the palette;
//  • ViewHost: retry → once-per-build reload escalation via an injected loadFor.
import { afterEach, beforeEach, expect, it, mock, test } from "bun:test";
import type { ComponentType } from "react";

import type { ViewDefinition, ViewProps } from "../src/shared/registry.js";
import type { ConnectionState } from "../src/client/store/types.js";
import type { OverviewSnapshot } from "../src/shared/snapshot.js";
import type { CycleObservation, SourceId, SourceObservation } from "@pulse/web-data/wire";
import { createAppStore, type AppStore } from "../src/client/store/index.js";
import { createPathRouter, type PathRouter } from "../src/client/router.js";
import { createEstateClock, TZ_FALLBACK_MARKER } from "../src/client/format.js";
import { groupNavViews, orderedNavViews } from "../src/client/shell/nav.js";
import { CHUNK_RELOAD_SESSION_KEY, Shell, ViewHost } from "../src/client/shell/index.js";
import { LiveStatusPill } from "../src/client/shell/HealthRegion.js";
import { CommandPalette } from "../src/client/shell/CommandPalette.js";
import type { PaletteDialogProps } from "../src/client/shell/PaletteDialog.js";
import { VIEWS } from "../src/client/views/registry.js";
import { NOW } from "./factories.js";

import { describeUi, render, screen, userEvent, waitFor, within } from "./rtl.js";

function stubView(id: string, label: string, nav?: { order: number }): ViewDefinition {
  return {
    id,
    label,
    icon: "circle",
    load: async () => (() => <div data-view={id}>{label} body</div>) as ComponentType<ViewProps>,
    ...(nav !== undefined ? { nav } : {}),
  };
}

const STUB_VIEWS: readonly ViewDefinition[] = [
  stubView("overview", "Overview", { order: 0 }),
  stubView("alerts", "Alerts", { order: 1 }),
  stubView("estate", "Estate", { order: 2 }),
  stubView("engine", "Engine", { order: 3 }),
  stubView("timeline", "Timeline", { order: 4 }),
];

let router: PathRouter | null = null;
afterEach(() => {
  router?.stop();
  router = null;
});

function setup(view = "overview", query: Record<string, string> = {}): { store: AppStore; router: PathRouter } {
  const store = createAppStore({ storage: null, initialQuery: query });
  store.route.value = { path: `/${view}`, view, params: {}, query };
  router = createPathRouter({
    routes: STUB_VIEWS.map((v) => ({ pattern: `/${v.id}`, view: v.id })),
    fallback: "/overview",
  });
  return { store, router };
}

function renderShell(store: AppStore, shellRouter: PathRouter, views = STUB_VIEWS) {
  return render(
    <Shell store={store} router={shellRouter} views={views} reloadOnce={() => {}} buildId="shell-test" />,
  );
}

const INITIAL_VIEW = { phase: "initial", identity: null, failure: null } as const;
const CONN_BASE: ConnectionState = {
  phase: "live",
  transport: "poll",
  lastGoodAt: null,
  failingSince: null,
  seq: 0,
  observation: null,
  views: {
    overview: INITIAL_VIEW,
    alerts: INITIAL_VIEW,
    estate: INITIAL_VIEW,
    engine: INITIAL_VIEW,
    timeline: INITIAL_VIEW,
  },
};

const SOURCE_IDS: readonly SourceId[] = [
  "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
  "alertmanager-alerts", "alertmanager-silences", "alertmanager-status",
  "alertmanager-receivers", "vmalert-rules", "gatus-statuses", "grafana-health",
];

function observation(): CycleObservation {
  const sources = {} as Record<SourceId, SourceObservation>;
  for (const id of SOURCE_IDS) sources[id] = { state: "current", lastAttemptAt: NOW, lastSuccess: NOW };
  return { generation: "11111111-1111-4111-8111-111111111111", seq: 1, observedAt: NOW, appVersion: "0.0.0-dev", sources };
}

// ─── Nav model (pure) ─────────────────────────────────────────────────────────────────────────────

test("orderedNavViews sorts by nav.order asc, nav-less last, registry index tiebreak", () => {
  const withNav = (id: string, order: number): ViewDefinition => stubView(id, id, { order });
  const noNav = (id: string): ViewDefinition => stubView(id, id);
  const scrambled = [withNav("c", 2), withNav("a", 0), noNav("z1"), withNav("b", 1), noNav("z2")];
  expect(orderedNavViews(scrambled).map((v) => v.id)).toEqual(["a", "b", "c", "z1", "z2"]);
});

test("groupNavViews groups the registry: Overview, Monitor, Inventory, System; unknown views last", () => {
  const groups = groupNavViews([...VIEWS, stubView("extra", "Extra", { order: 9 })]);
  expect(groups.map((g) => [g.label, g.views.map((v) => v.id)])).toEqual([
    ["Overview", ["overview"]],
    ["Monitor", ["alerts", "timeline"]],
    ["Inventory", ["estate"]],
    ["System", ["engine"]],
    [undefined, ["extra"]],
  ]);
});

// ─── Frame ────────────────────────────────────────────────────────────────────────────────────────

describeUi("Shell frame", () => {
  it("lists the views as grouped nav links and marks the active one aria-current", async () => {
    const ctx = setup("alerts");
    renderShell(ctx.store, ctx.router);
    await screen.findByText("Alerts body");

    const nav = screen.getByRole("navigation", { name: "Views" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Overview", "Alerts", "Timeline", "Estate", "Engine"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/overview", "/alerts", "/timeline", "/estate", "/engine",
    ]);
    expect(within(nav).getByRole("link", { name: "Alerts" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
    for (const heading of ["Overview", "Monitor", "Inventory", "System"]) {
      expect(within(nav).getAllByText(heading).length).toBeGreaterThan(0);
    }
  });

  it("follows the route: navigating moves aria-current and the title", async () => {
    const ctx = setup("overview");
    renderShell(ctx.store, ctx.router);
    await screen.findByText("Overview body");
    expect(document.title).toBe("Overview · Pulse");

    ctx.store.route.value = { path: "/engine", view: "engine", params: {}, query: {} };
    await screen.findByText("Engine body");
    const nav = screen.getByRole("navigation", { name: "Views" });
    expect(within(nav).getByRole("link", { name: "Engine" })).toHaveAttribute("aria-current", "page");
    expect(document.title).toBe("Engine · Pulse");
    expect(within(screen.getByRole("banner")).getByText("Engine")).toBeInTheDocument();
  });

  it("puts the skip link first in tab order; activating it focuses the single <main id=main>", async () => {
    const ctx = setup("overview");
    renderShell(ctx.store, ctx.router);
    await screen.findByText("Overview body");

    expect(screen.getAllByRole("main")).toHaveLength(1);
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main");
    expect(main).toHaveAttribute("tabindex", "-1");

    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.tab();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute("href", "#main");
    await userEvent.keyboard("{Enter}");
    expect(main).toHaveFocus();
  });

  it("keeps dev-only views out of the nav but hosts them by URL", async () => {
    const ctx = setup("_ui");
    render(
      <Shell
        store={ctx.store}
        router={ctx.router}
        views={STUB_VIEWS}
        devViews={[stubView("_ui", "UI workbench")]}
        reloadOnce={() => {}}
        buildId="shell-test"
      />,
    );
    await screen.findByText("UI workbench body");
    const nav = screen.getByRole("navigation", { name: "Views" });
    expect(nav.textContent).not.toContain("UI workbench");
  });
});

// ─── Health region + stale-data callout ───────────────────────────────────────────────────────────

describeUi("Shell health region", () => {
  it("shows the estate name and a live pill with the absolute + relative update time", async () => {
    const ctx = setup("overview");
    ctx.store.snapshot.value = {
      estate: { name: "Homelab", timezone: "America/Chicago", tzFallback: false },
      hosts: [],
    } as unknown as OverviewSnapshot;
    ctx.store.connection.value = { ...CONN_BASE, observation: observation() };
    renderShell(ctx.store, ctx.router);
    await screen.findByText("Overview body");

    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("Homelab")).toBeInTheDocument();
    const indicator = banner.querySelector('[data-slot="staleness-indicator"]') as HTMLElement;
    expect(indicator).toHaveAttribute("aria-live", "polite");
    expect(indicator).toHaveAttribute("data-status", "ok");
    expect(within(indicator).getByRole("link", { name: /^Live/ })).toHaveAttribute("href", "/engine");
    expect(indicator.textContent).toContain("Updated");
    expect(indicator.textContent).toContain("CDT");
    // The announcer's empty assertive region is the only alert.
    expect(screen.queryAllByRole("alert").filter((el) => el.textContent !== "")).toHaveLength(0);
  });

  it("names the estate neutrally before the first snapshot and waits for the first update", async () => {
    const ctx = setup("overview");
    renderShell(ctx.store, ctx.router);
    await screen.findByText("Overview body");
    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("Pulse")).toBeInTheDocument();
    expect(within(banner).getByRole("link", { name: /^Connecting/ })).toBeInTheDocument();
    expect(banner.textContent).toContain("Waiting for first update…");
  });

  it("a stale connection turns the pill critical and raises the stale-data alert under the top bar", async () => {
    const ctx = setup("overview");
    ctx.store.connection.value = { ...CONN_BASE, phase: "stale", lastGoodAt: Date.parse(NOW) };
    renderShell(ctx.store, ctx.router);
    await screen.findByText("Overview body");

    const indicator = screen.getByRole("banner").querySelector('[data-slot="staleness-indicator"]');
    expect(indicator).toHaveAttribute("data-status", "critical");
    expect(within(indicator as HTMLElement).getByRole("link", { name: /^Stale/ })).toBeInTheDocument();
    const alert = document.querySelector("[data-stale-warning]") as HTMLElement;
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert.textContent).toContain("app server unreachable");
    expect(alert.querySelectorAll('[data-source="app"]')).toHaveLength(1);
    expect(screen.getByRole("main").contains(alert)).toBe(false);
  });

  it("LiveStatusPill: phase → data-status, and the tz-fallback marker when UTC is a fallback", () => {
    const utc = createEstateClock({ name: "x", timezone: "UTC", tzFallback: true } as never);
    render(<LiveStatusPill connection={{ ...CONN_BASE, observation: observation() }} clock={utc} />);
    const indicator = document.querySelector('[data-slot="staleness-indicator"]') as HTMLElement;
    expect(indicator).toHaveAttribute("data-status", "ok");
    expect(indicator.textContent).toContain(TZ_FALLBACK_MARKER);
  });

  it("LiveStatusPill: the tz-fallback marker shows before the first update too", () => {
    const utc = createEstateClock({ name: "x", timezone: "UTC", tzFallback: true } as never);
    render(<LiveStatusPill connection={CONN_BASE} clock={utc} />);
    const indicator = document.querySelector('[data-slot="staleness-indicator"]') as HTMLElement;
    expect(indicator.textContent).toContain("Waiting for first update…");
    expect(indicator.textContent).toContain(TZ_FALLBACK_MARKER);
  });
});

// ─── Display preferences ──────────────────────────────────────────────────────────────────────────

describeUi("Shell display preferences", () => {
  it("the theme menu names the current theme and writes the chosen one to the store", async () => {
    const ctx = setup("overview");
    ctx.store.theme.value = "system";
    renderShell(ctx.store, ctx.router);
    await screen.findByText("Overview body");

    await userEvent.click(screen.getByRole("button", { name: "Theme: System" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Dark" }));
    expect(ctx.store.theme.peek()).toBe("dark");
    await waitFor(() => expect(screen.getByRole("button", { name: "Theme: Dark" })).toBeInTheDocument());
  });

  it("the density menu switches desk ↔ wallboard", async () => {
    const ctx = setup("overview");
    ctx.store.density.value = "desk";
    renderShell(ctx.store, ctx.router);
    await screen.findByText("Overview body");

    await userEvent.click(screen.getByRole("button", { name: "Density: Desk" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Wallboard" }));
    expect(ctx.store.density.peek()).toBe("wallboard");
  });
});

// ─── Kiosk ────────────────────────────────────────────────────────────────────────────────────────

describeUi("Shell under kiosk", () => {
  it("renders no sidebar, toggle, preference controls or palette; health and main stay", async () => {
    const ctx = setup("overview", { kiosk: "1" });
    renderShell(ctx.store, ctx.router);
    await screen.findByText("Overview body");

    expect(screen.queryAllByRole("navigation", { name: "Views" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "Toggle navigation" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /^Theme:/ })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /^Density:/ })).toHaveLength(0);
    expect(document.querySelectorAll('[data-slot="kiosk-shell"][data-kiosk="1"]')).toHaveLength(1);
    expect(screen.getByRole("banner").querySelectorAll('[data-slot="staleness-indicator"]')).toHaveLength(1);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");

    // No palette is mounted, so Ctrl+K is not even claimed (not default-prevented) and no dialog opens,
    // also after the time the lazy dialog chunk takes to load.
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
  });
});

// ─── Command palette ──────────────────────────────────────────────────────────────────────────────

describeUi("Shell command palette", () => {
  const pressModK = (): void => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
  };

  it("Ctrl+K opens it focused on the search; results are ranked; ArrowDown + Enter navigates and closes", async () => {
    const ctx = setup("overview");
    const navigate = mock((_path: string) => {});
    ctx.router.navigate = navigate as PathRouter["navigate"];
    renderShell(ctx.store, ctx.router);
    await screen.findByText("Overview body");
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);

    pressModK();
    // The combobox, not the dialog: until the chunk lands the loading dialog carries the same name.
    const input = await screen.findByRole("combobox");
    expect(screen.getByRole("dialog", { name: "Command palette" })).toContainElement(input);
    await waitFor(() => expect(input).toHaveFocus());
    // Empty query lists every view; they tie on tier and kind, so they rank by label.
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Alerts", "Engine", "Estate", "Overview", "Timeline",
    ]);

    await userEvent.type(input, "eng");
    await waitFor(() => expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Engine"]));
    await userEvent.clear(input);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(5));
    await waitFor(() => expect(screen.getByRole("option", { name: "Alerts" })).toHaveAttribute("aria-selected", "true"));
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("option", { name: "Engine" })).toHaveAttribute("aria-selected", "true"));
    await userEvent.keyboard("{Enter}");

    expect(navigate).toHaveBeenCalledWith("/engine");
    await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
  });

  it("Escape closes it and returns focus to the element that had it before opening", async () => {
    const ctx = setup("overview");
    renderShell(ctx.store, ctx.router);
    await screen.findByText("Overview body");
    const opener = screen.getByRole("button", { name: "Toggle navigation" });
    opener.focus();

    pressModK();
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("shows the empty text when nothing matches, Escape closes, and reopening starts a fresh query", async () => {
    const ctx = setup("overview");
    renderShell(ctx.store, ctx.router);
    await screen.findByText("Overview body");

    pressModK();
    const input = await screen.findByRole("combobox");
    await userEvent.type(input, "zzz-nothing-matches");
    await waitFor(() => expect(screen.getByText("No results")).toBeInTheDocument());
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));

    pressModK();
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue(""));
  });
});

describeUi("Shell command palette: chunk load failure", () => {
  const pressModK = (): void => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
  };
  const rejecting = (): { load: () => Promise<ComponentType<PaletteDialogProps>>; calls: () => number } => {
    let calls = 0;
    return {
      load: async () => {
        calls += 1;
        throw new TypeError("Failed to fetch dynamically imported module");
      },
      calls: () => calls,
    };
  };

  it("a rejected dynamic import shows an error state in the open palette; its action is the shared reload", async () => {
    const ctx = setup("overview");
    const loader = rejecting();
    const reloadOnce = mock(() => {});
    render(<CommandPalette store={ctx.store} router={ctx.router} reloadOnce={reloadOnce} loadDialog={loader.load} />);
    // The idle prefetch (1 s timer fallback) fails quietly: nothing is open, nothing is shown.
    await waitFor(() => expect(loader.calls()).toBe(1), { timeout: 3_000 });
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);

    // Ctrl/Cmd-K no longer closes silently: the palette opens on an error state (tone, icon, text).
    pressModK();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("The command palette could not be loaded.");
    expect(alert.closest("[data-slot=error-state]")).toHaveAttribute("data-tone", "danger");
    expect(alert.querySelector("svg")).not.toBeNull();
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    // Browsers replay a failed import's rejection, so it is not retried in-page.
    expect(loader.calls()).toBe(1);

    await userEvent.click(within(alert).getByRole("button", { name: "Reload page" }));
    expect(reloadOnce).toHaveBeenCalledTimes(1);
  });

  it("opening before the import settles shows a loading state, then the palette", async () => {
    const ctx = setup("overview");
    const { PaletteDialog } = await import("../src/client/shell/PaletteDialog.js");
    let resolve: (c: ComponentType<PaletteDialogProps>) => void = () => {};
    const loadDialog = () => new Promise<ComponentType<PaletteDialogProps>>((r) => (resolve = r));
    render(<CommandPalette store={ctx.store} router={ctx.router} reloadOnce={() => {}} loadDialog={loadDialog} />);
    pressModK();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Loading the command palette…");
    resolve(PaletteDialog);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());
    expect(screen.queryByText("Loading the command palette…")).toBeNull();
  });

  it("a palette that loads while open (loading → ready) still returns focus to the opener on Escape", async () => {
    const ctx = setup("overview");
    const { PaletteDialog } = await import("../src/client/shell/PaletteDialog.js");
    let resolve: (c: ComponentType<PaletteDialogProps>) => void = () => {};
    const loadDialog = () => new Promise<ComponentType<PaletteDialogProps>>((r) => (resolve = r));
    render(
      <>
        <button type="button">Opener</button>
        <CommandPalette store={ctx.store} router={ctx.router} reloadOnce={() => {}} loadDialog={loadDialog} />
      </>,
    );
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();

    pressModK();
    const loader = await screen.findByRole("dialog", { name: "Command palette" });
    await waitFor(() => expect(loader).toContainElement(document.activeElement as HTMLElement));
    expect(opener).not.toHaveFocus();

    resolve(PaletteDialog);
    const input = await screen.findByRole("combobox");
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("the error state closes with Escape, returns focus to the opener, and shows again on reopen", async () => {
    const ctx = setup("overview");
    const loader = rejecting();
    render(
      <>
        <button type="button">Opener</button>
        <CommandPalette store={ctx.store} router={ctx.router} reloadOnce={() => {}} loadDialog={loader.load} />
      </>,
    );
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();

    pressModK();
    await screen.findByRole("alert");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
    await waitFor(() => expect(opener).toHaveFocus());

    pressModK();
    await screen.findByRole("alert");
    expect(loader.calls()).toBe(1);
  });
});

// ─── ViewHost retry → reload escalation (injected loadFor) ────────────────────────────────────────

describeUi("ViewHost — retry then once-per-build reload escalation", () => {
  beforeEach(() => {
    try {
      window.sessionStorage.clear();
    } catch {
      /* not available before beforeAll */
    }
  });

  it("a persistently rejecting loadFor retries once, then fires reloadOnce and marks the build", async () => {
    const ctx = setup("overview");
    let loadCalls = 0;
    let reloads = 0;
    render(
      <ViewHost
        store={ctx.store}
        router={ctx.router}
        views={[stubView("overview", "Overview")]}
        reloadOnce={() => {
          reloads += 1;
        }}
        buildId="build-Z"
        loadFor={async () => {
          loadCalls += 1;
          throw new Error("chunk gone");
        }}
        attachStyles={async () => {}}
      />,
    );
    await waitFor(() => expect(reloads).toBe(1));

    // Initial attempt + one retry = 2 load calls, then escalate → one reload, mark written.
    expect(loadCalls).toBe(2);
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_SESSION_KEY)).toBe("build-Z");
    // Stays in loading (the page is about to be replaced), not error.
    expect(screen.getByRole("status")).toHaveTextContent("Loading Overview…");
    // The announcer's empty assertive region is the only alert.
    expect(screen.queryAllByRole("alert").filter((el) => el.textContent !== "")).toHaveLength(0);
  });
});
