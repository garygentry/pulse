// apps/web/src/client/mutations/matchers.ts — silence matcher helpers (REQ-SIL-01..03; bounds mirror the server's silence validation).
import type { ActiveAlert, AlertsPayload } from "@pulse/web-data/wire";
import {
  ALERTNAME_LABEL, RATIONALE_MAX_CHARS, RATIONALE_MIN_CHARS, SILENCE_COMMENT_MAX_BYTES, SILENCE_COMMENT_PREFIX,
} from "../../shared/mutations.js";
import { codePoints } from "./client.js";
import type { SilenceMatcherInput } from "../../shared/mutations.js";
import type { FieldCounter } from "./Field.js";

/** Prometheus label-name grammar, as the server validates it. */
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/**
 * Server bounds: name ≤ 128 bytes; value 1–256 bytes. The server constants live in
 * handlers/silences.ts (client code may not import server modules); a test pins them.
 */
const LABEL_NAME_MAX_BYTES = 128;
const LABEL_VALUE_MAX_BYTES = 256;
const ENC = new TextEncoder();

/**
 * Fingerprint / silence-id limit, mirroring the server's MUTATION_ID_MAX_BYTES. The client
 * may not import server constants, so the literal is kept here and pinned by a test.
 */
export const CLIENT_ID_MAX_BYTES = 128;

/** Alert labels as exact matchers: alertname first, then by name (deterministic). */
export function defaultMatchers(alert: ActiveAlert): readonly SilenceMatcherInput[] {
  return Object.entries(alert.labels)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) =>
      a.name === ALERTNAME_LABEL ? -1 : b.name === ALERTNAME_LABEL ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Why the server's silence validation would refuse this matcher, or null when sendable. */
export function matcherIssue(m: SilenceMatcherInput): string | null {
  if (!LABEL_NAME_RE.test(m.name) || ENC.encode(m.name).length > LABEL_NAME_MAX_BYTES) return "Unusable label name.";
  const vb = ENC.encode(m.value).length;
  if (vb < 1 || vb > LABEL_VALUE_MAX_BYTES) return "Label value is empty or longer than 256 bytes.";
  return null;
}

/** Exact equality over every matcher; a missing label compares as "" (Alertmanager semantics). */
export function matchesAll(labels: Readonly<Record<string, string>>, matchers: readonly SilenceMatcherInput[]): boolean {
  return matchers.every((m) => (labels[m.name] ?? "") === m.value);
}

/** Alerts in the live payload the matchers would silence (SIL-03); includes already-suppressed rows. */
export function matchedCount(payload: AlertsPayload, matchers: readonly SilenceMatcherInput[]): number {
  let n = 0;
  for (const a of payload.alerts) if (matchesAll(a.labels, matchers)) n += 1;
  return n;
}

const CONTROL_EXCEPT_NL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

/**
 * Counter for a silence rationale (create and expire share the rule above). It reports whichever
 * limit binds first: code points for typical text, UTF-8 bytes once multi-byte text makes the
 * Alertmanager byte ceiling the tighter one.
 */
export function silenceRationaleCounter(raw: string): FieldCounter {
  const t = raw.trim();
  const chars = codePoints(t);
  const bytes = ENC.encode(SILENCE_COMMENT_PREFIX + t).length;
  return SILENCE_COMMENT_MAX_BYTES - bytes < RATIONALE_MAX_CHARS - chars
    ? { used: bytes, limit: SILENCE_COMMENT_MAX_BYTES, unit: "bytes" }
    : { used: chars, limit: RATIONALE_MAX_CHARS, unit: "characters" };
}

/**
 * Server rule: `min`–500 CODE POINTS after trim AND "[pulse] " + rationale ≤ 512 UTF-8 bytes; no control
 * chars but \n. Create requires 10 (the default); the optional expire rationale has no minimum (pass 0).
 */
export function silenceRationaleIssue(raw: string, min: number = RATIONALE_MIN_CHARS): string | null {
  const t = raw.trim();
  const n = codePoints(t);
  if (n < min) return `Enter at least ${min} characters.`;
  if (n > RATIONALE_MAX_CHARS) return `Use at most ${RATIONALE_MAX_CHARS} characters.`;
  if (ENC.encode(SILENCE_COMMENT_PREFIX + t).length > SILENCE_COMMENT_MAX_BYTES) return "Too long for Alertmanager: shorten the text.";
  if (CONTROL_EXCEPT_NL.test(t)) return "Remove control characters (line breaks are allowed).";
  return null;
}
