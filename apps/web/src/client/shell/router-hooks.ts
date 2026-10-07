// shell/router-hooks.ts — deck-shaped React hooks over pulse's History-API router.
//
// The `PathRouter` stays the source of truth: these hooks only read `router.current()` and
// re-render on `router.subscribe(...)` notifications (via `useSyncExternalStore`). Navigation is
// still `router.navigate(...)` or a plain `<a href>` (the router's document click interceptor routes
// same-origin anchor clicks), so `@/ui` patterns such as `SafeRouteLink` and `ListItem href` need no
// router-specific link component.
//
// Query type: the router's own frozen flat record (`Readonly<Record<string, string>>`, last value
// wins for a repeated key). It is passed through unchanged rather than wrapped in `URLSearchParams`.

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import type { PathRouter, RouteMatch } from "../router.js";

/** The router's query record, as exposed on `RouteMatch.query`. */
export type RouteQuery = RouteMatch["query"];

/** The current location, shaped like deck's `useLocation()`. */
export interface RouterLocation {
  /** The address as the browser holds it (encoded path plus `?search`), safe to navigate back to. */
  url: string;
  /** The matched path, with each segment decoded. */
  path: string;
  query: RouteQuery;
  /** Navigate in-app (`replace` swaps the history entry), as deck's `location.route(url, replace)`. */
  route: (url: string, replace?: boolean) => void;
  /** The matched route. The router always resolves to one (unknown paths hit its fallback). */
  match: RouteMatch;
}

/** The matched route's path, query and `:param` values. */
export interface RouterRoute {
  path: string;
  query: RouteQuery;
  params: Readonly<Record<string, string>>;
}

const RouterContext = createContext<PathRouter | null>(null);
RouterContext.displayName = "RouterContext";

export interface RouterProviderProps {
  router: PathRouter;
  children?: ReactNode;
}

/** Makes `router` available to {@link useRouter}, {@link useLocation} and {@link useRoute}. */
export function RouterProvider({ router, children }: RouterProviderProps): ReactElement {
  return createElement(RouterContext.Provider, { value: router }, children);
}

/** The `PathRouter` from the nearest {@link RouterProvider}. Throws outside one. */
export function useRouter(): PathRouter {
  const router = useContext(RouterContext);
  if (router === null) throw new Error("[router-hooks] useRouter must be used inside <RouterProvider>");
  return router;
}

/** The current `RouteMatch`, re-rendering whenever the router notifies a navigation. */
function useRouteMatch(): RouteMatch {
  const router = useRouter();
  const subscribe = useCallback((onChange: () => void) => router.subscribe(onChange), [router]);
  const getSnapshot = useCallback(() => router.current(), [router]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * The current URL. The match's `path` is decoded per segment, so it cannot be re-encoded faithfully
 * (a param holding an encoded `/` would split); read the browser's own address instead, and fall
 * back to the match only where there is no `location` (never in the app).
 */
function urlOf(match: RouteMatch): string {
  const loc = (globalThis as { location?: Location }).location;
  if (loc !== undefined) return `${loc.pathname}${loc.search}`;
  const search = new URLSearchParams(Object.entries(match.query)).toString();
  return search === "" ? match.path : `${match.path}?${search}`;
}

/** The current location (`url`, `path`, `query`, `route`, `match`). */
export function useLocation(): RouterLocation {
  const router = useRouter();
  const match = useRouteMatch();
  return useMemo(
    () => ({
      url: urlOf(match),
      path: match.path,
      query: match.query,
      route: (url: string, replace?: boolean) => router.navigate(url, replace === true ? { replace: true } : {}),
      match,
    }),
    [router, match],
  );
}

/** The matched route's `path`, `query` and `params`. */
export function useRoute(): RouterRoute {
  const match = useRouteMatch();
  return useMemo(
    () => ({ path: match.path, query: match.query, params: match.params }),
    [match],
  );
}
