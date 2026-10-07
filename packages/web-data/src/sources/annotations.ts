// packages/web-data/src/sources/annotations.ts — bounded selection of alert/rule annotations,
// shared by the Alertmanager and vmalert clients.
//
// Annotations are display prose (summary, description) and runbook links, not identity. Rule
// authors routinely write descriptions of a few hundred bytes, so they get their own, larger
// value bound, and an over-long value never fails the source: prose is truncated on a UTF-8
// boundary with a trailing ellipsis, and an over-long runbook link is dropped (a cut URL would be
// a broken link). Labels keep the strict fail-closed bounds in each client, because they carry
// the relationships triage depends on.

/** Allowlisted annotation keys: summary, description, runbook display. */
export const ANNOTATION_ALLOWLIST: ReadonlySet<string> = new Set(["summary", "description", "runbook", "runbook_url"]);

/** Maximum UTF-8 bytes kept for one annotation value (the ellipsis included). */
export const MAX_ANNOTATION_VALUE_BYTES = 4_096;

/** Keys whose values are links: dropped rather than truncated when over the bound. */
const LINK_KEYS: ReadonlySet<string> = new Set(["runbook", "runbook_url"]);

const ELLIPSIS = "…";
const utf8 = new TextEncoder();

/** Truncate `value` to at most `maxBytes` UTF-8 bytes including a trailing ellipsis, never splitting a code point. */
function truncateUtf8(value: string, maxBytes: number): string {
  const budget = maxBytes - utf8.encode(ELLIPSIS).length;
  let used = 0;
  let out = "";
  for (const ch of value) {
    const n = utf8.encode(ch).length;
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return out + ELLIPSIS;
}

/**
 * Select the allowlisted annotations from `raw`, in key order, bounding each value to
 * {@link MAX_ANNOTATION_VALUE_BYTES}: prose is truncated with an ellipsis, links are dropped.
 * Unknown keys are dropped. Never throws.
 */
export function selectAnnotations(raw: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(raw).sort()) {
    if (!ANNOTATION_ALLOWLIST.has(key)) continue;
    const value = raw[key] ?? "";
    if (utf8.encode(value).length <= MAX_ANNOTATION_VALUE_BYTES) out[key] = value;
    else if (!LINK_KEYS.has(key)) out[key] = truncateUtf8(value, MAX_ANNOTATION_VALUE_BYTES);
  }
  return out;
}
