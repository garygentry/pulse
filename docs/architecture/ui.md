# Web UI: stack, component library, and conventions

The Pulse web client (`apps/web/src/client`) is a React 19 single-page app styled with Tailwind
CSS v4 and bundled with `Bun.build`. Every screen is composed from one in-repo component library,
`@/ui`, so views share one look, one set of status colours and one set of accessibility
behaviours. The library is vendored from deck, so Pulse and deck look and behave alike. The
decision behind this stack is recorded in [ADR-0001](./adr/0001-web-ui-stack.md).

## Layers

```
apps/web/src/client/
  ui/
    primitives/   shadcn/ui source (Radix-based): Button, Dialog, Sheet, Sidebar, Tabs, Tooltip, …
    patterns/     composites: StatusBadge, DataTable, FilterBar, TreeView, PageHeader, CommandPalette, …
    hooks/        useListNavigation, useFacetFilters, useDocumentTitle, useNow, …
    lib/          cn(), icons.ts (curated Lucide set; icons-shell.ts the eager part), status.ts (tones), format.ts, filters.ts, tree.ts
    status/       pulse status maps: TARGET_STATUS, ALERT_SEVERITY, MUTATION_STATE
    viz/          pulse charts: Sparkline, StatusTimeline, Gauge, TimeSeriesChart (lazy uPlot)
    index.ts      the public barrel: code outside ui/ imports from "@/ui"
    VENDORED.md   the deck commit the library was copied from, and every pulse divergence
  shell/          Shell (frame + ViewHost), AppSidebar, Topbar, HealthRegion, StaleDataCallout,
                  ThemeMenu, CommandPalette, router-hooks.ts, kiosk.ts
  views/<id>/     one directory per view; view.tsx is the lazy entry. views/_ui/ is the workbench
  store/          the application store (signals) and live state
  styles/         app.css (Tailwind entry + base rules), theme.css (deck tokens), theme-pulse.css
```

- **Primitives** are shadcn/ui components (new-york style, `apps/web/components.json`), copied
  into the repo rather than installed. Every local edit is recorded in `ui/VENDORED.md`; larger
  ones also carry a comment at the top of the file, so `shadcn diff` stays readable.
- **Patterns** carry the product rules: never colour-only status, a labelled region for every
  scrolling table, one `h1` per page, and so on.
- **Hooks and lib** hold behaviour without markup: keyboard navigation, filter state, time
  formatting and the tone vocabulary.
- **Views** compose patterns and hold domain logic. `@/ui` resolves through the web app's
  tsconfig `paths` (`@/*` → `src/client/*`, Bundler module resolution), so vendored files compile
  unmodified.

### Vendored from deck

`ui/primitives`, `ui/patterns`, `ui/hooks`, `ui/lib` and `styles/theme.css` are copied file for
file from deck's `apps/web/src/`. `ui/VENDORED.md` records the source commit, every Pulse-side
divergence (scoped Radix imports, the `Button` `loading` prop, `DataTable` virtualization, and a
few type widenings), and the Pulse-only additions that are candidates to move upstream.

To sync with a newer deck: diff these files against deck at the new commit, apply the changes,
keep the divergences listed in `VENDORED.md`, update the recorded commit, then re-run the
guardrail, contrast and `ui-*` tests. A shared package is deliberately not used yet. Keeping the
trees in parity means it can be extracted mechanically later.

## Tokens and tones

`styles/app.css` is the single Tailwind entry. It follows deck's order: `@import "tailwindcss"`,
`tw-animate-css`, the typography plugin, the class-based `dark` variant, then `theme.css` and
`theme-pulse.css`. Cascade layers are Tailwind's defaults (`theme, base, components, utilities`).
The base layer sets the body font, size and background, and handles `prefers-reduced-motion`. The
Geist faces are self-hosted from `@fontsource-variable` and registered from `styles/fonts.ts`,
because importing them from CSS would make Bun inline the font files into the sheet.

`styles/theme.css` is deck's file verbatim. It defines every colour in OKLCH for light (`:root`)
and dark (`.dark` on `<html>`):

- the shadcn semantic tokens (`--background`, `--foreground`, `--primary`, `--muted`,
  `--border`, `--ring`, …) with a teal primary, plus `--chart-1` to `--chart-5` and the sidebar
  set;
