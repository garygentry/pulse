// apps/web/tests/theme-shell.test.ts — integration coverage for Shell's document-root theme hook.

import { expect, test } from "bun:test";
import { createElement } from "react";
import type { ComponentType, ReactElement } from "react";

import type { ViewDefinition, ViewProps } from "../src/shared/registry.js";
import { createAppStore } from "../src/client/store/index.js";
import { createPathRouter } from "../src/client/router.js";
import { Shell } from "../src/client/shell/index.js";
import { describeDom } from "./dom.js";

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  await Promise.resolve();
  await Promise.resolve();
}

/** Poll (20 ms steps, up to 2 s) until `cond` holds; a fixed flush can elapse before effects run under load. */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

describeDom("Shell theme integration", (dom) => {
  test("tracks live OS theme changes while the preference is system", async () => {
    const originalMatchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
    const listeners = new Set<() => void>();
    let prefersDark = false;
    const darkQuery = {
      get matches() {
        return prefersDark;
      },
      addEventListener: (_type: string, listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.delete(listener);
      },
    } as unknown as MediaQueryList;

    (globalThis as { matchMedia?: unknown }).matchMedia = (query: string): MediaQueryList =>
      query.includes("dark") ? darkQuery : ({ matches: true } as unknown as MediaQueryList);
    const store = createAppStore({ storage: null, initialQuery: {} });
    const router = createPathRouter({
      routes: [{ pattern: "/overview", view: "overview" }],
      fallback: "/overview",
      win: dom.win as unknown as Window,
    });
    store.theme.value = "system";
    store.density.value = "desk";
    store.route.value = {
      path: "/overview",
      view: "overview",
      params: {},
      query: {},
    };
    const views: readonly ViewDefinition[] = [
      {
        id: "overview",
        label: "Overview",
        nav: { order: 0 },
        load: async () => (() => createElement("div", {}, "Overview")) as ComponentType<ViewProps>,
      },
    ];

    const { unmount } = await dom.mount(
      createElement(Shell, {
        store,
        router,
        views,
        reloadOnce: () => {},
        buildId: "theme-test",
      }) as ReactElement,
    );

    try {
      await flush();
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      expect(document.documentElement.style.colorScheme).toBe("light");

      prefersDark = true;
      for (const listener of listeners) listener();
      await flush();
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      expect(document.documentElement.style.colorScheme).toBe("dark");
    } finally {
      unmount();
      router.stop();
      (globalThis as { matchMedia?: unknown }).matchMedia = originalMatchMedia;
    }
  });

  test("forces wallboard density when the active URL is kiosk mode", async () => {
    const originalMatchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
    (globalThis as { matchMedia?: unknown }).matchMedia = (): MediaQueryList =>
      ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList;
    dom.win.happyDOM.setURL("http://localhost/overview?kiosk=1");

    const store = createAppStore({ storage: null, initialQuery: { kiosk: "1" } });
    const router = createPathRouter({
      routes: [{ pattern: "/overview", view: "overview" }],
      fallback: "/overview",
      win: dom.win as unknown as Window,
    });
    store.density.value = "desk";
    store.route.value = {
      path: "/overview",
      view: "overview",
      params: {},
      query: { kiosk: "1" },
    };
    const views: readonly ViewDefinition[] = [
      {
        id: "overview",
        label: "Overview",
        nav: { order: 0 },
        load: async () => (() => createElement("div", {}, "Overview")) as ComponentType<ViewProps>,
      },
    ];
    const { unmount } = await dom.mount(
      createElement(Shell, {
        store,
        router,
        views,
        reloadOnce: () => {},
        buildId: "kiosk-test",
      }) as ReactElement,
    );

    try {
      await waitFor(() => document.documentElement.dataset.density === "wallboard");
      expect(document.documentElement.dataset.density).toBe("wallboard");
    } finally {
      unmount();
      router.stop();
      dom.win.happyDOM.setURL("http://localhost/");
      (globalThis as { matchMedia?: unknown }).matchMedia = originalMatchMedia;
    }
  });

  test("falls back safely when matchMedia throws", async () => {
    const originalMatchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
    (globalThis as { matchMedia?: unknown }).matchMedia = (): MediaQueryList => {
      throw new Error("matchMedia unavailable");
    };
    dom.win.happyDOM.setURL("http://localhost/overview");

    const store = createAppStore({ storage: null, initialQuery: {} });
    const router = createPathRouter({
      routes: [{ pattern: "/overview", view: "overview" }],
      fallback: "/overview",
      win: dom.win as unknown as Window,
    });
    store.theme.value = "system";
    store.density.value = "desk";
    store.route.value = {
      path: "/overview",
      view: "overview",
      params: {},
      query: {},
    };
    const views: readonly ViewDefinition[] = [
      {
        id: "overview",
        label: "Overview",
        nav: { order: 0 },
        load: async () => (() => createElement("div", {}, "Overview")) as ComponentType<ViewProps>,
      },
    ];
    const { unmount } = await dom.mount(
      createElement(Shell, {
        store,
        router,
        views,
        reloadOnce: () => {},
        buildId: "throwing-match-media-test",
      }) as ReactElement,
    );

    try {
      await flush();
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      expect(document.documentElement.style.colorScheme).toBe("dark");
      expect(document.documentElement.dataset.density).toBe("desk");
    } finally {
      unmount();
      router.stop();
      (globalThis as { matchMedia?: unknown }).matchMedia = originalMatchMedia;
    }
  });
});
