// In-process push server harness: the real server composition (config → push runtime → server runtime → fetch
// handler) on a 127.0.0.1 listener, with push pointed at the fake APNs. Every value is generated per run: the data
// directory, the provider key and both secrets. No engine is contacted; the server runtime's upstream fetch is a stub.

import { randomBytes, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PushEnvironment } from "@pulse/web-data/wire";

import type { StaticAssets } from "../../../src/server/assets.js";
import { loadServerConfig } from "../../../src/server/config.js";
import { buildPushRuntime, type PushRuntime } from "../../../src/server/push/bootstrap.js";
import { PUSH_ENV, PUSH_PATHS } from "../../../src/server/push/constants.js";
import { createServerRuntime, type ServerRuntime } from "../../../src/server/refresh.js";
import { createFetchHandler, dispatchMutation } from "../../../src/server/router.js";
import { makeEstateBundleFixture } from "../../factories/estate-bundle.js";
import { startFakeApns, type FakeApns } from "./fake-apns.js";
import { createTestApnsKey, writeTestKeyFile } from "./keys.js";
import { createTestTls } from "./tls.js";

/** A running harness. */
export interface PushTestServer {
  /** `http://127.0.0.1:<port>` (Bun.serve port 0). */
  readonly baseUrl: string;
  /** The push runtime the handler dispatches to. */
  readonly runtime: PushRuntime;
  /** The fake APNs the push runtime delivers to. */
  readonly apns: FakeApns;
  /** Test-only random secrets. */
  readonly secrets: { readonly webhook: string; readonly operator: string };
  /** The createFetchHandler result that the Bun.serve listener wraps, for socket-free calls. */
  readonly handler: (request: Request) => Promise<Response>;
  /** Post an Alertmanager v4 body with the webhook secret. */
  webhook(body: unknown): Promise<Response>;
  /** Issue a token via the admin route and return its link and token. */
  pair(): Promise<{ readonly link: string; readonly token: string }>;
  /** Redeem the link's token, then PUT /api/push/device with a 64-hex test token (default sandbox). */
  register(
    link: string,
    opts?: { readonly apnsToken?: string; readonly environment?: PushEnvironment },
  ): Promise<{ readonly deviceId: string; readonly credential: string }>;
  /** Stop the listener, close both runtimes and the fake APNs, remove the temp directory. */
  close(): Promise<void>;
}

/** Options of {@link startPushTestServer}. */
export interface PushTestServerOptions {
  /** Push state: "configured" (default), "disabled" (no push variable) or "misconfigured" (KEY_ID only). */
  readonly state?: "configured" | "disabled" | "misconfigured";
  /** Devices paired and registered before the harness resolves (configured only). Default 0. */
  readonly devices?: number;
  /** Extra env entries, applied last. */
  readonly env?: Readonly<Record<string, string>>;
  /** "stub-cycle" publishes one cycle whose overview has {@link STUB_CYCLE_ALERTS} firing alerts; "none" (default) publishes none. */
  readonly runtime?: "stub-cycle" | "none";
}

/** Firing alerts in the overview the "stub-cycle" runtime publishes. */
export const STUB_CYCLE_ALERTS = 3;

/** The public base the pairing links carry. */
export const HARNESS_EXTERNAL_URL = "https://pulse.example.com";

/** Placeholder APNs credentials (never real values). */
const KEY_ID = "HARNESS001";
const TEAM_ID = "HARNESSTM1";
const TOPIC = "com.example.pulse";

/** The API routes need no built client bundle. */
const STUB_ASSETS: StaticAssets = {
  get: () => undefined,
  shell: () => '<!doctype html><html lang="en"><body><div id="app"></div></body></html>',
  buildId: () => null,
};

const JSON_TYPE = { "content-type": "application/json" } as const;

/** A random secret well over the 32-byte minimum. */
function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** 64 lowercase hex characters, unique per call. */
function randomApnsToken(): string {
  return randomBytes(32).toString("hex");
}

