// apps/cli/src/args.ts — argv → ParsedInvocation, via node:util parseArgs (REQ-CLI-01/02b,
// 04 §3). Zero third-party runtime deps: this module imports only node:util (+ types from
// @pulse/renderer for RENDER_KINDS/RenderKind). No I/O — fully unit-testable with a literal
// string[].

import { parseArgs } from "node:util";

import { RENDER_KINDS } from "@pulse/renderer";
import type { RenderKind } from "@pulse/renderer";

import { parseProposalsArgs } from "./commands/proposals/args.js";
import type { ProposalsInvocation } from "./commands/proposals/args.js";

/** Global flags valid on every verb (04 §3.1). */
export interface GlobalFlags {
  /** `--json`: machine payload to stdout, all human text to stderr (REQ-CLI-03). */
  json: boolean;
  /** `--strict`: promote `warning`-severity findings to exit 1 (REQ-CLI-02a). */
  strict: boolean;
  /** `--verbose`: more stderr detail; never alters `--json` stdout (REQ-OBS-02). */
  verbose: boolean;
  /** `--quiet`: less stderr detail; never alters `--json` stdout (REQ-OBS-02). */
  quiet: boolean;
  /**
   * `--config <path>`: override the `pulse.config.yaml` location. Absent (`undefined`) ⇒ the
   * conventional `<cwd>/pulse.config.yaml`. Only present when the flag was passed
   * (`exactOptionalPropertyTypes`).
   */
  configPath?: string;
}

/** `render`-only flags (REQ-RND-05/07). */
export interface RenderInvocationFlags {
  /** `--check`: render in memory and diff against the committed tree; write nothing (REQ-RND-07). */
  check: boolean;
  /**
   * `--only <kind[,kind…]>`: narrow output to named kinds for debugging (REQ-RND-05). Parsed +
   * validated against `RENDER_KINDS` (00 §2); absent ⇒ full tree.
   */
  only?: RenderKind[];
  /** `--output-root <path>`: override the resolved `outputRoot`. */
  outputRoot?: string;
}

/** `init`-only flags (REQ-INIT-03). */
export interface InitInvocationFlags {
  /** `--force`: overwrite existing files instead of reporting `wouldClobber` (REQ-INIT-03). */
  force: boolean;
}

/**
 * The fully-parsed invocation, discriminated by `kind` and then by `command`. Produced by
 * {@link parseInvocation}; consumed by `index.ts`. `--version` short-circuits before any verb
 * routing (REQ-CLI-06), so it is its own `kind`.
 */
export type ParsedInvocation =
  | { kind: "version" }
  | { kind: "command"; command: "validate"; global: GlobalFlags }
  | { kind: "command"; command: "coverage"; global: GlobalFlags }
  | { kind: "command"; command: "render"; global: GlobalFlags; render: RenderInvocationFlags }
  | { kind: "command"; command: "init"; global: GlobalFlags; init: InitInvocationFlags }
  /** The proposals family; its tail is parsed by `parseProposalsArgs`. */
  | { kind: "command"; command: "proposals"; global: GlobalFlags; proposals: ProposalsInvocation };

/** The verbs (REQ-CLI-01, REQ-PROP-07). Order is presentation-only. */
const VERBS = ["init", "render", "validate", "coverage", "proposals"] as const;
type Verb = (typeof VERBS)[number];

/**
 * Global flag config for `parseArgs`. `--version` is included so it can be detected on any verb
 * (and with no verb). `satisfies` preserves the literal `type` values `parseArgs` requires while
 * catching typos at compile time.
 */
const GLOBAL_OPTIONS = {
  json: { type: "boolean", default: false },
  strict: { type: "boolean", default: false },
  verbose: { type: "boolean", default: false },
  quiet: { type: "boolean", default: false },
  config: { type: "string" },
  version: { type: "boolean", default: false },
} satisfies Record<string, { type: "boolean" | "string"; default?: boolean | string }>;

/** `render` = global ∪ render flags. */
const RENDER_OPTIONS = {
  ...GLOBAL_OPTIONS,
  check: { type: "boolean", default: false },
  only: { type: "string" },
  "output-root": { type: "string" },
} satisfies Record<string, { type: "boolean" | "string"; default?: boolean | string }>;

/** `init` = global ∪ init flags. */
const INIT_OPTIONS = {
  ...GLOBAL_OPTIONS,
  force: { type: "boolean", default: false },
} satisfies Record<string, { type: "boolean" | "string"; default?: boolean | string }>;

