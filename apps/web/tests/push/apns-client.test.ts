// apps/web/tests/push/apns-client.test.ts — the APNs HTTP/2 client against the fake APNs over a real loopback
// TLS connection, with a fake clock and fake timers for every timeout, ping and idle-close decision. It also pins
// the bun node:http2 client behaviours the delivery queue relies on.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createPrivateKey } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:http2";
import { join } from "node:path";

import type { ApnsSettings } from "../../src/server/push/config.js";
import { PUSH_LIMITS } from "../../src/server/push/constants.js";
import {
  APNS_ORIGINS,
  createApnsClient,
  type ApnsClient,
  type ApnsRequest,
} from "../../src/server/push/apns/client.js";
import { createProviderTokenSigner, type ProviderTokenSigner } from "../../src/server/push/apns/jwt.js";
import { startFakeApns, type FakeApns } from "./helpers/fake-apns.js";
import { createFakeClock, createFakeTimers, type FakeClock, type FakeTimers } from "./helpers/fakes.js";
import { createTestApnsKey } from "./helpers/keys.js";
import { buildTestTls, createTestTls } from "./helpers/tls.js";

const tls = createTestTls();
const SKIP_REASON = "requires openssl (S-12); skipped locally when it is missing";
const TOKEN = "a".repeat(64);
const OTHER = "b".repeat(64);
const TOPIC = "com.example.pulse";
const START_MS = Date.UTC(2026, 10, 20, 12, 0, 0);

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

