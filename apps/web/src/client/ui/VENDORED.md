# Vendored from deck

Files under `src/client/ui/` (and the theme stylesheet) that are copied from deck's `@/ui`
library, file for file. The source is deck commit `e2e2661` (v0.3.2), `apps/web/src/`.

To sync: diff these files against deck at a newer commit, apply the changes, keep the pulse
divergences listed below, then re-run the guardrails and the contrast tests.

| Pulse path | Deck path | Divergence |
|---|---|---|
| `src/client/styles/theme.css` | `src/styles/theme.css` | None |
| `src/client/ui/lib/utils.ts` | `src/ui/lib/utils.ts` | None |
| `src/client/ui/lib/icons.ts` | `src/ui/lib/icons.ts` | Pulse additions: a second `lucide-react` import block and a "pulse additions" section at the end of `ICONS` (the shell and views' icons deck lacks). The shell's icons moved to the pulse-only `icons-shell.ts` (spread into `ICONS`, which keeps its type and contents) and `FALLBACK_ICON` with them; evaluating `icons.ts` registers the set with `icon-registry.ts` (pulse-only), so it can load as a lazy chunk |
| `apps/web/components.json` | `apps/web/components.json` | `tailwind.css` points at `src/client/styles/app.css` |
| `src/client/ui/index.ts` | `src/ui/index.ts` | No `ConfigGate` exports. Adds the pulse-only exports: `FreshnessStamp`/`FreshnessState`, the `kbd`/`radio-group`/`textarea` primitives, `CommandPalette` + `commandGroupsFromIndex`, the `useDisposable` hook, `isTextEntryTarget`, `export * from "./status"` and `"./viz"`, and the DataTable virtualization exports (`DATA_TABLE_VIRTUALIZE_DEFAULTS`, `DataTableHandle`, `DataTableScrollAlign`, `DataTableVirtualizeOptions`) |
| `src/client/ui/primitives/*` | `src/ui/primitives/*` | Radix comes from the scoped packages, not deck's `radix-ui` umbrella: `import { Dialog as DialogPrimitive } from "radix-ui"` → `import * as DialogPrimitive from "@radix-ui/react-dialog"` (`Slot` → `import * as Slot from "@radix-ui/react-slot"`), bodies unchanged. Through the umbrella, Bun.build puts every Radix package used anywhere on the initial route; the deps are pinned to the versions `radix-ui` 1.6.7 resolves, and `tests/ui-guardrails.test.ts` forbids the umbrella (re-apply on every sync and after `shadcn add`). `dropdown-menu.tsx`: `checked` is spread only when defined (`exactOptionalPropertyTypes`). `button.tsx`: pulse `loading` prop (spinner, `aria-busy`/`aria-disabled`/`data-loading`, clicks swallowed, never `disabled` so focus stays put). `sidebar.tsx`: the Ctrl/Cmd-B toggle returns early when `isTextEntryTarget(event.target)`, so the chord stays with a focused text field. `select.tsx` and `scroll-area.tsx`: the Radix `Viewport` gets `{...styleNonceProps()}` (its `nonce`; `lib/style-nonce.ts`), because each renders its own `<style>` element that the strict CSP `style-src` blocks without the response's nonce (issue #2; re-apply on every sync, and wire any newly vendored primitive whose Radix part takes a `nonce` prop) |
| `src/client/ui/patterns/*` | `src/ui/patterns/*` | `config-gate.tsx` not vendored (deck's config shell). `data-table.tsx`: pulse `virtualize` prop (`@tanstack/react-virtual`; `data-table-viewport` scroll region, spacer rows, rows measured as they render with `rowHeight` as the estimate and minimum height, `aria-rowcount`/`aria-rowindex`, focused row kept rendered by row id; hysteresis: once virtualized it stays so until rows < `floor(threshold * 0.8)`) and a `ref` handle with `scrollToIndex`; a `focusable` prop (default `true`) drops the scroll region's tab stop on a wallboard; below the threshold and with the defaults the output is deck's. `freshness-badge.tsx` imports its types from `lib/freshness.ts`. Console prefixes `[deck]` → `[pulse]` (`icon.tsx`, `page-error-boundary.tsx`, `fragment-boundary.tsx`). `icon.tsx` resolves names through `lib/icon-registry.ts` (shell icons eager, the rest once the lazy icon chunk loads; an empty same-size svg until then, the fallback glyph if the load fails). `facet-filter.tsx`: `defaultOpen ?? false`. `segmented-control.tsx`: optional `keyShortcuts`, set as `aria-keyshortcuts` on every option (the focusable radios). `disclosure.tsx`: the count pill is `aria-hidden` and the label carries a visually hidden `, N items` (optional `countLabel`), so the trigger is named "Proposals, 3 items" rather than "Proposals3". `filter-bar.tsx`: the result count's wrapper is `min-w-0`, not `shrink-0`, so a long count wraps at 320px. `page-error-boundary.tsx`: optional `pageSlot` prop; when set, the fallback renders inside a `data-slot={pageSlot} data-state="error"` root so a failed view keeps its `…-page` root and one `h1`; after Retry, focus moves to the page `h1` (or the `…-page` root) instead of dropping to `<body>`. `tree-view.tsx`: `renderMeta` output is the treeitem's accessible description (`aria-describedby`); an optional `aria-describedby` prop describes the tree (keyboard help). Type-only `\| undefined` widenings on optional props for `exactOptionalPropertyTypes`: `comparison-grid.tsx` (`headingLevel`), `show-more.tsx` (`noun`), `status-badge.tsx` (`role`). `status-badge.tsx`: `fromMap` applies the entry's `variant` (caller props win); `StatusBadgeVariant` is derived from `StatusPresentation["variant"]`. `search-input.tsx`: the `/` shortcut's guard is the shared `isTextEntryTarget` (adds contenteditable ancestors; a checkbox no longer blocks it) instead of a local `isEditable` |
| `src/client/ui/hooks/*` | `src/ui/hooks/*` | `use-show-more.ts`: `\| undefined` widenings; `use-document-title.ts`: doc comment says Pulse |
| `src/client/ui/lib/*` | `src/ui/lib/*` | `document-title.ts`: `APP_TITLE = "Pulse"`. `tree.ts`: `\| undefined` widenings on `TreeAccessors`. `dom.ts`: pulse `isTextEntryTarget` (text-like input, textarea, select, contenteditable; narrower than `isEditableTarget`, which also covers buttons and composite widgets). `freshness.ts` is pulse-only (deck imports the types from its server contract). `status.ts`: optional `StatusPresentation.variant` (badge shape per state, e.g. outline for suppressed) |

The library is imported as `@/ui` (tsconfig `paths` `@/*` → `src/client/*`, Bundler resolution, so
vendored files keep deck's extensionless imports). `import.meta.env.DEV` (read by `Icon`) is
defined by the client build, as Vite defines it for deck.

`src/client/styles/app.css` follows deck's file order and base rules, plus pulse's
`theme-pulse.css` import and an app-wide reduced-motion rule.

## Pulse-only additions

Files in the library directories that deck does not have. They follow the same conventions
(`data-slot`, `cn`, barrel export).

| Pulse path | Source | Notes |
|---|---|---|
| `src/client/ui/lib/style-nonce.ts` | pulse | `styleNonce()` / `styleNonceProps()` return the CSP style nonce (`get-nonce`, set by `main.tsx` from the shell) for primitives that render their own `<style>`; internal, not exported from the barrel |
| `src/client/ui/primitives/radio-group.tsx` | shadcn/ui new-york v4 `radio-group` | Built on `@radix-ui/react-radio-group` |
| `src/client/ui/primitives/textarea.tsx` | shadcn/ui new-york v4 `textarea` | None |
| `src/client/ui/primitives/kbd.tsx` | shadcn/ui new-york v4 `kbd` | `Kbd` and `KbdGroup` |
| `src/client/ui/hooks/use-disposable.ts` | pulse | `useDisposable(create, dispose)`: a per-mount resource that survives StrictMode's development unmount-and-remount (recreated if it was disposed) |
| `src/client/ui/status/*` | pulse | `TARGET_STATUS`, `ALERT_SEVERITY` (+ `alertSeverityOf`), `ALERT_STATE` (+ `alertStateOf`), `MUTATION_STATE` on `defineStatusMap`; the domain → `TargetStatus` maps in `src/client/status/target-status.ts` are unchanged |
| `src/client/ui/viz/*` | pulse (port of `src/client/viz/`) | `Sparkline`, `StatusTimeline`, `Gauge`, lazy `TimeSeriesChart` (uPlot in `uplot-chart.tsx`, reached only by dynamic import). Colours from tone/chart tokens; suppressed is hatched/dashed on the neutral tone |
| `src/client/ui/patterns/command-palette.tsx` | pulse (on the vendored `Command*` + `Dialog` primitives) | Data-driven `CommandPalette` (`groups` of items with their own `onSelect`; selecting closes) and `commandGroupsFromIndex`, which maps command-index entries (structural `CommandIndexEntry`, no shell import) to groups. Optional controlled `search`/`onSearchChange` and `shouldFilter={false}` let a caller rank and cap its own results (the shell's command index); `commandGroupsFromIndex(…, { groupOrder: "entries" })` keeps a ranked list's best match first; `returnFocusTo` names the element focus returns to on close when a caller showed another dialog first. Opening puts the caret after any text already in the search field (a caller's buffered keys) |

## Upstream candidates

Pulse-only additions that could move to deck:

- `primitives/radio-group.tsx`, `primitives/textarea.tsx`, `primitives/kbd.tsx`.
- `primitives/button.tsx` `loading` state.
- `patterns/data-table.tsx` `virtualize`, the `scrollToIndex` handle and `focusable`.
- `patterns/command-palette.tsx` (`CommandPalette`, `commandGroupsFromIndex`).
- `patterns/filter-bar.tsx` `min-w-0` result count (a deck fix: the long count side-scrolls at 320px).
- `patterns/tree-view.tsx` row meta as the treeitem's description (a deck a11y fix).
- `patterns/disclosure.tsx` separated count in the trigger's accessible name (a deck a11y fix).
- `patterns/status-badge.tsx` `fromMap` applying the entry's `variant`, with `StatusPresentation.variant`.
- `patterns/page-error-boundary.tsx` `pageSlot` (the fallback keeps the page's root and `h1`) and focus to the page heading after Retry.
- `ui/viz/*` (Sparkline, StatusTimeline with its geometry helpers and per-segment tone, Gauge, lazy
  uPlot TimeSeriesChart).
- `ui/lib/icons.ts` pulse additions (bell, clock, keyboard, menu, network, wifi and others).
