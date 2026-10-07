// stack/alerting/tests/run.ts
// The one-shot spawn helper the Tier-B suites (rules.promtool, routing.amtool) and the DOCKER_OK
// self-skip use. Copied SHAPE from stack/tests/harness.ts `run`: runs a command to completion,
// captures both streams as decoded strings, and NEVER throws on a non-zero exit (the caller asserts
// on `exitCode`). Uses only the Bun runtime built-in `Bun.spawnSync` — no dependency.

/* -------------------------------------------------------------------------------------------
 * Bun built-in surface used here. The repo installs no `bun-types`/`@types/bun`, so the single
 * built-in this module touches — `Bun.spawnSync` — is declared as a minimal ambient global so
 * `tsc -b` typechecks it. The Bun runtime that executes `bun test` provides it.
 * ----------------------------------------------------------------------------------------- */
declare global {
  /** Minimal view of the Bun global — only the members the alerting suite uses. `spawnSync` powers
   *  this helper + the Tier-B tool containers; `serve` powers the webhook loopback receiver (§6.4,
   *  item 013). Declared once here so the whole `stack/alerting` tsc project sees a single Bun type. */
  const Bun: {
    spawnSync(
      argv: string[],
      options?: {
        env?: Record<string, string | undefined>;
        stdout?: "pipe" | "inherit" | "ignore";
        stderr?: "pipe" | "inherit" | "ignore";
        cwd?: string;
      },
    ): { exitCode: number; stdout: Uint8Array; stderr: Uint8Array };
    serve(options: {
      port?: number;
      hostname?: string;
      fetch(req: Request): Response | Promise<Response>;
    }): { url: URL; port: number; stop(): void };
  };
}

/** The captured result of a completed command. */
export interface Ran {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command to completion, capturing both streams. Never throws on a non-zero exit — the caller
 * inspects `exitCode`. Merges `env` over `process.env` so `docker run` / tool invocations inherit the
 * ambient environment plus any per-call overrides.
 *
 * @param argv - The command and its arguments.
 * @param env  - Extra environment variables layered over `process.env`.
 * @returns The exit code and decoded stdout/stderr.
 */
export function run(argv: string[], env: Record<string, string> = {}): Ran {
  const p = Bun.spawnSync(argv, {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: p.exitCode,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}
