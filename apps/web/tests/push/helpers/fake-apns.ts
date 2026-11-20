// A fake APNs: two loopback HTTP/2 TLS listeners (sandbox and production) with per-token scripted responses. It
// records every request, verifies the provider token itself (no server code is imported) and counts sessions,
// PING frames and client stream resets.
//
// bun's node:http2 server notes: `stream.session` is null once the stream has ended, so the session is captured at
// the "stream" event; `session.socket.destroy()` throws ERR_HTTP2_NO_SOCKET_MANIPULATION, so `destroy-socket` finds
// the raw TLS socket from the server's "secureConnection" event by remote port.

import { constants as h2, createSecureServer, type Http2SecureServer, type Http2Session, type ServerHttp2Stream } from "node:http2";
import type { KeyObject } from "node:crypto";
import { verify } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";

import type { TestTls } from "./tls.js";

/** One scripted reaction to a request for a token. */
export type FakeApnsScript =
  /** Answer `status`; with `reason` the body is `{"reason"}` JSON, with `body` it is that raw text (reason wins). */
  | { readonly kind: "status"; readonly status: number; readonly reason?: string; readonly body?: string }
  | { readonly kind: "delay"; readonly ms: number; readonly then: FakeApnsScript }
  /** Reset the stream without a response. */
  | { readonly kind: "drop" }
  /** Never respond (exercises the client's request timeout and stream reset). */
  | { readonly kind: "hang" }
  /** Destroy the whole TCP/TLS socket (exercises reconnect). */
  | { readonly kind: "destroy-socket" }
  /** Answer 200, then send GOAWAY on the session. */
  | { readonly kind: "goaway" };

/** The environments the fake listens for. */
export type FakeApnsEnvironment = "sandbox" | "production";

/** One request the fake received. */
export interface FakeApnsRequest {
  /** performance.now() at the server's "stream" event. */
  readonly receivedAtMs: number;
  /** Which of the two listeners received it. */
  readonly environment: FakeApnsEnvironment;
  /** The `:path` pseudo-header, e.g. `/3/device/<token>`. */
  readonly path: string;
  /** Every request header (pseudo-headers included), values joined with ", " when repeated. */
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON body; the raw text when it is not JSON; null when empty. */
  readonly body: unknown;
  /** ES256 provider token verified against the provider key's public half. */
  readonly jwtValid: boolean;
}

/** A running fake APNs. */
export interface FakeApns {
  /** Origins to pass as `ApnsDeps.origins`. */
  readonly origins: Readonly<Record<FakeApnsEnvironment, string>>;
  /** The CA (the self-signed certificate) that trusts both listeners. */
  readonly ca: string;
  /** Append scripted responses for a device token (FIFO per token). Without a script the answer is 200. */
  script(token: string, ...steps: FakeApnsScript[]): void;
  /** Requests in arrival order of their completion (body read or stream closed). */
  readonly requests: readonly FakeApnsRequest[];
  /** Accepted HTTP/2 sessions across both listeners. */
  readonly connections: number;
  /** PING frames received from clients. */
  readonly pings: number;
  /** Streams the client reset (RST_STREAM); resets the fake caused itself (drop, destroy-socket, close) are excluded. */
  readonly streamResets: number;
  /** Destroy every session and close both listeners. */
  close(): Promise<void>;
}

/** Options of {@link startFakeApns}. */
export interface StartFakeApnsOptions {
  readonly tls: TestTls;
  readonly providerPublicKey: KeyObject;
  /** Passed to the server's HTTP/2 `settings`; default unlimited. */
  readonly maxConcurrentStreams?: number;
}

const DEVICE_PATH_PREFIX = "/3/device/";

/** Verify `bearer <header>.<claims>.<sig>` as ES256 (raw r||s signature) against `publicKey`. Never throws. */
function verifyBearer(authorization: string | undefined, publicKey: KeyObject): boolean {
  try {
    if (authorization === undefined || !authorization.startsWith("bearer ")) return false;
    const parts = authorization.slice("bearer ".length).split(".");
    if (parts.length !== 3) return false;
    const [header, claims, sig] = parts as [string, string, string];
    const decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: unknown };
    if (decoded.alg !== "ES256") return false;
    const signature = Buffer.from(sig, "base64url");
    if (signature.length !== 64) return false;
    return verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return false;
  }
}

