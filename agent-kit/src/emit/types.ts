// agent-kit/src/emit/types.ts
// The content-model / emit / slot type system.
//
// The single source of truth is a set of typed content units assembled into a manifest. Content
// is authored ONCE as these units; every ecosystem's output is generated from them. Because a
// unit renders from typed slots (§4) rather than string templates, the drift tests assert on the
// same objects the content renders from — a claim can never render one value and be tested as
// another.

// SeverityDef is a LOCAL mirror defined in `../slots/severity.js` (the OT-02 fallback); agent-kit
// takes NO runtime or type dependency on @pulse/alerting (V-002). Imported TYPE-ONLY here.
import type { SeverityDef } from "../slots/severity.js";

// ── §1. Enumerations and String Unions ──────────────────────────────────────────────────────

/**
 * The agent ecosystems agent-kit emits for. The first three are first-class (REQ-ECO-01): the
 * pack scaffolds their native files and their skills/subagents are delivered in a form the
 * ecosystem runs. `"generic"` is best-effort, untested `AGENTS.md`-class output (REQ-ECO-03) —
 * emitted but never claimed tested.
 *
 * Ordering is stable and significant: it fixes generated-directory iteration order for
 * determinism (REQ-PERF-02). Adding an ecosystem later (REQ-SCALE-01) is an additive change —
 * extend this union, add one `Emitter`, widen each unit's `targets`.
 */
export type Ecosystem = "claude" | "codex" | "pi" | "generic";

/**
 * The kind of an authored content unit. Governs which ecosystem sub-directory an emitter routes
 * the unit into (guidance → root/docs; skill → skills/; subagent → agents/) and whether runnable
 * frontmatter is required (skills/subagents on Claude/Pi).
 */
export type ContentKind = "guidance" | "skill" | "subagent";

/**
 * The `pulse` CLI verb set. Mirrors `PulseCommand` from `@pulse/cli`; defined locally so the
 * ecosystem-agnostic content model carries no runtime import of the CLI. The CLI-contract lock
 * asserts this union equals the real CLI's verb set, so a drift here fails the build
 * (REQ-DRIFT-02).
 */
export type PulseVerb = "init" | "render" | "validate" | "coverage";

/** Canonical emit order. Iterating ecosystems in this order keeps generated output stable. */
export const ECOSYSTEMS: readonly Ecosystem[] = ["claude", "codex", "pi", "generic"] as const;

/** First-class ecosystems (REQ-ECO-01) — the tested set; excludes `"generic"`. */
export const FIRST_CLASS_ECOSYSTEMS: readonly Ecosystem[] = ["claude", "codex", "pi"] as const;

/**
 * The only pack merge policy in v1 (REQ-GUIDE-06, REQ-SEC-03): every scaffolded file is
 * create-only. Referenced wherever a `GuidancePackFile` is constructed so the literal is never
 * hand-typed per file.
 */
export const CREATE_ONLY = "create-only" as const;

/**
 * Requirement-id grammar (`REQ-<AREA>-<NN>`). `ContentUnit.requirements` entries are validated
 * against this by the coverage test; a malformed id throws `ContentValidationError`.
 */
export const REQ_ID_RE = /^REQ-[A-Z0-9]+-\d{2}$/;

// ── §2. Core Content Model (D3 — REQ-DRIFT-01) ──────────────────────────────────────────────

/**
 * Frontmatter fields consumed by runnable ecosystems (Claude Code, Pi). On Claude these become
 * the `SKILL.md` / agent-definition YAML header; on Codex they are folded into the
 * instruction-prose heading (Codex has no skill runtime). All fields are plain text; none may
 * contain a secret literal (enforced by the secret-safety lint).
 */
export interface ContentFrontmatter {
  /** Human/agent-facing name, e.g. "Estate authoring". Becomes the skill `name`. */
  name: string;
  /** One-line description shown in skill listings. Becomes the skill `description`. */
  description: string;
  /** Optional argument hint for runnable skills, e.g. "<host-id>". Claude: `argument-hint`. */
  argumentHint?: string;
}

/**
 * One ordered body section of a content unit. `text` is pure authored prose; a section may
 * additionally carry pre-rendered `code` fences. Sections are composed into a file by plain
 * string composition (stable, deterministic), never a template engine.
 */
export interface Section {
  /** Markdown heading text for this section (without leading `#`). */
  heading: string;
  /** Heading depth (2 = `##`, 3 = `###`). Default 2. */
  level?: 2 | 3;
  /** Body prose for the section (Markdown). May be empty when the section is code-only. */
  text: string;
  /** Optional fenced code blocks appended after `text`, in order. */
  code?: CodeBlock[];
}

/** A fenced code block rendered verbatim into a section body. */
export interface CodeBlock {
  /** Fence language tag, e.g. "yaml", "bash", "ts". Empty string → no tag. */
  lang: string;
  /** Literal block contents (no surrounding fences; the emitter adds them). */
  body: string;
}

/**
 * One authored unit of agent-facing content, ecosystem-agnostic (D3). The generated file stem is
 * `id`; `targets` selects which ecosystems receive it; `requirements` ties it to requirement
 * ids (asserted real + covered by the coverage test); `render` produces the ordered body from the
 * typed slots (§4).
 */
