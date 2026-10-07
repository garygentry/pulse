// packages/renderer/src/render/secrets.ts — the secret-refusal choke-point (02 §7).
//
// A single place that serializes every credential to its REFERENCE form and refuses any
// non-`SecretRef` handed to a credential slot (REQ-RND-09, REQ-SEC-02). Defense-in-depth: a
// validated `EstateModel` already holds every credential as a typed `SecretRef`, so the refusal
// branch is impossible on the happy path — but it guarantees no literal ever reaches the tree.
import type { SecretRef, Finding } from "@pulse/core";
import { FINDING_CODES } from "@pulse/core";

/** Where a credential was found — used to build a precise refusal `Finding`. */
export interface CredentialSite {
  /** Rendered file the credential would have been written to, e.g. `"alertmanager/routing.yaml"`. */
  file: string;
  /** snake_case field path within that file, e.g. `"receivers.team-chat.credential"`. */
  path: string;
}

/** The outcome of serializing one credential: the reference string, or a refusal finding. */
export type SecretRenderResult =
  | { ok: true; ref: string }
  | { ok: false; finding: Finding };

/**
 * Serialize a credential to its REFERENCE form (REQ-RND-09, REQ-SEC-02). On a valid typed
 * `SecretRef` returns `{ ok: true, ref: value.raw }` — the original reference text (`${TOKEN}`
 * or `op://vault/item/field`). NEVER resolves, reads, or fetches a value.
 *
 * Defense-in-depth: if handed a non-`SecretRef` in a credential slot (should be impossible
 * post-validation), returns `{ ok: false, finding }` — an ERROR `Finding` with
 * `code: FINDING_CODES.SECRET_LITERAL` naming the file/field and a fix. NEVER a silent pass,
 * NEVER a crash, NEVER an embedded literal.
 *
 * @param value - The credential from the model — expected `SecretRef`, guarded as `unknown`.
 * @param site  - Where the credential lives, for a precise refusal finding.
 * @returns `{ ok: true, ref }` on success, `{ ok: false, finding }` on a refused literal.
 */
export function renderSecretRef(value: unknown, site: CredentialSite): SecretRenderResult {
  if (isSecretRefShape(value)) {
    return { ok: true, ref: value.raw }; // reference form ONLY — never resolved (REQ-SEC-02)
  }
  return {
    ok: false,
    finding: {
      severity: "error",
      code: FINDING_CODES.SECRET_LITERAL, // "secret_literal" — reused verbatim (CON-04)
      file: site.file,
      path: site.path,
      message:
        "A credential slot did not contain a secret reference. The renderer refuses to " +
        "emit a secret literal into the rendered tree.",
      fix:
        'Declare this credential as a reference (e.g. "${ENV_VAR}" or ' +
        '"op://vault/item/field") in the estate config; never a literal value.',
    },
  };
}

/**
 * Structural guard for the typed `SecretRef` union. Checks the discriminant + `.raw`, never
 * inspecting any (absent) resolved value. This is the ONLY place a credential's shape is
 * trusted; a non-match routes to the refusal branch above. A runtime shape check, NOT a re-parse
 * (`isSecretRef`/`parseSecretRef` are NOT on core's barrel — 06 §3).
 */
function isSecretRefShape(v: unknown): v is SecretRef {
  return (
    typeof v === "object" &&
    v !== null &&
    "kind" in v &&
    ((v as { kind: unknown }).kind === "env" || (v as { kind: unknown }).kind === "op") &&
    "raw" in v &&
    typeof (v as { raw: unknown }).raw === "string"
  );
}
