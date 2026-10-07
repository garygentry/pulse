// apps/web/src/client/mutations/dialog-models/silence-model.ts — pure logic behind the create-silence dialog
// (bounds mirror the server's silence validation): duration presets and caps, end-time and
// fingerprint validation, the datetime-local formatter and the request-body builder. No JSX, no React.
import {
  SILENCE_MAX_DURATION_MS, SILENCE_PRESETS_MS,
} from "../../../shared/mutations.js";
import type { CreateSilenceBody, SilenceMatcherInput } from "../../../shared/mutations.js";
import { CLIENT_ID_MAX_BYTES, silenceRationaleIssue } from "../matchers.js";

/** Margin below the inclusive server cap so client clock skew never trips the server's `endsAt ≤ now + 7d` check. */
export const SILENCE_CAP_MARGIN_MS = 60_000;
/** Largest duration the client sends: 7 d − 60 s. */
export const SILENCE_CLIENT_MAX_MS = SILENCE_MAX_DURATION_MS - SILENCE_CAP_MARGIN_MS;

/** A duration choice in the dialog. */
export type Preset = "1h" | "2h" | "4h" | "24h" | "7d" | "custom";
/** Duration of each fixed preset. */
export const PRESET_MS: Readonly<Record<Exclude<Preset, "custom">, number>> = {
  "1h": SILENCE_PRESETS_MS[0]!,
  "2h": SILENCE_PRESETS_MS[1]!,        // = SILENCE_DEFAULT_DURATION_MS
  "4h": SILENCE_PRESETS_MS[2]!,
  "24h": SILENCE_PRESETS_MS[3]!,
  "7d": SILENCE_CLIENT_MAX_MS,         // 7 d − 60 s (skew margin), NOT SILENCE_PRESETS_MS[4]
};
/** Radio options for the duration choice, in display order. */
export const PRESET_OPTIONS: readonly { readonly value: Preset; readonly label: string }[] = [
  { value: "1h", label: "1 hour" }, { value: "2h", label: "2 hours" }, { value: "4h", label: "4 hours" },
  { value: "24h", label: "24 hours" }, { value: "7d", label: "7 days" }, { value: "custom", label: "Custom end time" },
];
const ENC = new TextEncoder();
/** How long after the first send a same-key retry still replays the identical body. */
export const REPLAY_WINDOW_MS = 60_000;
/**
 * Server rule: 10–500 CODE POINTS after trim AND "[pulse] " + rationale ≤ 512 UTF-8 bytes; no control chars but \n.
 * Implemented in matchers.ts so ExpireDialog can share it without importing the lazy dialog chunk.
 */
export const rationaleError: (raw: string) => string | null = silenceRationaleIssue;

/** now < endsAt ≤ now + 7 d − 60 s, evaluated at submit time. */
export function endsAtError(endsMs: number, nowMs: number): string | null {
  if (!Number.isFinite(endsMs)) return "Enter a valid end time.";
  if (endsMs <= nowMs) return "The end time must be in the future.";
  if (endsMs - nowMs > SILENCE_CLIENT_MAX_MS) return "A silence can last at most 7 days.";
  return null;
}

/** Refusal for a fingerprint too long to send (mirrors the server's MUTATION_ID_MAX_BYTES), else null. */
export function fingerprintError(fingerprint: string): string | null {
  return ENC.encode(fingerprint).length > CLIENT_ID_MAX_BYTES
    ? "This alert's fingerprint is too long to silence from Pulse." : null;
}

/** "YYYY-MM-DDTHH:mm" in local time for datetime-local. */
export function toLocalInput(ms: number): string {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** The create-silence request body. */
export function buildSilenceBody(
  fingerprint: string, chosen: readonly SilenceMatcherInput[], endsAtMs: number, rationale: string,
): CreateSilenceBody {
  return {
    fingerprint,
    matchers: chosen.map((m) => ({ name: m.name, value: m.value })),
    endsAt: new Date(endsAtMs).toISOString(),
    rationale: rationale.trim(),
  };
}