/** A firing Alertmanager v2 API alert the data client accepts. */
function apiAlert(i: number): unknown {
  return {
    fingerprint: `00000000000000${i.toString(16).padStart(2, "0")}`,
    labels: { alertname: `HostDown${i}`, severity: "critical", instance: "web-01.example.com" },
    annotations: {},
    startsAt: "2026-11-20T11:00:00.000Z",
    endsAt: "2026-11-20T13:00:00.000Z",
    status: { state: "active", silencedBy: [], inhibitedBy: [] },
    receivers: [{ name: "default" }],
  };
}

/** Upstream stub: every engine answers an empty success; Alertmanager lists `alerts` firing alerts. */
function engineStub(alerts: number): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const u = new URL(input instanceof Request ? input.url : input.toString());
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { status: 200, headers: JSON_TYPE });
    switch (u.pathname) {
      case "/api/v1/query":
        return json({ status: "success", data: { resultType: "vector", result: [] } });
      case "/api/v1/query_range":
        return json({ status: "success", data: { resultType: "matrix", result: [] } });
      case "/api/v1/targets":
        return json({ status: "success", data: { activeTargets: [] } });
      case "/api/v1/status/buildinfo":
        return json({ status: "success", data: { version: "1.102.1" } });
      case "/api/v1/rules":
        return json({ status: "success", data: { groups: [] } });
      case "/api/v2/status":
        return json({ versionInfo: { version: "0.27.0" }, cluster: { status: "ready" } });
      case "/api/health":
        return json({ database: "ok", version: "11.4.0" });
      case "/api/v2/alerts":
        return json(Array.from({ length: alerts }, (_, i) => apiAlert(i)));
      default:
        return json([]);
    }
  };
  return impl as unknown as typeof fetch;
}

/** The env for one harness run. */
function harnessEnv(
  dir: string,
  state: "configured" | "disabled" | "misconfigured",
  secrets: { webhook: string; operator: string },
): { readonly env: Record<string, string>; readonly publicKey: KeyObject } {
  const f = makeEstateBundleFixture();
  const modelPath = join(dir, "web-estate-model.json");
  writeFileSync(modelPath, f.files.model);
  writeFileSync(join(dir, "web-coverage.json"), f.files.coverage ?? "");
  writeFileSync(join(dir, "web-findings.json"), f.files.findings ?? "");
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });

  const env: Record<string, string> = {
    PULSE_VM_URL: "http://localhost:8428",
    PULSE_ALERTMANAGER_URL: "http://localhost:9093",
    PULSE_GATUS_URL: "http://localhost:8080",
    PULSE_VMALERT_URL: "http://localhost:8880",
    PULSE_WEB_ESTATE_MODEL: modelPath,
    PULSE_WEB_EXTERNAL_URL: HARNESS_EXTERNAL_URL,
    [PUSH_ENV.dataDir]: dataDir,
  };
  // Only the configured state writes the key file; the fake APNs always needs a key to verify against.
  if (state !== "configured") {
    if (state === "misconfigured") env[PUSH_ENV.keyId] = KEY_ID;
    return { env, publicKey: createTestApnsKey().publicKey };
  }
  const key = writeTestKeyFile(dir);
  env[PUSH_ENV.keyFile] = key.path;
  env[PUSH_ENV.keyId] = KEY_ID;
  env[PUSH_ENV.teamId] = TEAM_ID;
  env[PUSH_ENV.topic] = TOPIC;
  env[PUSH_ENV.webhookSecret] = secrets.webhook;
  env[PUSH_ENV.operatorSecret] = secrets.operator;
  return { env, publicKey: key.publicKey };
}

/**
 * Build a config (temp data dir, test key, fake APNs origins), then start Bun.serve on 127.0.0.1:0. `state` picks the
 * push state: "configured" (default), "disabled" (no PULSE_PUSH_APNS_* variable), or "misconfigured" (KEY_ID only).
 * Throws when openssl is unavailable (the fake APNs needs a certificate); callers skip on `createTestTls() === null`.
 */