/**
 * A CLI **usage** fault (unknown verb/flag, bad `--only` kind, conflicting flags, stray
 * positional). Mapped to exit `2` by the single top-level catch (`index.ts`, REQ-CLI-02b) —
 * usage errors are tool faults, NOT findings. `message` is written to stderr, never stdout.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
    Object.setPrototypeOf(this, UsageError.prototype); // instanceof across ESM
  }
}

/**
 * Parse a raw argv tail (`process.argv.slice(2)`) into a {@link ParsedInvocation}.
 *
 * Routing: the **verb** is the first token equal to one of the four verbs; every other token is
 * a flag (global or per-verb) and may appear before or after the verb. `--version` (with or
 * without a verb, in any position) short-circuits to `{ kind: "version" }` (REQ-CLI-06).
 *
 * @param argv - Argument tail, already stripped of the node/bin prefix.
 * @returns The discriminated invocation.
 * @throws {UsageError} Unknown verb, no verb (and no `--version`), unknown flag, malformed
 *   `--only` kind, a stray positional, or `--verbose` together with `--quiet`. Every such throw
 *   is a tool fault → exit `2` (REQ-CLI-02b).
 */
export function parseInvocation(argv: string[]): ParsedInvocation {
  const verbIndex = argv.findIndex((t) => (VERBS as readonly string[]).includes(t));

  // ── No verb ────────────────────────────────────────────────────────────────
  if (verbIndex === -1) {
    if (argv.includes("--version")) return { kind: "version" };
    throw new UsageError(
      argv.length === 0
        ? "no command given (expected one of: init, render, validate, coverage, proposals)"
        : `unknown command: ${JSON.stringify(argv[0])}`,
    );
  }

  const verb = argv[verbIndex] as Verb;
  // Everything except the verb token is a flag; keep original order for parseArgs.
  const flagArgs = [...argv.slice(0, verbIndex), ...argv.slice(verbIndex + 1)];

  if (verb === "proposals") {
    // Positionals are enabled ONLY here, in the proposals module's own options bag; every other verb rejects positionals.
    const parsed = parseProposalsArgs(flagArgs, GLOBAL_OPTIONS);
    if (!parsed.ok) throw new UsageError(parsed.message);
    if (parsed.version) return { kind: "version" };
    return {
      kind: "command",
      command: "proposals",
      global: readGlobalFlags(parsed.values),
      proposals: parsed.invocation,
    };
  }

  const options =
    verb === "render" ? RENDER_OPTIONS : verb === "init" ? INIT_OPTIONS : GLOBAL_OPTIONS;

  let values: Record<string, string | boolean | undefined>;
  try {
    // strict + allowPositionals:false ⇒ an unknown flag or a stray positional throws.
    ({ values } = parseArgs({ args: flagArgs, options, strict: true, allowPositionals: false }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }

  // --version wins even with a verb present.
  if (values.version === true) return { kind: "version" };

  const global = readGlobalFlags(values);

  switch (verb) {
    case "validate":
      return { kind: "command", command: "validate", global };
    case "coverage":
      return { kind: "command", command: "coverage", global };
    case "render":
      return { kind: "command", command: "render", global, render: readRenderFlags(values) };
    case "init":
      return {
        kind: "command",
        command: "init",
        global,
        init: { force: values.force === true },
      };
  }
}

/** Extract + validate the global flags from a parseArgs value bag. */
function readGlobalFlags(values: Record<string, string | boolean | undefined>): GlobalFlags {
  const verbose = values.verbose === true;
  const quiet = values.quiet === true;
  if (verbose && quiet) {
    throw new UsageError("--verbose and --quiet are mutually exclusive");
  }
  const flags: GlobalFlags = {
    json: values.json === true,
    strict: values.strict === true,
    verbose,
    quiet,
  };
  // Only set optional props when present (exactOptionalPropertyTypes).
  if (typeof values.config === "string") flags.configPath = values.config;
  return flags;
}

/** Extract + validate the render flags, including the `--only` kind list. */
function readRenderFlags(
  values: Record<string, string | boolean | undefined>,
): RenderInvocationFlags {
  const flags: RenderInvocationFlags = { check: values.check === true };
  if (typeof values.only === "string") flags.only = parseOnly(values.only);
  if (typeof values["output-root"] === "string") flags.outputRoot = values["output-root"];
  return flags;
}

/** Split + validate a comma-delimited `--only` value against RENDER_KINDS (00 §2). */
function parseOnly(raw: string): RenderKind[] {
  const known = new Set<string>(RENDER_KINDS);
  const kinds = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (kinds.length === 0) throw new UsageError("--only requires at least one kind");
  for (const k of kinds) {
    if (!known.has(k)) {
      throw new UsageError(
        `--only: unknown kind ${JSON.stringify(k)} (valid: ${RENDER_KINDS.join(", ")})`,
      );
    }
  }
  return kinds as RenderKind[];
}
