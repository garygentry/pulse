# ADR-0001: React 19, Tailwind CSS v4 and a vendored shadcn/ui library for the web UI

- Status: accepted
- Date: 2026-10-02

## Context

The first version of the web client was built on Preact with `@preact/signals` and about 2,750
lines of hand-written CSS: a global reset, a token sheet, a small shared kit (Panel, Card, Table,
StatusChip, Drawer, Dialog and others) and one stylesheet per view. It worked, but each view
re-solved the same problems: overlays with a hand-rolled focus trap, status shown through unicode
glyphs and per-view colour choices, and native controls styled one view at a time. The views
looked inconsistent with each other and with deck, the sibling operator UI.

Deck had already replaced a similar setup with React 19, Tailwind CSS v4 and shadcn/ui, and built
a finished component library (`@/ui`) with its accessibility and status conventions, guardrail
tests and a component workbench. The goal for Pulse was to look, behave and be built like deck,
without changing its data flow, server, live-state machine, mutation semantics or routing.

## Decision

Move the client to **React 19**, style it with **Tailwind CSS v4**, and **vendor deck's `@/ui`
library** and `theme.css` file for file, pinned to a recorded deck commit
(`apps/web/src/client/ui/VENDORED.md`). Pulse-only components (data-table virtualization, the
command palette, the status maps, the viz components and a few primitives) live in the same
directories and are listed as candidates to move upstream.

Pulse-specific choices on top of deck's:

- **Keep `Bun.build`.** Tailwind is integrated with `bun-plugin-tailwind`. The existing manifest,
  chunk CSS loading, dev rebuild loop and budget tests stay.
- **Keep the store on signals.** The store moves to `@preact/signals-core`, and components read
  it through `@preact/signals-react` with an explicit `useSignals()` call, enforced by a
  guardrail test. This kept the existing per-cell update granularity without rewriting the store.
- **Keep Pulse's router** behind deck-shaped `useLocation()` and `useRoute()` hooks.
- **Keep the viz bespoke** (sparklines, status timelines, gauges, lazy uPlot charts), restyled
  with theme tokens.
- **Test with `bun test`, happy-dom and React Testing Library**, plus the existing headless
  Chromium suites (axe, grayscale, reflow, contrast, performance).

## Alternatives considered

- **Stay on Preact** (with `preact/compat` for shadcn and Radix). Rejected: shadcn and Radix are
  React-first, `preact/compat` has known rough edges with portals, refs and focus, and running a
  different framework from deck would block sharing the library.
- **Move to Vite**, as deck uses. Rejected for now: `Bun.build` already carries the manifest, chunk
  CSS and dev-loop contracts, and the Tailwind plugin integrates cleanly. Revisit only if the
  build becomes a bottleneck.
- **Extract `@/ui` into a shared package** used by both deck and Pulse. Deferred: vendoring was
  faster and keeps the trees in parity, so a later extraction is mechanical.
- **Committed visual regression baselines**, as deck verifies in CI. Deferred: Pulse has no
  `@playwright/test`, and deck's CI-only baseline machinery would be new infrastructure. Changed
  views are reviewed through local screenshots at three widths in both themes instead, and the axe,
  grayscale, reflow and contrast suites remain the automated gate.
- **A `useSyncExternalStore` hook per signal** instead of `@preact/signals-react`. Held as a
  fallback; not needed once a spike showed `useSignals()` works under React 19 and `Bun.build`.

## Consequences

- Every view shares one look and one set of behaviours with deck. A fix in a pattern reaches every
  view that uses it, and a deck fix can be synced across.
- Status is always a tone with an icon and text. Colours come only from theme tokens, and contrast
  is tested in both themes.
- Guardrail tests enforce the conventions: barrel imports, scoped Radix imports, no colour
  literals, allowlisted inline styles, `data-slot` roots, no legacy tokens and the `useSignals()`
  rule.
- The JavaScript budget grew: React is a fixed cost that Preact was not. The budget ceilings were
  re-baselined as recorded decisions, and lazy loading keeps uPlot, TanStack Table, mutation
  dialogs and the palette off the initial route.
- `Bun.build` needs care that Vite would not: entry code imports library modules by path, the
  package declares `"sideEffects"` so the barrel tree-shakes, and Radix must come from scoped
  packages.
- A missed `useSignals()` call fails silently, which is why it is enforced by a test rather than
  by review.
- Vendored files must be synced by hand, re-applying the divergences listed in `VENDORED.md`.

See [Web UI: stack, component library, and conventions](../ui.md) for how the stack is used.
