// apps/web/tests/push/fake-apns.test.ts — the throwaway TLS helper and the fake APNs, driven by a plain node:http2
// client so the APNs client suite can rely on every script kind and counter.

import { afterEach, describe, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { connect, constants as h2, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProviderTokenSigner } from "../../src/server/push/apns/jwt.js";
import { SYSTEM_CLOCK } from "../../src/server/push/ids.js";
import { startFakeApns, type FakeApns } from "./helpers/fake-apns.js";
import { createTestApnsKey } from "./helpers/keys.js";
import { buildTestTls, createTestTls, OPENSSL_REQUIRED_MESSAGE, TLS_TEMP_PREFIX } from "./helpers/tls.js";

const tls = createTestTls();
const SKIP_REASON = "requires openssl (S-12); skipped locally when it is missing";
const TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);
const TOPIC = "com.example.pulse";

function leftoverTlsDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(TLS_TEMP_PREFIX));
}

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

describe("createTestTls", () => {
  test("a missing openssl throws the exact message only under CI", () => {
    expect(() => buildTestTls({ openssl: null, ci: true })).toThrow(new Error(OPENSSL_REQUIRED_MESSAGE));
    expect(OPENSSL_REQUIRED_MESSAGE).toBe("openssl is required for the push test suites (S-12)");
    expect(buildTestTls({ openssl: null, ci: false })).toBeNull();
  });

  test("a failing openssl binary throws rather than skipping and leaves no temp directory", () => {
    const before = leftoverTlsDirs();
    expect(() => buildTestTls({ openssl: "false", ci: false })).toThrow(/openssl failed/);
    expect(leftoverTlsDirs()).toEqual(before);
  });

  test.skipIf(tls === null)(`returns a P-256 localhost certificate and key, memoised (${SKIP_REASON})`, () => {
    if (tls === null) throw new Error("unreachable");
    const cert = new X509Certificate(tls.cert);
    expect(cert.subjectAltName).toContain("DNS:localhost");
    expect(cert.subjectAltName).toContain("IP Address:127.0.0.1");
    const key = createPrivateKey(tls.key);
    expect(key.asymmetricKeyType).toBe("ec");
    expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(cert.checkPrivateKey(key)).toBe(true);
    expect(createTestTls()).toBe(tls);
  });

  test.skipIf(tls === null)(`leaves no temp directory behind (${SKIP_REASON})`, () => {
    const before = leftoverTlsDirs();
    const fresh = buildTestTls({ openssl: Bun.which("openssl"), ci: false });
    expect(fresh).not.toBeNull();
    expect(leftoverTlsDirs()).toEqual(before);
  });

  test("no file under tests/push/helpers contains a PEM block", () => {
    const dir = join(import.meta.dir, "helpers");
    const pem = /-----BEGIN [A-Z0-9 ]+-----/;
    for (const name of readdirSync(dir)) {
      expect({ name, pem: pem.test(readFileSync(join(dir, name), "utf8")) }).toEqual({ name, pem: false });
    }
  });
});

interface Reply {
  readonly status: number | null;
  readonly body: string;
}