function request(body: unknown = { aps: { alert: { title: "HostDown", body: "web-01.example.com" } } }): ApnsRequest {
  return {
    headers: {
      "apns-push-type": "alert",
      "apns-topic": TOPIC,
      "apns-priority": "10",
      "apns-expiration": "1795176000",
      "apns-collapse-id": "a-0123456789abcdef",
    },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

describe("APNS_ORIGINS", () => {
  test("is frozen with one https origin per environment", () => {
    expect(Object.isFrozen(APNS_ORIGINS)).toBe(true);
    expect(Object.keys(APNS_ORIGINS).sort()).toEqual(["production", "sandbox"]);
    for (const origin of Object.values(APNS_ORIGINS)) expect(origin.startsWith("https://")).toBe(true);
  });

  test("the push source never disables certificate checks and writes Apple's hosts only in apns/client.ts", () => {
    const root = join(import.meta.dir, "../../src/server/push");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(root);
    const hosts = Object.values(APNS_ORIGINS).map((o) => new URL(o).hostname);
    const flagName = ["reject", "Unauthorized"].join("");
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const rel = file.slice(root.length + 1);
      expect({ rel, flag: text.includes(flagName) }).toEqual({ rel, flag: false });
      if (rel !== join("apns", "client.ts")) {
        for (const host of hosts) expect({ rel, host: text.includes(host) }).toEqual({ rel, host: false });
      }
    }
  });
});

describe.skipIf(tls === null)(`APNs client against the fake APNs (${SKIP_REASON})`, () => {
  const providerKey = createTestApnsKey();
  const settings: ApnsSettings = Object.freeze({
    key: createPrivateKey(providerKey.pem),
    keyId: "ABC123DEFG",
    teamId: "TEAM456XYZ",
    topic: TOPIC,
  });

  let fake: FakeApns | undefined;
  let client: ApnsClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await fake?.close();
    fake = undefined;
  });

  interface Rig {
    readonly apns: FakeApns;
    readonly client: ApnsClient;
    readonly clock: FakeClock;
    readonly timers: FakeTimers;
    readonly signer: ProviderTokenSigner;
    readonly written: Array<{ environment: string; token: string; atMs: number }>;
  }

  async function rig(
    opts: { maxConcurrentStreams?: number; ca?: string; signer?: ProviderTokenSigner } = {},
  ): Promise<Rig> {
    if (tls === null) throw new Error("unreachable");
    const apns = await startFakeApns({
      tls,
      providerPublicKey: providerKey.publicKey,
      ...(opts.maxConcurrentStreams !== undefined ? { maxConcurrentStreams: opts.maxConcurrentStreams } : {}),
    });
    fake = apns;
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const signer = opts.signer ?? createProviderTokenSigner(settings.key, settings.keyId, settings.teamId, clock);
    const written: Rig["written"] = [];
    const c = createApnsClient(
      settings,
      signer,
      { origins: apns.origins, ca: opts.ca ?? apns.ca, clock, timers },
      { onRequestWritten: (environment, token, atMs) => written.push({ environment, token, atMs }) },
    );
    client = c;
    return { apns, client: c, clock, timers, signer, written };
  }

  test("sends a verified provider token, the fixed pseudo-headers and every ApnsRequest header", async () => {
    const r = await rig();
    const req = request();
    const result = await r.client.send("sandbox", TOKEN, req);
    expect(result).toEqual({ kind: "response", status: 200, reason: null });
    expect(r.apns.requests).toHaveLength(1);
    const seen = r.apns.requests[0];
    if (seen === undefined) throw new Error("no request");
    expect(seen.jwtValid).toBe(true);
    expect(seen.environment).toBe("sandbox");
    expect(seen.headers[":method"]).toBe("POST");
    expect(seen.path).toBe(`/3/device/${TOKEN}`);
    expect(seen.headers.authorization?.startsWith("bearer ")).toBe(true);
    expect(seen.headers["apns-topic"]).toBe(settings.topic);
    for (const [name, value] of Object.entries(req.headers)) expect(seen.headers[name]).toBe(value);
    expect(seen.headers["content-type"]).toBe("application/json");
    expect(seen.body).toEqual(JSON.parse(new TextDecoder().decode(req.body)));
    expect(r.written).toEqual([{ environment: "sandbox", token: TOKEN, atMs: START_MS }]);
  });

  test("apns-topic is always settings.topic, overriding the request's value", async () => {
    const r = await rig();
    const req = request();
    await r.client.send("production", TOKEN, { ...req, headers: { ...req.headers, "apns-topic": "com.example.other" } });
    expect(r.apns.requests[0]?.headers["apns-topic"]).toBe(TOPIC);
    expect(r.apns.requests[0]?.environment).toBe("production");
  });

  test("returns :status and {reason}; an empty or non-JSON body gives reason null", async () => {
    const r = await rig();
    r.apns.script(
      TOKEN,
      { kind: "status", status: 410, reason: "Unregistered" },
      { kind: "status", status: 500, body: "<html>oops</html>" },
      { kind: "status", status: 503, body: '{"reason":7}' },
      { kind: "status", status: 429 },
    );
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "response", status: 410, reason: "Unregistered" });
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "response", status: 500, reason: null });
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "response", status: 503, reason: null });
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "response", status: 429, reason: null });
    expect(r.apns.connections).toBe(1);
  });

  test("reconnects after a GOAWAY: the next send opens a new session and succeeds", async () => {
    const r = await rig();
    r.apns.script(TOKEN, { kind: "goaway" });
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "response", status: 200, reason: null });
    // The GOAWAY frame follows the response on the wire; a send racing it would be refused (and retried by the
    // queue). Give the loopback a moment so this test exercises the post-GOAWAY path.
    await Bun.sleep(50);
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "response", status: 200, reason: null });
    expect(r.apns.connections).toBe(2);
  });

  test("reconnects after the server destroys the socket", async () => {
    const r = await rig();
    r.apns.script(TOKEN, { kind: "destroy-socket" });
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "error", error: "session" });
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "response", status: 200, reason: null });
    expect(r.apns.connections).toBe(2);
  });

  test("an unanswered request times out after 10 s of fake time and the stream is reset", async () => {
    const r = await rig();
    r.apns.script(TOKEN, { kind: "hang" });
    let settled = false;
    const pending = r.client.send("sandbox", TOKEN, request()).finally(() => {
      settled = true;
    });
    await until(() => r.apns.requests.length === 1);
    r.timers.advance(PUSH_LIMITS.apnsRequestTimeoutMs - 1);
    await Bun.sleep(20);
    expect(settled).toBe(false);
    r.timers.advance(1);
    expect(await pending).toEqual({ kind: "error", error: "timeout" });
    await until(() => r.apns.streamResets === 1);
  });

  test("pings every 60 s while the session is active", async () => {
    const r = await rig();
    await r.client.send("sandbox", TOKEN, request());
    expect(r.apns.pings).toBe(0);
    r.timers.advance(PUSH_LIMITS.apnsPingIntervalMs);
    await until(() => r.apns.pings === 1);
    r.timers.advance(PUSH_LIMITS.apnsPingIntervalMs);
    await until(() => r.apns.pings === 2);
  });

  test("idle-closes the session after 10 min without sends and clears its timers", async () => {
    const r = await rig();
    await r.client.send("sandbox", TOKEN, request());
    expect(r.timers.pending()).toBe(2); // ping interval + idle close
    r.timers.advance(PUSH_LIMITS.apnsIdleCloseMs - 1);
    expect(r.timers.pending()).toBe(2);
    r.timers.advance(1);
    expect(r.timers.pending()).toBe(0);
    // Pings sent during the 10 minutes are still in flight on the loopback; let them land first.
    await Bun.sleep(100);
    const pingsAtClose = r.apns.pings;
    expect(pingsAtClose).toBeGreaterThanOrEqual(9);
    r.timers.advance(PUSH_LIMITS.apnsPingIntervalMs * 3);
    await Bun.sleep(50);
    expect(r.apns.pings).toBe(pingsAtClose);
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "response", status: 200, reason: null });
    expect(r.apns.connections).toBe(2);
  });

  test("a send inside the idle window keeps the session", async () => {
    const r = await rig();
    await r.client.send("sandbox", TOKEN, request());
    r.timers.advance(PUSH_LIMITS.apnsIdleCloseMs - 1_000);
    await r.client.send("sandbox", TOKEN, request());
    r.timers.advance(2_000);
    await r.client.send("sandbox", TOKEN, request());
    expect(r.apns.connections).toBe(1);
  });

  test("403 ExpiredProviderToken then 200 is one send result with two wire requests and a fresh token", async () => {
    const r = await rig();
    r.apns.script(TOKEN, { kind: "status", status: 403, reason: "ExpiredProviderToken" });
    const invalidate = spyOn(r.signer, "invalidate");
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "response", status: 200, reason: null });
    expect(r.apns.requests).toHaveLength(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(r.written).toHaveLength(2);
    expect(r.apns.requests.every((q) => q.jwtValid)).toBe(true);
  });

  test("a second ExpiredProviderToken reaches the caller: never two immediate retries", async () => {
    const r = await rig();
    r.apns.script(
      TOKEN,
      { kind: "status", status: 403, reason: "ExpiredProviderToken" },
      { kind: "status", status: 403, reason: "ExpiredProviderToken" },
    );
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({
      kind: "response",
      status: 403,
      reason: "ExpiredProviderToken",
    });
    expect(r.apns.requests).toHaveLength(2);
  });

  test("close() settles in-flight requests as session, resolves, and later sends fail at once", async () => {
    const r = await rig();
    r.apns.script(TOKEN, { kind: "hang" });
    r.apns.script(OTHER, { kind: "hang" });
    const a = r.client.send("sandbox", TOKEN, request());
    const b = r.client.send("production", OTHER, request());
    await until(() => r.apns.requests.length === 2);
    await r.client.close();
    expect(await a).toEqual({ kind: "error", error: "session" });
    expect(await b).toEqual({ kind: "error", error: "session" });
    const before = r.apns.requests.length;
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "error", error: "session" });
    expect(r.apns.requests.length).toBe(before);
    expect(r.timers.pending()).toBe(0);
    expect(r.client.close()).toBe(r.client.close());
  });

  test("a CA that does not trust the fake's certificate yields connection", async () => {
    const other = buildTestTls({ openssl: Bun.which("openssl"), ci: false });
    if (other === null) throw new Error("openssl vanished");
    const r = await rig({ ca: other.cert });
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "error", error: "connection" });
    expect(r.apns.requests).toHaveLength(0);
  });

  test("a throwing signer becomes session and logs push_internal_error {route: apns} once per client", async () => {
    const broken: ProviderTokenSigner = {
      current() {
        throw new Error("boom with secret material");
      },
      invalidate() {},
    };
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const r = await rig({ signer: broken });
      expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "error", error: "session" });
      expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "error", error: "session" });
      expect(r.apns.requests).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.filter((e) => e.event === "push_internal_error")).toHaveLength(1);
    const evt = events[0] ?? {};
    expect(Object.keys(evt).sort()).toEqual(["event", "ok", "route", "ts"]);
    expect(evt.route).toBe("apns");
    expect(lines.join("\n")).not.toContain("boom");
  });

  test("with maxConcurrentStreams 1, 20 concurrent sends all complete on one session", async () => {
    const r = await rig({ maxConcurrentStreams: 1 });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => r.client.send("sandbox", i.toString(16).padStart(64, "0"), request())),
    );
    expect(results.every((x) => x.kind === "response" && x.status === 200)).toBe(true);
    expect(r.apns.requests).toHaveLength(20);
    expect(r.apns.connections).toBe(1);
  });

  test("a slow device's stream never blocks another device on the same session", async () => {
    const r = await rig();
    r.apns.script(TOKEN, { kind: "hang" });
    const slow = r.client.send("sandbox", TOKEN, request());
    for (let i = 0; i < 3; i += 1) {
      expect(await r.client.send("sandbox", OTHER, request())).toEqual({ kind: "response", status: 200, reason: null });
    }
    r.timers.advance(PUSH_LIMITS.apnsRequestTimeoutMs);
    expect(await slow).toEqual({ kind: "error", error: "timeout" });
    expect(r.apns.connections).toBe(1);
  });

  test("a dropped stream (RST without a response) settles as session", async () => {
    const r = await rig();
    r.apns.script(TOKEN, { kind: "drop" });
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "error", error: "session" });
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "response", status: 200, reason: null });
  });

  test("a response body over 4096 bytes is truncated and still returns the status", async () => {
    const r = await rig();
    r.apns.script(TOKEN, { kind: "status", status: 400, body: "x".repeat(20_000) });
    expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "response", status: 400, reason: null });
  });

  // --- bun 1.3.9 node:http2 client behaviours the delivery queue depends on -------------------------------------

  describe("bun http2 behaviour", () => {
    test("goaway event / refused streams: goaway fires and an in-flight stream on the old session settles as session", async () => {
      const r = await rig();
      // Raw probe: bun emits "goaway" on the client session, then closes it.
      r.apns.script(TOKEN, { kind: "goaway" });
      const raw = connect(r.apns.origins.sandbox, { ca: r.apns.ca });
      raw.on("error", () => {});
      const goaway = new Promise<number>((resolve) => raw.once("goaway", (code: number) => resolve(code)));
      const probe = raw.request({ ":method": "POST", ":path": `/3/device/${TOKEN}`, authorization: `bearer ${r.signer.current()}` });
      probe.on("data", () => {});
      probe.on("error", () => {});
      probe.end("{}");
      expect(await goaway).toBe(0);
      await until(() => raw.closed || raw.destroyed);
      raw.destroy();

      // Through the client: an accepted but unanswered stream is closed with the session after GOAWAY (bun closes
      // the session at once instead of draining it), which the client reports as `session` without waiting for
      // the 10 s timeout. The next send opens a new session.
      r.apns.script(OTHER, { kind: "hang" });
      r.apns.script(TOKEN, { kind: "goaway" });
      const connectionsBefore = r.apns.connections;
      const inFlight = r.client.send("sandbox", OTHER, request());
      await until(() => r.apns.requests.some((q) => q.path.endsWith(OTHER)));
      expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "response", status: 200, reason: null });
      expect(await inFlight).toEqual({ kind: "error", error: "session" });
      expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "response", status: 200, reason: null });
      expect(r.apns.connections).toBe(connectionsBefore + 2);
    });

    test("NGHTTP2_CANCEL reset: stream.close(NGHTTP2_CANCEL) on a stream without a response reaches the server as a reset", async () => {
      const r = await rig();
      r.apns.script(TOKEN, { kind: "hang" });
      const pending = r.client.send("sandbox", TOKEN, request());
      await until(() => r.apns.requests.length === 1);
      expect(r.apns.streamResets).toBe(0);
      r.timers.advance(PUSH_LIMITS.apnsRequestTimeoutMs);
      expect(await pending).toEqual({ kind: "error", error: "timeout" });
      await until(() => r.apns.streamResets === 1);
      // The session survives the reset.
      expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "response", status: 200, reason: null });
      expect(r.apns.connections).toBe(1);
    });

    test("ca option: a self-signed certificate is trusted only through `ca`", async () => {
      const r = await rig();
      expect(await r.client.send("sandbox", TOKEN, request())).toEqual({ kind: "response", status: 200, reason: null });
      const other = buildTestTls({ openssl: Bun.which("openssl"), ci: false });
      if (other === null) throw new Error("openssl vanished");
      const clock = createFakeClock(START_MS);
      const untrusted = createApnsClient(settings, r.signer, {
        origins: r.apns.origins,
        ca: other.cert,
        clock,
        timers: createFakeTimers(clock),
      });
      try {
        expect(await untrusted.send("sandbox", TOKEN, request())).toEqual({ kind: "error", error: "connection" });
      } finally {
        await untrusted.close();
      }
    });

    test("stream queueing: streams above the peer's maxConcurrentStreams are queued, not refused", async () => {
      const r = await rig({ maxConcurrentStreams: 1 });
      r.apns.script(TOKEN, { kind: "delay", ms: 50, then: { kind: "status", status: 200 } });
      const results = await Promise.all([
        r.client.send("sandbox", TOKEN, request()),
        ...Array.from({ length: 5 }, () => r.client.send("sandbox", OTHER, request())),
      ]);
      expect(results.map((x) => (x.kind === "response" ? x.status : x.error))).toEqual([200, 200, 200, 200, 200, 200]);
      expect(r.apns.connections).toBe(1);
      // Every request was written synchronously; bun queued the stream frames itself.
      expect(r.written).toHaveLength(6);
    });

    test("close-after-error: a TLS failure emits session error, then close, then the stream closes", async () => {
      const r = await rig();
      const other = buildTestTls({ openssl: Bun.which("openssl"), ci: false });
      if (other === null) throw new Error("openssl vanished");
      const events: string[] = [];
      const raw = connect(r.apns.origins.sandbox, { ca: other.cert });
      raw.on("error", () => events.push("session error"));
      raw.on("close", () => events.push("session close"));
      const stream = raw.request({ ":method": "POST", ":path": `/3/device/${TOKEN}` });
      stream.on("error", () => events.push("stream error"));
      stream.on("close", () => events.push("stream close"));
      stream.end("{}");
      await until(() => events.includes("stream close") && events.includes("session close"));
      expect(events.slice(0, 2)).toEqual(["session error", "session close"]);
      raw.destroy();

      // Through the client, the error path settles the request as `connection` and the close path that follows
      // clears the session's ping and idle timers.
      const clock = createFakeClock(START_MS);
      const timers = createFakeTimers(clock);
      const failing = createApnsClient(settings, r.signer, { origins: r.apns.origins, ca: other.cert, clock, timers });
      try {
        expect(await failing.send("sandbox", TOKEN, request())).toEqual({ kind: "error", error: "connection" });
        await until(() => timers.pending() === 0);
      } finally {
        await failing.close();
      }
    });
  });
});
