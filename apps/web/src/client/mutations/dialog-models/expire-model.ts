// apps/web/src/client/mutations/dialog-models/expire-model.ts — pure expire-silence dialog logic: the
// silence id length check, the optional rationale rule and the request body. No React;
// the dialog lives in dialogs/ExpireDialog.tsx.
import type { ExpireSilenceBody } from "../../../shared/mutations.js";
import { CLIENT_ID_MAX_BYTES, silenceRationaleIssue } from "../matchers.js";

const ENC = new TextEncoder();

/** Silence id length check (mirrors the server's MUTATION_ID_MAX_BYTES). null when acceptable. */
export function expireIdError(silenceId: string): string | null {
  return ENC.encode(silenceId).length > CLIENT_ID_MAX_BYTES
    ? "This silence id is too long to expire from Pulse; use Alertmanager instead." : null;
}

/** The rationale is optional: its rules apply only when it is non-empty (no minimum). */
export function expireRationaleError(rationale: string): string | null {
  return rationale.trim() === "" ? null : silenceRationaleIssue(rationale, 0);
}

/** Expire body: the rationale is trimmed and omitted when empty. */
export function expireSilenceBody(silenceId: string, rationale: string): ExpireSilenceBody {
  const r = rationale.trim();
  return { silenceId, ...(r !== "" ? { rationale: r } : {}) };
}