- six **status tones**, `ok`, `warn`, `danger`, `info`, `pending` and `neutral`, each with `-fg`,
  `-bg` and `-border` variants, used as `text-status-warn-fg`, `bg-status-warn-bg` and so on.

`styles/theme-pulse.css` adds only Pulse's extensions:

- **Wallboard density.** `:root[data-density="wallboard"]` scales Tailwind's spacing and type
  scale for reading at a distance. `?kiosk=1` forces it, and the density control sets it
  otherwise. Desk density is `theme.css` as is.
- **Motion tokens** (`--motion-base`, `--motion-slow`, `--motion-ease`) for the few animated state
  changes, such as the overview change marker. The reduced-motion rule in `app.css` overrides them.

The inline script in `index.html` applies the stored theme (`.dark` class and `color-scheme`) and
density before first paint, so the page never flashes the wrong theme.

### Status maps

A view never picks a colour. Domain states map to tones with `defineStatusMap`, and every state
carries an icon and a label, so status is never shown by colour alone. Pulse's maps live in
`ui/status/` and are exported from the barrel:

| Map | States |
|---|---|
| `TARGET_STATUS` | ok → `ok`, warning → `warn`, critical → `danger`, unknown → `neutral`, suppressed → `neutral` with an outline variant and its own icon |
| `ALERT_SEVERITY` | critical, warning, info (its own `info` tone), unknown; free-form severities go through `alertSeverityOf` |
| `ALERT_STATE` | a delivered alert's state badge: firing takes its severity's entry (so firing info is `info`, never `unknown`), silenced and inhibited are `suppressed` (outline, bell); keyed by `alertStateOf(state, severity)` |
| `MUTATION_STATE` | acked, pending, failed, applied, rejected |

Render a state with `<StatusBadge {...TARGET_STATUS[status]} />` or
`StatusBadge.fromMap(TARGET_STATUS, status)`. `TARGET_STATUS` sets no live-region role, because
grids render many badges at once. A caller opts a single changing indicator in with `role`.

Contrast is tested, not assumed: `tests/tokens-contrast.test.ts` holds the text tokens to WCAG AA
in both themes, and the grayscale browser suites check that the five target statuses stay
distinct with colour removed.

### Icons

Icons are Lucide components, imported **by name** in `ui/lib/icons.ts` (or `ui/lib/icons-shell.ts`,
below) and nowhere else, and rendered with `<Icon name="…">`. Never use `lucide-react/dynamic` or a
namespace import: either ships the whole set. To use a new icon, add its named import and an entry
to `ICONS`. The build budget test checks that curated icons are bundled and a sample of non-curated
ones is not.

**Shell icons eager, the rest lazy.** `ICONS` and `IconName` are the whole curated set, as before,
but only the icons entry code can render before a view loads ship on the initial route:
`ui/lib/icons-shell.ts` (`SHELL_ICONS`: nav, theme menu, health region, and the Callout, ErrorState
and Button spinner icons). `ICONS` spreads them in. `<Icon>` resolves names through
`ui/lib/icon-registry.ts`, which starts with the shell set and gains the full set when the
`icons.ts` chunk loads; `ViewHost` loads that chunk alongside every view chunk and renders the view
once both are in, so a view's first render has every icon. A name asked for before then renders an
empty svg of the same size (no layout shift) and fills in when the chunk lands; once the full set is
in, an unknown token renders the fallback circle as before. If the chunk fails to load, icons render
the fallback circle (never a blank) and the registry retries on a bounded backoff (1, 2, 4, 8, 16,
30 s), then on the next navigation; a browser caches a failed module fetch, so a retry imports the
chunk URL the error names with a fresh query (Chromium, Firefox; where the error carries no URL the
fallback stays until a reload). Importing `icons.ts` registers it, so
tests (which import the `@/ui` barrel) resolve every icon synchronously.

The trade-off: the ~5 KB gz icon chunk moved off the shell's critical path, not out of the first
page load; every first view load fetches it in parallel with the view chunk. Per-view icon maps
would shave that further but need the names each view renders, which are runtime strings (status
maps, config tokens), so they were not worth a second registration contract. If you render a new
icon from entry code, add it to `SHELL_ICONS`: the build budget test scans every initial-route
module for icon tokens and fails on one that is not a shell icon.

## Pulse deltas from deck

