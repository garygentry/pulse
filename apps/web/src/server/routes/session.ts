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
//
// The body also carries the contract handshake (`contract`: version plus server capabilities). The
// optional `X-Pulse-Client` / `X-Pulse-Contract` announcement is bucketed into bounded labels and
// counted; it never changes the response, and raw header values are never logged or used as a label.

import type { SessionPayload } from "@pulse/web-data/wire";
import {
  CONTRACT_VERSION,
  currentServerCapabilities,
  handshakeLabels,
  parseClientAnnouncement,
} from "@pulse/web-data/contract";

import { defineRoute } from "../../shared/registry.js";
import { currentCapabilities } from "../mutations/session-provider.js";
import { recordClientHandshake } from "./metrics.js";

/**
 * `GET /api/session`: identity, auth mode, the three per-identity capabilities (REQ-AUTHZ-02), and the
 * contract handshake.
 *
 * The optional client announcement headers are parsed, bucketed into bounded labels and counted. They
 * never change the response: status, body and headers are identical with or without them. Computed
 * from in-process state only: no upstream call and no read of the cycle, sources, history or events.
 *
 * @returns 200 `SessionPayload`, `Cache-Control: private, no-store`. Never an error status because of
 *   the handshake: the announcement parser, the label bucketing and the capability registry never throw.
 */
export const sessionRoute = defineRoute({
  method: "GET",
  path: "/api/session",
  handler: (request, ctx) => {
    // Recorded before the body is built so the counter increments on every 200.
    recordClientHandshake(handshakeLabels(parseClientAnnouncement(request.request.headers)));
    const body: SessionPayload = {
      identity: ctx.identity,
      authMode: ctx.config.identity.mode,
      capabilities: currentCapabilities(ctx.identity, ctx.config.identity.mode),
      // Spelled out member by member: a spread would copy any future non-wire member of the version object.
      contract: {
        major: CONTRACT_VERSION.major,
        minor: CONTRACT_VERSION.minor,
        capabilities: currentServerCapabilities(),
      },
    };
    return Response.json(body, {
      status: 200,
      headers: { "cache-control": "private, no-store" },
    });
  },
});
