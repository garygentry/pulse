# API Reference

agent-kit's *public* API is one function and four types (`src/index.ts`). The rest of this reference
documents the **internal** surface — the content-model, slot, emitter, and error modules — because
those are the contracts a content author or maintainer works against when extending the package. Every
signature below is from the package source; internal surfaces are labeled as such and are not
re-exported from the barrel.

## Public barrel (`@pulse/agent-kit`)

```typescript
export type { ContentUnit, Manifest, EmittedFile, Ecosystem } from "./emit/types.js";
export { buildGuidancePack } from "./emit/pack.js";
```

### `buildGuidancePack(root?): Promise<GuidancePack>`

Assemble the guidance pack the CLI scaffolds, from the committed **first-class** `generated/**` trees.
Every entry is `create-only`. Reads the committed tree — never re-emits.

```typescript
export async function buildGuidancePack(root?: string): Promise<GuidancePack>;
```

**Parameters:**
- `root` (`string`, optional) — the generated root. Defaults to `agent-kit/generated`.

**Returns:** `GuidancePack` (from `@pulse/renderer`) — `{ id: "agent-kit", files: GuidancePackFile[] }`,
each file `{ source, target, merge: "create-only" }`, where `source` is the pack-internal
`<ecosystem>/<path>` key and `target` is the same relative destination in the consumer repo. Order is
stable: first-class ecosystem order, then sorted paths within each.

## Enumerations and constants

From `src/emit/types.ts`:

```typescript
export type Ecosystem   = "claude" | "codex" | "pi" | "generic";
export type ContentKind = "guidance" | "skill" | "subagent";
export type PulseVerb   = "init" | "render" | "validate" | "coverage";

export const ECOSYSTEMS: readonly Ecosystem[]            = ["claude", "codex", "pi", "generic"];
export const FIRST_CLASS_ECOSYSTEMS: readonly Ecosystem[] = ["claude", "codex", "pi"];
export const CREATE_ONLY = "create-only";
export const REQ_ID_RE   = /^REQ-[A-Z0-9]+-\d{2}$/;   // requirement-id grammar
```

`ECOSYSTEMS` order fixes generated-directory iteration order (determinism). `FIRST_CLASS_ECOSYSTEMS`
is the tested set the pack ships; `generic` is excluded. `REQ_ID_RE` validates each
`ContentUnit.requirements` entry.

## Content model *(internal — `src/emit/types.ts`)*

### `ContentUnit`

```typescript
export interface ContentUnit {
  id: string;                          // stable kebab-case; also the generated file stem
  kind: ContentKind;                   // routing + whether frontmatter is runnable
  frontmatter: ContentFrontmatter;
  targets: Ecosystem[];                // must equal the first-class set in v1
  requirements: string[];              // validated REQ_ID_RE; covered by tests
  render(slots: Slots): Section[];     // ordered body from typed slots
}
```

### `ContentFrontmatter`, `Section`, `CodeBlock`

```typescript
export interface ContentFrontmatter {
  name: string;             // becomes the skill `name`
  description: string;      // one-line skill-listing description
  argumentHint?: string;    // Claude: `argument-hint`; runnable skills only
}

export interface Section {
  heading: string;          // markdown heading text (no leading `#`)
  level?: 2 | 3;            // heading depth; default 2
  text: string;             // body prose (may be empty when code-only)
  code?: CodeBlock[];       // fenced blocks appended after `text`, in order
}

export interface CodeBlock {
  lang: string;             // fence tag, e.g. "yaml"; "" = no tag
  body: string;             // literal contents (no fences)
}
```

### `Manifest`

```typescript
export interface Manifest { units: ContentUnit[]; }   // stable authored order
```

`loadManifest()` (`src/content/manifest.ts`) assembles the units and throws `ContentValidationError`
if any unit's `targets` is not exactly the first-class set. `manifest` is the loaded singleton.

## Emit model *(internal — `src/emit/types.ts`)*

```typescript
export interface EmittedFile {
  path: string;       // relative to generated/<ecosystem>/; repo-relative, non-escaping
  contents: string;   // full file text; `\n` lines only, no clock/host/PID content
}

export interface Emitter {
  ecosystem: Ecosystem;
  emit(manifest: Manifest, slots: Slots): EmittedFile[];   // pure, deterministic
}
```

### Registry — `src/emit/registry.ts`

```typescript
export const EMITTERS: Record<Ecosystem, Emitter>;         // claude, codex, pi, generic
export function emitterFor(ecosystem: Ecosystem): Emitter; // throws UnknownEcosystemError
```

The four emitters (`claudeEmitter`, `codexEmitter`, `piEmitter`, `genericEmitter`) are exported from
their respective `src/emit/<eco>.ts` modules. See
[Architecture → The emitter registry](./architecture.md#the-emitter-registry) for each layout.

### Composition helpers

```typescript
// src/emit/markdown.ts
export function renderSection(section: Section): string;
export function renderSections(sections: readonly Section[]): string;

