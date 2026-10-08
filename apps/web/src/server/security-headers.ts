// src/server/security-headers.ts — the Content-Security-Policy and hardening headers (issue #2).
//
// One module owns every security header the web server sends, so the policy is read in one place:
//   • `inlineScriptHashes(html)` — the CSP hash of each inline EXECUTABLE script in an HTML document.
//     `scripts/build-client.ts` runs it over `src/client/index.html` and records the result in
//     `manifest.json` (`inlineScriptHashes`), so the policy is never hand-maintained: edit the inline
//     script, rebuild, and the new hash ships with it. Data islands (`type="application/json"`) are
//     inert and need no hash.
//   • `shellContentSecurityPolicy(hashes)` — the policy for the SPA shell document.
//   • `withSecurityHeaders(res)` — the per-response-type header set, applied by `createFetchHandler`
//     to every response it returns (shell, error page, `/assets/*`, `/api/*`, health/metrics).
//
// Architecture: docs/architecture/web-foundation/architecture.md § Security headers.

import { createHash, randomBytes } from "node:crypto";

/** A CSP hash source without its quotes: `sha256-<base64>`. */
export type CspHash = `sha256-${string}`;

/** Shape of one recorded hash (`sha256-` + standard base64 of a 32-byte digest). */
export const CSP_HASH_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;

/** `type` values that make a `<script>` executable as a classic or module script (HTML §4.12.1.1:
 *  absent, empty, a JavaScript MIME type essence, or `module`). Anything else is a data block. */
const JS_MIME_TYPES = new Set([
  "",
  "module",
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

/** Read one attribute's value from a start tag's attribute text, or `null` when absent. */
function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*(?:=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+)))?`, "i").exec(attrs);
  if (match === null) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

/** The CSP hash source of a script's text: SHA-256 over its UTF-8 bytes, base64. */
export function cspHash(text: string): CspHash {
  return `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`;
}

/**
 * The CSP hash of every inline executable `<script>` in `html`, in document order, deduplicated.
 * External scripts (`src=`) are covered by `'self'`; data blocks (any non-JavaScript `type`, e.g. the
 * `application/json` chunk-css island) never execute, so CSP does not apply to them. HTML comments
 * are skipped. Line endings are normalised to `\n`, as the HTML parser does before CSP hashes the
 * element's text.
 */
export function inlineScriptHashes(html: string): CspHash[] {
  const source = html.replace(/<!--[\s\S]*?-->/g, "");
  const hashes: CspHash[] = [];
  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = match[1] ?? "";
    if (attribute(attrs, "src") !== null) continue;
    const type = attribute(attrs, "type");
    if (type !== null && !JS_MIME_TYPES.has(type.trim().toLowerCase())) continue;
    const hash = cspHash((match[2] ?? "").replace(/\r\n?/g, "\n"));
    if (!hashes.includes(hash)) hashes.push(hash);
  }
  return hashes;
}

/** Serialise directives (name → sources) into a policy string, in insertion order. */
function serialise(directives: Readonly<Record<string, readonly string[]>>): string {
  return Object.entries(directives)
    .map(([name, sources]) => (sources.length > 0 ? `${name} ${sources.join(" ")}` : name))
    .join("; ");
}

/**
 * The SPA shell's Content-Security-Policy. Dev and production share it: the dev loop's reload
 * channel is a same-origin poll of `/__dev/build-id`, and the dev bundle evaluates no strings.
 *
 * `style-src` carries no `'unsafe-inline'`. The app's stylesheets are same-origin files, and React,
 * Radix, and uPlot set inline styles through the CSSOM (`element.style`), which CSP does not govern.
 * The one `<style>` element the app creates at runtime is react-remove-scroll's scroll lock (every
 * modal Radix dialog, sheet, select, and menu); it carries the per-response `styleNonce`, which the
 * client hands to `get-nonce` from the shell's nonce meta. A `style="…"` attribute in parsed markup
 * stays blocked. The zero-violation browser suite (`tests/browser/csp.test.ts`) guards all of it.
 *
 * @param scriptHashes - Hashes of the shell's inline scripts (manifest `inlineScriptHashes`).
 * @param styleNonce - This response's style nonce; omitted, no runtime `<style>` element applies.
 */
export function shellContentSecurityPolicy(scriptHashes: readonly string[], styleNonce?: string): string {
  return serialise({
    "default-src": ["'self'"],
    "script-src": ["'self'", ...scriptHashes.map((h) => `'${h}'`)],
    "style-src": ["'self'", ...(styleNonce !== undefined ? [`'nonce-${styleNonce}'`] : [])],
    "img-src": ["'self'", "data:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  });
}

/** `name` of the shell meta that carries the style nonce in its `nonce` attribute. Duplicated as
 *  `SHELL_MARKERS.cspNonceMeta` on both sides of the server/client wall (pinned by a test). */
export const CSP_NONCE_META = "pulse-csp-nonce" as const;

/** A fresh CSP nonce: 128 random bits, base64. One per shell response. */
export function newCspNonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * Stamp `<meta name="pulse-csp-nonce" nonce="…">` into a shell, just before `</head>` (appended when
 * the shell has no head close). The value sits in the `nonce` attribute, which browsers hide from
 * the DOM attribute API and CSS selectors once a CSP header applies; scripts read it through the
 * element's `.nonce` property.
 */
export function withCspNonceMeta(shell: string, nonce: string): string {
  const tag = `    <meta name="${CSP_NONCE_META}" nonce="${nonce}">\n`;
  const at = shell.indexOf("</head>");
  return at === -1 ? shell + tag : `${shell.slice(0, at)}${tag}  ${shell.slice(at)}`;
}

/**
 * The policy for a standalone server-rendered HTML page with no script and one inline `<style>`
 * element (the estate-model error page): nothing loads, only that exact stylesheet applies.
 *
 * @param styleHashes - Hashes of the page's inline `<style>` elements.
 */
export function staticPageContentSecurityPolicy(styleHashes: readonly string[]): string {
  return serialise({
    "default-src": ["'none'"],
    "style-src": styleHashes.map((h) => `'${h}'`),
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
    "frame-ancestors": ["'none'"],
  });
}

/** Headers every response carries, whatever its type. */
export const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};

/** Powerful features the operator UI never uses, disabled for the document and any frame. */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "usb=()",
].join(", ");

/** Headers an HTML document additionally carries (its CSP comes from the caller). */
export const DOCUMENT_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": PERMISSIONS_POLICY,
};

/** Is this response an HTML document? */
function isHtml(res: Response): boolean {
  return res.headers.get("content-type")?.toLowerCase().startsWith("text/html") ?? false;
}

/**
 * Return `res` with the security headers for its type: the base set on every response; on an HTML
 * document also COOP, Permissions-Policy, and `documentPolicy` as its CSP unless the response
 * already names its own (the error page does). Existing values are never overwritten. A Response
 * whose headers are immutable is copied (its body stream is moved, not read).
 *
 * @param res - The response the router produced.
 * @param documentPolicy - The CSP for an HTML document that does not carry one.
 */
export function withSecurityHeaders(res: Response, documentPolicy: string): Response {
  const extra: Record<string, string> = { ...BASE_SECURITY_HEADERS };
  if (isHtml(res)) {
    Object.assign(extra, DOCUMENT_SECURITY_HEADERS, { "content-security-policy": documentPolicy });
  }
  const missing = Object.entries(extra).filter(([name]) => !res.headers.has(name));
  if (missing.length === 0) return res;
  try {
    for (const [name, value] of missing) res.headers.set(name, value);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    for (const [name, value] of missing) headers.set(name, value);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}
