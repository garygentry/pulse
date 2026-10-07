// src/client/views/alerts/detail/labels-annotations-model.ts — the single safe-link helper every
// alert-provided URL render path uses. Alert-provided URLs are untrusted.

/**
 * Return a safe href for an untrusted, alert-provided URL, or null if it must not be linked.
 * Only absolute `http:` / `https:` URLs are allowed; `javascript:`, `data:`, `vbscript:`, `file:`,
 * relative, and unparseable inputs return null (no anchor is rendered). Pair every rendered anchor
 * with rel="noopener noreferrer".
 *
 * @param url - The raw annotation value (e.g. annotations["runbook_url"]).
 * @returns The normalized href string when the scheme is allowlisted, otherwise null.
 */
export function safeHref(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url); // no base: relative inputs throw → rejected (runbook URLs are absolute)
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
}