export async function startPushTestServer(opts: PushTestServerOptions = {}): Promise<PushTestServer> {
  const state = opts.state ?? "configured";
  const tls = createTestTls();
  if (tls === null) throw new Error("startPushTestServer needs openssl for the fake APNs certificate");

  const dir = mkdtempSync(join(tmpdir(), "pulse-push-server-"));
  const secrets = Object.freeze({ webhook: randomSecret(), operator: randomSecret() });
  const built = harnessEnv(dir, state, secrets);
  const env = { ...built.env, ...(opts.env ?? {}) };

  let apns: FakeApns | null = null;
  let push: PushRuntime | null = null;
  let runtime: ServerRuntime | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  const teardown = async (): Promise<void> => {
    server?.stop(true);
    runtime?.close();
    await push?.close();
    await apns?.close();
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    apns = await startFakeApns({ tls, providerPublicKey: built.publicKey });
    // The same order as the server entry: config, push runtime, server runtime, attach, fetch handler.
    const config = loadServerConfig(env);
    push = await buildPushRuntime(config, { apns: { origins: apns.origins, ca: apns.ca } });
    const alerts = opts.runtime === "stub-cycle" ? STUB_CYCLE_ALERTS : 0;
    runtime = createServerRuntime(config, { fetchImpl: engineStub(alerts) });
    push.attachRuntime(runtime);
    if (opts.runtime === "stub-cycle") await runtime.runOnce();

    const fetchHandler = createFetchHandler(runtime, STUB_ASSETS, dispatchMutation, push.dispatcher);
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request): Promise<Response> =>
        fetchHandler(request, {
          peerIp: listener.requestIP(request)?.address ?? null,
          disableTimeout: () => listener.timeout(request, 0),
        }),
    });
    server = listener;
    const baseUrl = `http://127.0.0.1:${listener.port}`;
    const handler = (request: Request): Promise<Response> =>
      fetchHandler(request, { peerIp: "127.0.0.1", disableTimeout() {} });

    const call = (method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> => {
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      return handler(new Request(`${baseUrl}${path}`, init));
    };

    const pair = async (): Promise<{ link: string; token: string }> => {
      const res = await call("POST", PUSH_PATHS.adminPairingTokens, {
        ...JSON_TYPE,
        authorization: `Bearer ${secrets.operator}`,
      }, {});
      if (res.status !== 201) throw new Error(`pair: admin pairing-tokens answered ${res.status}`);
      const { link } = (await res.json()) as { link: string };
      const token = new URL(link).searchParams.get("pair");
      if (token === null) throw new Error("pair: the link carries no pair token");
      return { link, token };
    };

    let registered = 0;
    const register = async (
      link: string,
      ropts: { readonly apnsToken?: string; readonly environment?: PushEnvironment } = {},
    ): Promise<{ deviceId: string; credential: string }> => {
      const token = new URL(link).searchParams.get("pair");
      if (token === null) throw new Error("register: the link carries no pair token");
      registered++;
      const redeemed = await call("POST", PUSH_PATHS.redeem, JSON_TYPE, {
        token,
        displayName: `Example iPhone ${registered}`,
      });
      if (redeemed.status !== 201) throw new Error(`register: redeem answered ${redeemed.status}`);
      const { deviceId, credential } = (await redeemed.json()) as { deviceId: string; credential: string };
      const put = await call("PUT", PUSH_PATHS.device, { ...JSON_TYPE, authorization: `Bearer ${credential}` }, {
        apnsToken: ropts.apnsToken ?? randomApnsToken(),
        environment: ropts.environment ?? "sandbox",
        preferences: { critical: true, warning: true, info: true },
      });
      if (put.status !== 200) throw new Error(`register: PUT device answered ${put.status}`);
      return { deviceId, credential };
    };

    const webhook = (body: unknown): Promise<Response> =>
      call("POST", PUSH_PATHS.webhook, { ...JSON_TYPE, authorization: `Bearer ${secrets.webhook}` }, body);

    for (let i = 0; i < (opts.devices ?? 0); i++) await register((await pair()).link);

    let closing: Promise<void> | null = null;
    const fakeApns = apns;
    const pushRuntime = push;
    return {
      baseUrl,
      runtime: pushRuntime,
      apns: fakeApns,
      secrets,
      handler,
      webhook,
      pair,
      register,
      close: () => (closing ??= teardown()),
    };
  } catch (err) {
    await teardown();
    throw err;
  }
}
