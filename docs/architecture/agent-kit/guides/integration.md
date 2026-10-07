# Integration Guide

This guide is for two audiences: **content authors** evolving the guidance Pulse ships to agents, and
**CLI/build maintainers** wiring the guidance pack into the `pulse` binary. agent-kit is a build-time
generator — you extend its single source and regenerate; you do not run it in production.

## The authoring loop

Everything flows from one source. The invariant is: source and `generated/**` are always committed
together and always in sync.

```bash
cd agent-kit
$EDITOR src/content/...          # 1. edit the typed source
bun run generate                 # 2. re-render every ecosystem + the pack module
bun run verify:generated         # 3. confirm no drift (source ⇄ generated)
bun test                         # 4. confirm the contract/eval suites stay green
git add src generated            # 5. commit source AND generated together
```

Skipping step 2 or 5 fails `generated-drift.test.ts` in CI: the committed tree would no longer match a
fresh render.

## Adding or editing content

Content units live under `src/content/{guidance,skills,subagents}/`. A unit is a plain typed object —
no template, no per-ecosystem file.

1. **Create the unit.** Add `src/content/<kind>/<id>.ts` exporting a `ContentUnit`. Set a stable
   kebab-case `id` (it becomes the file stem), the `kind`, `frontmatter` (`name` / `description`, plus
   `argumentHint` for a runnable skill), `targets: [...FIRST_CLASS_ECOSYSTEMS]`, the `requirements` ids
   it satisfies, and a `render(slots)` returning ordered `Section[]`.
2. **Render from slots, never hard-code contract facts.** If you teach a collection class, a CLI exit
   code, a schema section, or a severity, read it from `slots.inventoryVocab` / `slots.cliContract` /
   `slots.severity` — never a string literal. This is what keeps the claim contract-tested. (See the
   existing `vocab-primer`, `estate-authoring`, and `alert-triage` units for the pattern.)
3. **Register it** in `src/content/manifest.ts`'s `UNITS` array, in the right group and position
   (guidance → skills → subagents; order within a group is significant and fixes generated iteration
   order).
4. **Use only reference secret grammar.** Any credential in a code example must be a `${ENV}` or
   `op://` reference — a literal fails the secret-lint at generation time.
5. `bun run generate && bun test`.

Requirement ids in `requirements[]` are validated against `REQ_ID_RE` and checked by
`requirements-coverage.test.ts` against the committed `KNOWN_REQ_IDS` mirror — an invented or typo'd id
fails. That guard checks *traceability*, not that your prose satisfies the requirement; the contract
locks and the eval harness cover behavior.

## Adding an ecosystem

Adding a fourth-and-beyond ecosystem is **additive by construction** — the type system forces every
step:

1. Extend the `Ecosystem` union in `src/emit/types.ts` (and `ECOSYSTEMS`; add to
   `FIRST_CLASS_ECOSYSTEMS` only if it will be tested + packed).
2. Add `src/emit/<eco>.ts` exporting an `Emitter` — route by `ContentKind`, reuse `renderSections`
   and (for runnable ecosystems) `renderFrontmatter`, stamp the generated banner, and throw
   `ContentValidationError` on an empty body.
3. Register it in `EMITTERS` (`src/emit/registry.ts`). The `Record<Ecosystem, Emitter>` type makes
   this a **compile error** until you do — no silent gap.
4. Widen each unit's `targets` to include it (v1's `loadManifest()` requires `targets` to equal the
   first-class set; adjust that invariant deliberately if the new ecosystem is first-class).
5. `bun run generate` and commit the new `generated/<eco>/**` tree.

## How the `pulse` CLI consumes the pack

The pack is a **declarative value**, decoupled from the CLI at the committed-source level.

- **The contract type** is `GuidancePack` from `@pulse/renderer`
  (`packages/renderer/src/init-seam.ts`): a stable `id` and a list of `GuidancePackFile`s, each
  `{ source, target, merge: "create-only" }`.
- **The committed data module** is `generated/guidance-pack.generated.ts`, exporting `GUIDANCE_PACK`
  and `PACK_BYTES` (each `source` → its literal contents). Both are produced by `bun run generate`.
- **At release build**, `apps/cli/scripts/build-bin.ts` rewrites `apps/cli/src/commands/init.ts` so
  `BUNDLED_GUIDANCE_PACK = GUIDANCE_PACK` and `readPackSource(source)` returns `PACK_BYTES[source]`,
  importing both from `agent-kit/generated/guidance-pack.generated.js` via a **relative** specifier.
- **At `pulse init`**, the CLI lays every pack file into the consumer repo **after** the base
  scaffold, create-only: an existing target is never overwritten — a collision is reported via
  `InitData.wouldClobber` (exit 1) unless `--force`. With no pack bundled, `init` still emits the base
  scaffold and succeeds.

**The dependency-graph rule that must hold:** the committed graph has only `agent-kit → @pulse/cli`
(agent-kit's CLI-contract slot drives the real CLI in tests). The reverse `apps/cli → agent-kit` edge
exists **only** transiently, in the rewritten source, during a release build — the relative import
specifier is deliberate so no `@pulse/agent-kit` entry is added to the CLI's `package.json`. Do not add
that dependency to keep the graph acyclic.

## When to use agent-kit

- You are **adding or changing agent-facing guidance** — a new skill, a new subagent, a vocabulary or
  workflow update an agent operating a Pulse estate should read.
- An **upstream contract moved** (the inventory schema, the CLI verb/exit surface, or the severity
  taxonomy) and a slot's contract lock is now failing: update the slot (and, if needed, the authored
  summary prose), regenerate, and let the lock re-pass.
- You are **wiring the pack into the CLI release** or adding a new agent ecosystem.

## When NOT to use agent-kit

- **Don't hand-edit anything under `generated/**`.** It is generated output; a hand-edit fails the
  drift check. Change the source and regenerate.
- **Don't hard-code a contract fact in content prose.** Collection classes, CLI exit codes, schema
  sections, and severities come from the slots — a literal defeats the contract lock and can ship
  stale.
- **Don't put a secret literal in an example.** Teach `${ENV}` / `op://` references only; a literal
  fails the secret-lint at generation time.
- **Don't add `@pulse/agent-kit` to `apps/cli/package.json`.** The release wire-in is a relative,
  transient edge on purpose; a committed dependency would make the graph cyclic.
- **Don't treat the `generic` output or the Pi mapping as tested.** `generic` is best-effort and
  excluded from the pack; the Pi emitter's concrete paths/keys are the OT-01 provisional mapping,
  unconfirmed against a live Pi runtime. Claude Code is the reference ecosystem (the live eval gate);
  Codex and Pi are smoke-checked for presence and well-formedness.
