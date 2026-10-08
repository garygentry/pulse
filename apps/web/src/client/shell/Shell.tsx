// shell/Shell.tsx — the single top-level component App renders: deck's app frame (skip link, sidebar,
// sticky top bar with the health region, stale-data callout, one `<main id="main">`) and the command
// palette. Owns the single theme/density document-root effect, the singleton announcer mount, kiosk
// rotation, and ViewHost (the lazy view outlet with its chunk-reload ladder).
//
// Kiosk renders no sidebar, top-bar controls or palette; the store forces wallboard density.
import type { ComponentType, ReactElement } from "react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSignals } from "@preact/signals-react/runtime";

// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { useDocumentTitle } from "@/ui/hooks/use-document-title";
// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { loadIconSet } from "@/ui/lib/icon-registry";
// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { ErrorState } from "@/ui/patterns/error-state";
// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { LoadingState } from "@/ui/patterns/loading-state";
// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { PageErrorBoundary } from "@/ui/patterns/page-error-boundary";
// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { SidebarInset, SidebarProvider } from "@/ui/primitives/sidebar";

import type { AppStore } from "../store/index.js";
import type { NextKioskView } from "../store/live-state.js";
import type { ViewId } from "@pulse/web-data/wire";
import type { PathRouter } from "../router.js";
import type { ViewDefinition, ViewProps, ViewRotationContext } from "../../shared/registry.js";
import { attachChunkStyles } from "../store/chunk-css.js";
import { useTheme } from "../theme/index.js";
import { mountAnnouncer, SkipLink } from "../a11y/index.js";
import { createEstateClock, type EstateClock } from "../format.js";
import { AppSidebar } from "./AppSidebar.js";
import { CommandPalette } from "./CommandPalette.js";
import { StaleDataCallout } from "./StaleDataCallout.js";
import { Topbar } from "./Topbar.js";
import { createKioskRotation, parseRotate } from "./kiosk.js";

/** The id of the single `<main>`; the skip link's target. */
export const MAIN_ID = "main";

/** The sidebar remembers open/collapsed in a cookie (written by SidebarProvider). */
const SIDEBAR_COOKIE = "sidebar_state";

function sidebarDefaultOpen(): boolean {
  if (typeof document === "undefined") return true;
  const match = document.cookie.match(new RegExp(`(?:^|; )${SIDEBAR_COOKIE}=(true|false)`));
  return match ? match[1] === "true" : true;
}

/** The view definition the outlet shows for `viewId`: an unknown route falls back to the first view. */
export function resolveView(
  views: readonly ViewDefinition[],
  viewId: string,
): ViewDefinition | undefined {
  return views.find((v) => v.id === viewId) ?? views[0];
}

/**
 * Props for the root shell. Identical to the reduced `App`'s props (app.tsx AppProps) — `App`
 * forwards them straight through so `main.tsx` (web-foundation, unedited) keeps constructing
 * `<App store router views reloadOnce buildId />`.
 */
export interface ShellProps {
  /** The single application store (00 §8). Shell reads theme/density/connection/snapshot/route. */
  store: AppStore;
  /** The History-API path router (00 §8). Passed to views and to the palette/kiosk seams (07). */
  router: PathRouter;
  /** The pre-registered view registry (08). Source of nav entries and the outlet's view set. */
  views: readonly ViewDefinition[];
  /** Development-only views (the `/_ui` workbench). The outlet hosts them, but they stay out of the
   *  side nav and kiosk rotation, which read `views` only. Empty or absent in production builds. */
  devViews?: readonly ViewDefinition[] | undefined;
  /** The shared once-only reload (`LiveStateHandle.reloadOnce`) — passed to `ViewHost` (REQ-VIEW-04)
   *  and to the command palette, whose chunk-failure state recovers by reloading.
   *  Never call `location.reload` directly. */
  reloadOnce: () => void;
  /** `<meta name="pulse-build-id">` content; `null` in manifest-fallback mode. Keys the chunk-reload
   *  session mark in `escalateToReload`. */
  buildId: string | null;
  /** Publish the imminent shell-owned rotation entry to live-state for bounded prefetch. */
  setNextKioskView?: ((next: NextKioskView | null) => void) | undefined;
}

// ─── Relocated ViewHost types & constants (verbatim from app.tsx) ─────────────────────────────────

/** The `ViewHost` state machine (REQ-VIEW-03/04, 00 §6.2). */
export type ViewHostState =
  | { kind: "loading" }
  | { kind: "ready"; component: ComponentType<ViewProps> }
  | { kind: "error" };

/** Session key recording the build id a chunk-failure reload was already attempted for; a second
 *  failure on the SAME build id renders the error state instead of reloading (REQ-VIEW-04). */
