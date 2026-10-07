// packages/renderer/src/render/web-command.ts
//
// Deterministic, display-only POSIX argv formatting (02 §6, tech-spec §3.7). This converts a
// core `CommandSignal.command` (`string[]`) into a single display string that preserves argv
// token boundaries. It NEVER invokes a shell, executes the argv, reads the environment, or
// resolves a credential — the output is for human reading only. The conversion is total: any
// string token (including empty, spaced, quoted, apostrophe, or newline tokens) round-trips to
// a deterministic quoted form without throwing (02 §8 error table; REQ-MODEL-06, REQ-REL-02).

/** A token needs no quoting iff it is entirely composed of these shell-safe characters. */
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Render one argv token with deterministic POSIX-compatible single quoting (02 §6).
 *
 * 1. A token of only safe characters (`[A-Za-z0-9_@%+=:,./-]+`) is returned unchanged.
 * 2. An empty token renders as `''`.
 * 3. Otherwise the token is wrapped in single quotes and each embedded `'` is replaced with the
 *    exact five-character fragment `'"'"'` (close quote, double-quoted apostrophe, reopen quote).
 *
 * @param token - One argv element, verbatim.
 * @returns The display-safe quoted token; never executed.
 */
export function quotePosixArg(token: string): string {
  if (SAFE_TOKEN.test(token)) return token;
  if (token === "") return "''";
  return `'${token.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Render argv for display while preserving token boundaries; never invokes a shell (02 §6).
 * Quoted tokens are joined with exactly one ASCII space; an empty argv renders as the empty
 * string.
 *
 * @param argv - The ordered command tokens, exactly as declared. Order is preserved.
 * @returns A single deterministic display string; display-only, never executed.
 */
export function displayPosixArgv(argv: readonly string[]): string {
  return argv.map(quotePosixArg).join(" ");
}
