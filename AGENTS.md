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

## Client contract

- Changing a contract wire type (`packages/web-data/src/wire/**`, `CONTRACT_LIMITS`, `ENUM_FALLBACKS`) requires
  `bun run contract:gen`, committing all of `contract/**`, and a `CONTRACT_VERSION` bump per
  `contract/CONTRACT.md` #versioning. `contract/shape/<version>.json` is frozen once written; `bun test` gates both.

## Public-safe content

- Tracked `contract/**` and `apps/ios/**` use only the placeholders in `CONTRIBUTING.md` "Public-safe
  placeholders"; `bun test` enforces it. Run `bun run lint:public-safe` before copying `specs/ios/` to another
  machine.

<!-- rauf:agents:start -->
## Autonomous Loop (Rauf)

This repository uses **rauf**, an autonomous coding loop. When you are running as a
rauf loop iteration, follow these operational rules. They are host-agnostic — they
apply whichever coding agent (Claude, Codex, Gemini, …) drives the iteration.

### Reading Your Task
1. Read `.rauf/RAUF.md` for detailed per-iteration instructions
2. Read the backlog (`.rauf/backlog.json`) — find the current `in_progress` item
3. The item's `acceptanceCriteria` define "done" for this iteration

### Working
4. Implement the changes described in the item's description
5. Follow acceptance criteria precisely — each one must pass
6. Run the verification command before considering work complete (foreground, and wait for it to finish within this turn — never background it or defer your signal behind an async completion notification; a non-interactive session ends when you yield, so a deferred signal never arrives and the item is retried)

### Completing
7. If all acceptance criteria pass: output `RAUF_DONE` as your final line (optionally preceded by one `RAUF_SUMMARY: <≤120 chars>` line saying what you did)
8. If blocked (missing dependency, unclear requirement): output `RAUF_BLOCKED:<reason>`
9. If human input needed (API key, design decision): output `RAUF_NEEDS_HUMAN:<reason>`
10. Do NOT commit or stage — the iteration agent never commits or stages; the loop runner owns the commit. Leave your changes in the working tree.

> Output the signal on a line by itself, as your final line — that's the safest
> habit. The runner scans backwards from the end and uses the **last** signal
> line, so trailing text after it (a commit message, a summary) does **not** break
> detection.
>
> `RAUF_REVIEW:<json>` is emitted only by a review pass, not a normal work
> iteration. If you emit no recognized signal, the runner does **not** auto-block
> the item — it classifies the outcome by exit context and reconciles committed
> work.

### Rules
- ONE item per iteration — do not work on multiple items
- Do not modify `backlog.json` — the loop runner manages status
- Do not modify `state.json` — the loop runner manages state
- Read `progress.md` for accumulated project learnings
- Append new learnings to `progress.md` if you discover important patterns

### Delegation
- If a backlog item carries `agentDelegation` and your host agent provides a
  subagent/delegation mechanism, use it to parallelize the independent subtasks;
  if it does not, complete the subtasks inline in the main session.
- You (the main agent) own the `RAUF_*` exit signal — delegated subtasks do not emit it.

### Model Selection
The runner picks the model by precedence (highest wins):
`item.model` > `--model` / options > project default > provider default.
(`rauf loop run --no-model` ignores `item.model` for one run — useful for running
a backlog whose items carry Claude-only tier aliases under a non-Claude `--agent`.)
<!-- rauf:agents:end -->