describe.skipIf(tls === null)(`fake APNs (${SKIP_REASON})`, () => {
  const providerKey = createTestApnsKey();
  const signer = createProviderTokenSigner(createPrivateKey(providerKey.pem), "ABC123DEFG", "TEAM456XYZ", SYSTEM_CLOCK);
  const otherSigner = createProviderTokenSigner(
    createPrivateKey(createTestApnsKey().pem),
    "ABC123DEFG",
    "TEAM456XYZ",
    SYSTEM_CLOCK,
  );

  let fake: FakeApns | undefined;
  const clients: ClientHttp2Session[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    await fake?.close();
    fake = undefined;
  });

  async function start(maxConcurrentStreams?: number): Promise<FakeApns> {
    if (tls === null) throw new Error("unreachable");
    fake = await startFakeApns({
      tls,
      providerPublicKey: providerKey.publicKey,
      ...(maxConcurrentStreams !== undefined ? { maxConcurrentStreams } : {}),
    });
    return fake;
  }

  /** A client that opens a new session when the previous one has closed (what a reconnecting client does). */
  function client(origin: string, ca: string): { session(): ClientHttp2Session } {
    let current: ClientHttp2Session | undefined;
    return {
      session() {
        if (current === undefined || current.closed || current.destroyed) {
          current = connect(origin, { ca });
          current.on("error", () => {});
          clients.push(current);
        }
        return current;
      },
    };
  }

  function open(
    session: ClientHttp2Session,
    token = TOKEN,
    jwt: string = signer.current(),
    body: unknown = { aps: { alert: "x" } },
  ): { stream: ClientHttp2Stream; reply: Promise<Reply> } {
    const stream = session.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": TOPIC,
      "apns-push-type": "alert",
      "content-type": "application/json",
    });
    const reply = new Promise<Reply>((resolve) => {
      let status: number | null = null;
      let text = "";
      stream.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        text += chunk;
      });
      // bun: after the peer destroys the socket the stream emits "end" but no "close", so settle on either.
      const settle = (): void => resolve({ status, body: text });
      stream.on("error", () => {});
      stream.on("end", settle);
      stream.on("close", settle);
    });
    stream.end(JSON.stringify(body));
    return { stream, reply };
  }

  test("a default request gets 200 with an empty body", async () => {
    const apns = await start();
    const c = client(apns.origins.sandbox, apns.ca);
    const reply = await open(c.session()).reply;
    expect(reply.status).toBe(200);
    expect(reply.body).toBe("");
  });

  test("a status script with a reason answers with {reason} JSON", async () => {
    const apns = await start();
    apns.script(TOKEN, { kind: "status", status: 410, reason: "Unregistered" });
    const reply = await open(client(apns.origins.sandbox, apns.ca).session()).reply;
    expect(reply.status).toBe(410);
    expect(reply.body).toBe('{"reason":"Unregistered"}');
  });

  test("scripts are FIFO per token and fall back to 200", async () => {
    const apns = await start();
    apns.script(TOKEN, { kind: "status", status: 500 }, { kind: "status", status: 429, reason: "TooManyRequests" });
    apns.script(OTHER_TOKEN, { kind: "status", status: 400, reason: "BadDeviceToken" });
    const session = client(apns.origins.sandbox, apns.ca).session();
    const statuses: (number | null)[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await open(session).reply).status);
    expect(statuses).toEqual([500, 429, 200]);
    expect((await open(session, OTHER_TOKEN).reply).status).toBe(400);
    expect((await open(session, OTHER_TOKEN).reply).status).toBe(200);
  });

  test("a delay script answers with its follow-up after the delay", async () => {
    const apns = await start();
    apns.script(TOKEN, { kind: "delay", ms: 60, then: { kind: "status", status: 503, reason: "ServiceUnavailable" } });
    const t0 = performance.now();
    const reply = await open(client(apns.origins.sandbox, apns.ca).session()).reply;
    expect(performance.now() - t0).toBeGreaterThanOrEqual(50);
    expect(reply.status).toBe(503);
    expect(reply.body).toBe('{"reason":"ServiceUnavailable"}');
  });

  test("a drop script resets the stream without a response and is not counted as a client reset", async () => {
    const apns = await start();
    apns.script(TOKEN, { kind: "drop" });
    const reply = await open(client(apns.origins.sandbox, apns.ca).session()).reply;
    expect(reply.status).toBeNull();
    expect(apns.streamResets).toBe(0);
  });

  test("the provider token is verified: the test key is valid, another key is not", async () => {
    const apns = await start();
    const session = client(apns.origins.sandbox, apns.ca).session();
    await open(session).reply;
    await open(session, TOKEN, otherSigner.current()).reply;
    await open(session, TOKEN, "not.a.jwt").reply;
    expect(apns.requests.map((r) => r.jwtValid)).toEqual([true, false, false]);
  });

  test("requests record path, environment, headers and parsed body", async () => {
    const apns = await start();
    await open(client(apns.origins.sandbox, apns.ca).session(), TOKEN, signer.current(), { n: 1 }).reply;
    const t0 = performance.now();
    await open(client(apns.origins.production, apns.ca).session(), OTHER_TOKEN, signer.current(), { n: 2 }).reply;
    expect(apns.requests).toHaveLength(2);
    const [first, second] = apns.requests;
    expect(first?.environment).toBe("sandbox");
    expect(first?.path).toBe(`/3/device/${TOKEN}`);
    expect(first?.body).toEqual({ n: 1 });
    expect(second?.environment).toBe("production");
    expect(second?.path).toBe(`/3/device/${OTHER_TOKEN}`);
    expect(second?.body).toEqual({ n: 2 });
    expect(second?.headers[":method"]).toBe("POST");
    expect(second?.headers["apns-topic"]).toBe(TOPIC);
    expect(second?.headers["apns-push-type"]).toBe("alert");
    expect(second?.headers.authorization?.startsWith("bearer ")).toBe(true);
    expect(second?.receivedAtMs).toBeGreaterThanOrEqual(t0);
    expect(apns.connections).toBe(2);
  });

  test("goaway answers 200 and makes the next request open a new session", async () => {
    const apns = await start();
    apns.script(TOKEN, { kind: "goaway" });
    const c = client(apns.origins.sandbox, apns.ca);
    const first = c.session();
    const goaway = new Promise<void>((resolve) => first.once("goaway", () => resolve()));
    expect((await open(first).reply).status).toBe(200);
    await goaway;
    await until(() => first.closed || first.destroyed);
    const second = c.session();
    expect(second).not.toBe(first);
    expect((await open(second).reply).status).toBe(200);
    expect(apns.connections).toBe(2);
  });

  test("destroy-socket kills the connection and the next request opens a new session", async () => {
    const apns = await start();
    apns.script(TOKEN, { kind: "destroy-socket" });
    const c = client(apns.origins.sandbox, apns.ca);
    const first = c.session();
    expect((await open(first).reply).status).toBeNull();
    await until(() => first.closed || first.destroyed);
    expect((await open(c.session()).reply).status).toBe(200);
    expect(apns.connections).toBe(2);
    expect(apns.streamResets).toBe(0);
  });

  test("hang plus a client NGHTTP2_CANCEL increments streamResets", async () => {
    const apns = await start();
    apns.script(TOKEN, { kind: "hang" });
    const { stream, reply } = open(client(apns.origins.sandbox, apns.ca).session());
    await until(() => apns.requests.length === 1);
    expect(apns.streamResets).toBe(0);
    stream.close(h2.NGHTTP2_CANCEL);
    const settled = await reply;
    expect(settled.status).toBeNull();
    await until(() => apns.streamResets === 1);
  });

  test("a client session.ping increments pings", async () => {
    const apns = await start();
    const session = client(apns.origins.sandbox, apns.ca).session();
    await new Promise<void>((resolve, reject) => {
      session.ping((error) => (error === null ? resolve() : reject(error)));
    });
    await until(() => apns.pings === 1);
  });

  test("maxConcurrentStreams 1 still completes concurrent requests", async () => {
    const apns = await start(1);
    const session = client(apns.origins.sandbox, apns.ca).session();
    const replies = await Promise.all(Array.from({ length: 5 }, () => open(session).reply));
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(apns.connections).toBe(1);
  });

  test("close() resolves and both listeners stop accepting connections", async () => {
    const apns = await start();
    const session = client(apns.origins.sandbox, apns.ca).session();
    await open(session).reply;
    await apns.close();
    await apns.close();
    for (const origin of Object.values(apns.origins)) {
      const probe = connect(origin, { ca: apns.ca });
      clients.push(probe);
      const outcome = await new Promise<string>((resolve) => {
        probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
        probe.once("connect", () => resolve("connected"));
      });
      expect(outcome).toBe("ECONNREFUSED");
    }
  });
});
