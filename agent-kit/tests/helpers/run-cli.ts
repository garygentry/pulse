// agent-kit/tests/helpers/run-cli.ts
// In-process CLI harness (04-contract-locks-and-embedding.md §3.2, REQ-DRIFT-02).
//
// Deep import: @pulse/cli has no `exports`/`main`/`module` gate today (type:module only), so its
// source entry is importable directly (OT-03 — if pulse-cli later adds an exports map, a public
// `main` export is needed). This is a HELPER module, not a bun:test suite (no test() calls); the
// contract suites that use it arrive in items 006/007.
import { main, ExitSignal, type ProcessBridge } from "@pulse/cli/src/index.ts"; // apps/cli/src/index.ts:111,62,75

/** The captured outcome of one in-process CLI invocation. */
export interface RunResult {
  /** Everything written to the CLI's stdout sink (the `--json` envelope, `--version`). */
  stdout: string;
  /** Everything written to the CLI's stderr sink (human text, findings, diagnostics). */
  stderr: string;
  /** The resolved exit code, captured from `io.exit(code)` (0/1/2 per the CLI contract). */
  exitCode: number;
}

/**
 * Run the real `pulse` CLI IN-PROCESS against a working directory, capturing its streams and
 * exit code without spawning a subprocess (fast enough for the <2-min gate, REQ-PERF-01). The
 * estate dir is cwd-relative and not flag-overridable, so callers point `cwd` at a copy of the
 * reference estate (05 §6.5) and pass verbs in `argv`.
 *
 * @param argv - The verb + flags exactly as a user types them, e.g. ["validate","--json"].
 * @param cwd - Working directory the CLI resolves config/estate against.
 * @param env - Optional env overrides merged over a clean base (default: NO_COLOR set, so
 *   captured output is deterministic and colour-free).
 * @returns The captured stdout/stderr/exitCode.
 * @throws Re-throws any non-`ExitSignal` error `main` propagates (a genuine tool fault the test
 *   should surface, not swallow). A well-formed invocation always exits via `ExitSignal`.
 */
export async function runCli(
  argv: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;

  const bridge: ProcessBridge = {
    env: { NO_COLOR: "1", ...env },
    cwd: () => cwd,
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
    stderrIsTTY: false, // deterministic: never colourize captured output
    exit: (n) => {
      code = n;
      throw new ExitSignal(n); // unwinds main; re-thrown past main's catch (index.ts:177)
    },
  };

  try {
    await main(argv, bridge);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e; // a real fault — surface it
    // else: deliberate exit already captured in `code`
  }
  return { stdout: out.join(""), stderr: err.join(""), exitCode: code };
}
