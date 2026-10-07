# @pulse/agent-kit

Generates the agent-facing guidance that Pulse ships to each supported agent ecosystem
(Claude Code, Codex, Pi, and a best-effort generic `AGENTS.md`) from a single authored source.

## Single-source model

Content is authored **once** as typed content units under `src/content/**` and rendered from
contract-checked data slots (`src/slots/**`). The per-ecosystem emitters (`src/emit/**`) transform
that one manifest into each ecosystem's native files. Because the units render from typed slots
rather than string templates, the drift/contract tests assert against the same objects the content
renders from — a claim can never render one value and be tested as another.

The rendered output is **committed** under `generated/**` so the guidance pack ships exactly the
reviewed bytes; `generated/guidance-pack.generated.ts` embeds the pack the CLI's `init` scaffolds.

## Workflow

Author in `src/content/**` → regenerate → commit `generated/**` → verify. The four scripts:

| Script | Purpose |
| --- | --- |
| `bun run generate` | Re-render `generated/**` from `src/content/**`. |
| `bun run verify:generated` | Confirm the committed `generated/**` matches a fresh render (no drift). |
| `bun run typecheck` | `tsc -b` over the package. |
| `bun test` | Run the contract, drift, pack-scaffold, error-surface, and eval suites. |

After any content or emitter change, run `bun run generate`, commit the updated `generated/**`
tree alongside the source change, and confirm `bun test` stays green.