**Signals bridge.** The store (`store/*`, `live-state.ts`) is built on `@preact/signals-core`.
Components read it through `@preact/signals-react` with an explicit `useSignals()` call (from
`@preact/signals-react/runtime`) at the top of every component that reads a signal's `.value`
during render, including reads made through a helper such as `canAct` or `readAlerts`. The Babel
transform that would insert the call cannot run under `Bun.build`, and a missed call fails
silently: the component simply stops updating. `useSignal`, `useComputed` and `useSignalEffect`
also come from `@preact/signals-react`. The guardrail test scans for components that read signals
without the call.

**StrictMode.** `main.tsx` renders the app inside `<StrictMode>`, so development builds double
render and double run effects; effects must clean up after themselves. A per-mount resource with
its own teardown (a time axis, a history client) goes through `useDisposable`, which defers disposal
a microtask so the StrictMode remount keeps the same instance and mount-once effects
(`useSignalEffect`) stay bound to it. Production builds skip those checks. Tests render without it, so render-count assertions stay exact.

**Build.** There is no Vite. `scripts/build-client.ts` drives `Bun.build` with
`bun-plugin-tailwind`, so the entry CSS is the one global Tailwind sheet. It defines
`process.env.NODE_ENV` (React's production build) and `import.meta.env.DEV` (the library's dev
warnings, which deck gets from Vite). Tailwind scans the client source (`@import "tailwindcss" source("..")` in `styles/app.css` roots detection at `src/client`, minus `@source not` exclusions) and the bundled modules for class names, so classes in a source file that never ships still reach the sheet. Rooting detection at the client source, not the build's working directory, keeps the sheet the same wherever the build starts, and it matters: modules loaded through the build's barrel-import plugin (below) skip Tailwind's per-module scan, so a build started outside the repository root once lost most utilities. Never
supply module contents through a Bun `onLoad` in the client build, because the plugin skips those
modules.

**Chunk CSS.** The manifest's `chunkCss` map lists stylesheets that belong to lazy chunks, and
`attachChunkStyles` loads them with the chunk. Every Pulse style is Tailwind, so the only CSS a lazy
chunk imports is third-party: uPlot's stylesheet, imported by `ui/viz/uplot-chart.tsx`. Bun copies a
lazy child's CSS into each ancestor's bundle, the entry included, so the build omits any chunk
stylesheet whose rules the entry sheet already carries. Today that is all of them: the production
build ships one stylesheet and an empty `chunkCss`. The mechanism stays for a future chunk whose CSS
the entry does not carry.

**Deep imports in entry code, the barrel in lazy views.** Lazy views import from `@/ui`. Entry
code (`shell/`, `app.tsx`, `main.tsx`) imports each module by path, with a
`// ui-deep-import: <why>` comment. If entry code used the barrel, Bun would hoist library modules
that only lazy views need into the entry chunk. The barrel tree-shakes because
`apps/web/package.json` declares `"sideEffects": ["*.css"]`. One consequence: an effect-only
`import "./x"` of a `.ts` file is dropped, so such a file must be added to that list. A build test
fails if lazy-only library code reaches the initial route.

**Barrel imports are rewritten at build time.** Bun.build tree-shakes a barrel, but it assigns
modules to chunks by reachability: everything a barrel re-exports counts as used by every chunk
that imports it. Through `@/ui`, every library module was reachable from every lazy view, so they
all shared one chunk and each view's first load carried the others' modules (the overview's carried
the data table, TanStack Virtual and Radix Select, ~46 KB gz it never ran). The `lucide-react`
barrel did the same to icons: every curated icon rode the initial route. So `build-client.ts`
loads each client module that imports one of these barrels through a plugin that rewrites
`import { A, B } from "@/ui"` (outside `ui/`) and `import { X } from "lucide-react"` (anywhere)
into imports from the modules that own each name. Source code is unchanged: feature code still
imports from `@/ui`. The plugin drops `type` specifiers and fails the build on a name the barrel
does not export or on any other form of barrel import (namespace, re-export, dynamic), so nothing
falls back to the barrel. An `export *` of a nested barrel (`ui/status`, `ui/viz`) is followed to
the modules that own its names. Rewritten imports name modules by package subpath or `@/ui/…` path,
never by absolute path: sourcemaps carry the rewritten source, and the bundle is public. The cost
is more, smaller chunks, which compress less well as separate
files: total JS rose ~15 KB gz while each view's first load fell 6–44 KB gz. The build budget test
holds a first-load ceiling per view and one for a session that opens them all. The initial route is
now ~26 small files; the server's shell lists every chunk the entry imports statically as
`<link rel="modulepreload">` (`modulePreloadPaths` in `src/server/assets.ts`), so the browser
fetches them in parallel with the entry instead of after parsing it.

