// src/client/views/alerts/detail/silences-model.ts — silence matcher text, shared by the detail pane,
// the silences tab and the expire dialog.
import type { SilenceMatcher } from "@pulse/web-data/wire";

/**
 * Render a Prometheus/Alertmanager-style match expression for one silence matcher:
 *   isEqual && !isRegex → name="value"    | !isEqual && !isRegex → name!="value"
 *   isEqual &&  isRegex → name=~"value"    | !isEqual &&  isRegex → name!~"value"
 */
export function matcherExpression(m: SilenceMatcher): string {
  const op = m.isRegex ? (m.isEqual ? "=~" : "!~") : m.isEqual ? "=" : "!=";
  return `${m.name}${op}"${m.value}"`;
}
