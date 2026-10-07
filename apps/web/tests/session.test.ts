// apps/web/tests/session.test.ts — request-identity integration + the `/api/session` route
// (05-http-routes-and-representations.md §§4, 6; 09-identity-audit-and-dark-mutation-seams.md §§3–5).
//
// Covers item 035's four acceptance criteria:
//   • The router resolves one per-request identity from the Bun peer/request and the validated
//     package IdentityConfig, passing it ONLY through the captured ServerContext (never a global).
//   • `/api/session` returns null/minimized identity, the exact configured auth mode, three
//     capabilities, false unless identity ∧ healthy write path (mutation-foundation 02 §4), and
//     `Cache-Control: private, no-store`.
//   • Direct / untrusted / malformed / trusted peer cases resolve correctly with no raw peer/header
//     value leaking into the response.
// No port is bound — `dispatch` is called directly (the prober idiom).

import { afterEach, describe, expect, test } from "bun:test";

import type { Identity } from "@pulse/web-data/identity";

import { dispatch } from "../src/server/router.js";
import { createServerRuntime, type ServerRuntime } from "../src/server/refresh.js";
import { loadServerConfig, type ServerConfig } from "../src/server/config.js";
import { ConfigError } from "../src/shared/errors.js";
import type { ServerContext } from "../src/shared/registry.js";
import type { RequestServices } from "../src/server/router.js";
import type { StaticAssets } from "../src/server/assets.js";
import { resetWritePathProvider, setWritePathProvider } from "../src/server/mutations/session-provider.js";
import type { WritePathReason, WritePathSnapshot, WritePathStore } from "../src/server/mutations/write-path.js";

// ── Shared helpers ───────────────────────────────────────────────────────────────────────────────

/** A full required env map (four engine URLs) plus optional identity overrides. */
function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PULSE_VM_URL: "http://victoriametrics:8428",
    PULSE_ALERTMANAGER_URL: "http://alertmanager:9093",
    PULSE_GATUS_URL: "http://gatus:8080",
    PULSE_VMALERT_URL: "http://vmalert:8880",
    ...over,
  };
}

/** The env for a proxy-header deployment trusting the 10.0.0.0/24 range on the default header. */
function proxyEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return env({
    PULSE_WEB_AUTH_MODE: "proxy-header",
    PULSE_WEB_TRUSTED_PROXIES: "10.0.0.0/24",
    ...over,
  });
}

const stubAssets: StaticAssets = {
  get: () => undefined,
  shell: () => "<!doctype html><div id=app></div>",
};

function services(peerIp: string | null): RequestServices {
  return { peerIp, disableTimeout() {} };
}

/** A GET `/api/session` request with optional headers. */
function sessionRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://web:8080/api/session", { method: "GET", headers });
}

interface SessionBody {
  identity: Identity | null;
  authMode: string;
  capabilities: Record<string, boolean>;
}

/** Dispatch `/api/session` against a runtime built from `cfg` env with the given peer/headers. */
async function getSession(
  cfgEnv: Record<string, string | undefined>,
  peerIp: string | null,
  headers: Record<string, string> = {},
): Promise<{ res: Response; body: SessionBody }> {
  const runtime = createServerRuntime(loadServerConfig(cfgEnv));
  const res = await dispatch(sessionRequest(headers), "/api/session", runtime, stubAssets, services(peerIp));
  const body = (await res.clone().json()) as SessionBody;
  return { res, body };
}

// ── config.identity parsing wiring (09 §2) ───────────────────────────────────────────────────────