**Scoped Radix.** Import Radix from the scoped `@radix-ui/react-*` packages, never the
`radix-ui` umbrella. Through the umbrella, `Bun.build` puts every Radix package used anywhere onto
the initial route. A new primitive adds its scoped package to `apps/web/package.json` and to the
exact-version pin table in `tests/deps.test.ts`. Re-apply this edit after every deck sync or
`shadcn add`.

**Bespoke viz.** `ui/viz/` holds `Sparkline`, `StatusTimeline`, `Gauge` and `TimeSeriesChart`.
`TimeSeriesChart` loads uPlot through `React.lazy`, so uPlot never ships on the initial route.
Colours come only from the tone and chart tokens. uPlot draws to a `<canvas>`, which cannot
resolve `var()`, so `ui/viz/uplot-chart.tsx` reads the theme tokens from the chart root's computed
style: `--border` for the axes and grid, `--muted-foreground` for tick text, `--chart-1` to
`--chart-5` for series by index, and `--status-<tone>-fg` for a series that carries a status.
Suppressed marks are hatched or dashed on the neutral tone. `StatusTimeline` draws each segment
from a status map: `TARGET_STATUS` by default, or the caller's own `statusMap` for another
vocabulary (the alert swimlane passes each bar's severity with `ALERT_SEVERITY`, so info bars take
the info tone). An outline entry is hatched. `TimeSeriesChart` takes optional `splitYTicks` and
`formatYTicks`; `SyncedChart` passes `axisSplits` and `formatAxisTicks` (`chart-data.ts`), so y
ticks fall on steps that are round in the display unit (`5.2 GiB`, `30 min`, `99.5 %`) and use the
same unit rule (`displayScale`) as the cursor readout. The timeline view's lanes, overlay and swimlane stay in that view; they are not
library patterns.

**DataTable `virtualize`.** An opt-in prop on the vendored `DataTable`, backed by
`@tanstack/react-virtual`. It switches on at a row threshold (300 by default), keeps the focused
row rendered by id, exposes `aria-rowcount` and `aria-rowindex`, and offers a ref handle with
`scrollToIndex`. Rows are measured as they render (`virtualize.rowHeight` is the estimate and
each row's minimum height), so rows that grow a second line, such as the alert catalog's rule
errors, keep the spacers, the scrollbar and `scrollToIndex` exact. Below the threshold the output
is deck's. The alerts triage table and catalog, the estate inventory, coverage and entity pages,
and the `/_ui` workbench use it.
`focusable={false}` drops the scroll region's tab stop where nobody interacts (the kiosk engine
tables).

**TreeView `virtualize`.** The same opt-in on `TreeView`, for trees whose expanded branches can
reach thousands of rows (the estate inventory). At a threshold of visible rows (300 by default,
with the same hysteresis) the treeitems render flat, without `group` nesting, in a bounded scroll
viewport; each carries `aria-level`, `aria-setsize`, `aria-posinset` and `aria-expanded` computed
from the model, so the set is described correctly while most of it is not in the DOM. Rows are
measured as they render. The focused row and the Tab stop stay rendered, and keyboard moves go
through `useListNavigation`'s `virtual` option (the full row count and a `focus(index)` that renders
the row first), so ↑/↓, Home/End, `*` (expand every sibling) and type-ahead reach rows that are not
rendered and scroll them into view. Typing j or k while a type-ahead search is live extends it
(`useListNavigation`'s `typeaheadActive`); otherwise they move. Switching layouts as the row count crosses the threshold keeps focus on the row
that had it, and `*` opening rows above the focused one scrolls it back into view. Known
limitations: the browser's find (Ctrl/Cmd-F) only finds rendered rows, printing shows only the
rendered window, and the 70vh scroll region uses `overscroll-contain`, so on a phone a swipe that
reaches its end does not scroll the page; swipe outside the tree to scroll the page.

**Shell, palette and kiosk.** The shell is deck's frame: a collapsible sidebar (a Sheet below
`md`), a sticky top bar and a single `<main id="main">` reached from the skip link. The shell
renders no `h1`; each view's `PageHeader` supplies it. The sidebar's view links are one Tab stop
(a roving tabindex on the last focused link, else the active view), and ↑/↓ (or j/k) and Home/End
move between them through `useListNavigation`, on the icon rail and in the mobile sheet alike.
Ctrl/Cmd-B toggles the sidebar, except while focus is in a text field (`isTextEntryTarget`). The top bar's health region shows the
estate name, the live and staleness pill, the theme menu and the density control. A stale-data
`Callout` with `role="alert"` sits under it. `CommandPalette` is a Pulse pattern on shadcn
`Command` inside `Dialog`. The shell loads it as a lazy chunk (prefetched when idle), registers
`mod+k` through `a11y/shortcuts.ts`, and ranks results with the pure `shell/command-index.ts`. If
Ctrl/Cmd-K lands before the chunk, the palette opens on a loading state and keys typed meanwhile
are captured into the query (printable keys including Alt/AltGr characters, and pasted text;
Backspace edits, Escape closes; F-keys and Ctrl/Cmd chords pass), so they show in the search field,
caret at the end, when the dialog mounts, and nothing typed reaches the page. If the chunk fails,
the buffer is dropped and focus moves to the error state's Reload button. In kiosk mode
(`?kiosk=1`) the shell renders no sidebar, top-bar controls or palette, and uses wallboard density.
Rotation lives in `shell/kiosk.ts`.

