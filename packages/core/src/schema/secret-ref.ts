/** Secret-*reference* grammars and lexical parser (00-core-definitions.md §2,
 *  02-inventory-schema.md §4.6). Recognition ONLY: these functions never read a
 *  process env var, never contact 1Password, and never resolve a value
 *  (REQ-SECR-03/REQ-SEC-01). ENV_REF_RE/OP_REF_RE are canonically declared here and
 *  referenced — not re-declared — by the shape (006) and semantic (009) layers. */

import { z } from "zod";

import type { SecretRef } from "../model/index.js";

/** Env-var reference grammar: `${ENV_VAR}` (upper-snake, leading letter/underscore). */
export const ENV_REF_RE = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

/** 1Password reference grammar: `op://vault/item/field`. */
export const OP_REF_RE = /^op:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+$/;

/** True iff `raw` is a well-formed `${ENV_VAR}` reference (lexical only). */
export function isEnvRef(raw: string): boolean {
  return ENV_REF_RE.test(raw);
}

/** True iff `raw` is a well-formed `op://vault/item/field` reference (lexical only). */
export function isOpRef(raw: string): boolean {
  return OP_REF_RE.test(raw);
}

/** True iff `raw` matches either secret-reference grammar. */
export function isSecretRef(raw: string): boolean {
  return isEnvRef(raw) || isOpRef(raw);
}

/** Parse `raw` into a SecretRef, or `undefined` if it matches no grammar. Purely
 *  lexical — never reads env/1Password/filesystem, never resolves a value. */
export function parseSecretRef(raw: string): SecretRef | undefined {
  if (ENV_REF_RE.test(raw)) {
    return { kind: "env", raw, varName: raw.slice(2, -1) };
  }
  if (OP_REF_RE.test(raw)) {
    const [vault, item, field] = raw.slice("op://".length).split("/");
    return { kind: "op", raw, vault: vault!, item: item!, field: field! };
  }
  return undefined;
}

/** Shape-layer slot for a credential: a non-empty string. The literal-vs-reference
 *  decision is a semantic single-field check routed through layer 04 (item 009), NOT
 *  made here. */
export const secretRefSchema = z.string().min(1);