describe("loadServerConfig wires the validated IdentityConfig (09 §2)", () => {
  test("defaults to none mode / Remote-User / empty trust when unset", () => {
    expect(loadServerConfig(env()).identity).toEqual({
      mode: "none",
      headerName: "Remote-User",
      trustedProxies: [],
    });
  });

  test("parses and canonicalizes proxy-header mode with a trusted CIDR", () => {
    const identity = loadServerConfig(
      proxyEnv({ PULSE_WEB_TRUSTED_PROXIES: "10.0.0.5/24", PULSE_WEB_AUTH_HEADER: "X-Auth-User" }),
    ).identity;
    expect(identity.mode).toBe("proxy-header");
    expect(identity.headerName).toBe("X-Auth-User");
    // The host bits are masked to the canonical network address.
    expect(identity.trustedProxies).toEqual(["10.0.0.0/24"]);
  });

  test("a malformed mode is a fatal ConfigError that prevents binding, without echoing the value", () => {
    let thrown: unknown;
    try {
      loadServerConfig(env({ PULSE_WEB_AUTH_MODE: "trust-everyone" }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const error = thrown as ConfigError;
    expect(error.envVar).toBe("PULSE_WEB_AUTH_MODE");
    // The message names the env key but never interpolates the rejected value (09 §2).
    expect(error.message).toBe("PULSE_WEB_AUTH_MODE must be none or proxy-header.");
    expect(error.message).not.toContain("trust-everyone");
  });

  test("a malformed CIDR is a fatal ConfigError that never echoes the value", () => {
    let thrown: unknown;
    try {
      loadServerConfig(proxyEnv({ PULSE_WEB_TRUSTED_PROXIES: "10.0.0.0/99,not-a-cidr" }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).not.toContain("not-a-cidr");
  });
});

// ── GET /api/session — representation contract (05 §6, 09 §5) ────────────────────────────────────

describe("GET /api/session representation (05 §6, 09 §5)", () => {
  test("none mode: identity null, authMode none, three literal-false capabilities, private/no-store", async () => {
    const { res, body } = await getSession(env(), "10.0.0.5", { "Remote-User": "alice" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(body.identity).toBeNull(); // none mode never trusts a header, even with a peer present
    expect(body.authMode).toBe("none");
    expect(body.capabilities).toEqual({ silence: false, ack: false, proposeEstateEdit: false });
  });

  test("proxy-header + trusted peer … minimized identity; capabilities all false under the default provider", async () => {
    const { res, body } = await getSession(proxyEnv(), "10.0.0.42", { "Remote-User": "alice" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(body.authMode).toBe("proxy-header");
    expect(body.identity).toEqual({ subject: "alice", displayName: "alice", source: "proxy-header" });
    // The identity object exposes EXACTLY the three minimized fields — no peer/raw-header metadata.
    expect(Object.keys(body.identity as object).sort()).toEqual(["displayName", "source", "subject"]);
    expect(body.capabilities).toEqual({ silence: false, ack: false, proposeEstateEdit: false });
  });

  test("proxy-header + UNTRUSTED (direct) peer → identity null even though the header is present", async () => {
    const { body } = await getSession(proxyEnv(), "203.0.113.9", { "Remote-User": "alice" });
    expect(body.identity).toBeNull();
    expect(body.authMode).toBe("proxy-header"); // the mode still reflects the exact configuration
  });

  test("proxy-header + trusted peer but NO header → identity null (headerless caller)", async () => {
    const { body } = await getSession(proxyEnv(), "10.0.0.42");
    expect(body.identity).toBeNull();
  });

  test("proxy-header + missing peer IP → identity null (no peer, no trust)", async () => {
    const { body } = await getSession(proxyEnv(), null, { "Remote-User": "alice" });
    expect(body.identity).toBeNull();
  });

  test("proxy-header + trusted peer but a malformed (control-bearing) header value → identity null", async () => {
    // A DEL (0x7f) control byte passes the Fetch Headers guard but fails resolveIdentity's control-free
    // check, so the value is rejected as anonymous rather than trusted.
    const { body } = await getSession(proxyEnv(), "10.0.0.42", { "Remote-User": "al\x7fice" });
    expect(body.identity).toBeNull();
  });
});

// ── AC-1: identity resolved once, carried only through the captured context ──────────────────────

describe("identity resolved once, passed only through the captured ServerContext (AC-1)", () => {
  /** A runtime that records every identity handed to `getContext`, over a real IdentityConfig. */
  function recordingRuntime(config: ServerConfig): { runtime: ServerRuntime; seen: Array<Identity | null> } {
    const seen: Array<Identity | null> = [];
    const runtime: ServerRuntime = {
      getContext: (identity) => {
        seen.push(identity);
        return Object.freeze({
          estate: null,
          cycle: null,
          history: {} as ServerContext["history"],
          events: {} as ServerContext["events"],
          sources: {} as ServerContext["sources"],
          config,
          identity,
          snapshot: null,
        });
      },
      identityConfig: config.identity,
      getStatus: () => ({
        sources: {
          metrics: { ok: true, lastSuccess: null, error: null },
          alerts: { ok: true, lastSuccess: null, error: null },
          checks: { ok: true, lastSuccess: null, error: null },
        },
        model: { loaded: true, formatVersion: 1, error: null },
        lastSnapshotAt: null,
      }),
      runOnce: async () => {},
      start: async () => {},
      close: () => {},
    };
    return { runtime, seen };
  }

  test("getContext is called exactly once with the resolved identity, and the body echoes it", async () => {
    const config = loadServerConfig(proxyEnv());
    const { runtime, seen } = recordingRuntime(config);
    const res = await dispatch(
      sessionRequest({ "Remote-User": "carol" }),
      "/api/session",
      runtime,
      stubAssets,
      services("10.0.0.7"),
    );
    const body = (await res.json()) as SessionBody;
    // Resolved exactly once and threaded through the single captured context (not a global).
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ subject: "carol", displayName: "carol", source: "proxy-header" });
    expect(body.identity).toEqual(seen[0] ?? null);
  });

  test("a subsequent anonymous (untrusted) request captures null — no identity persists", async () => {
    const config = loadServerConfig(proxyEnv());
    const { runtime, seen } = recordingRuntime(config);
    await dispatch(sessionRequest({ "Remote-User": "carol" }), "/api/session", runtime, stubAssets, services("10.0.0.7"));
    await dispatch(sessionRequest({ "Remote-User": "mallory" }), "/api/session", runtime, stubAssets, services("203.0.113.1"));
    expect(seen[0]).not.toBeNull(); // trusted
    expect(seen[1]).toBeNull(); // untrusted peer — no leak from the prior request
  });
});

// ── AC-3: no raw peer/header value leakage ───────────────────────────────────────────────────────

describe("no raw peer/header value leaks into the response (AC-3)", () => {
  test("a rejected malformed header value and the peer IP never appear in the body or headers", async () => {
    const peer = "10.0.0.55";
    const rawValue = "SECRET-LEAK-MARKER\x7f"; // control byte → rejected → identity null
    const { res, body } = await getSession(proxyEnv(), peer, { "Remote-User": rawValue });
    expect(body.identity).toBeNull();
    const serialized = JSON.stringify(body) + "\n" + [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    expect(serialized).not.toContain("SECRET-LEAK-MARKER");
    expect(serialized).not.toContain(peer);
  });

  test("a trusted identity exposes the minimized subject but never the peer IP", async () => {
    const peer = "10.0.0.88";
    const { res, body } = await getSession(proxyEnv(), peer, { "Remote-User": "dave" });
    expect(body.identity).toEqual({ subject: "dave", displayName: "dave", source: "proxy-header" });
    const serialized = JSON.stringify(body) + "\n" + [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    expect(serialized).not.toContain(peer); // the direct peer address is never surfaced
  });
});

// ── M2: capabilities are derived (mutation-foundation 02-m1-compatibility.md §4.3) ─────────────────

const OK = { ok: true, reason: null } as const;
function snapshot(down: Partial<Record<WritePathStore, WritePathReason>> = {}): WritePathSnapshot {
  const s = (store: WritePathStore) => (down[store] === undefined ? OK : { ok: false, reason: down[store]! });
  return { audit: s("audit"), acks: s("acks"), proposals: s("proposals"), secret: s("secret"), alertmanager: s("alertmanager") };
}
const ALL_FALSE = { silence: false, ack: false, proposeEstateEdit: false };
const ALL_TRUE = { silence: true, ack: true, proposeEstateEdit: true };

describe("capabilities: false without trusted identity or healthy write path (REQ-COMPAT-01, REQ-AUTHZ-02)", () => {
  afterEach(() => resetWritePathProvider());

  test("default provider: a trusted proxy-header identity still reports all false", async () => {
    resetWritePathProvider();
    const { body } = await getSession(proxyEnv(), "10.0.0.42", { "Remote-User": "alice" });
    expect(body.identity).not.toBeNull();
    expect(body.capabilities).toEqual(ALL_FALSE);
  });

  test("positive control: healthy write path + trusted identity → all true", async () => {
    setWritePathProvider(() => snapshot());
    const { body } = await getSession(proxyEnv(), "10.0.0.42", { "Remote-User": "alice" });
    expect(body.capabilities).toEqual(ALL_TRUE);
  });

  test("healthy write path but no trusted identity → all false", async () => {
    setWritePathProvider(() => snapshot());
    for (const [peer, headers] of [
      ["203.0.113.9", { "Remote-User": "alice" }], // untrusted peer
      ["10.0.0.42", {}], // headerless
      [null, { "Remote-User": "alice" }], // no peer
    ] as const) {
      const { body } = await getSession(proxyEnv(), peer, headers);
      expect(body.capabilities).toEqual(ALL_FALSE);
    }
  });

  test("healthy write path in none mode → all false (REQ-CFG-03)", async () => {
    setWritePathProvider(() => snapshot());
    const { body } = await getSession(env(), "10.0.0.42", { "Remote-User": "alice" });
    expect(body.capabilities).toEqual(ALL_FALSE);
  });

  const DEGRADED: ReadonlyArray<readonly [Partial<Record<WritePathStore, WritePathReason>>, Record<string, boolean>]> = [
    [{ audit: "unwritable" }, ALL_FALSE],
    [{ acks: "corrupt" }, { silence: true, ack: false, proposeEstateEdit: true }],
    [{ alertmanager: "not-configured" }, { silence: false, ack: true, proposeEstateEdit: true }],
    [{ proposals: "missing" }, { silence: true, ack: true, proposeEstateEdit: false }],
    [{ secret: "secret-missing" }, { silence: true, ack: true, proposeEstateEdit: false }],
  ];
  for (const [down, expected] of DEGRADED) {
    test(`degraded ${Object.keys(down).join(",")} → only dependent capabilities false`, async () => {
      setWritePathProvider(() => snapshot(down));
      const { body } = await getSession(proxyEnv(), "10.0.0.42", { "Remote-User": "alice" });
      expect(body.capabilities).toEqual(expected);
    });
  }

  test("a throwing provider fails closed → all false", async () => {
    setWritePathProvider(() => {
      throw new Error("probe exploded");
    });
    const { res, body } = await getSession(proxyEnv(), "10.0.0.42", { "Remote-User": "alice" });
    expect(res.status).toBe(200);
    expect(body.capabilities).toEqual(ALL_FALSE);
  });
});
