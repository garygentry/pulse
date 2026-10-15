// apps/web/src/client/api/proxy-answer.ts — recognise an auth proxy answering in Pulse's place
// (GitHub #64). Shared by the view API client and the mutation client; browser-safe, no imports.

/** The fetch-spec redirect statuses (304 Not Modified is not a redirect). */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Whether `res` is a redirect. Requests send `redirect: "manual"`, so a browser hands back an
 * `opaqueredirect` response (status 0, no readable headers) for ANY redirect, same- or cross-origin,
 * and a non-browser fetch returns the raw 3xx. The Pulse API never redirects, so a redirect is an
 * auth proxy sending an expired session to its login page.
 */
export function isRedirect(res: Response): boolean {
  return res.type === "opaqueredirect" || REDIRECT_STATUSES.has(res.status);
}

/**
 * Whether a 2xx is a page rather than a Pulse API answer: an HTML body (a login page served in
 * place of the API), or a response a fetch implementation reached by following a redirect. Every
 * Pulse API 2xx is `application/json`.
 */
export function isLoginPage(res: Response): boolean {
  if (res.redirected) return true;
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  return type.startsWith("text/html") || type.startsWith("application/xhtml+xml");
}