**Router adapter.** Pulse keeps its own History-API router (`router.ts`).
`shell/router-hooks.ts` exposes deck-shaped `useLocation()` (`url`, `path`, `query`, `route`,
`match`) and `useRoute()` (`path`, `query`, `params`) over it, so vendored patterns such as
`SafeRouteLink` and `ListItem href` work unchanged. A plain `<a href>` routes through the router's
document click interceptor.

**Overlays and focus.** Dialogs, sheets, tooltips, popovers and menus are Radix, portalled to
`document.body`. A controlled Radix `Dialog` with no `DialogTrigger` returns focus to `<body>` on
close, so a dialog opened from code restores focus itself (`mutations/dialog-frame.tsx` and the
command palette do). Mutation dialogs stay lazy chunks, loaded with `useLazyDialog`.

**Estate tree rows.** A `treeitem` cannot own an interactive control, so the estate inventory
tree's rows show provenance as plain text and the provenance copy button lives on the entity page.
The keyboard path there is Enter on a host or service row, and the tree's visible keyboard help
(its `aria-describedby`) says so.

**Overview grid.** The host grid stays bespoke (a 2-D `role="grid"` with spatial roving focus and
change markers) and is restyled with token classes. Its cells use `React.memo` with an explicit
equality function, so a live update re-renders only the cells that changed.

## The `/_ui` workbench

`views/_ui/` is a development-only view that shows every library component in its states,
grouped by section (`views/_ui/sections/`). It is reached by URL at `/_ui` on a development build
(`bun run dev:web`) and is never in the nav, the palette or a kiosk rotation. Its `import()` sits
behind a literal `process.env.NODE_ENV !== "production"` check, and `app.css` excludes it with
`@source not`, so no code or class from it ships. The build budget test checks that it is absent
from a production build.

## Adding to a view or the library

- Build screens from `@/ui`: `PageHeader` for the one `h1`, `Section` for each `h2` region, the
  pattern that fits the content (`DataTable`, `List`, `CardGrid`, `KeyValueList`, `TreeView`, …),
  and `LoadingState`, `EmptyState`, `ErrorState` and `PageErrorBoundary` for the other paths.
  Give a view's root `data-slot="<view>-page"`, and wrap the view in `PageErrorBoundary` with the
  same `pageSlot`, so a render fault keeps the root and its `h1`.
- A new pattern goes in `ui/patterns/<kebab-name>.tsx`, is exported from `ui/index.ts`, has a
  `data-slot="<kebab-name>"` root, and is shown in the workbench in every state. If it is
  Pulse-only, list it in `VENDORED.md`.
- Advertise a page shortcut with `aria-keyshortcuts` on the focusable control it acts on (each
  radio of a `SegmentedControl` through `keyShortcuts`), never on a wrapper. Values are
  KeyboardEvent `key` values, space-separated alternatives: `"[ ]"`, `"Shift+ArrowLeft"`, with
  `Space` and `Plus` spelled out; `code` names such as `BracketLeft` are wrong.
- Style only with token classes. `style={…}` is for dynamic geometry, in files on the guardrail
  allowlist.

