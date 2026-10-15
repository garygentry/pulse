# Vendored from deck

Files under `src/client/ui/` (and the theme stylesheets) are copied from deck's `@/ui` library,
file for file, from deck's `apps/web/src/`. Pulse keeps vendoring them rather than consuming a
shared package (issue #5). `VENDORED.json`, next to this file, is the machine-readable record. For
every vendored file it holds the deck path, the git blob id of deck's file at the pinned commit,
the blob id of pulse's copy as last reviewed, and the divergence notes that explain any
difference. `bun run ui:drift` checks the record, and `bun test` runs the same check in CI.

<!-- ui-drift:begin source (generated from VENDORED.json by `bun run ui:drift --record`; do not edit) -->
Pinned upstream: https://github.com/garygentry/deck at `209c635` (deck v0.5.0). Vendored files: 99, 27 of them with pulse divergences. Upstream files in scope that are deliberately not vendored: 6.
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
   diverged, merge deck's change and re-apply the file's notes, in particular `style-nonce` on
   primitives, which deck's shadcn flow undoes. Radix comes from the scoped `@radix-ui/react-*`
   packages in deck too (since v0.5.0); `tests/ui-guardrails.test.ts` forbids the `radix-ui`
   umbrella. Vendor or exclude the files deck
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
| `apps/web/src/client/styles/tailwind-theme.css` | `packages/sdk/tailwind/theme.css` | None |
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
| `apps/web/src/client/ui/lib/status.ts` | `apps/web/src/ui/lib/status.ts` | None |
| `apps/web/src/client/ui/lib/tone.ts` | `apps/web/src/ui/lib/tone.ts` | None |
| `apps/web/src/client/ui/lib/tree.ts` | `apps/web/src/ui/lib/tree.ts` | `exact-optional`, `tree-row-position` |
| `apps/web/src/client/ui/lib/utils.ts` | `apps/web/src/ui/lib/utils.ts` | None |
| `apps/web/src/client/ui/lib/virtual.ts` | `apps/web/src/ui/lib/virtual.ts` | None |
| `apps/web/src/client/ui/patterns/active-filters.tsx` | `apps/web/src/ui/patterns/active-filters.tsx` | None |
| `apps/web/src/client/ui/patterns/callout.tsx` | `apps/web/src/ui/patterns/callout.tsx` | None |
| `apps/web/src/client/ui/patterns/card-grid.tsx` | `apps/web/src/ui/patterns/card-grid.tsx` | None |
| `apps/web/src/client/ui/patterns/code-block.tsx` | `apps/web/src/ui/patterns/code-block.tsx` | None |
| `apps/web/src/client/ui/patterns/command-palette.tsx` | `apps/web/src/ui/patterns/command-palette.tsx` | `exact-optional` |
| `apps/web/src/client/ui/patterns/comparison-grid.tsx` | `apps/web/src/ui/patterns/comparison-grid.tsx` | `exact-optional` |
| `apps/web/src/client/ui/patterns/data-table.tsx` | `apps/web/src/ui/patterns/data-table.tsx` | None |
| `apps/web/src/client/ui/patterns/disclosure.tsx` | `apps/web/src/ui/patterns/disclosure.tsx` | None |
| `apps/web/src/client/ui/patterns/empty-state.tsx` | `apps/web/src/ui/patterns/empty-state.tsx` | None |
| `apps/web/src/client/ui/patterns/error-state.tsx` | `apps/web/src/ui/patterns/error-state.tsx` | None |
| `apps/web/src/client/ui/patterns/external-link.tsx` | `apps/web/src/ui/patterns/external-link.tsx` | None |
| `apps/web/src/client/ui/patterns/facet-filter.tsx` | `apps/web/src/ui/patterns/facet-filter.tsx` | `facet-default-open` |
| `apps/web/src/client/ui/patterns/filter-bar.tsx` | `apps/web/src/ui/patterns/filter-bar.tsx` | None |
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
| `apps/web/src/client/ui/patterns/page-error-boundary.tsx` | `apps/web/src/ui/patterns/page-error-boundary.tsx` | `console-prefix` |
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
| `apps/web/src/client/ui/patterns/status-badge.tsx` | `apps/web/src/ui/patterns/status-badge.tsx` | `exact-optional` |
| `apps/web/src/client/ui/patterns/tree-view.tsx` | `apps/web/src/ui/patterns/tree-view.tsx` | `tree-view-virtualize` |
| `apps/web/src/client/ui/patterns/visually-hidden.tsx` | `apps/web/src/ui/patterns/visually-hidden.tsx` | None |
| `apps/web/src/client/ui/primitives/alert-dialog.tsx` | `apps/web/src/ui/primitives/alert-dialog.tsx` | None |
| `apps/web/src/client/ui/primitives/alert.tsx` | `apps/web/src/ui/primitives/alert.tsx` | None |
| `apps/web/src/client/ui/primitives/badge.tsx` | `apps/web/src/ui/primitives/badge.tsx` | None |
| `apps/web/src/client/ui/primitives/breadcrumb.tsx` | `apps/web/src/ui/primitives/breadcrumb.tsx` | None |
| `apps/web/src/client/ui/primitives/button.tsx` | `apps/web/src/ui/primitives/button.tsx` | None |
| `apps/web/src/client/ui/primitives/card.tsx` | `apps/web/src/ui/primitives/card.tsx` | None |
| `apps/web/src/client/ui/primitives/checkbox.tsx` | `apps/web/src/ui/primitives/checkbox.tsx` | None |
| `apps/web/src/client/ui/primitives/collapsible.tsx` | `apps/web/src/ui/primitives/collapsible.tsx` | None |
| `apps/web/src/client/ui/primitives/command.tsx` | `apps/web/src/ui/primitives/command.tsx` | None |
| `apps/web/src/client/ui/primitives/dialog.tsx` | `apps/web/src/ui/primitives/dialog.tsx` | None |
| `apps/web/src/client/ui/primitives/dropdown-menu.tsx` | `apps/web/src/ui/primitives/dropdown-menu.tsx` | `dropdown-checked` |
| `apps/web/src/client/ui/primitives/input.tsx` | `apps/web/src/ui/primitives/input.tsx` | None |
| `apps/web/src/client/ui/primitives/kbd.tsx` | `apps/web/src/ui/primitives/kbd.tsx` | None |
| `apps/web/src/client/ui/primitives/label.tsx` | `apps/web/src/ui/primitives/label.tsx` | None |
| `apps/web/src/client/ui/primitives/popover.tsx` | `apps/web/src/ui/primitives/popover.tsx` | None |
| `apps/web/src/client/ui/primitives/radio-group.tsx` | `apps/web/src/ui/primitives/radio-group.tsx` | None |
| `apps/web/src/client/ui/primitives/scroll-area.tsx` | `apps/web/src/ui/primitives/scroll-area.tsx` | `style-nonce` |
| `apps/web/src/client/ui/primitives/select.tsx` | `apps/web/src/ui/primitives/select.tsx` | `style-nonce` |
| `apps/web/src/client/ui/primitives/separator.tsx` | `apps/web/src/ui/primitives/separator.tsx` | None |
| `apps/web/src/client/ui/primitives/sheet.tsx` | `apps/web/src/ui/primitives/sheet.tsx` | None |
| `apps/web/src/client/ui/primitives/sidebar.tsx` | `apps/web/src/ui/primitives/sidebar.tsx` | `sidebar-text-entry` |
| `apps/web/src/client/ui/primitives/skeleton.tsx` | `apps/web/src/ui/primitives/skeleton.tsx` | None |
| `apps/web/src/client/ui/primitives/table.tsx` | `apps/web/src/ui/primitives/table.tsx` | None |
| `apps/web/src/client/ui/primitives/tabs.tsx` | `apps/web/src/ui/primitives/tabs.tsx` | None |
| `apps/web/src/client/ui/primitives/textarea.tsx` | `apps/web/src/ui/primitives/textarea.tsx` | None |
| `apps/web/src/client/ui/primitives/toggle-group.tsx` | `apps/web/src/ui/primitives/toggle-group.tsx` | None |
| `apps/web/src/client/ui/primitives/toggle.tsx` | `apps/web/src/ui/primitives/toggle.tsx` | None |
| `apps/web/src/client/ui/primitives/tooltip.tsx` | `apps/web/src/ui/primitives/tooltip.tsx` | None |
| `apps/web/src/client/ui/viz/gauge.tsx` | `apps/web/src/ui/viz/gauge.tsx` | None |
| `apps/web/src/client/ui/viz/geometry.ts` | `apps/web/src/ui/viz/geometry.ts` | None |
| `apps/web/src/client/ui/viz/sparkline.tsx` | `apps/web/src/ui/viz/sparkline.tsx` | None |
| `apps/web/src/client/ui/viz/status-marks.ts` | `apps/web/src/ui/viz/status-marks.ts` | None |
| `apps/web/src/client/ui/viz/status-timeline.tsx` | `apps/web/src/ui/viz/status-timeline.tsx` | None |

Not vendored:

- `apps/web/src/ui/patterns/config-gate.tsx`: deck's config shell; pulse has no config gate, and the barrel drops its exports.
- `apps/web/src/styles/hljs.css`: deck's highlight.js token theme; pulse ships no syntax highlighting.
- `apps/web/src/ui/lib/contributed-icons.ts`: deck's runtime-module SVG icons; pulse has no runtime modules, and `Icon` resolves through pulse's icon registry.
- `apps/web/src/ui/lib/highlight.ts`: deck's highlight.js setup for its markdown renderer; pulse ships no syntax highlighting.
- `apps/web/src/ui/lib/markdown.ts`: deck's markdown renderer (markdown-it + DOMPurify); pulse renders no markdown.
- `apps/web/src/ui/lib/markdown-it-task-lists.d.ts`: types for deck's markdown renderer, which pulse does not vendor.
<!-- ui-drift:end mapping -->

### Divergence notes

<!-- ui-drift:begin notes (generated from VENDORED.json by `bun run ui:drift --record`; do not edit) -->
- **`dropdown-checked`** (`dropdown-menu.tsx`): `checked` is spread only when defined (`exactOptionalPropertyTypes`).
- **`sidebar-text-entry`** (`sidebar.tsx`): The Ctrl/Cmd-B toggle returns early when `isTextEntryTarget(event.target)`, so the chord stays with a focused text field.
- **`style-nonce`** (`scroll-area.tsx`, `select.tsx`): The Radix `Viewport` gets `{...styleNonceProps()}` (its `nonce`; `lib/style-nonce.ts`), because it renders its own `<style>` element that the strict CSP `style-src` blocks without the response's nonce (issue #2). Re-apply on every sync, and wire any newly vendored primitive whose Radix part takes a `nonce` prop.
- **`app-css`** (`app.css`): Pulse's Tailwind entry, kept in deck's file order with deck's base rules: `source("..")` on the Tailwind import and an `@source not` for the workbench (no `@source` for deck's runtime modules, which pulse does not have), `theme-pulse.css` instead of `hljs.css`, the token utilities from the vendored `tailwind-theme.css` (deck imports `@deck/sdk/tailwind/theme.css`), no `@fontsource` imports (the faces register from `styles/fonts.ts`), and pulse base rules (heading wrap, focus ring, inline monospace size, app-wide reduced motion).
- **`icons-additions`** (`icons.ts`): Pulse additions: a second `lucide-react` import block and a "pulse additions" section at the end of `ICONS` (the shell and views' icons deck lacks). The shell's icons moved to the pulse-only `icons-shell.ts` (spread into `ICONS`, which keeps its type and contents) and `FALLBACK_ICON` with them; evaluating `icons.ts` registers the set with `icon-registry.ts` (pulse-only), so it can load as a lazy chunk.
- **`components-json`** (`components.json`): `tailwind.css` points at `src/client/styles/app.css`.
- **`barrel-exports`** (`index.ts`): No `ConfigGate` or contributed-icon exports (`contributed-icons.ts` is not vendored). Adds the pulse-only exports: `FreshnessStamp`/`FreshnessState`, `commandGroupsFromIndex` (+ `CommandGroupsOptions`, `CommandIndexEntry`, from the pulse-only `lib/command-groups.ts`), the `useDisposable` hook, `isTextEntryTarget`, `export * from "./status"`, the StatusTimeline layout helpers (`timelineHeight`, `timelineSegmentRect`, `TimelineLayoutOpts`, `TimelineRect`) for the timeline view's decorations, the pulse-only `TimeSeriesChart` (+ its types), the pulse-only `ScrollRegion` (+ `ScrollRegionProps`), and the TreeView virtualization exports (`TREE_VIEW_VIRTUALIZE_DEFAULTS`, `TreeViewVirtualizeOptions`).
- **`freshness-types`** (`freshness-badge.tsx`): Imports `FreshnessStamp`/`FreshnessState` from `lib/freshness.ts` (deck imports them from its server contract).
- **`console-prefix`** (`fragment-boundary.tsx`, `icon.tsx`, `page-error-boundary.tsx`): Console prefix `[deck]` becomes `[pulse]`.
- **`icon-registry`** (`icon.tsx`): Resolves names through `lib/icon-registry.ts`: shell icons eager, the rest once the lazy icon chunk loads; an empty same-size svg until then, the fallback glyph if the load fails. Deck's module-contributed SVG icons (`contributed-icons.ts`, v0.5.0) are not taken: pulse has no runtime modules.
- **`facet-default-open`** (`facet-filter.tsx`): `defaultOpen ?? false`.
- **`segmented-key-shortcuts`** (`segmented-control.tsx`): Optional `keyShortcuts`, set as `aria-keyshortcuts` on every option (the focusable radios).
- **`exact-optional`** (`use-show-more.ts`, `tree.ts`, `command-palette.tsx`, `comparison-grid.tsx`, `show-more.tsx`, `status-badge.tsx`): Type-only `| undefined` widenings on optional props for `exactOptionalPropertyTypes` (`headingLevel`, `noun`, `role` and `variant`, the `useShowMore` options, `TreeAccessors`, `CommandPalette`'s `search`/`onSearchChange`).
- **`text-entry-guard`** (`search-input.tsx`): The `/` shortcut's guard is the shared `isTextEntryTarget` (adds contenteditable ancestors; a checkbox no longer blocks it) instead of a local `isEditable`.
- **`pulse-name`** (`use-document-title.ts`, `document-title.ts`): The app name is Pulse (`APP_TITLE = "Pulse"`; the hook's doc comment).
- **`dom-text-entry`** (`dom.ts`): Pulse `isTextEntryTarget` (text-like input, textarea, select, contenteditable; narrower than `isEditableTarget`, which also covers buttons and composite widgets).
- **`tree-view-virtualize`** (`tree-view.tsx`): Pulse `virtualize` prop (`@tanstack/react-virtual`; at a visible-row threshold, default 300, the treeitems render flat in a `tree-view-viewport` scroll region with `aria-hidden` spacers, `aria-level`/`aria-setsize`/`aria-posinset` from the model, rows measured as they render, the focused row and the Tab stop kept rendered, keyboard moves over every visible row through `useListNavigation`'s `virtual` option; hysteresis as in deck's `data-table.tsx`; below the threshold the output is deck's); `*` expands every sibling branch and printable keys move by label (type-ahead), both from the model; the row is `flex-wrap` and the meta wrapper is `contents` (deck: `inline-flex min-w-0`), so a caller's meta can take a line of its own (`basis-full`) at narrow widths.
- **`list-navigation-virtual`** (`use-list-navigation.ts`): Optional `virtual` (`count`, `activeIndex`, `focus(index)`), so moves in a virtualized list run over every item, not only the rendered ones (deck's `focusEdge` covers only Home/End); optional `typeaheadActive()`, while true printable keys (j/k included) are left to the list's type-ahead.
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
| `apps/web/src/client/ui/hooks/use-disposable.ts` | pulse | `useDisposable(create, dispose)`: a per-mount resource that survives StrictMode's development unmount-and-remount (recreated if it was disposed) |
| `apps/web/src/client/ui/status/` | pulse | `TARGET_STATUS`, `ALERT_SEVERITY` (+ `alertSeverityOf`), `ALERT_STATE` (+ `alertStateOf`), `ALERT_INTERVAL` (+ `alertIntervalStatusOf`), `MUTATION_STATE` on `defineStatusMap`; the domain → `TargetStatus` maps in `src/client/status/target-status.ts` are unchanged |
| `apps/web/src/client/ui/viz/time-series-chart.tsx` | pulse | Lazy `TimeSeriesChart` (a Suspense wrapper; `status` takes a status-map entry, like the vendored charts). Colours from tone/chart tokens |
| `apps/web/src/client/ui/viz/uplot-chart.tsx` | pulse | The uPlot implementation behind `TimeSeriesChart`, reached only by dynamic import; a status series strokes with `--status-{tone}-fg`, dashed for an outline entry |
| `apps/web/src/client/ui/lib/command-groups.ts` | pulse | `commandGroupsFromIndex`: maps command-index entries (structural `CommandIndexEntry`, no shell import) to `CommandPalette` groups keyed by kind; `{ groupOrder: "entries" }` keeps a ranked list's best match first |
| `apps/web/src/client/ui/patterns/scroll-region.tsx` | pulse | `ScrollRegion`: a horizontal scroller for fixed-width content (a StatusTimeline in a narrow pane) that is a labelled, focusable region (`tabIndex=0`) only while its content overflows; `data-slot="scroll-region"` |
<!-- ui-drift:end pulse-only -->

## Upstream candidates

Pulse-only additions that could move to deck. The earlier list (the radio-group, textarea and kbd
primitives, Button `loading`, DataTable `virtualize`, `CommandPalette`, the FilterBar, Disclosure,
StatusBadge, TreeView-description and PageErrorBoundary fixes, and the SVG viz) went upstream in
deck v0.5.0 and is vendored from there since the sync to it (issue #18).

- `patterns/tree-view.tsx` `virtualize`, `*` and type-ahead, the wrapping row, and the
  `virtual`/`typeaheadActive` options of `hooks/use-list-navigation.ts`.
- `patterns/stat-tile.tsx` `valueState="absent"` (placeholder text never reads as a headline number).
- `lib/dom.ts` `isTextEntryTarget`, used by `SearchInput`'s `/` and the sidebar's Ctrl/Cmd-B.
- The lazy uPlot `TimeSeriesChart` (`viz/time-series-chart.tsx`, `viz/uplot-chart.tsx`).
- `ui/lib/icons.ts` pulse additions (bell, clock, keyboard, menu, network, wifi and others).
