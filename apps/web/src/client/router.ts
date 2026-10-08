// src/client/router.ts — the History-API path router (07-path-router.md).
//
// Zero runtime imports (07 §1). `createPathRouter` binds to a Window handed in via `opts.win`
// (defaulting to `globalThis.window`) so tests can pass the happy-dom window explicitly. The router
// installs exactly two listeners — `popstate` on the window and `click` on `window.document` — and
// `stop()` removes both. Nothing else in the module touches globals.

/** One declared route (REQ-ROUTE-01). `pattern` is a path with optional `:param` segments. */
export interface RouteDef {
  pattern: string;
  view: string;
}

/** A resolved location (07 §3). `path` is the canonical matched path (pattern with each `:param`
 *  substituted by its decoded value); `params`/`query` are frozen. */
export interface RouteMatch {
  path: string;
  view: string;
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
}

/** The router handle (REQ-ROUTE-01). */
export interface PathRouter {
  current(): RouteMatch;
  /** Navigate in-app. A `#fragment` on `path` reaches `location.hash`; a target on the current
   *  path that names no fragment keeps the current one (pass a bare trailing `#` to clear it). */
  navigate(path: string, opts?: { replace?: boolean }): void;
  subscribe(listener: (match: RouteMatch) => void): () => void;
  stop(): void;
}

/** Construction options (00 §5). */
export interface PathRouterOptions {
  routes: readonly RouteDef[];
  fallback: string;
  win?: Window;
}

/** History-entry state the router writes (REQ-ROUTE-08). Other state keys are preserved. */
export interface RouterHistoryState {
  scrollY?: number;
  [key: string]: unknown;
}

/** Prefixes the router never claims as SPA routes (REQ-ROUTE-07). Compared against the normalised
 *  pathname with `startsWith`; `/healthz` and `/metrics` are exact-or-prefix. */
export const RESERVED_PREFIXES = ["/api/", "/assets/", "/healthz", "/metrics"] as const;

/** Query keys copied from the current match into a target that lacks them (REQ-ROUTE-03). */
export const CARRIED_QUERY_KEYS = ["kiosk", "rotate"] as const;

/** The structural slice of `ViewDefinition` (00 §6.1) that `routesFromViews` needs. Declared
 *  structurally so `router.ts` keeps zero imports (07 §1). */
export interface RoutableView {
  readonly id: string;
  readonly routes?: readonly string[];
}

/** Pure: `#/overview?kiosk=1` → `{ path: "/overview", query: { kiosk: "1" } }`; `null` for hashes
 *  that are not `#/<segment>…`. Never throws. */
export function parseLegacyHash(
  hash: string,
): { path: string; query: Record<string, string> } | null {
  if (!hash.startsWith("#/")) return null;
  const rest = hash.slice(1);
  const q = rest.indexOf("?");
  const path = normalizePath(q === -1 ? rest : rest.slice(0, q));
  if (path === "/") return null;
  return { path, query: parseQuery(q === -1 ? "" : rest.slice(q + 1)) };
}

/** Pure: collapse `//`, force a leading `/`, strip a trailing `/` (except the root). Case is NOT
 *  changed here — case-insensitivity is a property of static-segment comparison in `matchRoute`. */
export function normalizePath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  const rooted = collapsed.startsWith("/") ? collapsed : `/${collapsed}`;
  return rooted.length > 1 && rooted.endsWith("/") ? rooted.slice(0, -1) : rooted;
}

/** `"/"` → `[]`; `"/a/b"` → `["a","b"]`. */
function splitSegments(normalised: string): string[] {
  return normalised === "/" ? [] : normalised.slice(1).split("/");
}

/** `decodeURIComponent` that returns the raw segment on failure — a hand-typed deep link with a
 *  malformed escape degrades to a literal param instead of a blank screen. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Pure matcher (07 §3). Static segments compare case-insensitively; `:param` segments capture
 *  the original segment `decodeURIComponent`-ed once (case preserved). First declared match wins. */
export function matchRoute(
  routes: readonly RouteDef[],
  pathname: string,
): { view: string; params: Record<string, string>; pattern: string } | null {
  const segments = splitSegments(normalizePath(pathname));
  for (const route of routes) {
    const patternSegments = splitSegments(normalizePath(route.pattern));
    if (patternSegments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < patternSegments.length; i++) {
      const p = patternSegments[i] as string;
      const s = segments[i] as string;
      if (p.startsWith(":")) {
        params[p.slice(1)] = decodeSegment(s);
      } else if (p.toLowerCase() !== s.toLowerCase()) {
        ok = false;
        break;
      }
    }
    if (ok) return { view: route.view, params, pattern: route.pattern };
  }
  return null;
}

