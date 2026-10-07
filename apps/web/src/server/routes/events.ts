// src/server/routes/events.ts — the `GET /api/events` SSE handler (08 §§2–3). It is the ONLY route
// that disables the per-request server timeout (a stream is long-lived; §9), reads the reconnect
// `Last-Event-ID` header, and hands the connection to the process-lifetime stream registry captured
// on the context. The registry frames `retry`, heartbeats, and post-publication ticks; this handler
// only wires the request to it and returns the streaming body with the exact SSE headers.

import { defineRoute } from "../../shared/registry.js";
import { SSE_HEADERS } from "../events/stream.js";

/** `GET /api/events` — open one SSE stream. Disables the Bun per-request timeout (§9), converges to
 *  the current cycle from the reconnect `Last-Event-ID`, and streams retry/heartbeat/tick frames from
 *  the shared registry. The response carries no view body, history, session, identity, or secret. */
export const eventsRoute = defineRoute({
  method: "GET",
  path: "/api/events",
  handler: (request, context) => {
    request.disableTimeout(); // only `/api/events` disables its own Bun timeout (§9)
    const lastEventId = request.request.headers.get("last-event-id");
    const stream = context.events.connect(lastEventId);
    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  },
});
