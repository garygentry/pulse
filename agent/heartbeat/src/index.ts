// agent/heartbeat/src/index.ts
//
// The per-host heartbeat exporter (03-bundle-and-heartbeat.md §5). A minimal `Bun.serve`
// process that runs on every managed-linux host and serves the bundle's own primary
// self-observability signal on HEARTBEAT_PORT (9110). It exposes exactly ONE readable
// endpoint (GET /metrics) and NO write/control surface (REQ-SEC-02, REQ-HB-03).
//
// The pure request router (`handleRequest`) and body renderer (`renderHeartbeat`) are
// exported as side-effect-free seams so unit tests can assert routing + exposition WITHOUT
// binding the real production port (06 §3.4). Only running this file as the container
// entrypoint (guarded by `import.meta.main`) starts the server.

import { HEARTBEAT_PORT } from "../../contract/constants.js";
import { PULSE_AGENT_UP, PULSE_AGENT_BUILD_INFO } from "../../contract/types.js";
import { AGENT_VERSION } from "./version.js";

/** Prometheus text exposition content type (v0.0.4). */
const EXPOSITION_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8" as const;

/**
 * Render the heartbeat exposition body.
 *
 * Emits exactly the two contract series (03 §5.1): `pulse_agent_up 1` (liveness) and
 * `pulse_agent_build_info{version,component="agent"} 1` (version carrier). The `host` label
 * is deliberately NOT emitted here — it is applied at scrape time via file_sd relabel
 * (03 §5.1, tech-spec §3.8), keeping the bundle estate-agnostic (REQ-BUNDLE-04).
 *
 * @param version - The baked agent build version (`AGENT_VERSION`, 03 §5.2).
 * @returns Prometheus text-exposition body (trailing newline included).
 */
export function renderHeartbeat(version: string): string {
  const escapedVersion = version
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
  return [
    `# HELP ${PULSE_AGENT_UP} Pulse managed-linux agent liveness (1 = alive).`,
    `# TYPE ${PULSE_AGENT_UP} gauge`,
    `${PULSE_AGENT_UP} 1`,
    `# HELP ${PULSE_AGENT_BUILD_INFO} Pulse agent build/version info (value always 1).`,
    `# TYPE ${PULSE_AGENT_BUILD_INFO} gauge`,
    `${PULSE_AGENT_BUILD_INFO}{version="${escapedVersion}",component="agent"} 1`,
    "",
  ].join("\n");
}

/**
 * Pure request router — the heartbeat serves ONLY `GET /metrics`; every other path is a 404
 * and every other method on `/metrics` is a 405 (03 §5.3: no write/control surface,
 * REQ-SEC-02). Exported so server-unit tests can assert routing WITHOUT binding
 * {@link HEARTBEAT_PORT} (06 §3.4).
 *
 * @param req - The incoming request.
 * @returns The response — the fixed exposition for `GET /metrics`, or a 404/405.
 */
export function handleRequest(req: Request): Response {
  const { pathname } = new URL(req.url);
  if (pathname !== "/metrics") {
    return new Response("not found\n", { status: 404 });
  }
  if (req.method !== "GET") {
    return new Response("method not allowed\n", { status: 405 });
  }
  return new Response(renderHeartbeat(AGENT_VERSION), {
    headers: { "Content-Type": EXPOSITION_CONTENT_TYPE },
  });
}

/**
 * Start the heartbeat HTTP server on {@link HEARTBEAT_PORT}.
 *
 * Serves `GET /metrics` only; every other method/path returns 404/405 (via
 * {@link handleRequest}). No write or control route exists (REQ-SEC-02). The server is the
 * process's sole responsibility; if it throws on bind, the process exits non-zero and the
 * supervisor (compose `restart: unless-stopped` / systemd `Restart=on-failure`) restarts it
 * (03 §Error Handling).
 *
 * @returns The running Bun server handle.
 */
export function startHeartbeatServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: HEARTBEAT_PORT,
    fetch: (req) => handleRequest(req),
  });
}

// Bun runs this file directly as the container command (Dockerfile CMD). The
// `import.meta.main` guard means importing `renderHeartbeat`/`handleRequest` in a test does
// NOT start the server — only executing this file as the entrypoint binds HEARTBEAT_PORT
// (06 §3.4 hermetic imports).
if (import.meta.main) {
  startHeartbeatServer();
}