/** The canonical matched path: pattern segments with `:param` replaced by their decoded value. */
function canonicalPath(pattern: string, params: Readonly<Record<string, string>>): string {
  const segments = splitSegments(normalizePath(pattern)).map((p) =>
    p.startsWith(":") ? params[p.slice(1)] ?? "" : p,
  );
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** Parse a `location.search` (leading `?` optional) into a flat record; last value wins. */
function parseQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(search)) out[key] = value;
  return out;
}

/** Serialize a flat query record back to a string WITHOUT the leading `?`. Empty → `""`. */
function serializeQuery(query: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, value);
  return params.toString();
}

/** `path` + `?query` when the query is non-empty. */
function href(path: string, query: Readonly<Record<string, string>>): string {
  const search = serializeQuery(query);
  return search === "" ? path : `${path}?${search}`;
}

/** Scroll the element a URL fragment names into view. `false` when there is no fragment or no such
 *  element (the caller then falls back to its own scroll). Mirrors `@/ui`'s `hashTargetId` decode
 *  without importing it (07 §1). Never throws. */
function scrollToHashTarget(win: Window, hash: string): boolean {
  const raw = hash.replace(/^#/, "");
  if (raw === "") return false;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    /* malformed escape: use the raw fragment */
  }
  try {
    const target = win.document.getElementById(id);
    if (target === null) return false;
    target.scrollIntoView?.({ block: "start" });
    return true;
  } catch {
    return false;
  }
}

/** Copy every CARRIED_QUERY_KEYS key present in `from` and absent from `to`. */
function carryQuery(
  from: Readonly<Record<string, string>>,
  to: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = { ...to };
  for (const key of CARRIED_QUERY_KEYS) {
    const value = from[key];
    if (value !== undefined && out[key] === undefined) out[key] = value;
  }
  return out;
}

/** `/api/` and `/assets/` are prefix matches; `/healthz` and `/metrics` are exact-or-prefix. */
function isReserved(normalised: string): boolean {
  return RESERVED_PREFIXES.some((p) =>
    p.endsWith("/")
      ? normalised.startsWith(p)
      : normalised === p || normalised.startsWith(`${p}/`),
  );
}

/** Read `history.state` defensively — `null` on a fresh entry; may be any JSON written by an
 *  earlier app version. Never throws. */
function readState(win: Window): RouterHistoryState {
  const state: unknown = win.history.state;
  return typeof state === "object" && state !== null ? (state as RouterHistoryState) : {};
}

/** Route source (REQ-VIEW-02, 07 §11): for each view, `/<id>` plus every pattern in `routes`, in
 *  registry order. Shared by `main.tsx` and `tests/router.test.ts`. */
export function routesFromViews(views: readonly RoutableView[]): RouteDef[] {
  return views.flatMap((view) => [
    { pattern: `/${view.id}`, view: view.id },
    ...(view.routes ?? []).map((pattern) => ({ pattern, view: view.id })),
  ]);
}

/** Build a `RouteMatch` from a raw `matchRoute` result + the target query. Freezes both records so
 *  a subscriber cannot mutate router state. */
function buildMatch(
  found: { view: string; params: Record<string, string>; pattern: string },
  query: Readonly<Record<string, string>>,
): RouteMatch {
  return {
    path: canonicalPath(found.pattern, found.params),
    view: found.view,
    params: Object.freeze({ ...found.params }),
    query: Object.freeze({ ...query }),
  };
}

/** Notification key — `view|path|search` (07 §7 step 8). A URL-only change such as `/Alerts/` →
 *  `/alerts` produces no spurious re-render. */
function matchKey(m: RouteMatch): string {
  return `${m.view}|${m.path}|${serializeQuery(m.query)}`;
}