export interface ContentUnit {
  /** Stable kebab-case id; also the generated file stem (e.g. "estate-authoring"). */
  id: string;
  /** Guidance / skill / subagent — governs routing and whether frontmatter is runnable. */
  kind: ContentKind;
  /** Frontmatter consumed by runnable ecosystems (Claude/Pi). */
  frontmatter: ContentFrontmatter;
  /** Ecosystems that receive this unit (all first-class by default). */
  targets: Ecosystem[];
  /** Requirement ids this unit satisfies — validated `REQ_ID_RE` and covered by tests. */
  requirements: string[];
  /** Produce the ordered body sections; slots inject typed, contract-checked data (§4). */
  render(slots: Slots): Section[];
}

/** The ordered set of all authored content units — the single source of truth. */
export interface Manifest {
  /** Content units in stable authored order (fixes generated iteration order). */
  units: ContentUnit[];
}

// ── §3. Emit Model (D4 — REQ-ECO-04, REQ-DRIFT-03) ──────────────────────────────────────────

/** A single generated file: a repo-relative path and its full text contents. */
export interface EmittedFile {
  /**
   * Path relative to the ecosystem's generated root (e.g. "skills/estate-authoring/SKILL.md").
   * The generator prefixes `generated/<ecosystem>/` when writing to disk. Must be repo-relative
   * and non-escaping — asserted by `pack-scaffold.test.ts`.
   */
  path: string;
  /** Full file contents; `\n`-terminated lines only, no clock/host/PID content (determinism). */
  contents: string;
}

/**
 * An ecosystem emitter. Pure and deterministic: identical `(manifest, slots)` yields
 * byte-identical `EmittedFile[]` (REQ-PERF-02). Throws `UnknownEcosystemError` /
 * `ContentValidationError` on a malformed unit rather than emitting degraded content.
 */
export interface Emitter {
  /** Which ecosystem this emitter targets. */
  ecosystem: Ecosystem;
  /** Transform the manifest + slots into this ecosystem's native files. */
  emit(manifest: Manifest, slots: Slots): EmittedFile[];
}

// ── §4. Contract-Checked Data Slots (D3 — the `Slots` bundle) ───────────────────────────────

/**
 * The three typed data blocks injected into every `ContentUnit.render`. Because these are typed
 * values (not string templates), a rendered claim and its contract test read the same object —
 * the guidance is "contract-tested or generated", never hand-trusted.
 */
export interface Slots {
  /** Inventory-schema vocabulary, derived-and-checked vs `inventorySchema` (§4.1). */
  inventoryVocab: InventoryVocab;
  /** CLI verb/exit-code/`--json` table, contract-tested vs the real CLI (§4.2). */
  cliContract: CliContract;
  /** Severity taxonomy; locked to `severity-taxonomy.json`'s `contractVersion` by `severity-contract.test.ts`. */
  severity: readonly SeverityDef[];
}

// §4.1 InventoryVocab (REQ-DRIFT-05, REQ-GUIDE-02, REQ-SKILL-01)

/** One top-level estate-config section (e.g. `hosts`, `services`). */
export interface VocabSection {
  /** Section key; asserted ∈ `Object.keys(inventorySchema.shape)`. */
  key: string;
  /** Whether the schema marks the section required (vs optional). */
  required: boolean;
  /** Authored teaching summary of what the section declares (not contract-checked). */
  summary: string;
}

/**
 * The taught inventory vocabulary. The contract test (`inventory-contract.test.ts`) asserts:
 *   1. `collectionClasses` == introspected host discriminated-union literals (sorted);
 *   2. `sections.map(s => s.key)` == `Object.keys(inventorySchema.shape)`;
 *   3. `schemaMajor` == `CURRENT_SCHEMA_MAJOR`.
 */
export interface InventoryVocab {
  /** Schema major version taught; asserted == `CURRENT_SCHEMA_MAJOR` (`@pulse/core`). */
  schemaMajor: number;
  /** Top-level sections in schema-declared order. */
  sections: readonly VocabSection[];
  /** Host collection classes, sorted; asserted == introspected union literals. */
  collectionClasses: readonly string[];
}

// §4.2 CliContract (REQ-DRIFT-02, REQ-GUIDE-03, REQ-SKILL-02)

/** One documented exit-code case for a verb (asserted against the real CLI). */
export interface CliExitCase {
  /** Exit code per the CLI's 0/1/2 contract. */
  code: 0 | 1 | 2;
  /** The condition that produces it, e.g. "validate clean", "seeded error", "thrown fault". */
  condition: string;
}

/** One CLI verb's documented contract. */
export interface CliVerb {
  /** Verb name; the set is asserted == the real CLI's verb set. */
  name: PulseVerb;
  /** One-line summary of what the verb does. */
  summary: string;
  /** Exit-code cases an agent keys off (asserted by driving the real CLI). */
  exitCodes: readonly CliExitCase[];
  /**
   * Documented `data` field names for this verb's `--json` envelope, e.g. `InitData` →
   * ["created","skipped","wouldClobber"]. Asserted against the real envelope shape.
   */
  dataFields: readonly string[];
}

/** The authored CLI contract table content renders from and tests assert against. */
export interface CliContract {
  /** All verbs; `verbs.map(v => v.name)` asserted == real CLI verb set. */
  verbs: readonly CliVerb[];
  /**
   * `PulseEnvelope<D>` top-level field names an agent parses:
   * `["ok","exitCode","command","findings","data","meta"]`. Asserted == the real envelope.
   */
  envelopeFields: readonly string[];
}
