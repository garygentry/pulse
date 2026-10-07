// apps/web/src/client/mutations/dialog-models/ack-model.ts — pure ack-dialog logic: the note rule, the
// fingerprint length check and the request bodies. No React; the dialog lives in
// dialogs/AckDialog.tsx.
import { ACK_NOTE_MAX_CHARS } from "../../../shared/mutations.js";
import type { RemoveAckBody, SetAckBody } from "../../../shared/mutations.js";
import { codePoints } from "../client.js";
import { CLIENT_ID_MAX_BYTES } from "../matchers.js";

const ENC = new TextEncoder();
const CONTROL_EXCEPT_NL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

/** Note rule (same as the server's): ≤ ACK_NOTE_MAX_CHARS code points after trim; no control chars except \n. */
export function ackNoteError(raw: string): string | null {
  const t = raw.trim();
  if (codePoints(t) > ACK_NOTE_MAX_CHARS) return `Use at most ${ACK_NOTE_MAX_CHARS} characters.`;
  if (CONTROL_EXCEPT_NL.test(t)) return "Remove control characters (line breaks are allowed).";
  return null;
}

/** The two ack actions; each has its own idempotency key. */
export type AckAction = "set" | "remove";

/** Fingerprint length check (mirrors the server's MUTATION_ID_MAX_BYTES). null when acceptable. */
export function ackFingerprintError(fingerprint: string): string | null {
  return ENC.encode(fingerprint).length > CLIENT_ID_MAX_BYTES
    ? "This alert's fingerprint is too long to acknowledge from Pulse." : null;
}

/** Set/replace body: the note is trimmed and omitted when empty. */
export function setAckBody(fingerprint: string, note: string): SetAckBody {
  const trimmed = note.trim();
  return { fingerprint, ...(trimmed !== "" ? { note: trimmed } : {}) };
}

/** Remove body. */
export function removeAckBody(fingerprint: string): RemoveAckBody {
  return { fingerprint };
}
