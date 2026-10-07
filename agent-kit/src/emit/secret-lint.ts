// agent-kit/src/emit/secret-lint.ts
// Secret-safety lint (REQ-SEC-01).
//
// Shipped guidance must never contain a secret literal — it teaches secret REFERENCES only
// (`${ENV}` / `op://` grammar, matching core's SecretRef). Enforced as a generation-time lint
// invoked by the emit pipeline on EVERY emitted file (before any file is written), so a
// secret literal fails `bun run generate` / the drift test rather than shipping.

import { SecretLiteralError } from "./errors.js";

/**
 * Reference grammar that is ALLOWED to appear in emitted content:
 *   - `${ENV_VAR}`         env-substitution reference
 *   - `op://vault/item/f`  1Password secret reference
 * Anything matching a secret-literal heuristic that is NOT one of these throws.
 */
const ENV_REF = /\$\{[A-Z0-9_]+\}/;
const OP_REF = /\bop:\/\/[^\s"']+/;

/**
 * Heuristic secret-literal markers (assignment of a long opaque value to a
 * secret-suggesting key). Deliberately conservative: the goal is to catch an authored
 * literal, not to validate consumer estates (that is core's `SecretRef` job).
 */
const SECRET_LITERAL =
  /\b(password|passwd|secret|token|api[_-]?key|apikey|bearer)\b\s*[:=]\s*['"]?[A-Za-z0-9/_+\-.]{12,}/i;

/**
 * Assert an emitted file contains no secret literal. Throws {@link SecretLiteralError}
 * (code `SECRET_LITERAL`) naming the file when a literal is found. A line whose only
 * secret-suggesting content is an `${ENV}` / `op://` reference is allowed.
 *
 * @param path - The emitted file path (for the error message), e.g. "claude/CLAUDE.md".
 * @param contents - The full emitted file contents.
 * @throws {SecretLiteralError} when a non-reference secret literal is detected.
 */
export function assertNoSecretLiterals(path: string, contents: string): void {
  for (const [i, line] of contents.split("\n").entries()) {
    if (!SECRET_LITERAL.test(line)) continue;
    // A reference on the same line is the sanctioned form — not a literal.
    if (ENV_REF.test(line) || OP_REF.test(line)) continue;
    throw new SecretLiteralError(path, `line ${i + 1}: ${line.trim()}`);
  }
}
