// agent/prober/src/credential.ts
//
// Probe-credential resolution (02-deep-health-prober.md §5, REQ-PROBE-03 / REQ-SEC-01).
// A probe credential is a `SecretRef.raw` string only — never a literal. The resolved
// value comes from an environment variable that `deploy-toolkit` injects at deploy time
// (tech-spec §3.4). v1 mechanically supports the `${ENV}` form (the shipped
// `SecretRef.kind === "env"`); any other reference form (e.g. `op://…`) is expected to
// have been rewritten upstream into an injected env var, and fails visibly here otherwise.
//
// The resolved token is NEVER logged and NEVER written to any metric, error message, or
// file (REQ-SEC-01): error messages carry only the env-var NAME, never its value.

import { ProbeExecutionError } from "./errors.js";

/** `${VARNAME}` → capture the env var name; used to look the resolved secret up at runtime. */
const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Resolve a probe credential reference to a Bearer token from the supplied environment
 * (REQ-PROBE-03, REQ-SEC-01). The prober only ever sees a `SecretRef.raw` string; the
 * resolved value comes from an env var `deploy-toolkit` injected (tech-spec §3.4).
 *
 * - `undefined` credential → `undefined` (no `Authorization` header; an unauthenticated probe).
 * - `${VARNAME}` → `env[VARNAME]`. A declared credential whose env var is MISSING/empty is a
 *   fail-visible probe error (REQ-PROBE-04) — the endpoint would 401, so failing visibly is
 *   correct.
 * - Any non-`${ENV}` form (e.g. `op://…`) → fail-visible: v1 has no mechanical name to look up,
 *   so `deploy-toolkit` must have rewritten it to a `${ENV}` reference upstream (§5 WARNING).
 *
 * @param credentialRaw - `DeepHealthProbeConfig.credential` (a `SecretRef.raw` string) or undefined.
 * @param env - Env map to resolve against (test seam, `ProbeOptions.env`). Default: `process.env`.
 * @returns The resolved Bearer token, or `undefined` when no credential is declared.
 * @throws {ProbeExecutionError} reason `"unreachable"` when a credential is declared but cannot be
 *   resolved (unset env var, or an unsupported reference form). The token value never appears.
 */
export function resolveBearer(
  credentialRaw: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (credentialRaw === undefined) return undefined;
  const varName = ENV_REF.exec(credentialRaw)?.[1];
  if (varName === undefined) {
    // op:// or any non-`${ENV}` form: v1 expects deploy-toolkit to have injected a resolved env
    // var. Without a mechanical name we cannot look it up → fail visibly (§5 WARNING). The raw
    // reference is not echoed, so a malformed reference cannot leak a value.
    throw new ProbeExecutionError(
      "<credential>",
      "unreachable",
      "unsupported credential reference form (v1 supports ${ENV}); resolve upstream",
    );
  }
  const token = env[varName];
  if (token === undefined || token === "") {
    throw new ProbeExecutionError(
      "<credential>",
      "unreachable",
      `credential env var ${varName} is not set in the prober environment`,
    );
  }
  return token;
}
