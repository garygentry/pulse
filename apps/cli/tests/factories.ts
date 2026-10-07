// apps/cli/tests/factories.ts — the in-process CLI runner shared by the shell suites (04 §9)
// and by item 018's smoke/exit-code/purity suites. `runCli` invokes `main` with an injected
// ProcessBridge that captures stdout/stderr into buffers and turns `exit(code)` into a thrown
// ExitSignal, so a full CLI invocation (parse → route → emit → exit) runs without a subprocess
// and without touching the real process streams. This is the DEV path deliberately — the CLI
// runs on local source, with no dependency on a compiled binary (item 019).

import { main, ExitSignal } from "../src/index.js";

/** Captured result of one in-process CLI run. */
export interface RunResult {
  /** Everything written to stdout (the `--json` envelope, or `--version` text, or ""). */
  stdout: string;
  /** Everything written to stderr (findings, diagnostics, progress). */
  stderr: string;
  /** The exit code `main` resolved (0/1/2). */
  exitCode: number;
}

/** Options for {@link runCli}: the injected env, cwd, and stderr TTY-ness (all default off). */
export interface RunOptions {
  /** Environment for config resolution / colour. Defaults to `{}` (no ambient PULSE_ or NO_COLOR). */
  env?: NodeJS.ProcessEnv;
  /** Working directory (default config location + `init` repo root). Defaults to `process.cwd()`. */
  cwd?: string;
  /** Whether stderr is a TTY (drives colour). Defaults to `false` (no escape bytes in tests). */
  stderrIsTTY?: boolean;
}

/**
 * Run the CLI in-process, capturing both streams and the exit code (04 §9). Never terminates the
 * test process: the injected `exit` throws {@link ExitSignal}, which is caught here after
 * `main`'s buffers are flushed. Any non-`ExitSignal` throw is a bug (`main` must map every fault
 * to `exit(2)`) and is re-thrown to fail the test loudly.
 *
 * @param args - The argv tail (as a user would type after `pulse`), e.g. `["render", "--json"]`.
 * @param opts - Injected env / cwd / TTY-ness.
 * @returns The captured `{ stdout, stderr, exitCode }`.
 */
export async function runCli(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  let exitCode = -1;

  const bridge = {
    env: opts.env ?? {},
    cwd: () => opts.cwd ?? process.cwd(),
    stdout: (s: string) => void outChunks.push(s),
    stderr: (s: string) => void errChunks.push(s),
    stderrIsTTY: opts.stderrIsTTY ?? false,
    exit: (code: number): never => {
      exitCode = code;
      throw new ExitSignal(code);
    },
  };

  try {
    await main(args, bridge);
  } catch (err) {
    // main always ends in `exit` (→ ExitSignal); anything else is an unmapped fault → fail.
    if (!(err instanceof ExitSignal)) throw err;
  }

  return { stdout: outChunks.join(""), stderr: errChunks.join(""), exitCode };
}
