// apps/cli/src/index.ts — the process entry (04 §8, REQ-CLI-02b/06). Parses argv, resolves
// config, routes a verb to its 05 handler, maps the 0/1/2 exit code, builds + emits the single
// `--json` envelope, and owns the ONE top-level try/catch (every thrown fault → exit 2, stderr
// only). No fault ever writes stdout, so under `--json` the machine channel is exactly one
// envelope (a completed command) or empty (a fault) — never a half-written object.

import { SUPPORTED_SCHEMA_MAJORS, ConfigIoError } from "@pulse/core";
import { RenderIoError } from "@pulse/renderer";

import { parseInvocation, UsageError } from "./args.js";
import type { GlobalFlags, RenderInvocationFlags, InitInvocationFlags } from "./args.js";
import { resolveConfig } from "./config.js";
import type { ResolvedConfig } from "./config.js";
import { computeOutcomeExit } from "./exit.js";
import type { ExitCode } from "./exit.js";
import { buildEnvelope, serializeEnvelope } from "./envelope.js";
import type { PulseCommand } from "./envelope.js";
import {
  createOutputWriter,
  resolveColor,
  verbosityOf,
  reportFindings,
} from "./output.js";
import type { OutputWriter } from "./output.js";
import { runValidate } from "./commands/validate.js"; // 05 §4
import { runRender } from "./commands/render.js"; //     05 §5
import { runCoverage } from "./commands/coverage.js"; // 05 §6
import { runInit, BUNDLED_GUIDANCE_PACK } from "./commands/init.js"; // 05 §7 (+ build-embedded pack)
import { PULSE_VERSION } from "./version.js";
import type { CommandResult } from "./commands/result.js"; // 05 §3
import { runProposals } from "./commands/proposals/index.js";
import type { ProposalsInvocation } from "./commands/proposals/args.js";
import { ProposalToolError } from "./commands/proposals/git.js";

/** Everything a command handler (05) needs; assembled by the shell before routing (04 §8.1). */
export interface CommandContext {
  /** Fully-resolved config (config.ts §7). */
  config: ResolvedConfig;
  /** Parsed global flags (for `strict`, verbosity, `json`). */
  global: GlobalFlags;
  /** Present only for `render`. */
  render?: RenderInvocationFlags;
  /** Present only for `init`. */
  init?: InitInvocationFlags;
  /** Present only for `proposals`. */
  proposals?: ProposalsInvocation;
  /** The output writer — handlers emit progress via `note`/`detail`, never stdout directly. */
  out: OutputWriter;
}

/**
 * The `pulse --version` text (REQ-CLI-06): the CLI version plus the bundled core's supported
 * schema majors (REQ-VER-01). Both draw from single sources of truth — `PULSE_VERSION`
 * (`version.ts`) and `SUPPORTED_SCHEMA_MAJORS` (`@pulse/core`) — so `--version` and the
 * envelope `meta` can never disagree.
 */
export function versionText(): string {
  return `pulse ${PULSE_VERSION}\nsupported schema majors: ${SUPPORTED_SCHEMA_MAJORS.join(", ")}\n`;
}

/**
 * Thrown by an injected {@link ProcessBridge.exit} to unwind the stack in-process (tests capture
 * it to read the exit code). In production the bridge's `exit` is `process.exit`, which never
 * returns and never throws, so this class is inert. `main`'s top-level catch rethrows it so a
 * deliberate exit is never re-mapped to a fault.
 */
export class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
    this.name = "ExitSignal";
    Object.setPrototypeOf(this, ExitSignal.prototype); // instanceof across ESM
  }
}

/**
 * The process facilities `main` touches, injectable so the entry point is unit-testable
 * in-process (04 §9). Production uses {@link realBridge} (the real streams / env / cwd / exit);
 * tests inject buffers and an `exit` that throws {@link ExitSignal}.
 */
export interface ProcessBridge {
  /** The environment (`PULSE_*` config keys + `NO_COLOR`). */
  env: NodeJS.ProcessEnv;
  /** Working directory (default config location + `init` repo root). */
  cwd(): string;
  /** The ONLY stdout sink (machine envelope / `--version`). */
  stdout(s: string): void;
  /** The stderr sink (all human text, findings, diagnostics). */
  stderr(s: string): void;
  /** Whether stderr is a TTY (drives colour, REQ-CLI-05). */
  stderrIsTTY: boolean;
  /** Terminate with a code; never returns. */
  exit(code: number): never;
}

/** The real process bridge used by the compiled binary / `bin` entry. */
const realBridge: ProcessBridge = {
  env: process.env,
  cwd: () => process.cwd(),
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  stderrIsTTY: Boolean(process.stderr.isTTY),
  exit: (code) => process.exit(code),
};

/**
 * Process entry point (04 §8.3). Parses argv, resolves config, routes to a handler (05), maps
 * the exit code (exit.ts §4), builds + emits the envelope (envelope.ts §5 / output.ts §6), and
 * calls `io.exit`. The single top-level `try/catch` maps ANY thrown fault to exit `2` via
 * {@link failHard} with a stderr-only diagnostic — `--json` stdout is never polluted on a fault
 * (it is simply never written).
 *
 * @param argv - `process.argv.slice(2)`.
 * @param io - The process bridge (defaults to the real streams/env/cwd/exit).
 * @returns Never — always ends in `io.exit`.
 */
