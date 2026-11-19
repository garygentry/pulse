// apps/web/tests/connect-route.test.ts — `GET /api/connect-link`.
//
// The route maps the startup-parsed external address to one of three payloads. It never reflects a
// request header, is never cached, and stays live in bundle-error mode. No port is bound —
// `dispatch` is called directly.

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildConnectLink } from "@pulse/web-data/contract";

import type { StaticAssets } from "../src/server/assets.js";
import { loadServerConfig, UNSET_EXTERNAL_URL } from "../src/server/config.js";
import { createServerRuntime, type ServerRuntime } from "../src/server/refresh.js";
import { dispatch, type RequestServices } from "../src/server/router.js";
import { connectLinkPayload, connectLinkRoute } from "../src/server/routes/connect-link.js";
import { ROUTES } from "../src/server/routes/registry.js";
import type { ConnectLinkPayload } from "../src/shared/connect-link.js";

const VAR = "PULSE_WEB_EXTERNAL_URL";

/** A full required env map (four engine URLs) plus optional overrides. */
function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PULSE_VM_URL: "http://victoriametrics:8428",
    PULSE_ALERTMANAGER_URL: "http://alertmanager:9093",
    PULSE_GATUS_URL: "http://gatus:8080",
    PULSE_VMALERT_URL: "http://vmalert:8880",
    ...over,
  };
}

const stubAssets: StaticAssets = {
  get: () => undefined,
  shell: () => "<!doctype html><div id=app></div>",
};

const services: RequestServices = { peerIp: null, disableTimeout() {} };

const built = buildConnectLink("https://pulse.example.com");
if (!built.ok) throw new Error("placeholder address must build");
const LINK = built.link;

let runtime: ServerRuntime | null = null;
let logSpy: Mock<(...args: unknown[]) => void>;
beforeEach(() => {
  // A refused address logs one config_warning; keep it out of the test output.
  logSpy = spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  runtime?.close();
  runtime = null;
  logSpy.mockRestore();
});

/** Dispatch a request for `/api/connect-link` through the real router. */
async function request(
  rt: ServerRuntime,
  init: { method?: string; headers?: Record<string, string>; search?: string } = {},
): Promise<Response> {
  const req = new Request(`http://web:8080/api/connect-link${init.search ?? ""}`, {
    method: init.method ?? "GET",
    ...(init.headers !== undefined ? { headers: init.headers } : {}),
  });
  return dispatch(req, "/api/connect-link", rt, stubAssets, services);
}

function boot(externalUrl: string | undefined): ServerRuntime {
  runtime = createServerRuntime(loadServerConfig(env({ [VAR]: externalUrl })));
  return runtime;
}

const STATES: readonly (readonly [string, string | undefined, ConnectLinkPayload])[] = [
  ["usable", "https://pulse.example.com", { configured: { link: LINK, baseUrl: "https://pulse.example.com" }, refusal: null }],
  ["refused", "http://pulse.example.com", { configured: null, refusal: { reason: "not-https", envVar: VAR } }],
  ["unset", undefined, { configured: null, refusal: null }],
];

describe("GET /api/connect-link payload states", () => {
  for (const [name, value, expected] of STATES) {
    test(`${name}: 200, private no-store, exact payload`, async () => {
      const res = await request(boot(value));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("cache-control")).toContain("no-store");
      const body = (await res.json()) as ConnectLinkPayload;
      expect(body).toEqual(expected);
      expect(body.configured !== null && body.refusal !== null).toBe(false);
    });
  }

  test("the usable body is the documented JSON, byte for byte", async () => {
    const res = await request(boot("https://pulse.example.com/"));
    expect(await res.text()).toBe(
      `{"configured":{"link":${JSON.stringify(LINK)},"baseUrl":"https://pulse.example.com"},"refusal":null}`,
    );
  });

  test("each soft refusal reason is carried through", () => {
    for (const reason of ["not-https", "loopback", "too-long"] as const) {
      expect(connectLinkPayload({ state: "refused", refusal: reason })).toEqual({
        configured: null,
        refusal: { reason, envVar: VAR },
      });
    }
    expect(connectLinkPayload(UNSET_EXTERNAL_URL)).toEqual({ configured: null, refusal: null });
  });

  test("the payload never reflects Host or X-Forwarded-* headers", async () => {
    for (const [, value] of STATES) {
      const rt = boot(value);
      const plain = await (await request(rt)).text();
      const spoofed = await (
        await request(rt, {
          headers: {
            host: "other.example.net",
            "x-forwarded-host": "other.example.net",
            "x-forwarded-proto": "http",
            "x-forwarded-for": "198.51.100.7",
          },
        })
      ).text();
      expect(spoofed).toBe(plain);
      expect(spoofed).not.toContain("other.example.net");
      rt.close();
      runtime = null;
    }
  });
});

describe("GET /api/connect-link routing", () => {
  test("is registered as a GET-only route", () => {
    expect(connectLinkRoute.method).toBe("GET");
    expect(connectLinkRoute.path).toBe("/api/connect-link");
    expect(ROUTES).toContain(connectLinkRoute);
  });

  test("POST returns 405", async () => {
    const res = await request(boot("https://pulse.example.com"), { method: "POST" });
    expect(res.status).toBe(405);
  });

  test("a repeated query key returns 400", async () => {
    const res = await request(boot(undefined), { search: "?a=1&a=2" });
    expect(res.status).toBe(400);
  });

  test("a partial context falls back to the unset payload", async () => {
    const res = await connectLinkRoute.handler(
      {
        request: new Request("http://web:8080/api/connect-link"),
        params: {},
        routePattern: "/api/connect-link",
        peerIp: null,
        disableTimeout() {},
      },
      {} as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: null, refusal: null });
  });
});

describe("GET /api/connect-link in bundle-error mode", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pulse-connect-route-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Every upstream is unreachable; the route must not depend on any of them. */
  const unreachable = (async () => new Response("upstream unreachable", { status: 502 })) as unknown as typeof fetch;

  test("returns 200 with the payload while /api/overview is the bundle 503", async () => {
    const modelPath = join(dir, "web-estate-model.json");
    writeFileSync(modelPath, "{ not json");
    writeFileSync(join(dir, "web-coverage.json"), "");
    writeFileSync(join(dir, "web-findings.json"), "");
    const rt = createServerRuntime(
      loadServerConfig(env({ PULSE_WEB_ESTATE_MODEL: modelPath, [VAR]: "https://pulse.example.com" })),
      { fetchImpl: unreachable, monotonicNow: () => 0, wallNow: () => new Date() },
    );
    runtime = rt;
    await rt.runOnce();

    const overview = await dispatch(
      new Request("http://web:8080/api/overview"),
      "/api/overview",
      rt,
      stubAssets,
      services,
    );
    expect(overview.status).toBe(503);
    expect(String(((await overview.json()) as { code: unknown }).code)).toMatch(/^ESTATE_BUNDLE_/);

    const res = await request(rt);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({
      configured: { link: LINK, baseUrl: "https://pulse.example.com" },
      refusal: null,
    });
  });
});
