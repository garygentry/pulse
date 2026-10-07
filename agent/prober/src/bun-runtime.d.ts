// Ambient Bun runtime globals used by the agent tree. `tsc` typechecks against `@types/node`
// only (no `bun-types` is installed), so the Bun-specific globals the prober entrypoint uses
// (`Bun.serve`) and the test harness may use (`Bun.spawnSync`) are declared here. This is a
// script (ambient) file — no import/export — so it augments the global scope directly. It is
// the SINGLE canonical `Bun` declaration for the agent tree: both the prober project
// (`src/**/*.ts`) and the tests project (`../prober/src/**/*.ts`) include it, so it must not be
// re-declared elsewhere (a second top-level `declare const Bun` would be a TS2451 redeclare).

/** Minimal Bun HTTP server handle returned by {@link Bun.serve}. */
interface BunServer {
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
}

/** Minimal async subprocess handle returned by {@link Bun.spawn} (used by the command-exporter). */
interface BunSubprocess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves with the process exit code (null if killed by a signal). */
  readonly exited: Promise<number | null>;
  kill(signal?: number | string): void;
}

declare const Bun: {
  /** Start an HTTP server (used by the prober + command-exporter entrypoints). */
  serve(options: {
    port: number;
    fetch(req: Request): Response | Promise<Response>;
  }): BunServer;
  /** Synchronous subprocess (used by daemon-free structural tests). */
  spawnSync(
    argv: string[],
    options?: {
      env?: Record<string, string | undefined>;
      stdout?: "pipe" | "inherit" | "ignore";
      stderr?: "pipe" | "inherit" | "ignore";
      cwd?: string;
    },
  ): { exitCode: number; stdout: Uint8Array; stderr: Uint8Array };
  /** Asynchronous subprocess (used by the command-exporter to run each signal's command). The
   *  object form is used so `timeout`/`killSignal` bound a command that hangs or runs long. */
  spawn(options: {
    cmd: string[];
    env?: Record<string, string | undefined>;
    stdout?: "pipe" | "inherit" | "ignore";
    stderr?: "pipe" | "inherit" | "ignore";
    cwd?: string;
    /** Kill the process after this many ms (Bun ≥1.1). */
    timeout?: number;
    /** Signal used to kill on timeout/`.kill()`. */
    killSignal?: number | string;
  }): BunSubprocess;
};
