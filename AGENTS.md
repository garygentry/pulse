## Web UI conventions (apps/web)

See `docs/architecture/ui.md` for the full picture. The rules that matter most:

- Build screens from the `@/ui` library (`import { … } from "@/ui"`). Don't write one-off markup
  for things a pattern covers (tables, lists, cards, trees, filters, status, empty/loading/error).
  Entry code (`shell/`, `app.tsx`, `main.tsx`) deep-imports with a `// ui-deep-import:` comment.
- Status is a **tone** (`ok`/`warn`/`danger`/`info`/`pending`/`neutral`) mapped with
  `defineStatusMap` (`TARGET_STATUS`, `ALERT_SEVERITY`, `ALERT_STATE`, `MUTATION_STATE`), always
  shown with an icon and text. Never pick colours directly.
- Style with Tailwind token classes only: no hex/`rgb()`/`oklch()` literals, and `style={…}`
  only for dynamic geometry. Icons come from `<Icon name>` with names from `ui/lib/icons.ts`.
- A component that reads a signal's `.value` during render (directly or through a helper) calls
  `useSignals()` from `@preact/signals-react/runtime` first; a miss fails silently.
- Import Radix only from scoped `@radix-ui/react-*` packages, never the `radix-ui` umbrella.
- A page root and every pattern root carry `data-slot="…"`. There is one `h1` per page
  (`PageHeader`), and keyboard list navigation goes through `useListNavigation`.
- Test the a11y contract with React Testing Library role queries (via `tests/rtl.ts`), never
  class strings. Visual baselines are committed under `apps/web/tests/visual/` and generated and
  verified on CI Linux only. When a change moves pixels, merge main, then run
  `gh workflow run visual-update.yml --ref <branch>`. Replace the baselines with the
  `visual-baselines` artifact (`rm -rf apps/web/tests/visual/*-snapshots && gh run download <id> -n
  visual-baselines -D apps/web/tests/visual`) and commit it. Never commit locally made PNGs. While
  working, still review screenshots (375/768/1280, light and dark) under `screenshots/`.
- `apps/web/tests/ui-guardrails.test.ts` enforces the mechanical rules; keep it green instead of
  allowlisting around it.