export function createPathRouter(opts: PathRouterOptions): PathRouter {
  const win: Window | undefined = opts.win ?? (globalThis as { window?: Window }).window;
  if (win === undefined) {
    throw new Error("[router] createPathRouter requires a window (no SSR/document-less support)");
  }
  const routes = opts.routes;
  const fallbackPath = normalizePath(opts.fallback);
  const fallbackFound = matchRoute(routes, fallbackPath);
  if (fallbackFound === null) {
    throw new Error(
      `[router] fallback "${opts.fallback}" matches no declared route`,
    );
  }

  try {
    if ("scrollRestoration" in win.history) win.history.scrollRestoration = "manual";
  } catch {
    /* older/embedded engines: keep the browser's own restoration */
  }

  const legacy = parseLegacyHash(win.location.hash);
  if (legacy !== null) {
    const merged = { ...legacy.query, ...parseQuery(win.location.search) };
    win.history.replaceState(readState(win), "", href(legacy.path, merged));
  }

  const listeners = new Set<(match: RouteMatch) => void>();

  const fallbackReplace = (query: Readonly<Record<string, string>>): RouteMatch => {
    const target = href(fallbackPath, query);
    win.history.replaceState(readState(win), "", target);
    return buildMatch(fallbackFound, query);
  };

  const initialPath = normalizePath(win.location.pathname);
  const initialQuery = parseQuery(win.location.search);
  const initialFound = matchRoute(routes, initialPath);
  let currentMatch: RouteMatch =
    initialFound === null ? fallbackReplace(initialQuery) : buildMatch(initialFound, initialQuery);

  const notify = (next: RouteMatch): void => {
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch (error) {
        console.error("[router] subscriber threw", error);
      }
    }
  };

  const onPopState = (): void => {
    const path = normalizePath(win.location.pathname);
    const query = parseQuery(win.location.search);
    const found = matchRoute(routes, path);
    const previous = currentMatch;
    const next = found === null ? fallbackReplace(query) : buildMatch(found, query);
    currentMatch = next;
    const samePage = matchKey(next) === matchKey(previous);
    if (!samePage) notify(next);
    try {
      const state = readState(win);
      if (typeof state.scrollY === "number") {
        win.scrollTo(0, state.scrollY);
      } else if (!(samePage && scrollToHashTarget(win, win.location.hash))) {
        // An entry with no saved offset: a same-page `#fragment` entry (the browser's own fragment
        // navigation, or a navigate() hash change) goes back to its target instead of the top.
        win.scrollTo(0, 0);
      }
    } catch {
      /* older engines / test envs without scrollTo */
    }
  };
  win.addEventListener("popstate", onPopState);

  const onClick = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (event.defaultPrevented) return;

    const target = event.target as { closest?: (s: string) => Element | null } | null;
    const anchor =
      typeof target?.closest === "function"
        ? (target.closest("a[href]") as HTMLAnchorElement | null)
        : null;
    if (anchor === null) return;
    if (anchor.hasAttribute("target")) return;
    if (anchor.hasAttribute("download")) return;
    if ((anchor.getAttribute("href") ?? "").startsWith("#")) return;
    if (anchor.origin !== win.location.origin) return;
    if (isReserved(normalizePath(anchor.pathname))) return;
    // A same-document fragment link (`/alerts#firing` while on `/alerts`) stays browser-owned like
    // `#firing`: the browser scrolls, sets `:target` and fires `hashchange` without a reload.
    if (
      anchor.hash !== "" &&
      anchor.pathname === win.location.pathname &&
      anchor.search === win.location.search
    ) {
      return;
    }

    event.preventDefault();
    navigate(anchor.pathname + anchor.search + anchor.hash);
  };
  win.document.addEventListener("click", onClick as EventListener);

  function navigate(path: string, navOpts?: { replace?: boolean }): void {
    let url: URL;
    try {
      url = new URL(path, win!.location.origin);
    } catch {
      console.warn("[router] ignoring unparseable navigate target: " + path);
      return;
    }
    if (url.origin !== win!.location.origin) {
      win!.location.assign(path);
      return;
    }
    const targetPath = normalizePath(url.pathname);
    if (isReserved(targetPath)) {
      win!.location.assign(path);
      return;
    }
    const query = carryQuery(currentMatch.query, parseQuery(url.search));
    const herePath = normalizePath(win!.location.pathname);
    const hereHash = win!.location.hash;
    // Fragment: the target's own wins; a same-path target that names none (a view rewriting its
    // query state) keeps the current one; a bare trailing `#` clears it; a new path drops it.
    const explicitHash = url.hash !== "" || path.includes("#");
    const hash = explicitHash ? url.hash : targetPath === herePath ? hereHash : "";
    const target = href(targetPath, query) + hash;
    const here = href(herePath, parseQuery(win!.location.search)) + hereHash;
    if (target === here) return;

    const push = navOpts?.replace !== true;
    if (push) {
      win!.history.replaceState({ ...readState(win!), scrollY: win!.scrollY }, "");
      win!.history.pushState({}, "", target);
    } else {
      win!.history.replaceState(readState(win!), "", target);
    }
    const found = matchRoute(routes, targetPath);
    const previous = currentMatch;
    const next = found === null ? fallbackReplace(query) : buildMatch(found, query);
    currentMatch = next;
    const samePage = matchKey(next) === matchKey(previous);
    if (!samePage) notify(next);
    if (!push) return;
    // A push lands at the top, except a fragment change on the page already rendered, which jumps
    // to its target. A new page's fragment is the view's job on mount (`@/ui` `useScrollToHash`).
    if (samePage && hash !== "" && hash !== hereHash && scrollToHashTarget(win!, hash)) return;
    try {
      win!.scrollTo(0, 0);
    } catch {
      /* test envs without scrollTo */
    }
  }

  return {
    current: () => currentMatch,
    navigate,
    subscribe(listener: (match: RouteMatch) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop(): void {
      win.removeEventListener("popstate", onPopState);
      win.document.removeEventListener("click", onClick as EventListener);
      listeners.clear();
    },
  };
}
