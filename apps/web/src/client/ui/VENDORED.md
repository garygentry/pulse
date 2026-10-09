# Vendored from deck

Files under `src/client/ui/` (and the theme stylesheets) are copied from deck's `@/ui` library,
file for file, from deck's `apps/web/src/`. Pulse keeps vendoring them rather than consuming a
shared package (issue #5). `VENDORED.json`, next to this file, is the machine-readable record. For
every vendored file it holds the deck path, the git blob id of deck's file at the pinned commit,
the blob id of pulse's copy as last reviewed, and the divergence notes that explain any
difference. `bun run ui:drift` checks the record, and `bun test` runs the same check in CI.

<!-- ui-drift:begin source (generated from VENDORED.json by `bun run ui:drift --record`; do not edit) -->
Pinned upstream: https://github.com/garygentry/deck at `d6a1595` (deck v0.3.2; the public squash of e2e2661, the commit the port was copied from, with identical library files). Vendored files: 88, 45 of them with pulse divergences. Upstream files in scope that are deliberately not vendored: 2.
<!-- ui-drift:end source -->

The library is imported as `@/ui` (tsconfig `paths` `@/*` → `src/client/*`, Bundler resolution, so
vendored files keep deck's extensionless imports). `import.meta.env.DEV` (read by `Icon`) is
defined by the client build, as Vite defines it for deck.

## Drift check

`bun run ui:drift` (the script is `apps/web/scripts/ui-drift.ts`) classifies every vendored file:

| State | Meaning | Fails |
|---|---|---|
| identical | Pulse's copy is deck's file at the pin, and lists no notes | No |
| diverged | Pulse's copy differs from the pin, matches its recorded blob and lists at least one note | No |
| undocumented | Pulse's copy changed since it was recorded, or differs from the pin without a note, or equals the pin but still lists notes | Yes |
| missing | The vendored file is gone from pulse (or, upstream, from deck at the pin) | Yes |
| unlisted | A tracked file under `src/client/ui/` or `src/client/styles/` that is neither vendored nor pulse-only (editor swap files and merge leftovers don't count; symlinks are skipped with a warning) | Yes |
| new upstream | A deck file in scope that is neither vendored nor excluded: at the pin it fails, at a newer ref it is reported | At the pin |

The offline check needs neither the network nor a deck checkout. It compares files with the
recorded blob ids and fails when a vendored file changes without a manifest update. It also fails
when the generated sections of this file fall out of step with `VENDORED.json`. It runs in
`tests/ui-drift.test.ts`, so the required `ci` check covers it.

Upstream comparison reads deck's git history, from a local checkout or from GitHub:

```sh
bun run ui:drift --deck ../deck            # local checkout; compares the pin with its local `main`
bun run ui:drift --deck ../deck --ref origin/main  # ... or with the remote's, if local main lags
bun run ui:drift --deck ../deck --ref HEAD # ... or with whatever is checked out
bun run ui:drift --fetch                   # depth-1 fetch of the pin and `main` into node_modules/.cache
bun run ui:drift --fetch --diff            # plus the upstream diff of every vendored file deck changed
bun run ui:drift --fetch --format markdown # report for a PR or issue
```

It first checks that every recorded deck blob matches deck at the pin, and that every deck file in
scope at the pin is vendored or excluded. Then it lists the vendored files deck changed or removed
since the pin, each with what syncing it takes. When pulse's copy is identical at the pin, take
deck's file. When pulse diverges, merge and keep the listed notes. It also lists files deck added.
That part only reports; `--strict` makes it fail. The `ui-drift` workflow runs it on a weekly
schedule and on demand (`workflow_dispatch`, with a `ref` input), writes the report to the job
summary, and opens nothing.

## Changing a vendored file

1. Make the change.
2. Edit its entry in `VENDORED.json`: add a note to `notes` (or extend one) and list its id on the
   file. A file that now matches deck again drops its notes.
3. Run `bun run ui:drift --record`. It re-records the blob ids and regenerates the sections of this
   file. It refuses to write a manifest that would fail the check, such as a diverged file without
   a note. Its output names every re-recorded file, so you can check that the notes still describe
   it. The blob change in the diff tells the reviewer to read the notes too.

A new file under `ui/` or `styles/` goes into `localOnly` (pulse-only) or `files` (vendored).

## Syncing with a newer deck

1. Report what changed: `bun run ui:drift --deck <deck checkout> --ref <new commit> --diff`, or
   `--fetch --ref <new commit>` without a checkout. Pick the new pin, a commit on deck's `main`, so
   `--fetch` can always reach it.
2. Apply each change. When pulse's copy is identical at the old pin, copy deck's file. When it
   diverged, merge deck's change and re-apply the file's notes, in particular `radix-scoped` and
   `style-nonce` on primitives, which deck's shadcn flow undoes. Vendor or exclude the files deck
   added (new `files` or `excluded` entries). Drop or remap the files deck removed.
3. Bump the pin and re-record: `bun run ui:drift --record --deck <deck checkout> --pin <new commit>`
   (or `--fetch --pin <new commit>`). This re-reads every deck blob at the new pin and writes
   `upstream.commit`. Update `upstream.describe` by hand (deck version). It refuses a diverged
   file whose deck blob moved while pulse's copy did not, since the next report would compare
   from the new pin and deck's change would drop out of sight. Merge it, or pass
   `--accept-unmerged` when deck's change does not apply to pulse. The guard only detects an
   unchanged pulse copy: if pulse's copy was edited too, the bump goes through, so read every
   "upstream changed" line the bump prints.
4. Re-run the gates: `bunx tsc -b`, `bun test` (the guardrail, contrast and `ui-*` suites cover the
   library) and `bun run ui:drift --deck <deck checkout> --ref none`, which checks the new pin.

Pulse-only additions worth having in deck go upstream first (issue #18); after deck releases them,
the next sync turns them from pulse-only into vendored files.

## Vendored files

<!-- ui-drift:begin mapping (generated from VENDORED.json by `bun run ui:drift --record`; do not edit) -->
| Pulse path | Deck path | Divergence notes |
|---|---|---|
| `apps/web/components.json` | `apps/web/components.json` | `components-json` |
| `apps/web/src/client/styles/app.css` | `apps/web/src/styles/app.css` | `app-css` |
| `apps/web/src/client/styles/theme.css` | `apps/web/src/styles/theme.css` | None |
| `apps/web/src/client/ui/hooks/use-copy-to-clipboard.ts` | `apps/web/src/ui/hooks/use-copy-to-clipboard.ts` | None |
| `apps/web/src/client/ui/hooks/use-document-title.ts` | `apps/web/src/ui/hooks/use-document-title.ts` | `pulse-name` |
| `apps/web/src/client/ui/hooks/use-facet-filters.ts` | `apps/web/src/ui/hooks/use-facet-filters.ts` | None |
| `apps/web/src/client/ui/hooks/use-list-navigation.ts` | `apps/web/src/ui/hooks/use-list-navigation.ts` | `list-navigation-virtual` |
| `apps/web/src/client/ui/hooks/use-mobile.ts` | `apps/web/src/ui/hooks/use-mobile.ts` | None |
| `apps/web/src/client/ui/hooks/use-now.ts` | `apps/web/src/ui/hooks/use-now.ts` | None |
| `apps/web/src/client/ui/hooks/use-page-heading-id.ts` | `apps/web/src/ui/hooks/use-page-heading-id.ts` | None |
| `apps/web/src/client/ui/hooks/use-scroll-to-hash.ts` | `apps/web/src/ui/hooks/use-scroll-to-hash.ts` | None |
| `apps/web/src/client/ui/hooks/use-show-more.ts` | `apps/web/src/ui/hooks/use-show-more.ts` | `exact-optional` |
| `apps/web/src/client/ui/hooks/use-stick-to-bottom.ts` | `apps/web/src/ui/hooks/use-stick-to-bottom.ts` | None |
| `apps/web/src/client/ui/index.ts` | `apps/web/src/ui/index.ts` | `barrel-exports` |
| `apps/web/src/client/ui/lib/document-title.ts` | `apps/web/src/ui/lib/document-title.ts` | `pulse-name` |
| `apps/web/src/client/ui/lib/dom-id.ts` | `apps/web/src/ui/lib/dom-id.ts` | None |
| `apps/web/src/client/ui/lib/dom.ts` | `apps/web/src/ui/lib/dom.ts` | `dom-text-entry` |
| `apps/web/src/client/ui/lib/filters.ts` | `apps/web/src/ui/lib/filters.ts` | None |
| `apps/web/src/client/ui/lib/format.ts` | `apps/web/src/ui/lib/format.ts` | None |
| `apps/web/src/client/ui/lib/grid.ts` | `apps/web/src/ui/lib/grid.ts` | None |
| `apps/web/src/client/ui/lib/icons.ts` | `apps/web/src/ui/lib/icons.ts` | `icons-additions` |
| `apps/web/src/client/ui/lib/link.ts` | `apps/web/src/ui/lib/link.ts` | None |
| `apps/web/src/client/ui/lib/list-navigation.ts` | `apps/web/src/ui/lib/list-navigation.ts` | None |
| `apps/web/src/client/ui/lib/status.ts` | `apps/web/src/ui/lib/status.ts` | `status-variant` |
| `apps/web/src/client/ui/lib/tone.ts` | `apps/web/src/ui/lib/tone.ts` | None |
| `apps/web/src/client/ui/lib/tree.ts` | `apps/web/src/ui/lib/tree.ts` | `exact-optional`, `tree-row-position` |
| `apps/web/src/client/ui/lib/utils.ts` | `apps/web/src/ui/lib/utils.ts` | None |
| `apps/web/src/client/ui/patterns/active-filters.tsx` | `apps/web/src/ui/patterns/active-filters.tsx` | None |
| `apps/web/src/client/ui/patterns/callout.tsx` | `apps/web/src/ui/patterns/callout.tsx` | None |
| `apps/web/src/client/ui/patterns/card-grid.tsx` | `apps/web/src/ui/patterns/card-grid.tsx` | None |
| `apps/web/src/client/ui/patterns/code-block.tsx` | `apps/web/src/ui/patterns/code-block.tsx` | None |
| `apps/web/src/client/ui/patterns/comparison-grid.tsx` | `apps/web/src/ui/patterns/comparison-grid.tsx` | `exact-optional` |
| `apps/web/src/client/ui/patterns/data-table.tsx` | `apps/web/src/ui/patterns/data-table.tsx` | `data-table-virtualize` |
| `apps/web/src/client/ui/patterns/disclosure.tsx` | `apps/web/src/ui/patterns/disclosure.tsx` | `disclosure-count-label` |
| `apps/web/src/client/ui/patterns/empty-state.tsx` | `apps/web/src/ui/patterns/empty-state.tsx` | None |
| `apps/web/src/client/ui/patterns/error-state.tsx` | `apps/web/src/ui/patterns/error-state.tsx` | None |
| `apps/web/src/client/ui/patterns/external-link.tsx` | `apps/web/src/ui/patterns/external-link.tsx` | None |
| `apps/web/src/client/ui/patterns/facet-filter.tsx` | `apps/web/src/ui/patterns/facet-filter.tsx` | `facet-default-open` |
| `apps/web/src/client/ui/patterns/filter-bar.tsx` | `apps/web/src/ui/patterns/filter-bar.tsx` | `filter-bar-wrap` |
| `apps/web/src/client/ui/patterns/fragment-boundary.tsx` | `apps/web/src/ui/patterns/fragment-boundary.tsx` | `console-prefix` |
| `apps/web/src/client/ui/patterns/freshness-badge.tsx` | `apps/web/src/ui/patterns/freshness-badge.tsx` | `freshness-types` |
| `apps/web/src/client/ui/patterns/health-pill.tsx` | `apps/web/src/ui/patterns/health-pill.tsx` | None |
| `apps/web/src/client/ui/patterns/icon.tsx` | `apps/web/src/ui/patterns/icon.tsx` | `console-prefix`, `icon-registry` |
| `apps/web/src/client/ui/patterns/key-value-list.tsx` | `apps/web/src/ui/patterns/key-value-list.tsx` | None |
| `apps/web/src/client/ui/patterns/link-tile.tsx` | `apps/web/src/ui/patterns/link-tile.tsx` | None |
| `apps/web/src/client/ui/patterns/list.tsx` | `apps/web/src/ui/patterns/list.tsx` | None |
| `apps/web/src/client/ui/patterns/loading-state.tsx` | `apps/web/src/ui/patterns/loading-state.tsx` | None |
| `apps/web/src/client/ui/patterns/log-output.tsx` | `apps/web/src/ui/patterns/log-output.tsx` | None |
| `apps/web/src/client/ui/patterns/meter.tsx` | `apps/web/src/ui/patterns/meter.tsx` | None |
| `apps/web/src/client/ui/patterns/page-error-boundary.tsx` | `apps/web/src/ui/patterns/page-error-boundary.tsx` | `console-prefix`, `page-error-page-slot` |
| `apps/web/src/client/ui/patterns/page-header.tsx` | `apps/web/src/ui/patterns/page-header.tsx` | None |
| `apps/web/src/client/ui/patterns/prose.tsx` | `apps/web/src/ui/patterns/prose.tsx` | None |
| `apps/web/src/client/ui/patterns/relative-time.tsx` | `apps/web/src/ui/patterns/relative-time.tsx` | None |
| `apps/web/src/client/ui/patterns/result-count.tsx` | `apps/web/src/ui/patterns/result-count.tsx` | None |
| `apps/web/src/client/ui/patterns/safe-route-link.tsx` | `apps/web/src/ui/patterns/safe-route-link.tsx` | None |
| `apps/web/src/client/ui/patterns/search-input.tsx` | `apps/web/src/ui/patterns/search-input.tsx` | `text-entry-guard` |
| `apps/web/src/client/ui/patterns/section.tsx` | `apps/web/src/ui/patterns/section.tsx` | None |
| `apps/web/src/client/ui/patterns/segmented-control.tsx` | `apps/web/src/ui/patterns/segmented-control.tsx` | `segmented-key-shortcuts` |
| `apps/web/src/client/ui/patterns/show-more.tsx` | `apps/web/src/ui/patterns/show-more.tsx` | `exact-optional` |
| `apps/web/src/client/ui/patterns/stat-tile.tsx` | `apps/web/src/ui/patterns/stat-tile.tsx` | `stat-tile-absent` |
| `apps/web/src/client/ui/patterns/status-badge.tsx` | `apps/web/src/ui/patterns/status-badge.tsx` | `exact-optional`, `status-badge-variant` |
| `apps/web/src/client/ui/patterns/tree-view.tsx` | `apps/web/src/ui/patterns/tree-view.tsx` | `tree-view-description`, `tree-view-virtualize` |
| `apps/web/src/client/ui/patterns/visually-hidden.tsx` | `apps/web/src/ui/patterns/visually-hidden.tsx` | None |
| `apps/web/src/client/ui/primitives/alert-dialog.tsx` | `apps/web/src/ui/primitives/alert-dialog.tsx` | `radix-scoped` |
| `apps/web/src/client/ui/primitives/alert.tsx` | `apps/web/src/ui/primitives/alert.tsx` | None |
| `apps/web/src/client/ui/primitives/badge.tsx` | `apps/web/src/ui/primitives/badge.tsx` | `radix-scoped` |
| `apps/web/src/client/ui/primitives/breadcrumb.tsx` | `apps/web/src/ui/primitives/breadcrumb.tsx` | `radix-scoped` |
| `apps/web/src/client/ui/primitives/button.tsx` | `apps/web/src/ui/primitives/button.tsx` | `radix-scoped`, `button-loading` |
| `apps/web/src/client/ui/primitives/card.tsx` | `apps/web/src/ui/primitives/card.tsx` | None |
| `apps/web/src/client/ui/primitives/checkbox.tsx` | `apps/web/src/ui/primitives/checkbox.tsx` | `radix-scoped` |
| `apps/web/src/client/ui/primitives/collapsible.tsx` | `apps/web/src/ui/primitives/collapsible.tsx` | `radix-scoped` |
| `apps/web/src/client/ui/primitives/command.tsx` | `apps/web/src/ui/primitives/command.tsx` | None |
| `apps/web/src/client/ui/primitives/dialog.tsx` | `apps/web/src/ui/primitives/dialog.tsx` | `radix-scoped` |
| `apps/web/src/client/ui/primitives/dropdown-menu.tsx` | `apps/web/src/ui/primitives/dropdown-menu.tsx` | `radix-scoped`, `dropdown-checked` |
| `apps/web/src/client/ui/primitives/input.tsx` | `apps/web/src/ui/primitives/input.tsx` | None |
| `apps/web/src/client/ui/primitives/label.tsx` | `apps/web/src/ui/primitives/label.tsx` | `radix-scoped` |
| `apps/web/src/client/ui/primitives/popover.tsx` | `apps/web/src/ui/primitives/popover.tsx` | `radix-scoped` |
| `apps/web/src/client/ui/primitives/scroll-area.tsx` | `apps/web/src/ui/primitives/scroll-area.tsx` | `radix-scoped`, `style-nonce` |
| `apps/web/src/client/ui/primitives/select.tsx` | `apps/web/src/ui/primitives/select.tsx` | `radix-scoped`, `style-nonce` |
| `apps/web/src/client/ui/primitives/separator.tsx` | `apps/web/src/ui/primitives/separator.tsx` | `radix-scoped` |
| `apps/web/src/client/ui/primitives/sheet.tsx` | `apps/web/src/ui/primitives/sheet.tsx` | `radix-scoped` |
| `apps/web/src/client/ui/primitives/sidebar.tsx` | `apps/web/src/ui/primitives/sidebar.tsx` | `radix-scoped`, `sidebar-text-entry` |
| `apps/web/src/client/ui/primitives/skeleton.tsx` | `apps/web/src/ui/primitives/skeleton.tsx` | None |
| `apps/web/src/client/ui/primitives/table.tsx` | `apps/web/src/ui/primitives/table.tsx` | None |
| `apps/web/src/client/ui/primitives/tabs.tsx` | `apps/web/src/ui/primitives/tabs.tsx` | `radix-scoped` |
| `apps/web/src/client/ui/primitives/toggle-group.tsx` | `apps/web/src/ui/primitives/toggle-group.tsx` | `radix-scoped` |
| `apps/web/src/client/ui/primitives/toggle.tsx` | `apps/web/src/ui/primitives/toggle.tsx` | `radix-scoped` |
| `apps/web/src/client/ui/primitives/tooltip.tsx` | `apps/web/src/ui/primitives/tooltip.tsx` | `radix-scoped` |

Not vendored:

- `apps/web/src/ui/patterns/config-gate.tsx`: deck's config shell; pulse has no config gate, and the barrel drops its exports.
- `apps/web/src/styles/hljs.css`: deck's highlight.js token theme; pulse ships no syntax highlighting.
<!-- ui-drift:end mapping -->

### Divergence notes

<!-- ui-drift:begin notes (generated from VENDORED.json by `bun run ui:drift --record`; do not edit) -->
- **`radix-scoped`** (`alert-dialog.tsx`, `badge.tsx`, `breadcrumb.tsx`, `button.tsx`, `checkbox.tsx`, `collapsible.tsx`, `dialog.tsx`, `dropdown-menu.tsx`, `label.tsx`, `popover.tsx`, `scroll-area.tsx`, `select.tsx`, `separator.tsx`, `sheet.tsx`, `sidebar.tsx`, `tabs.tsx`, `toggle-group.tsx`, `toggle.tsx`, `tooltip.tsx`): Radix comes from the scoped packages, not deck's `radix-ui` umbrella: `import { Dialog as DialogPrimitive } from "radix-ui"` becomes `import * as DialogPrimitive from "@radix-ui/react-dialog"` (`Slot` becomes `import * as Slot from "@radix-ui/react-slot"`), bodies unchanged. Through the umbrella, Bun.build puts every Radix package used anywhere on the initial route; the deps are pinned to the versions `radix-ui` 1.6.7 resolves, and `tests/ui-guardrails.test.ts` forbids the umbrella. Re-apply on every sync and after `shadcn add`.
- **`dropdown-checked`** (`dropdown-menu.tsx`): `checked` is spread only when defined (`exactOptionalPropertyTypes`).
- **`button-loading`** (`button.tsx`): Pulse `loading` prop: spinner, `aria-busy`/`aria-disabled`/`data-loading`, clicks swallowed, never `disabled` so focus stays put.
- **`sidebar-text-entry`** (`sidebar.tsx`): The Ctrl/Cmd-B toggle returns early when `isTextEntryTarget(event.target)`, so the chord stays with a focused text field.
- **`style-nonce`** (`scroll-area.tsx`, `select.tsx`): The Radix `Viewport` gets `{...styleNonceProps()}` (its `nonce`; `lib/style-nonce.ts`), because it renders its own `<style>` element that the strict CSP `style-src` blocks without the response's nonce (issue #2). Re-apply on every sync, and wire any newly vendored primitive whose Radix part takes a `nonce` prop.
- **`app-css`** (`app.css`): Pulse's Tailwind entry, kept in deck's file order with deck's base rules: `source("..")` on the Tailwind import and an `@source not` for the workbench, `theme-pulse.css` instead of `hljs.css`, no `@fontsource` imports (the faces register from `styles/fonts.ts`), and pulse base rules (heading wrap, focus ring, inline monospace size, app-wide reduced motion).
- **`icons-additions`** (`icons.ts`): Pulse additions: a second `lucide-react` import block and a "pulse additions" section at the end of `ICONS` (the shell and views' icons deck lacks). The shell's icons moved to the pulse-only `icons-shell.ts` (spread into `ICONS`, which keeps its type and contents) and `FALLBACK_ICON` with them; evaluating `icons.ts` registers the set with `icon-registry.ts` (pulse-only), so it can load as a lazy chunk.
- **`components-json`** (`components.json`): `tailwind.css` points at `src/client/styles/app.css`.
- **`barrel-exports`** (`index.ts`): No `ConfigGate` exports. Adds the pulse-only exports: `FreshnessStamp`/`FreshnessState`, the `kbd`/`radio-group`/`textarea` primitives, `CommandPalette` + `commandGroupsFromIndex`, the `useDisposable` hook, `isTextEntryTarget`, `export * from "./status"` and `"./viz"`, and the DataTable virtualization exports (`DATA_TABLE_VIRTUALIZE_DEFAULTS`, `DataTableHandle`, `DataTableScrollAlign`, `DataTableVirtualizeOptions`) and the TreeView ones (`TREE_VIEW_VIRTUALIZE_DEFAULTS`, `TreeViewVirtualizeOptions`).
- **`data-table-virtualize`** (`data-table.tsx`): Pulse `virtualize` prop (`@tanstack/react-virtual`, with `observeClientRect` from the pulse-only `lib/virtual.ts`; `data-table-viewport` scroll region, spacer rows, rows measured as they render with `rowHeight` as the estimate and minimum height, `aria-rowcount`/`aria-rowindex`, focused row kept rendered by row id; hysteresis: once virtualized it stays so until rows < `floor(threshold * 0.8)`) and a `ref` handle with `scrollToIndex`; a `focusable` prop (default `true`) drops the scroll region's tab stop on a wallboard. Below the threshold and with the defaults the output is deck's.
- **`freshness-types`** (`freshness-badge.tsx`): Imports `FreshnessStamp`/`FreshnessState` from `lib/freshness.ts` (deck imports them from its server contract).
- **`console-prefix`** (`fragment-boundary.tsx`, `icon.tsx`, `page-error-boundary.tsx`): Console prefix `[deck]` becomes `[pulse]`.
- **`icon-registry`** (`icon.tsx`): Resolves names through `lib/icon-registry.ts`: shell icons eager, the rest once the lazy icon chunk loads; an empty same-size svg until then, the fallback glyph if the load fails.
- **`page-error-page-slot`** (`page-error-boundary.tsx`): Optional `pageSlot` prop: when set, the fallback renders inside a `data-slot={pageSlot} data-state="error"` root so a failed view keeps its `…-page` root and one `h1`; after Retry, focus moves to the page `h1` (or the `…-page` root) instead of dropping to `<body>`.
- **`facet-default-open`** (`facet-filter.tsx`): `defaultOpen ?? false`.
- **`segmented-key-shortcuts`** (`segmented-control.tsx`): Optional `keyShortcuts`, set as `aria-keyshortcuts` on every option (the focusable radios).
- **`disclosure-count-label`** (`disclosure.tsx`): The count pill is `aria-hidden` and the label carries a visually hidden `, N items` (optional `countLabel`), so the trigger is named "Proposals, 3 items" rather than "Proposals3".
- **`filter-bar-wrap`** (`filter-bar.tsx`): The result count's wrapper is `min-w-0`, not `shrink-0`, so a long count wraps at 320px.
- **`tree-view-description`** (`tree-view.tsx`): `renderMeta` output is the treeitem's accessible description (`aria-describedby`); an optional `aria-describedby` prop describes the tree (keyboard help).
- **`exact-optional`** (`use-show-more.ts`, `tree.ts`, `comparison-grid.tsx`, `show-more.tsx`, `status-badge.tsx`): Type-only `| undefined` widenings on optional props for `exactOptionalPropertyTypes` (`headingLevel`, `noun`, `role`, the `useShowMore` options, `TreeAccessors`).
- **`status-badge-variant`** (`status-badge.tsx`): `fromMap` applies the entry's `variant` (caller props win); `StatusBadgeVariant` is derived from `StatusPresentation["variant"]`.
- **`text-entry-guard`** (`search-input.tsx`): The `/` shortcut's guard is the shared `isTextEntryTarget` (adds contenteditable ancestors; a checkbox no longer blocks it) instead of a local `isEditable`.
- **`pulse-name`** (`use-document-title.ts`, `document-title.ts`): The app name is Pulse (`APP_TITLE = "Pulse"`; the hook's doc comment).
- **`dom-text-entry`** (`dom.ts`): Pulse `isTextEntryTarget` (text-like input, textarea, select, contenteditable; narrower than `isEditableTarget`, which also covers buttons and composite widgets).
- **`status-variant`** (`status.ts`): Optional `StatusPresentation.variant` (badge shape per state, e.g. outline for suppressed).
- **`tree-view-virtualize`** (`tree-view.tsx`): Pulse `virtualize` prop (`@tanstack/react-virtual`; at a visible-row threshold, default 300, the treeitems render flat in a `tree-view-viewport` scroll region with `aria-hidden` spacers, `aria-level`/`aria-setsize`/`aria-posinset` from the model, rows measured as they render, the focused row and the Tab stop kept rendered, keyboard moves over every visible row through `useListNavigation`'s `virtual` option; hysteresis as in `data-table.tsx`; below the threshold the output is deck's); `*` expands every sibling branch and printable keys move by label (type-ahead), both from the model; the row is `flex-wrap`, so a caller's meta can take a line of its own (`basis-full`) at narrow widths.
- **`list-navigation-virtual`** (`use-list-navigation.ts`): Optional `virtual` (`count`, `activeIndex`, `focus(index)`), so moves in a virtualized list run over every item, not only the rendered ones; optional `typeaheadActive()`, while true printable keys (j/k included) are left to the list's type-ahead.
- **`tree-row-position`** (`tree.ts`): `VisibleTreeRow` carries `posInSet`/`setSize`.
- **`stat-tile-absent`** (`stat-tile.tsx`): Optional `valueState: "absent"` (placeholder text such as "not reported" renders small and muted on the neutral tone, whatever `tone` says, so "no data" never reads as a headline number) with an optional screen-reader `absentDescription`; the root and the value carry `data-value-state`.
<!-- ui-drift:end notes -->

## Pulse-only additions

Files in the library directories that deck does not have. They follow the same conventions
(`data-slot`, `cn`, barrel export).

<!-- ui-drift:begin pulse-only (generated from VENDORED.json by `bun run ui:drift --record`; do not edit) -->
| Pulse path | Source | Notes |
|---|---|---|
| `apps/web/src/client/styles/fonts.ts` | pulse | Registers the self-hosted Geist faces (`@fontsource-variable`), which deck imports from `app.css`; importing them from CSS would make Bun inline the font files into the sheet |
| `apps/web/src/client/styles/theme-pulse.css` | pulse | Pulse's token extensions on top of deck's `theme.css` |
| `apps/web/src/client/ui/lib/freshness.ts` | pulse | `FreshnessStamp`/`FreshnessState`, which deck imports from its server contract |
| `apps/web/src/client/ui/lib/icon-registry.ts` | pulse | Name → icon registry behind `Icon`: the shell set eagerly, the rest when the lazy `icons.ts` chunk registers |
| `apps/web/src/client/ui/lib/icons-shell.ts` | pulse | The shell's icons and `FALLBACK_ICON`, split out of `icons.ts` so they stay on the initial route |
| `apps/web/src/client/ui/lib/style-nonce.ts` | pulse | `styleNonce()` / `styleNonceProps()` return the CSP style nonce (`get-nonce`, set by `main.tsx` from the shell) for primitives that render their own `<style>`; internal, not exported from the barrel |
| `apps/web/src/client/ui/lib/virtual.ts` | pulse | `observeClientRect`, shared by the virtualized `DataTable` and `TreeView` |
| `apps/web/src/client/ui/primitives/radio-group.tsx` | shadcn/ui new-york v4 `radio-group` | Built on `@radix-ui/react-radio-group` |
| `apps/web/src/client/ui/primitives/textarea.tsx` | shadcn/ui new-york v4 `textarea` | None |
| `apps/web/src/client/ui/primitives/kbd.tsx` | shadcn/ui new-york v4 `kbd` | `Kbd` and `KbdGroup` |
| `apps/web/src/client/ui/hooks/use-disposable.ts` | pulse | `useDisposable(create, dispose)`: a per-mount resource that survives StrictMode's development unmount-and-remount (recreated if it was disposed) |
| `apps/web/src/client/ui/status/` | pulse | `TARGET_STATUS`, `ALERT_SEVERITY` (+ `alertSeverityOf`), `ALERT_STATE` (+ `alertStateOf`), `MUTATION_STATE` on `defineStatusMap`; the domain → `TargetStatus` maps in `src/client/status/target-status.ts` are unchanged |
| `apps/web/src/client/ui/viz/` | pulse (port of `src/client/viz/`) | `Sparkline`, `StatusTimeline`, `Gauge`, lazy `TimeSeriesChart` (uPlot in `uplot-chart.tsx`, reached only by dynamic import). Colours from tone/chart tokens; suppressed is hatched/dashed on the neutral tone |
| `apps/web/src/client/ui/patterns/command-palette.tsx` | pulse (on the vendored `Command*` + `Dialog` primitives) | Data-driven `CommandPalette` (`groups` of items with their own `onSelect`; selecting closes) and `commandGroupsFromIndex`, which maps command-index entries (structural `CommandIndexEntry`, no shell import) to groups. Optional controlled `search`/`onSearchChange` and `shouldFilter={false}` let a caller rank and cap its own results (the shell's command index); `commandGroupsFromIndex(…, { groupOrder: "entries" })` keeps a ranked list's best match first; `returnFocusTo` names the element focus returns to on close when a caller showed another dialog first. Opening puts the caret after any text already in the search field (a caller's buffered keys) |
<!-- ui-drift:end pulse-only -->

## Upstream candidates

Pulse-only additions that could move to deck:

- `primitives/radio-group.tsx`, `primitives/textarea.tsx`, `primitives/kbd.tsx`.
- `primitives/button.tsx` `loading` state.
- `patterns/data-table.tsx` `virtualize`, the `scrollToIndex` handle and `focusable`.
- `patterns/command-palette.tsx` (`CommandPalette`, `commandGroupsFromIndex`).
- `patterns/filter-bar.tsx` `min-w-0` result count (a deck fix: the long count side-scrolls at 320px).
- `patterns/tree-view.tsx` row meta as the treeitem's description (a deck a11y fix), `virtualize`,
  `*` and type-ahead, and the `virtual`/`typeaheadActive` options of `hooks/use-list-navigation.ts`.
- `patterns/disclosure.tsx` separated count in the trigger's accessible name (a deck a11y fix).
- `patterns/status-badge.tsx` `fromMap` applying the entry's `variant`, with `StatusPresentation.variant`.
- `patterns/stat-tile.tsx` `valueState="absent"` (placeholder text never reads as a headline number).
- `patterns/page-error-boundary.tsx` `pageSlot` (the fallback keeps the page's root and `h1`) and focus to the page heading after Retry.
- `ui/viz/*` (Sparkline, StatusTimeline with its geometry helpers and a `statusMap` for any status
  vocabulary, Gauge, lazy uPlot TimeSeriesChart with `formatYTicks`/`splitYTicks`).
- `ui/lib/icons.ts` pulse additions (bell, clock, keyboard, menu, network, wifi and others).