export const CHUNK_RELOAD_SESSION_KEY = "pulse.web.chunk-reload" as const;
/** Number of `load()` retries before escalating to the reload path. */
export const VIEW_LOAD_RETRIES = 1 as const;

/** `ViewHost` collaborators. The first five come straight from `ShellProps`. The two optional
 *  injectables exist for `tests/view-host.test.ts`: a fake `loadFor` drives every outcome without a
 *  real chunk, and an `attachStyles` spy proves chunk CSS attach idempotence. */
export interface ViewHostProps {
  store: AppStore;
  router: PathRouter;
  views: readonly ViewDefinition[];
  /** REQ-CONC-03: the shared once-only reload, never `location.reload` directly. */
  reloadOnce: () => void;
  /** Keys the chunk-reload session mark (REQ-VIEW-04, REQ-OBS-02); `null` → `"unknown"`. */
  buildId: string | null;
  /** Override for `def.load()`. Default: `(def) => def.load()`. */
  loadFor?: (def: ViewDefinition) => Promise<ComponentType<ViewProps>>;
  /** Override for the promise-based chunk stylesheet loader. */
  attachStyles?: (chunk: string) => Promise<void>;
  /** Shell-owned readonly kiosk rotation context for the active view. */
  rotation?: ViewRotationContext | null;
}

/** Record that a chunk-load reload was attempted for this build and fire the SHARED once-only
 *  reload (REQ-VIEW-04, REQ-CONC-03). Returns true when a reload was fired, false when the caller
 *  must render the error state instead (storage unavailable, or already reloaded for this build). */
export function escalateToReload(buildId: string | null, reloadOnce: () => void): boolean {
  const mark = buildId ?? "unknown";
  let previous: string | null;
  try {
    previous = window.sessionStorage.getItem(CHUNK_RELOAD_SESSION_KEY);
  } catch {
    return false;
  }
  if (previous === mark) {
    // Already reloaded for THIS build — clear the mark so a new build id gets its own attempt.
    try {
      window.sessionStorage.removeItem(CHUNK_RELOAD_SESSION_KEY);
    } catch {
      /* best-effort */
    }
    return false;
  }
  try {
    window.sessionStorage.setItem(CHUNK_RELOAD_SESSION_KEY, mark);
  } catch {
    return false;
  }
  reloadOnce();
  return true;
}

/** Hosts the active view: resolves the definition from the route, loads its chunk with one retry
 *  and a once-per-build reload escalation, and renders a text loading/error state (REQ-VIEW-03/04,
 *  REQ-A11Y-02). A render throw in the view degrades to a retryable page fallback (reset on view
 *  change) instead of blanking the app; lazy parts inside a view get a loading fallback. Sets the
 *  document title to "{view} · Pulse". */
export function ViewHost(props: ViewHostProps): ReactElement {
  useSignals();
  const { store, router, views, reloadOnce, buildId } = props;
  const load = props.loadFor ?? ((def: ViewDefinition) => def.load());
  const attach = props.attachStyles ?? attachChunkStyles;

  const def = resolveView(views, store.route.value.view);
  useDocumentTitle(def?.label);

  const [state, setState] = useState<ViewHostState>({ kind: "loading" });
  const generation = useRef(0);

  useEffect(() => {
    if (!def) return;
    const token = ++generation.current;
    setState({ kind: "loading" });

    void (async () => {
      const stylesReady = attach(`views/${def.id}/view`).catch(() => {}); // chunkCss key views/<id>/view
      // The curated icons beyond the shell's are a lazy chunk; load it with the view so the view's
      // first render has them. A failure is not fatal: <Icon> retries and fills in when it lands.
      const iconsReady = loadIconSet().catch(() => {});
      for (let attempt = 0; attempt <= VIEW_LOAD_RETRIES; attempt += 1) {
        try {
          const [component] = await Promise.all([load(def), stylesReady, iconsReady]);
          if (token !== generation.current) return;
          setState({ kind: "ready", component });
          return;
        } catch {
          if (token !== generation.current) return;
          if (attempt < VIEW_LOAD_RETRIES) continue;
          if (!escalateToReload(buildId, reloadOnce)) setState({ kind: "error" });
          return;
        }
      }
    })();

    return () => {
      generation.current += 1;
    };
  }, [def?.id]);

  if (!def) return <p data-slot="no-views">No views registered.</p>;
  if (state.kind === "loading") return <LoadingState label={`Loading ${def.label}…`} />;
  if (state.kind === "error") return <ErrorState title={`Could not load ${def.label}.`} />;
  const Component = state.component;
  return (
    <PageErrorBoundary resetKey={def.id}>
      <Suspense fallback={<LoadingState label={`Loading ${def.label}…`} />}>
        <Component store={store} router={router} rotation={props.rotation ?? null} />
      </Suspense>
    </PageErrorBoundary>
  );
}