function parseBody(raw: string): unknown {
  if (raw === "") return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function flattenHeaders(headers: Readonly<Record<string, string | string[] | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/** Start both listeners on 127.0.0.1 with ephemeral ports. */
export async function startFakeApns(opts: StartFakeApnsOptions): Promise<FakeApns> {
  const scripts = new Map<string, FakeApnsScript[]>();
  const requests: FakeApnsRequest[] = [];
  const sessions = new Set<Http2Session>();
  const sockets = new Set<Socket>();
  const killed = new WeakSet<Http2Session>();
  const delays = new Set<ReturnType<typeof setTimeout>>();
  let connections = 0;
  let pings = 0;
  let streamResets = 0;
  let closed = false;

  function nextScript(token: string): FakeApnsScript {
    const queue = scripts.get(token);
    const step = queue?.shift();
    if (queue !== undefined && queue.length === 0) scripts.delete(token);
    return step ?? { kind: "status", status: 200 };
  }

  function destroySocketOf(session: Http2Session): void {
    killed.add(session);
    let port: number | undefined;
    try {
      port = session.socket.remotePort;
    } catch {
      port = undefined;
    }
    const raw = port === undefined ? undefined : [...sockets].find((s) => s.remotePort === port);
    if (raw !== undefined) raw.destroy();
    else session.destroy();
  }

  function apply(
    step: FakeApnsScript,
    stream: ServerHttp2Stream,
    session: Http2Session,
    markServerClose: () => void,
  ): void {
    if (stream.destroyed || stream.closed) return;
    switch (step.kind) {
      case "status": {
        if (step.reason === undefined && step.body !== undefined) {
          stream.respond({ ":status": step.status, "content-type": "text/plain" });
          stream.end(step.body);
        } else if (step.reason === undefined) {
          stream.respond({ ":status": step.status });
          stream.end();
        } else {
          stream.respond({ ":status": step.status, "content-type": "application/json" });
          stream.end(JSON.stringify({ reason: step.reason }));
        }
        return;
      }
      case "delay": {
        const handle = setTimeout(() => {
          delays.delete(handle);
          apply(step.then, stream, session, markServerClose);
        }, step.ms);
        delays.add(handle);
        return;
      }
      case "drop":
        markServerClose();
        stream.close(h2.NGHTTP2_INTERNAL_ERROR);
        return;
      case "hang":
        return;
      case "destroy-socket":
        markServerClose();
        destroySocketOf(session);
        return;
      case "goaway":
        stream.respond({ ":status": 200 });
        stream.end();
        session.goaway();
        return;
    }
  }

  function listen(environment: FakeApnsEnvironment): Http2SecureServer {
    const server = createSecureServer({
      cert: opts.tls.cert,
      key: opts.tls.key,
      ...(opts.maxConcurrentStreams !== undefined ? { settings: { maxConcurrentStreams: opts.maxConcurrentStreams } } : {}),
    });
    server.on("secureConnection", (socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("session", (session: Http2Session) => {
      connections += 1;
      sessions.add(session);
      session.on("ping", () => {
        pings += 1;
      });
      session.on("error", () => {});
      session.on("close", () => sessions.delete(session));
    });
    server.on("stream", (stream: ServerHttp2Stream, rawHeaders) => {
      const receivedAtMs = performance.now();
      const session = stream.session;
      const headers = flattenHeaders(rawHeaders);
      const path = headers[":path"] ?? "";
      const token = path.startsWith(DEVICE_PATH_PREFIX) ? path.slice(DEVICE_PATH_PREFIX.length) : path;
      const chunks: Buffer[] = [];
      let recorded = false;
      let serverClosed = false;
      const record = (): void => {
        if (recorded) return;
        recorded = true;
        requests.push({
          receivedAtMs,
          environment,
          path,
          headers,
          body: parseBody(Buffer.concat(chunks).toString("utf8")),
          jwtValid: verifyBearer(headers.authorization, opts.providerPublicKey),
        });
      };
      stream.on("error", () => {});
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("close", () => {
        record();
        const serverCaused = serverClosed || closed || (session !== undefined && killed.has(session));
        if (!serverCaused && stream.rstCode !== h2.NGHTTP2_NO_ERROR) streamResets += 1;
      });
      stream.on("end", () => {
        record();
        if (session === undefined || closed) return;
        const step = nextScript(token);
        apply(step, stream, session, () => {
          serverClosed = true;
        });
      });
    });
    return server;
  }

  const servers: Record<FakeApnsEnvironment, Http2SecureServer> = {
    sandbox: listen("sandbox"),
    production: listen("production"),
  };
  const origins = {} as Record<FakeApnsEnvironment, string>;
  for (const environment of ["sandbox", "production"] as const) {
    const server = servers[environment];
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    origins[environment] = `https://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }
  Object.freeze(origins);

  let closing: Promise<void> | undefined;
  return {
    origins,
    ca: opts.tls.cert,
    script(token, ...steps) {
      const queue = scripts.get(token) ?? [];
      queue.push(...steps);
      scripts.set(token, queue);
    },
    get requests() {
      return requests;
    },
    get connections() {
      return connections;
    },
    get pings() {
      return pings;
    },
    get streamResets() {
      return streamResets;
    },
    close() {
      closing ??= (async () => {
        closed = true;
        for (const handle of delays) clearTimeout(handle);
        delays.clear();
        for (const session of sessions) session.destroy();
        for (const socket of sockets) socket.destroy();
        await Promise.all(
          Object.values(servers).map(
            (server) => new Promise<void>((resolve) => server.close(() => resolve())),
          ),
        );
      })();
      return closing;
    },
  };
}
