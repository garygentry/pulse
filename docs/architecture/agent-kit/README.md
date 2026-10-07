# agent-kit

`agent-kit` (`@pulse/agent-kit`) generates the **agent-facing guidance** Pulse ships to each
supported agent ecosystem — Claude Code, Codex, Pi, and a best-effort generic `AGENTS.md` — from
a **single authored source**. It is the package that teaches a coding agent how to operate a Pulse
estate: the inventory vocabulary, the `pulse` CLI contract, the severity taxonomy, and the runnable
skills and subagents that put those to work.

The defining property is *single-source*: every claim an agent reads is authored once as a typed
content unit and rendered from **contract-checked data slots**. Because a unit renders from typed
values rather than string templates, the drift and contract tests assert against the very objects
the content renders from — so a claim can never render one value and be tested as another. If the
inventory schema, the CLI verb set, or the severity taxonomy drifts, the build fails rather than
shipping stale guidance.

## Quick Start

agent-kit is authored, generated, and verified — you do not "run" it. The loop is: edit the source,
regenerate the committed output, commit both, verify no drift.

```bash
cd agent-kit

# 1. edit the single source (typed content units + contract-checked slots)
$EDITOR src/content/skills/estate-authoring.ts

# 2. re-render every ecosystem's files from that one source
bun run generate

# 3. commit the updated generated/** tree alongside the source change, then confirm no drift
bun run verify:generated
bun test
```

`bun run generate` walks the manifest, runs each ecosystem emitter, writes every file under
`generated/<ecosystem>/`, and regenerates `generated/guidance-pack.generated.ts` — the data module
the `pulse` CLI embeds to scaffold guidance into a consumer repo on `pulse init`.

## Key Concepts

**One authored source, many ecosystems.** Content lives once under `src/content/**` as an ordered
`Manifest` of `ContentUnit`s. Each unit declares its `kind` (`guidance` / `skill` / `subagent`),
its target ecosystems, the requirement ids it satisfies, and a `render(slots)` function that
produces ordered body sections. Every ecosystem's native files are generated from that one
manifest — never hand-maintained per ecosystem.

**Contract-checked slots, not string templates.** A unit's `render()` receives a `Slots` bundle of
three typed, contract-locked data blocks: the **inventory vocabulary** (derived from `@pulse/core`'s
Zod schema), the **CLI contract** (verb / exit-code / `--json`-shape table, asserted by driving the
real `pulse` CLI), and the **severity taxonomy** (read from `@pulse/alerting`'s published JSON
artifact). The content and its contract test read the same object, so guidance is
"contract-tested or generated", never hand-trusted.

**The generated tree is committed.** `generated/**` is checked in so the guidance pack ships exactly
the reviewed bytes. A drift check (`verify:generated`) regenerates into a temp dir and byte-compares
against the committed tree; any hand-edit or un-regenerated source change fails loud.

**First-class vs generic.** Claude Code, Codex, and Pi are the **first-class** ecosystems: the pack
scaffolds their native files and their contract/eval suites gate the build. `generic` is best-effort,
untested `AGENTS.md`-class output — emitted, but never claimed tested and never part of the scaffolded
pack.

**The pack is create-only.** Every file the pack lays into a consumer repo is `create-only`: it never
overwrites an existing target, so shipped guidance can never stomp a consumer's edits.

**Fail loud, never degrade.** A malformed unit, an unknown ecosystem target, a slot-shape mismatch,
or a secret literal in emitted content *throws* — failing `generate` / `tsc -b` / the tests. There is
no silent fallback; a broken source fails the build rather than emitting degraded guidance.

## Package Exports

`@pulse/agent-kit` has a deliberately narrow public surface (`src/index.ts`): one function and four
types. The internal content-model, emit, and slot modules are consumed by the package's own tests and
generator, not re-exported for external use.

| Export | Kind | Description |
|--------|------|-------------|
| `buildGuidancePack` | function | Assemble the `GuidancePack` the CLI scaffolds, from the committed first-class `generated/**` trees. |
| `ContentUnit` | type | One authored, ecosystem-agnostic unit of agent-facing content. |
| `Manifest` | type | The ordered set of all authored content units — the single source of truth. |
| `EmittedFile` | type | A single generated file: a repo-relative path plus its full text. |
| `Ecosystem` | type | The agent ecosystems emitted for: `"claude" \| "codex" \| "pi" \| "generic"`. |

## Configuration

agent-kit has no runtime configuration — it is a build-time generator. Its behavior is fixed by the
authored source and the four package scripts:

| Script | Purpose |
|--------|---------|
| `bun run generate` | Re-render `generated/**` (and the pack module) from `src/content/**`. |
| `bun run verify:generated` | Confirm the committed `generated/**` matches a fresh render (no drift). |
| `bun run typecheck` | `tsc -b` over the package. |
| `bun test` | Contract, drift, pack-scaffold, error-surface, and eval suites. |

## Further Reading

- [Architecture](./architecture.md) — The single-source pipeline: content model, the three
  contract-checked slots, the per-ecosystem emitters, drift verification, and the CLI init seam.
- [API Reference](./api-reference.md) — The public barrel plus the internal type surface, the slot
  builders, the error hierarchy, and the scripts.
- [Integration Guide](./guides/integration.md) — Adding content, adding an ecosystem, and how the
  `pulse` CLI consumes the pack.
