// src/client/views/engine/presentation.ts — total health words and component chip labels. Pure.

import { HEALTH_TEXT, formatLastGood } from "./labels.js";
import type { ComponentPresentation } from "./labels.js";

/** Total lookup for untrusted health strings (e.g. RuleState.health): unmapped → "Unknown".
 *  Mirrors `toStatus`, so the word and the status token always agree. */
export function healthText(h: string): string {
  // Own-property check, so prototype keys ("toString") also fall back, as in toStatus.
  return typeof h === "string" && Object.prototype.hasOwnProperty.call(HEALTH_TEXT, h)
    ? (HEALTH_TEXT as Readonly<Record<string, string>>)[h]!
    : "Unknown";
}

/**
 * Chip label for a presentation: the status word, plus " — " + formatLastGood(lastGoodAt) for
 * every kind except "healthy" and "not-configured" ("Stale — last good {t}", "Unreachable — …",
 * "Unknown — …"). Pure.
 */
export function presentationLabel(p: ComponentPresentation, format: (isoUtc: string) => string): string {
  return p.kind === "healthy" || p.kind === "not-configured"
    ? p.text
    : `${p.text} — ${formatLastGood(p.lastGoodAt, format)}`;
}