// ─── Shell ────────────────────────────────────────────────────────────────────────────────────────

export function Shell(props: ShellProps): ReactElement {
  useSignals();
  const { store, router, views, reloadOnce, buildId } = props;

  // Kiosk flag — derived reactively from the carried route query (07).

  // Single document-root theme/density effect, including live OS-preference changes.
  useTheme(store);

  // Mount the singleton announcer region exactly once (05-a11y-primitives.md).
  useEffect(() => {
    mountAnnouncer();
  }, []);

  // Kiosk rotation lifecycle (07 §4.3). Read route.query reactively so this recomputes on every
  // navigation (including rotation's own replace-navs, which the router re-populates with kiosk/rotate
  // via CARRIED_QUERY_KEYS). Rotation is active ONLY while kiosk === true AND steps.length > 0; the
  // effect cleanup stop()s the previous controller on unmount, kiosk-clear, or steps-change so no
  // timer outlives the condition that created it (REQ-KIOSK-04).
  const routeQuery = store.route.value.query;
  const kioskOn = routeQuery.kiosk === "1";
  const rotateSpec = routeQuery.rotate ?? "";
  const viewIdsKey = views.map((v) => v.id).join(",");
  const [rotationContext, setRotationContext] = useState<ViewRotationContext | null>(null);
  useEffect(() => {
    if (!kioskOn) {
      setRotationContext(null);
      props.setNextKioskView?.(null);
      return;
    }
    const steps = parseRotate(rotateSpec, views.map((v) => v.id));
    if (steps.length === 0) {
      setRotationContext(null);
      props.setNextKioskView?.(null);
      return;
    }
    const rotation = createKioskRotation({
      router,
      steps,
      initialViewId: store.route.value.view,
      onContext(context): void {
        setRotationContext(context);
        const next = steps[(context.index + 1) % steps.length];
        props.setNextKioskView?.(next === undefined
          ? null
          : { view: next.viewId as ViewId, dueWithinMs: context.entry.dwellMs });
      },
    });
    rotation.start();
    return () => {
      rotation.stop();
      props.setNextKioskView?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kioskOn, rotateSpec, viewIdsKey, router]);

  // The outlet hosts the dev-only views too; nav and kiosk rotation keep reading `views`.
  const devViews = props.devViews;
  const hostedViews = useMemo(
    () => (devViews === undefined || devViews.length === 0 ? views : [...views, ...devViews]),
    [views, devViews],
  );

  // One estate clock per timezone, threaded to every absolute-time consumer.
  const snapshot = store.snapshot.value;
  const clock: EstateClock | null = useMemo(
    () => (snapshot ? createEstateClock(snapshot.estate) : null),
    [snapshot?.estate.timezone, snapshot?.estate.tzFallback],
  );

  const title = resolveView(hostedViews, store.route.value.view)?.label;
  const outlet = (
    // isolate: the content's own stacking context, so a view's sticky elements stay under the
    // sticky top bar and the portalled overlays.
    // Kiosk keeps the full width and height for the wallboard page fit: no outlet padding.
    <main
      id={MAIN_ID}
      tabIndex={-1}
      className={
        kioskOn
          ? "isolate w-full min-w-0 flex-1 outline-none"
          : "isolate w-full min-w-0 flex-1 px-4 py-6 outline-none md:px-6"
      }
    >
      <ViewHost
        store={store}
        router={router}
        views={hostedViews}
        reloadOnce={reloadOnce}
        buildId={buildId}
        rotation={rotationContext}
      />
    </main>
  );

  if (kioskOn) {
    // Kiosk: no sidebar, top-bar controls or palette (the palette is not even mounted, so there is no
    // Ctrl/Cmd-K shortcut). The skip link, health region and stale-data callout stay.
    return (
      <div data-slot="kiosk-shell" data-kiosk="1" className="flex min-h-svh flex-col">
        <SkipLink targetId={MAIN_ID} />
        <Topbar store={store} clock={clock} title={title} kiosk />
        <StaleDataCallout store={store} clock={clock} />
        {outlet}
      </div>
    );
  }

  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen()} data-kiosk="0">
      <SkipLink targetId={MAIN_ID} />
      <AppSidebar store={store} views={views} />
      {/* min-w-0: wide view content wraps or scrolls instead of widening the column. */}
      <SidebarInset className="min-w-0">
        <Topbar store={store} clock={clock} title={title} kiosk={false} />
        <StaleDataCallout store={store} clock={clock} />
        {outlet}
      </SidebarInset>
      <CommandPalette store={store} router={router} reloadOnce={reloadOnce} />
    </SidebarProvider>
  );
}
