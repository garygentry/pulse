// src/server/dev/protocol.ts — shared dev-loop protocol constants and event shapes.
//
// Env-var names, endpoint paths, and event shapes are defined here so the supervisor (writer)
// and the child (reader) never disagree on the wire. No behaviour — just literals and types
// (spec 00 §2.2/§2.3, 04-dev-loop.md §7).

/** Env-var names the supervisor sets on the child (re-sent verbatim on every restart, REQ-DEV-13). */
export const DEV_ENV = {
  /** `"1"` — informational marker that the process is the dev composition root. */
  DEV: "PULSE_WEB_DEV",
  /** Listen port as a decimal string; `"0"` = OS-assigned. */
  PORT: "PULSE_WEB_PORT",
  /** Bind hostname. */
  HOST: "PULSE_WEB_HOST",
  /** Absolute path of the served asset dir (`apps/web/dist/client`). */
  CLIENT_DIR: "PULSE_WEB_CLIENT_DIR",
  /** Scenario name; present only in mock mode. */
  MOCK_SCENARIO: "PULSE_WEB_MOCK_SCENARIO",
  /** Optional ISO-8601 scenario start (`--clock`). */
  MOCK_CLOCK: "PULSE_WEB_MOCK_CLOCK",
  /** Build id the supervisor stamps into the child's snapshot appVersion. */
  BUILD_ID: "PULSE_WEB_BUILD_ID",
} as const;

/** Path the dev composition root answers before delegating to the production handler (REQ-DEV-05).
 *  The CLIENT carries its own identical literal in `src/client/api/client.ts` — the two must stay
 *  equal (`tests/live-state.test.ts`). */
export const DEV_BUILD_ID_PATH = "/__dev/build-id" as const;

/** Default estate model for the dev loop when `PULSE_WEB_ESTATE_MODEL` is unset (REQ-DEV-08),
 *  relative to the repo root. */
export const DEV_DEFAULT_ESTATE_MODEL = "examples/reference/rendered/web-estate-model.json" as const;

/** Body of `GET /__dev/build-id` (REQ-DEV-05). `null` when the loader is in fallback mode. */
export interface DevBuildIdResponse {
  /** The currently served manifest's `buildId`, or `null` in manifest-fallback mode. */
  buildId: string | null;
  /** ISO-8601 timestamp of when the dev server started; lets a client detect a restart even when
   *  the buildId is unchanged. */
  startedAt: string;
}

/** The structured line the child logs once bound; the supervisor parses it for the listening
 *  line and the REQ-DEV-11 smoke test parses it for the bound port (spec 00 §2.3). */
export interface DevServerListeningEvent {
  /** The `LogEvent.event` discriminant; the supervisor matches on this literal. */
  event: "dev_server_listening";
  /** Always `true` — the event is only emitted after a successful bind. */
  ok: true;
  /** The BOUND port from `Bun.serve` (differs from the requested port under `--port 0`). */
  port: number;
  /** The bind address the child listened on (`DEV_ENV.HOST`, loopback by default). */
  host: string;
  /** Active mock scenario, or `null` in env/engine mode. */
  mock: string | null;
  /** The build id the child is currently serving, or `null` in fallback mode. */
  buildId: string | null;
}