## Testing

- **Unit and component:** `bun test` with happy-dom and React Testing Library. Suites import RTL
  from `tests/rtl.ts`, never from `@testing-library/*`, and wrap their tests in `describeUi`, which
  installs the Radix stubs (`ResizeObserver`, Floating UI) and unmounts after each test. Assert
  roles, accessible names and ARIA state. Never assert Tailwind class strings; use `data-slot`,
  `data-status` or `data-state` where a role is not enough. Portalled content is queried through
  `screen`.
- **Browser:** headless Chromium through playwright-core. `tests/browser/` holds the axe,
  grayscale and reflow suites per view and the performance suites (the overview one is opt-in
  through `bun run perf`); `tests/contrast.test.ts` checks status contrast on rendered pages. They
  skip when Chromium is absent unless `PULSE_REQUIRE_BROWSER=1` is set.
- **Visual regression:** committed `toHaveScreenshot` baselines, generated and verified on CI
  Linux only (see [Visual baselines](#visual-baselines)). A change that moves pixels updates them in
  the same PR, regenerated on CI. Screenshots of a changed view at 375, 768 and 1280 px in light and
  dark are still worth reviewing locally under the git-ignored `screenshots/` while you work.
- **Budgets:** `tests/build-budget.test.ts` holds the initial-route JS, total JS, total CSS and
  per-view first-load ceilings, uPlot's absence from the initial route, the curated-icon and
  shell-icon checks, barrel tree-shaking and the workbench's absence. `tests/client-build.test.ts` holds the initial-route JS + entry
  CSS ceiling. Raising a ceiling is a deliberate, reviewed change.

## Visual baselines

`apps/web/tests/visual/` holds the visual-regression suite, run by `@playwright/test` (pinned to
the playwright-core release; `tests/deps.test.ts` checks both). It sits beside the playwright-core
browser suites, which still run under `bun test`. Its files are `visual-<view>.pw.ts`: the `.pw.ts`
suffix keeps them out of `bun test`, which collects `*.spec.*`.

- **Coverage:**
  - One spec per view: overview, the alerts tabs and detail pane, the estate tabs and entity pages,
    timeline and engine. Each is captured at 375, 768 and 1280 px in light and dark, with the side
    nav and top bar hidden.
  - The shell itself (side nav and top bar) is captured on overview at 375 and 1280 px in both
    themes.
  - Overview, alerts and timeline also get a 1920×1080 kiosk wallboard capture.
  - The `/_ui` workbench gets one capture per section, at 1280 px in both themes and 375 px light.
- **Determinism:**
  - **Server:** `tests/visual/serve.ts` builds the client once and serves the `degraded-mix` mock
    through the dev composition root. It spawns `entry.ts` with `--preload freeze-clock.ts`, a
    test-only preload that freezes the server's wall clock. `--clock` sits 15 minutes before the
    frozen instant, so the scenario timeline has fully played out.
  - **History:** the mock engine serves no range queries, so `visual-kit.ts` answers
    `/api/history/**` with series generated from the query, target and range alone.
  - **Browser clock:** frozen at the same instant (`page.clock.setFixedTime`).
  - **Timers:** `setTimeout` callbacks 4 s or more out are held, so the overview poll chain and
    kiosk paging never fire mid-capture. `setInterval` refreshes and the SSE stream still run.
    They re-render the same frozen data, and `toHaveScreenshot` waits for two identical
    consecutive captures.
  - **Rendering:** animations are disabled and fonts are awaited. The timezone and locale are
    pinned. The build-id-bearing app version on the engine page is masked. Workbench inner
    scrollers are pinned to the top.
  - **Comparison:** per-pixel `threshold: 0.1`, and no pixel may exceed it.
- **CI only:** font rasterisation differs between hosts, so baselines are made and checked only on
  the CI Linux image. Locally the specs skip unless `UPDATE_VISUALS=1` is set. With it set, they
  run against the committed Linux baselines and will usually fail on a laptop. That is still useful
  for debugging a spec. Don't commit locally generated PNGs. The suite always starts its own server
  (`PULSE_VISUAL_PORT`, default 4319) and never attaches to one already running.
- **Verifying:** the `ci` job runs `bun run visual` after `bun run ci`, whenever the change touches
  something the suite renders from. That means `apps/web/`, `packages/{web-data,renderer,core}/`,
  `examples/reference/rendered/`, the dependency pins and `ci.yml`. Other changes skip the step,
  but the job still runs and reports. On failure, the actual, expected and diff images are uploaded
  as the `visual-results` artifact.
- **Updating baselines:** run the separate `visual-update.yml` workflow. It is dispatch-only, its job
  is not named `ci`, and it never reports the required check. It deletes the committed set,
  regenerates every baseline on CI, and uploads exactly that set as the `visual-baselines` artifact.
- **Keeping up with main:** a PR's `ci` run checks the merge with main. So when main has moved,
  merge it into the branch first, regenerate, then commit:

  ```
  git merge origin/main && git push                    # 1. bring the branch up to date
  gh workflow run visual-update.yml --ref <branch>     # 2. regenerate on CI
  gh run list --workflow visual-update.yml --branch <branch> --limit 1   # note the run id
  rm -rf apps/web/tests/visual/*-snapshots             # 3. replace the set (drops stale images)
  gh run download <run-id> -n visual-baselines -D apps/web/tests/visual
  git add apps/web/tests/visual && git commit           # 4. review the PNG diffs, commit, push
  ```

  A new view or state gets a spec here, and its baselines arrive the same way.

## Guardrails

`apps/web/tests/ui-guardrails.test.ts` scans the client sources and enforces:

- barrel-only `@/ui` imports outside `ui/`, unless justified with `// ui-deep-import: <why>`;
- scoped `@radix-ui/react-*` imports, never `radix-ui`;
- icons through `<Icon name>`: no `lucide-react` import outside `ui/`;
- raw HTML (`dangerouslySetInnerHTML`, `Prose sanitizedHtml`, `CodeBlock highlightedHtml`) only in
  allowlisted files (the two vendored patterns and the workbench's constant demos);
- no colour literals (hex, `rgb()`, `oklch()`, named colours) anywhere in `src/client`;
- `style={…}` only in allowlisted files, with no stale allowlist entries;
- a `data-slot` root on every pattern, and no `data-icon`;
- no legacy design tokens;
- `useSignals()` in every component that reads a signal during render;
- token resolution: every utility with a theme-backed root (the colour roots `bg-`, `text-`,
  `border-*`, `ring-`, `fill-`, `stroke-`, … plus `font-`, `rounded-*`, `tracking-`, `leading-`,
  `animate-`, `ease-`, `drop-shadow-`, `blur-`, `max-w-`) in a class context (a `className`
  attribute, a `cn`/`cva`/`clsx`/`twMerge` argument, or a class-shaped initializer) compiles under
  the installed Tailwind over `app.css`, variants included; colour utilities name an app theme colour
  (not Tailwind's palette; black, white and the keywords excepted); every `var(--…)` reference in
  sources and stylesheets is declared by the compiled sheet, set at runtime by the same module, or set
  by Radix; every dark token overrides a light one and every light colour has a dark value; and every
  wallboard token overrides a real theme variable. A `${…}` interpolation is matched as a wildcard;
  classes built by concatenation or returned from a helper are not seen;
- list keyboards through `useListNavigation`: no new hand-rolled `ArrowUp`/`ArrowDown` or `j`/`k`
  handler (`.key`/`.code` comparisons, inline key lists, case-folded keys), vertical or 2-D
  `rovingTabindex`, or `j`/`k` shortcut (alone or with Shift) outside the hook. The alerts triage
  keyboard, the timeline lane tree and the overview grid are listed exemptions, each with its reason, as is
  the command palette's pre-load key buffer, which swallows keys but moves nothing.

`tests/views-page-structure.test.tsx` renders every registered view on every route it owns (tabs and
deep routes included), loaded, before data and after a render fault, and checks the
`data-slot="…-page"` root and the one `PageHeader` `h1`. A view's `PageErrorBoundary` takes the page
slot (`pageSlot`), so its fallback keeps that root and heading. `tests/ui-tabs-keyboard.test.tsx` holds the Radix tabs keyboard contract (arrows,
Home/End, wrap, roving tabindex, automatic and manual activation) for the primitive and for the
alerts and estate tabs.

Related suites: `tests/no-preact.test.ts` keeps `preact` out of `apps/web`,
`tests/mutations-client-imports.test.ts` keeps mutation dialogs behind `import()`, and
`tests/ui-tailwind-classes.test.ts` checks that every class the library uses compiles under the
plugin's embedded Tailwind. Keep these green rather than allowlisting around them.
