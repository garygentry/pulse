// apps/web/tests/ui-router-hooks.test.tsx — the deck-shaped router hooks over the pulse PathRouter.
import { afterEach, expect, it } from "bun:test";

import { List, ListItem, SafeRouteLink } from "@/ui";
import { createPathRouter, type PathRouter, type RouteDef } from "../src/client/router.js";
import { RouterProvider, useLocation, useRoute, useRouter } from "../src/client/shell/router-hooks.js";

import { act, describeUi, render, screen, userEvent } from "./rtl.js";

const ROUTES: RouteDef[] = [
  { pattern: "/overview", view: "overview" },
  { pattern: "/alerts", view: "alerts" },
  { pattern: "/alerts/:fingerprint", view: "alerts" },
  { pattern: "/estate/service/:host/:name", view: "estate" },
];

function LocationProbe() {
  const location = useLocation();
  const route = useRoute();
  return (
    <dl>
      <dd data-testid="url">{location.url}</dd>
      <dd data-testid="path">{location.path}</dd>
      <dd data-testid="view">{location.match.view}</dd>
      <dd data-testid="query">{JSON.stringify(location.query)}</dd>
      <dd data-testid="route-path">{route.path}</dd>
      <dd data-testid="params">{JSON.stringify(route.params)}</dd>
      <dd data-testid="route-query">{JSON.stringify(route.query)}</dd>
    </dl>
  );
}

const text = (id: string) => screen.getByTestId(id).textContent;

describeUi("router hooks", (dom) => {
  let router: PathRouter | null = null;

  function start(url: string): PathRouter {
    dom.win.history.replaceState({}, "", url);
    router = createPathRouter({ routes: ROUTES, fallback: "/overview", win: dom.win as unknown as Window });
    return router;
  }

  afterEach(() => {
    router?.stop();
    router = null;
  });

  it("returns path, params and query for a matched route", () => {
    const r = start("/estate/service/web-01/nginx%20proxy?range=6h");
    render(
      <RouterProvider router={r}>
        <LocationProbe />
      </RouterProvider>,
    );

    expect(text("path")).toBe("/estate/service/web-01/nginx proxy");
    expect(text("route-path")).toBe("/estate/service/web-01/nginx proxy");
    expect(text("view")).toBe("estate");
    expect(JSON.parse(text("params") ?? "")).toEqual({ host: "web-01", name: "nginx proxy" });
    expect(JSON.parse(text("query") ?? "")).toEqual({ range: "6h" });
    expect(JSON.parse(text("route-query") ?? "")).toEqual({ range: "6h" });
    expect(text("url")).toBe("/estate/service/web-01/nginx%20proxy?range=6h");
  });

  it("re-renders after router.navigate", () => {
    const r = start("/overview");
    render(
      <RouterProvider router={r}>
        <LocationProbe />
      </RouterProvider>,
    );
    expect(text("path")).toBe("/overview");
    expect(JSON.parse(text("params") ?? "")).toEqual({});

    act(() => r.navigate("/alerts/abc123?sort=age"));

    expect(text("path")).toBe("/alerts/abc123");
    expect(text("view")).toBe("alerts");
    expect(JSON.parse(text("params") ?? "")).toEqual({ fingerprint: "abc123" });
    expect(JSON.parse(text("query") ?? "")).toEqual({ sort: "age" });
    expect(text("url")).toBe("/alerts/abc123?sort=age");
  });

  it("url keeps the address encoded, so navigating to it lands on the same route", () => {
    const r = start("/alerts/fp%2F1?sort=age");
    render(
      <RouterProvider router={r}>
        <LocationProbe />
      </RouterProvider>,
    );
    expect(JSON.parse(text("params") ?? "")).toEqual({ fingerprint: "fp/1" });
    expect(text("url")).toBe("/alerts/fp%2F1?sort=age");

    act(() => r.navigate("/overview"));
    act(() => r.navigate("/alerts/fp%2F1?sort=age"));
    expect(text("view")).toBe("alerts");
    expect(JSON.parse(text("params") ?? "")).toEqual({ fingerprint: "fp/1" });
  });

  it("location.route navigates, pushing or replacing the history entry", () => {
    const r = start("/overview");
    let route: ((url: string, replace?: boolean) => void) | null = null;
    function Navigator() {
      route = useLocation().route;
      return null;
    }
    render(
      <RouterProvider router={r}>
        <Navigator />
        <LocationProbe />
      </RouterProvider>,
    );
    const length = dom.win.history.length;
    act(() => route?.("/alerts?sort=age"));
    expect(text("view")).toBe("alerts");
    expect(dom.win.history.length).toBe(length + 1);
    act(() => route?.("/alerts/abc", true));
    expect(JSON.parse(text("params") ?? "")).toEqual({ fingerprint: "abc" });
    expect(dom.win.history.length).toBe(length + 1);
  });

  it("useRouter exposes the provided router and throws outside a provider", () => {
    const r = start("/overview");
    let seen: PathRouter | null = null;
    function Probe() {
      seen = useRouter();
      return null;
    }
    render(
      <RouterProvider router={r}>
        <Probe />
      </RouterProvider>,
    );
    expect(seen === r).toBe(true);

    function Orphan() {
      useLocation();
      return null;
    }
    const error = console.error;
    console.error = () => undefined;
    try {
      expect(() => render(<Orphan />)).toThrow(/RouterProvider/);
    } finally {
      console.error = error;
    }
  });

  it("routes a SafeRouteLink click through the pulse router", async () => {
    const r = start("/overview");
    render(
      <RouterProvider router={r}>
        <SafeRouteLink build={() => `/alerts/${encodeURIComponent("fp/1")}`}>Open alert</SafeRouteLink>
        <LocationProbe />
      </RouterProvider>,
    );
    const link = screen.getByRole("link", { name: "Open alert" });
    expect(link).toHaveAttribute("href", "/alerts/fp%2F1");

    await userEvent.click(link);

    expect(text("path")).toBe("/alerts/fp/1");
    expect(JSON.parse(text("params") ?? "")).toEqual({ fingerprint: "fp/1" });
    expect(dom.win.location.pathname).toBe("/alerts/fp%2F1");
  });

  it("routes a ListItem href click through the pulse router", async () => {
    const r = start("/overview?kiosk=1");
    render(
      <RouterProvider router={r}>
        <List aria-label="Alerts">
          <ListItem title="Disk full" href="/alerts/disk-full" />
        </List>
        <LocationProbe />
      </RouterProvider>,
    );
    const link = screen.getByRole("link", { name: "Disk full" });
    expect(link.tagName).toBe("A");

    await userEvent.click(link);

    expect(text("path")).toBe("/alerts/disk-full");
    expect(text("view")).toBe("alerts");
    // The router's carried query keys survive in-app link navigation.
    expect(JSON.parse(text("query") ?? "")).toEqual({ kiosk: "1" });
  });
});
