// src/server/routes/connect-link.ts — `GET /api/connect-link`.
//
// The web UI's only way to learn `PULSE_WEB_EXTERNAL_URL`. Web-only: not part of the client API
// contract. No access control: the link carries no secret and is shown to anyone who can reach the
// web UI. The link is built once at startup; the handler does no URL work and reads no request
// header, so the payload never reflects `Host` or `X-Forwarded-*`.

import type { ConnectLinkPayload } from "../../shared/connect-link.js";
import { ENV } from "../../shared/constants.js";
import { defineRoute } from "../../shared/registry.js";
import { UNSET_EXTERNAL_URL, type ExternalUrlState } from "../config.js";

/**
 * Map the startup-parsed state to the payload. Pure and total.
 * - usable  → `{ configured: { link, baseUrl }, refusal: null }`
 * - refused → `{ configured: null, refusal: { reason, envVar } }`
 * - unset   → `{ configured: null, refusal: null }` (the UI builds from the browsing address)
 */
export function connectLinkPayload(state: ExternalUrlState): ConnectLinkPayload {
  switch (state.state) {
    case "usable":
      return { configured: { link: state.link, baseUrl: state.baseUrl }, refusal: null };
    case "refused":
      return { configured: null, refusal: { reason: state.refusal, envVar: ENV.WEB_EXTERNAL_URL } };
    case "unset":
      return { configured: null, refusal: null };
  }
}

/** `GET /api/connect-link`: 200 `ConnectLinkPayload`, `Cache-Control: private, no-store`. Never errors. */
export const connectLinkRoute = defineRoute({
  method: "GET",
  path: "/api/connect-link",
  handler: (_request, ctx) => {
    // Defensive read: direct-dispatch tests may pass a partial context.
    const state = ctx?.config?.externalUrl ?? UNSET_EXTERNAL_URL;
    return Response.json(connectLinkPayload(state), {
      status: 200,
      headers: { "cache-control": "private, no-store" },
    });
  },
});