export async function main(argv: string[], io: ProcessBridge = realBridge): Promise<never> {
  // Colour/verbosity are needed even to report a parse fault, so build a minimal writer first.
  // This bootstrap writer is text-mode (json:false) so a usage fault before parsing writes only
  // to stderr; the real writer (with the parsed `--json`/verbosity) is built after a good parse.
  const bootstrapOut = createOutputWriter({
    json: false,
    verbosity: "normal",
    color: resolveColor(io.env.NO_COLOR, io.stderrIsTTY),
    stdout: io.stdout,
    stderr: io.stderr,
  });

  try {
    const inv = parseInvocation(argv);

    if (inv.kind === "version") {
      io.stdout(versionText()); // stdout: the explicitly requested output (§8.2), exit 0
      return io.exit(0);
    }

    const out = createOutputWriter({
      json: inv.global.json,
      verbosity: verbosityOf(inv.global),
      color: resolveColor(io.env.NO_COLOR, io.stderrIsTTY),
      stdout: io.stdout,
      stderr: io.stderr,
    });

    const config = resolveConfig({
      flags: inv.global,
      ...(inv.command === "render" && inv.render.outputRoot !== undefined
        ? { outputRootFlag: inv.render.outputRoot }
        : {}),
      ...(inv.command === "proposals" && inv.proposals.proposalsDirFlag !== undefined
        ? { proposalsDirFlag: inv.proposals.proposalsDirFlag }
        : {}),
      env: io.env,
      cwd: io.cwd(),
    });

    const ctx: CommandContext = {
      config,
      global: inv.global,
      out,
      ...(inv.command === "render" ? { render: inv.render } : {}),
      ...(inv.command === "init" ? { init: inv.init } : {}),
      ...(inv.command === "proposals" ? { proposals: inv.proposals } : {}),
    };

    const result = route(inv.command, ctx, io.cwd(), io.env); // handlers live in 05 (synchronous)

    const exitCode: ExitCode = computeOutcomeExit({
      findings: result.findings,
      outcomeFailed: result.outcomeFailed,
      strict: inv.global.strict,
    });

    // Human summary (stderr) always; machine envelope (stdout) only under --json.
    reportFindings(out, result.findings);
    const envelope = buildEnvelope({
      command: inv.command,
      exitCode,
      findings: result.findings,
      data: result.data,
    });
    out.emitJson(serializeEnvelope(envelope)); // no-op when !--json (REQ-CLI-03)

    return io.exit(exitCode);
  } catch (err) {
    // A deliberate exit (injected `exit` throws ExitSignal in tests) is not a fault — propagate.
    if (err instanceof ExitSignal) throw err;
    return failHard(bootstrapOut, io, err); // the single catch site (§8.4)
  }
}

/**
 * Route a verb to its `05` handler, unpacking the handler's typed inputs from `ctx`. The
 * `switch` is exhaustive over {@link PulseCommand}. Synchronous — every handler and every
 * engine call it makes (`loadAndValidate`, `render`, `materialize`, `computeCoverage`) is sync.
 *
 * @param command - The parsed verb.
 * @param ctx - The assembled command context (config, flags, writer).
 * @param cwd - The working directory (`init` scaffolds relative to it).
 * @param env - The process environment (`proposals` reads the secret from it).
 */
function route(
  command: PulseCommand,
  ctx: CommandContext,
  cwd: string,
  env: NodeJS.ProcessEnv,
): CommandResult<unknown> {
  switch (command) {
    case "validate":
      return runValidate(ctx.config.estateDir);
    case "render":
      // RenderOptions (05 §5): `mode` maps from `--check`; `only` passes the validated kinds.
      return runRender(ctx.config.estateDir, {
        outputRoot: ctx.config.outputRoot,
        mode: ctx.render?.check ? "check" : "write",
        ...(ctx.render?.only ? { only: ctx.render.only } : {}),
      });
    case "coverage":
      return runCoverage(ctx.config.estateDir);
    case "init":
      // InitOptions (05 §7): `repoRoot` is the cwd; the build-embedded pack is passed when
      // present — undefined ⇒ base scaffold only (REQ-INIT-02).
      return runInit({
        repoRoot: cwd,
        force: ctx.init?.force ?? false,
        ...(BUNDLED_GUIDANCE_PACK ? { pack: BUNDLED_GUIDANCE_PACK } : {}),
      });
    case "proposals":
      // Synchronous like every other handler; git via Bun.spawnSync.
      return runProposals(ctx.proposals!, ctx, { env, now: () => new Date() });
  }
}

/**
 * The ONE place any thrown error becomes exit `2` (REQ-CLI-02b, REQ-VAL-03). Writes a single
 * stderr line (never stdout — so a partially-started `--json` stdout stays empty and therefore
 * trivially "pure"). Labels the known fault classes for a clearer message but maps them all to
 * `2`; findings never reach here (they exit 0/1 via exit.ts §4).
 *
 * @returns Never — ends in `io.exit(2)`.
 */
function failHard(out: OutputWriter, io: ProcessBridge, err: unknown): never {
  const label =
    err instanceof UsageError
      ? "usage error"
      : err instanceof ConfigIoError
        ? `config error [${err.code}]`
        : err instanceof RenderIoError
          ? `render io error [${err.code}]`
          : err instanceof ProposalToolError
            ? `proposal tool fault [${err.step}]`
            : "unexpected error";
  const message = err instanceof Error ? err.message : String(err);
  out.diagnostic(`pulse: ${label}: ${message}`); // stderr only
  return io.exit(2);
}

// Real process entry (the `bin`/compiled binary calls this). Guarded by `import.meta.main` so
// importing this module (e.g. the in-process test runner, factories.ts) does NOT run the CLI.
if (import.meta.main) void main(process.argv.slice(2));
