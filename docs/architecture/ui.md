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
    lib/          cn(), icons.ts (curated Lucide set), status.ts (tones), format.ts, filters.ts, tree.ts
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
- **Canvas tokens** (`--canvas-axis`, `--canvas-series`, `--canvas-status-*`, …). uPlot draws to a
  `<canvas>`, which cannot resolve `var()`, so the chart reads these names through
  `getComputedStyle`. They are references to `theme.css` tokens, never literal colours.
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
| `MUTATION_STATE` | acked, pending, failed, applied, rejected |

Render a state with `<StatusBadge {...TARGET_STATUS[status]} />` or
`StatusBadge.fromMap(TARGET_STATUS, status)`. `TARGET_STATUS` sets no live-region role, because
grids render many badges at once. A caller opts a single changing indicator in with `role`.

Contrast is tested, not assumed: `tests/tokens-contrast.test.ts` holds the text tokens to WCAG AA
in both themes, and the grayscale browser suites check that the five target statuses stay
distinct with colour removed.

### Icons

Icons are Lucide components, imported **by name** in `ui/lib/icons.ts` and nowhere else, and
rendered with `<Icon name="…">`. Never use `lucide-react/dynamic` or a namespace import: either
ships the whole set. To use a new icon, add its named import and an entry to `ICONS`. The build
budget test checks that curated icons are bundled and a sample of non-curated ones is not.

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
warnings, which deck gets from Vite). Tailwind scans the source tree (automatic source detection, minus `@source not` exclusions in `styles/app.css`) plus the bundled modules for class names, so classes in a source file that never ships still reach the sheet. Never
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

**Scoped Radix.** Import Radix from the scoped `@radix-ui/react-*` packages, never the
`radix-ui` umbrella. Through the umbrella, `Bun.build` puts every Radix package used anywhere onto
the initial route. A new primitive adds its scoped package to `apps/web/package.json` and to the
exact-version pin table in `tests/deps.test.ts`. Re-apply this edit after every deck sync or
`shadcn add`.

**Bespoke viz.** `ui/viz/` holds `Sparkline`, `StatusTimeline`, `Gauge` and `TimeSeriesChart`.
`TimeSeriesChart` loads uPlot through `React.lazy`, so uPlot never ships on the initial route.
Colours come only from the tone and chart tokens. Suppressed marks are hatched or dashed on the
neutral tone. The timeline view's lanes, overlay and swimlane stay in that view; they are not
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

**Shell, palette and kiosk.** The shell is deck's frame: a collapsible sidebar (a Sheet below
`md`), a sticky top bar and a single `<main id="main">` reached from the skip link. The shell
renders no `h1`; each view's `PageHeader` supplies it. The top bar's health region shows the
estate name, the live and staleness pill, the theme menu and the density control. A stale-data
`Callout` with `role="alert"` sits under it. `CommandPalette` is a Pulse pattern on shadcn
`Command` inside `Dialog`. The shell loads it as a lazy chunk, registers `mod+k` through
`a11y/shortcuts.ts`, and ranks results with the pure `shell/command-index.ts`. In kiosk mode
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
  Give a view's root `data-slot="<view>-page"`.
- A new pattern goes in `ui/patterns/<kebab-name>.tsx`, is exported from `ui/index.ts`, has a
  `data-slot="<kebab-name>"` root, and is shown in the workbench in every state. If it is
  Pulse-only, list it in `VENDORED.md`.
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
- **Visual review:** there are no committed visual baselines. Screenshots of a changed view at
  375, 768 and 1280 px in light and dark (and wallboard for overview and kiosk) are captured to the
  git-ignored `screenshots/` directory and reviewed locally.
- **Budgets:** `tests/build-budget.test.ts` holds the initial-route JS, total JS and total CSS
  ceilings, uPlot's absence from the initial route, the curated-icon checks, barrel tree-shaking
  and the workbench's absence. `tests/client-build.test.ts` holds the initial-route JS + entry
  CSS ceiling. Raising a ceiling is a deliberate, reviewed change.

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
- `useSignals()` in every component that reads a signal during render.

Related suites: `tests/no-preact.test.ts` keeps `preact` out of `apps/web`,
`tests/mutations-client-imports.test.ts` keeps mutation dialogs behind `import()`, and
`tests/ui-tailwind-classes.test.ts` checks that every class the library uses compiles under the
plugin's embedded Tailwind. Keep these green rather than allowlisting around them.
