// src/server/routes/session.ts — the `/api/session` route (05 §6, 09 §5; M2 adds capabilities).
//
// Returns the per-request resolved identity (or null when disabled/untrusted/headerless), the exact
// configured authentication mode, and the three capabilities — false unless proxy-header mode ∧ a trusted
// identity ∧ a healthy write path (REQ-AUTHZ-02), derived via `currentCapabilities` (no provider → all
// false). It responds WITHOUT a cycle (§7): no shared cycle ETag or observation header.
// `Cache-Control: private, no-store` keeps a caller/proxy from caching an identity across principals.
// The route is GET-only and performs no authorization side effect — a direct/untrusted/headerless caller
// receives identity null even when the trusted header is present, because identity was resolved
// deny-by-default upstream (09 §§3–4).

import type { SessionPayload } from "@pulse/web-data/wire";

import { defineRoute } from "../../shared/registry.js";
import { currentCapabilities } from "../mutations/session-provider.js";

/** `GET /api/session` — identity, auth mode, and the three computed capabilities (REQ-AUTHZ-02). */
export const sessionRoute = defineRoute({
  method: "GET",
  path: "/api/session",
  handler: (_request, ctx) => {
    const body: SessionPayload = {
      identity: ctx.identity,
      authMode: ctx.config.identity.mode,
      capabilities: currentCapabilities(ctx.identity, ctx.config.identity.mode),
    };
    return Response.json(body, {
      status: 200,
      headers: { "cache-control": "private, no-store" },
    });
  },
});