// src/emit/frontmatter.ts — fixed key order: name, description, then optional argument-hint
export function renderFrontmatter(fm: ContentFrontmatter): string;
```

## Slots *(internal — `src/emit/types.ts` + `src/slots/**`)*

### The `Slots` bundle

```typescript
export interface Slots {
  inventoryVocab: InventoryVocab;      // §4.1 — locked to @pulse/core schema
  cliContract: CliContract;            // §4.2 — locked to the real pulse CLI
  severity: readonly SeverityDef[];    // §4.3 — locked to @pulse/alerting JSON
}

// src/slots/index.ts
export function buildSlots(): Slots;   // pure; assembles the three blocks
```

### `InventoryVocab` — `src/slots/inventory-vocab.ts`

```typescript
export interface VocabSection { key: string; required: boolean; summary: string; }
export interface InventoryVocab {
  schemaMajor: number;                       // == CURRENT_SCHEMA_MAJOR
  sections: readonly VocabSection[];         // schema-declared order
  collectionClasses: readonly string[];      // host union literals, sorted
}

export function buildInventoryVocab(summaries: Readonly<Record<string,string>>): InventoryVocab;
export function collectionClasses(): string[];   // throws SlotMismatchError on shape change
export function sectionKeys(): string[];
export const VOCAB_SUMMARIES: Readonly<Record<string, string>>;   // authored per-section prose
```

### `CliContract` — `src/slots/cli-contract.ts`

```typescript
export interface CliExitCase { code: 0 | 1 | 2; condition: string; }
export interface CliVerb {
  name: PulseVerb;
  summary: string;
  exitCodes: readonly CliExitCase[];
  dataFields: readonly string[];             // --json `data` field names
}
export interface CliContract {
  verbs: readonly CliVerb[];                 // verbs.map(v => v.name) == real CLI verb set
  envelopeFields: readonly string[];         // ["ok","exitCode","command","findings","data","meta"]
}

export const CLI_CONTRACT: CliContract;      // the authored table; asserted by driving the real CLI
```

### Severity — `src/slots/severity.ts`

```typescript
export type Severity      = "critical" | "warning" | "info";   // deadman is NOT a severity
export type WebhookMirror = "always" | "if-selected" | "never";

export interface SeverityDef {
  readonly name: Severity;
  readonly response: string;
  readonly channels: string;
  readonly repeatInterval: string | null;
  readonly groupWindow: string | null;
  readonly bypassesQuietHours: boolean;
  readonly sendsResolved: boolean;
  readonly webhookMirror: WebhookMirror;
}

export function severityTaxonomy(): readonly SeverityDef[];   // read from published JSON, by path
export function severityContractVersion(): number;           // the artifact's contractVersion
```

`SeverityDef` is a sanctioned local mirror of `@pulse/alerting`'s type — agent-kit takes no dependency
on that package; `severity-contract.test.ts` locks the shipped content to the real artifact.

## Error model *(internal — `src/emit/errors.ts`)*

```typescript
export class AgentKitError extends Error { readonly code: string; }

export class ContentValidationError extends AgentKitError { readonly unitId: string; }   // CONTENT_INVALID
export class UnknownEcosystemError  extends AgentKitError { readonly ecosystem: string; } // UNKNOWN_ECOSYSTEM
export class SlotMismatchError      extends AgentKitError { readonly slot: string; }      // SLOT_MISMATCH
export class SecretLiteralError     extends AgentKitError { readonly path: string; }      // SECRET_LITERAL
```

### Secret-safety lint — `src/emit/secret-lint.ts`

```typescript
export function assertNoSecretLiterals(path: string, contents: string): void;  // throws SecretLiteralError
```

Allows `${ENV}` and `op://vault/item/field` references; throws on a secret-suggesting literal
assignment that is not one of those. Run on every emitted file before it is written.

## Generation and drift *(internal — `scripts/**`)*

```typescript
// scripts/generate.ts
export async function generate(root?: string): Promise<void>;   // re-render generated/** + pack module

// scripts/verify-generated.ts
export interface DriftFinding { path: string; kind: "missing" | "unexpected" | "changed"; diff: string; }
export async function verifyGenerated(): Promise<DriftFinding[]>;    // [] ⇒ in sync
export async function regenerateToTemp(): Promise<string>;          // fresh temp render dir
export async function listGeneratedFiles(dir: string): Promise<string[]>;  // sorted relative paths
```

`renderPackModule(root)` (`src/emit/pack.ts`) renders the deterministic
`generated/guidance-pack.generated.ts` source (`GUIDANCE_PACK` + `PACK_BYTES`) that the release build
embeds into the CLI binary.

## Scripts and tests

| Command | What it runs |
|---------|--------------|
| `bun run generate` | `scripts/generate.ts` — re-render `generated/**` and the pack module from source |
| `bun run verify:generated` | `scripts/verify-generated.ts` — drift check; exits non-zero on any finding |
| `bun run typecheck` | `tsc -b` over the package |
| `bun test` | The full suite below |

| Test suite | Guards |
|------------|--------|
| `inventory-contract.test.ts` | `inventoryVocab` == the introspected `@pulse/core` schema |
| `cli-contract.test.ts` | `CLI_CONTRACT` == the real `pulse` CLI (driven in-process) |
| `severity-contract.test.ts` | shipped severity content == `@pulse/alerting`'s `severity-taxonomy.json` |
| `generated-drift.test.ts` | committed `generated/**` == a fresh render (no drift) |
| `pack-scaffold.test.ts` | create-only scaffolding; every emitted path repo-relative + non-escaping |
| `requirements-coverage.test.ts` | traceability meta-guard over each unit's `requirements[]` |
| `error-surface.test.ts` | the stated-throws behavior of the error model |
| `eval.deterministic.test.ts` | per-PR eval: scripted fixture mutations driving the real CLI (no model) |
| `eval.live.test.ts` | opt-in live Claude Code eval (reference-ecosystem release gate; self-skips without a credential) |
| `eval.smoke.test.ts` | Codex/Pi packs present, non-empty, well-formed |
