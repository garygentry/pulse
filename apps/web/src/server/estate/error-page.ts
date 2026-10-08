// src/server/estate/error-page.ts — the error-page HTML (REQ-MODEL-03).
//
// When the estate bundle cannot be loaded/validated (06 `EstateBundleError`), every SPA route serves
// this page instead of the grid. It names the file (`error.path`), the problem (`error.message`),
// and the fix path — agent-actionable, never a blank or partial grid. Pure string construction: no
// I/O, no `Response`. The HTTP mapping (status codes, which routes short-circuit) is the router (§4.2).

import type { EstateBundleError } from "../../shared/errors.js";
import { cspHash, staticPageContentSecurityPolicy } from "../security-headers.js";

/** The page's one inline stylesheet — the exact text of its `<style>` element. */
const ERROR_PAGE_STYLE = `
      body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #1a1a1a; color: #eee; }
      main { max-width: 46rem; margin: 0 auto; }
      h1 { color: #ff6b6b; font-size: 1.4rem; }
      code { background: #000; padding: 0.1rem 0.35rem; border-radius: 3px; }
      .detail { background: #000; padding: 1rem; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
      .kind { color: #ffd166; }
    `;

/** The page's Content-Security-Policy: no script, nothing fetched, and only `ERROR_PAGE_STYLE`
 *  applies (its hash is computed here from the same constant, so it cannot drift). */
export const ERROR_PAGE_CSP = staticPageContentSecurityPolicy([cspHash(ERROR_PAGE_STYLE)]);

/** Minimal HTML-escape for interpolated error text (the model path/message are operator-controlled,
 *  but escaping keeps the page well-formed regardless of their content). */
function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render the standalone error page for an `EstateBundleError`. Names the kind, the in-container
 * member path, and the full agent-actionable message (which already carries the fix path — `pulse
 * render`, mount check). Served with `200` + `text/html` on SPA routes in error-page mode (§4.4).
 *
 * @param error - The held estate-bundle error driving error-page mode.
 * @returns The full HTML document as a string.
 */
export function renderErrorPage(error: EstateBundleError): string {
  const kind = escapeHtml(error.kind);
  const path = escapeHtml(error.path);
  const message = escapeHtml(error.message);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pulse — Estate model unavailable</title>
    <style>${ERROR_PAGE_STYLE}</style>
  </head>
  <body>
    <main>
      <h1>Estate model unavailable</h1>
      <p>The Pulse web app could not load its estate model, so the overview grid cannot render.</p>
      <p>Problem: <span class="kind">${kind}</span> at <code>${path}</code></p>
      <p class="detail">${message}</p>
      <p>The app recovers automatically within one refresh cycle once a valid model is available — no restart needed.</p>
    </main>
  </body>
</html>
`;
}
