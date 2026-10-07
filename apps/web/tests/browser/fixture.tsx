// apps/web/tests/browser/fixture.tsx — the browser-suite fixture (item 015, 10 §3.11/§3.12).
//
// Renders the design-system Shell (App → Shell, 06-app-shell.md) over a real store + router and
// imports the global stylesheet (styles/app.css: Tailwind + the theme tokens) so getComputedStyle(:root) resolves EVERY design
// token in both themes × both densities (SC-01) and the curated status palette is live for the
// contrast suite (SC-02). Alongside the shell it renders one StatusBadge per TargetStatus so the
// grayscale suite proves each state stays distinct with colour removed (glyph + label carry it,
// REQ-A11Y-06) and the reflow suite proves the chrome + chips reflow at 375px without side-scroll
// (SC-03). Everything on the page is design-system-owned (shell / ui / tokens), so any axe fix lives
// in this member's own source (never web-foundation's).
//
// The bundle is theme-agnostic (one build serves both themes). renderFixtureShell (_harness.ts)
// stamps the theme on `<html>` (the `.dark` class); the fixture reads that stamp and seeds store.theme to it BEFORE the
// first render so the Shell's single theme effect re-applies the SAME theme instead of resolving
// `system` from the OS and overwriting the requested appearance (06 §2.3, 02-design-tokens.md §3).

import { Fragment, createElement } from "react";
import { render } from "../react-render.js";

// The global stylesheet — the value home for every token. `App` imports it
// too, but importing here makes the token dependency explicit and independent of App's internals.
import "../../src/client/styles/app.css";

import { App } from "../../src/client/app.js";
import { createAppStore } from "../../src/client/store/index.js";
import { createPathRouter, routesFromViews } from "../../src/client/router.js";
import { VIEWS } from "../../src/client/views/registry.js";
import { StatusBadge, TARGET_STATUS } from "../../src/client/ui/index.js";
import { STATUS_STATES } from "../../src/shared/constants.js";

const root = document.getElementById("app");
if (root === null) throw new Error("[fixture] #app mount node missing");

// The theme stamped by renderFixtureShell (dark | light). Seed the store to it so the Shell's theme
// effect keeps this appearance rather than resolving `system` from the OS.
const stampedTheme = (document.documentElement.classList.contains("dark") ? "dark" : "light");

const store = createAppStore();
if (stampedTheme === "dark" || stampedTheme === "light") {
  store.theme.value = stampedTheme;
}

const router = createPathRouter({ routes: routesFromViews(VIEWS), fallback: "/overview" });
// Mirror main.tsx: the router is the only writer of store.route (REQ-STORE-05).
store.route.value = router.current();
router.subscribe((match) => {
  store.route.value = match;
});

render(
  createElement(
    Fragment,
    null,
    createElement(App, { store, router, views: VIEWS, reloadOnce: () => {}, buildId: null }),
    // A design-system status showcase: one labeled badge per state (icon + always-visible label),
    // so the grayscale / reflow suites scan real design-system status content in every state.
    createElement(
      "section",
      { "data-fixture": "status-showcase", "aria-label": "Status showcase" },
      STATUS_STATES.map((status) => {
        const { tone, icon, label, variant } = TARGET_STATUS[status];
        return <StatusBadge key={status} tone={tone} icon={icon} label={label} {...(variant ? { variant } : {})} data-status={status} />;
      }),
    ),
  ),
  root,
);
