// apps/web/tests/browser/fixtures/alerts-render.tsx — shared mount for the alerts browser fixture
// pages. NOT an entry: each `alerts-<page>.tsx` entry calls mountAlertsFixture once.
//
// Renders the REAL /alerts view (views/alerts/view.tsx, styled by Tailwind token classes and the
// @/ui library) inside a <main> landmark over the global stylesheet (styles/app.css); the view's
// PageHeader supplies the page's one h1, against a payload built
// by the alert-triage fixture builder (tests/alerts-fixtures.ts — type-only wire imports, so it
// bundles for the browser). The bundle is theme-agnostic: renderFixtureShell stamps the theme on
// <html> (the .dark class) and the tokens resolve from that stamp.
//
// The history strip's on-demand GET /api/history/alerts is answered in-page with the `ready` history
// fixture so the detail pane renders its real StatusTimeline (the loopback server has no API). The
// page sets `data-fixture-ready` on <html> once the view has rendered, for the suites to await.

import { render } from "../../react-render.js";

import "../../../src/client/styles/app.css";

import AlertsView from "../../../src/client/views/alerts/view.js";
import { createAppStore } from "../../../src/client/store/index.js";
import { createPathRouter } from "../../../src/client/router.js";
import { makeAlertsPayload, makeHistoryPayload } from "../../alerts-fixtures.js";
import type { AlertsScenario } from "../../alerts-fixtures.js";

export interface AlertsFixtureOptions {
  /** Which alert-triage payload scenario to seed into store.alerts. */
  readonly scenario: AlertsScenario;
  /** Query string (no leading "?") for the /alerts deep link, e.g. `sel=fp-host-down` or `tab=catalog`. */
  readonly query?: string;
}

/** Mount the real alerts view for one browser fixture page. Call once at the page entry's top. */
export function mountAlertsFixture(opts: AlertsFixtureOptions): void {
  const root = document.getElementById("app");
  if (root === null) throw new Error("[alerts-fixture] #app mount node missing");

  const history = makeHistoryPayload({ kind: "ready" });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("/api/history/alerts")) {
      return Promise.resolve(
        new Response(JSON.stringify(history), { headers: { "content-type": "application/json" } }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;

  // The view navigates within /alerts; move the page there (same-origin replaceState, no reload).
  const query = opts.query ?? "";
  window.history.replaceState({}, "", "/alerts" + (query === "" ? "" : `?${query}`));
  const router = createPathRouter({ routes: [{ pattern: "/alerts", view: "alerts" }], fallback: "/alerts" });

  const store = createAppStore({ storage: null });
  const stampedTheme = (document.documentElement.classList.contains("dark") ? "dark" : "light");
  if (stampedTheme === "dark" || stampedTheme === "light") store.theme.value = stampedTheme;
  store.route.value = router.current();
  router.subscribe((match) => {
    store.route.value = match;
  });
  store.alerts.value = makeAlertsPayload({ scenario: opts.scenario });

  render(
    <main className="fixture-alerts">
      <AlertsView store={store} router={router} />
    </main>,
    root,
  );
  // render() is synchronous; no rAF here — Chromium throttles rAF on background pages.
  document.documentElement.dataset["fixtureReady"] = "1";
}
