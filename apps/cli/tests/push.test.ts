/** push.test.ts — `pulse push`: argument parsing, the --insecure-local rule, server resolution, the operator
 *  secret, the HTTP client and its response-to-finding mapping, and the async shell wiring. */

import { afterEach, describe, expect, test } from "bun:test";

import { FINDING_CODES } from "@pulse/core";

import { GLOBAL_OPTIONS } from "../src/args.js";
import type { ConnectLinkAddress, PushServerAddress } from "../src/config.js";
import { PUSH_SUBVERBS, parsePushArgs } from "../src/commands/push/args.js";
import type { PushArgsResult } from "../src/commands/push/args.js";
import {
  OPERATOR_SECRET_ENV,
  PUSH_ADMIN_PATHS,
  PUSH_HTTP_TIMEOUT_MS,
  PUSH_MAX_RESPONSE_CHARS,
  PUSH_TEST_TIMEOUT_MS,
  classifyPushResponse,
  createPushClient,
  findingForFailure,
  readPushOperatorSecret,
} from "../src/commands/push/client.js";
import type { FailureContext, PushCallFailure, PushCallKind, PushStatusClass } from "../src/commands/push/client.js";
import { PUSH_PATHS } from "../../web/src/server/push/constants.js";
import { runCli } from "./factories.js";
import {
  PUSH_SERVER_SOURCE_LABEL,
  parseInsecureLocalBase,
  resolvePushServer,
} from "../src/commands/push/server.js";

function messageOf(r: PushArgsResult): string {
  if (r.ok) throw new Error(`expected a usage message, got ${JSON.stringify(r)}`);
  return r.message;
}

const parse = (tokens: string[]) => parsePushArgs(tokens, GLOBAL_OPTIONS);
const ID = "dev_AbCdEfGhIjK";
const CREDENTIALED = "http://user:pw@127.0.0.1:1";

describe("parsePushArgs — usage messages", () => {
  const ROWS: ReadonlyArray<{ name: string; tokens: string[]; message: string }> = [
    {
      name: "no sub-command",
      tokens: [],
      message: "push: missing sub-command (expected one of: pair, devices, revoke, test)",
    },
    { name: "unknown sub-command", tokens: ["list"], message: 'push: unknown sub-command "list"' },
    { name: "revoke with no id", tokens: ["revoke"], message: "push revoke: missing <id>" },
    {
      name: "revoke bad-id",
      tokens: ["revoke", "bad-id"],
      message: 'push revoke: malformed device id "bad-id" (expected dev_ followed by 11 base64url characters)',
    },
    {
      name: "revoke with two ids",
      tokens: ["revoke", ID, "dev_ZyXwVuTsRqP"],
      message: 'push revoke: unexpected argument "dev_ZyXwVuTsRqP"',
    },
    { name: "pair extra", tokens: ["pair", "extra"], message: 'push pair: unexpected argument "extra"' },
    {
      name: "--device on devices",
      tokens: ["devices", "--device", ID],
      message: "--device is only valid for 'push test'",
    },
    {
      name: "test --device bad",
      tokens: ["test", "--device", "bad"],
      message: 'push test: malformed --device id "bad" (expected dev_ followed by 11 base64url characters)',
    },
    { name: '--server ""', tokens: ["devices", "--server", ""], message: "--server needs an https address" },
    { name: "--server blank", tokens: ["devices", "--server", "   "], message: "--server needs an https address" },
    {
      name: "--insecure-local without --server",
      tokens: ["devices", "--insecure-local"],
      message: "--insecure-local requires --server http://127.0.0.1:<port> or http://localhost:<port>",
    },
    {
      name: "--insecure-local with http://192.0.2.10:8080",
      tokens: ["test", "--insecure-local", "--server", "http://192.0.2.10:8080"],
      message: "--insecure-local accepts only http://127.0.0.1:<port> or http://localhost:<port>",
    },
    {
      name: "--insecure-local with https://pulse.example.com",
      tokens: ["devices", "--insecure-local", "--server", "https://pulse.example.com"],
      message: "--insecure-local accepts only http://127.0.0.1:<port> or http://localhost:<port>",
    },
  ];

  for (const row of ROWS) {
    test(row.name, () => {
      expect(messageOf(parse(row.tokens))).toBe(row.message);
    });
  }

  test("an unknown flag and a missing flag value are usage messages", () => {
    expect(messageOf(parse(["devices", "--bogus"]))).toContain("--bogus");
    expect(messageOf(parse(["devices", "--server"]))).toContain("--server");
  });

  test("no message echoes a raw --server value", () => {
    const cases = [
      ["devices", "--insecure-local", "--server", CREDENTIALED],
      ["pair", "--insecure-local", "--server", "https://user:pw@pulse.example.com"],
      ["revoke", "bad-id", "--server", CREDENTIALED],
      ["test", "--device", "bad", "--server", CREDENTIALED],
      ["devices", "--device", ID, "--server", CREDENTIALED],
      ["nope", "--server", CREDENTIALED],
    ];
    for (const tokens of cases) {
      const message = messageOf(parse(tokens));
      expect(message).not.toContain(tokens[tokens.length - 1]!);
      expect(message).not.toContain("user:pw");
    }
  });

  test("--version short-circuits with the value bag", () => {
    const r = parse(["--version"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.version).toBe(true);
    const later = parse(["devices", "--version"]);
    expect(later.ok && later.version).toBe(true);
  });
});

describe("parsePushArgs — invocations", () => {
  test("PUSH_SUBVERBS is the four sub-verbs", () => {
    expect([...PUSH_SUBVERBS]).toEqual(["pair", "devices", "revoke", "test"]);
  });

  test("revoke with --server keeps the raw server", () => {
    const r = parse(["revoke", ID, "--server", "https://pulse.example.com"]);
    expect(r.ok && !r.version ? r.invocation : null).toEqual({
      sub: "revoke",
      id: ID,
      server: "https://pulse.example.com",
      insecureLocal: false,
    });
  });

  test("pair, devices and test invocations", () => {
    const pair = parse(["pair", "--json"]);
    expect(pair.ok && !pair.version ? pair.invocation : null).toEqual({ sub: "pair", server: null, insecureLocal: false });
    if (pair.ok) expect(pair.values.json).toBe(true);

    const devices = parse(["devices", "--server", "http://localhost:8080", "--insecure-local"]);
    expect(devices.ok && !devices.version ? devices.invocation : null).toEqual({
      sub: "devices",
      server: "http://localhost:8080",
      insecureLocal: true,
    });

    const all = parse(["test"]);
    expect(all.ok && !all.version ? all.invocation : null).toEqual({
      sub: "test",
      device: null,
      server: null,
      insecureLocal: false,
    });
    const one = parse(["test", "--device", ID]);
    expect(one.ok && !one.version ? one.invocation : null).toEqual({
      sub: "test",
      device: ID,
      server: null,
      insecureLocal: false,
    });
  });

  test("the server value is not normalised", () => {
    const r = parse(["devices", "--server", "https://pulse.example.com/"]);
    expect(r.ok && !r.version ? r.invocation.server : null).toBe("https://pulse.example.com/");
  });
});

describe("parseInsecureLocalBase", () => {
  test("accepts the loopback http bases", () => {
    expect(parseInsecureLocalBase("http://127.0.0.1:8080")).toEqual({ ok: true, baseUrl: "http://127.0.0.1:8080" });
    expect(parseInsecureLocalBase("http://localhost:8080")).toEqual({ ok: true, baseUrl: "http://localhost:8080" });
    expect(parseInsecureLocalBase("http://LOCALHOST:8080/")).toEqual({ ok: true, baseUrl: "http://localhost:8080" });
  });

  test("rejects everything else", () => {
    for (const raw of [
      "https://127.0.0.1:8080",
      "http://127.0.0.2:8080",
      "http://[::1]:8080",
      "http://0.0.0.0:8080",
      "http://localhost:8080/x",
      "http://localhost:8080?q",
      "http://localhost:8080?",
      "http://localhost:8080#f",
      CREDENTIALED,
      "http://user@localhost:8080",
      "http://192.0.2.10:8080",
      "not a url",
      "",
    ]) {
      expect(parseInsecureLocalBase(raw)).toEqual({ ok: false });
    }
  });
});

describe("resolvePushServer", () => {
  const srv = (value: string, source: PushServerAddress["source"]): PushServerAddress => ({ value, source });
  const ext = (value: string, source: ConnectLinkAddress["source"]): ConnectLinkAddress => ({ value, source });

  test("the server address beats externalUrl, keeping its own source", () => {
    for (const source of ["flag", "env", "config"] as const) {
      expect(
        resolvePushServer({
          server: srv("https://pulse.example.com", source),
          externalUrl: ext("https://ext.example.com", "env"),
          insecureLocal: false,
        }),
      ).toEqual({ ok: true, baseUrl: "https://pulse.example.com", source, insecure: false });
    }
  });

  test("externalUrl is the fallback with external-url-* sources", () => {
    expect(
      resolvePushServer({ server: undefined, externalUrl: ext("https://pulse.example.com", "env"), insecureLocal: false }),
    ).toEqual({ ok: true, baseUrl: "https://pulse.example.com", source: "external-url-env", insecure: false });
    expect(
      resolvePushServer({
        server: undefined,
        externalUrl: ext("https://pulse.example.com", "config"),
        insecureLocal: false,
      }),
    ).toEqual({ ok: true, baseUrl: "https://pulse.example.com", source: "external-url-config", insecure: false });
  });

  test("each source is normalised", () => {
    const r = resolvePushServer({
      server: srv("https://pulse.example.com/", "env"),
      externalUrl: undefined,
      insecureLocal: false,
    });
    expect(r).toEqual({ ok: true, baseUrl: "https://pulse.example.com", source: "env", insecure: false });
    const e = resolvePushServer({
      server: undefined,
      externalUrl: ext("https://pulse.example.com/", "config"),
      insecureLocal: false,
    });
    expect(e.ok && e.baseUrl).toBe("https://pulse.example.com");
  });

  test("a refused source gives PUSH_SERVER_MISSING naming it, with no fall-through", () => {
    const r = resolvePushServer({
      server: srv("http://pulse.example.com", "env"),
      externalUrl: ext("https://pulse.example.com", "env"),
      insecureLocal: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.finding).toEqual({
        severity: "error",
        code: FINDING_CODES.PUSH_SERVER_MISSING,
        file: "",
        path: "",
        message: "The address from PULSE_SERVER_URL does not use HTTPS.",
        fix: "Use the server's https address. For a local development server only, pass --server http://127.0.0.1:<port> --insecure-local.",
      });
    }
  });

  test("each refusal has its message and fix and never repeats the address", () => {
    const rows = [
      { value: "https://127.0.0.1:8443", message: "The address from --server is a loopback address." },
      {
        value: "https://user:pw@pulse.example.com",
        message: "The address from --server contains a user name or password.",
        fix: "Remove the credentials; the operator secret is read from PULSE_PUSH_OPERATOR_SECRET.",
      },
      {
        value: "pulse.example.com",
        message: "The address from --server is not a valid absolute URL.",
        fix: "Use an absolute https URL such as https://pulse.example.com.",
      },
    ];
    for (const row of rows) {
      const r = resolvePushServer({ server: srv(row.value, "flag"), externalUrl: undefined, insecureLocal: false });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.finding.message).toBe(row.message);
        if (row.fix !== undefined) expect(r.finding.fix).toBe(row.fix);
        expect(r.finding.message).not.toContain(row.value);
        expect(r.finding.fix).not.toContain("user:pw");
      }
    }
  });

  test("the externalUrl label is used for a refused fallback", () => {
    const r = resolvePushServer({
      server: undefined,
      externalUrl: ext("http://pulse.example.com", "config"),
      insecureLocal: false,
    });
    expect(!r.ok && r.finding.message).toBe(
      `The address from ${PUSH_SERVER_SOURCE_LABEL["external-url-config"]} does not use HTTPS.`,
    );
  });

  test("no source gives the missing finding", () => {
    const r = resolvePushServer({ server: undefined, externalUrl: undefined, insecureLocal: false });
    expect(r).toEqual({
      ok: false,
      finding: {
        severity: "error",
        code: FINDING_CODES.PUSH_SERVER_MISSING,
        file: "",
        path: "",
        message: "No Pulse server address is set for push commands.",
        fix: "Pass --server https://<server address>, set PULSE_SERVER_URL, set server in pulse.config.yaml, or set PULSE_WEB_EXTERNAL_URL.",
      },
    });
  });

  test("--insecure-local accepts only a loopback --server flag", () => {
    expect(
      resolvePushServer({ server: srv("http://127.0.0.1:8080/", "flag"), externalUrl: undefined, insecureLocal: true }),
    ).toEqual({ ok: true, baseUrl: "http://127.0.0.1:8080", source: "flag", insecure: true });
    for (const server of [srv("http://127.0.0.1:8080", "env"), srv("http://192.0.2.10:8080", "flag"), undefined]) {
      const r = resolvePushServer({ server, externalUrl: undefined, insecureLocal: true });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.finding.code).toBe(FINDING_CODES.PUSH_SERVER_MISSING);
        expect(r.finding.message).toContain("does not use HTTPS");
      }
    }
  });
});

// ── Operator secret, client and shell ───────────────────────────────────────

/** A 48-character sentinel; it must never appear in any output, trace or finding. */
const SECRET = "SentinelOperatorSecret-0123456789abcdefghijklmno";
const BASE = "https://pulse.example.com";
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
const LINK = `pulse://connect?v=1&url=${encodeURIComponent(BASE)}&pair=${TOKEN}`;
const EXPIRES = "2026-11-20T12:10:00.000Z";

/** Every string a test produced (stdout, stderr, traces, finding text); checked by the shared afterEach. */
const captured: string[] = [];
afterEach(() => {
  for (const text of captured) expect(text.includes(SECRET)).toBe(false);
  captured.length = 0;
});

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
  readonly redirect: RequestRedirect | undefined;
  readonly hasSignal: boolean;
}

type Answer = Response | (() => Response) | { readonly reject: unknown };

/** A recording stub fetch answering from a FIFO table; an exhausted table fails the test loudly. */
function stubFetch(answers: Answer[]): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const queue = [...answers];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      headers,
      body: typeof init?.body === "string" ? init.body : null,
      redirect: init?.redirect,
      hasSignal: init?.signal instanceof AbortSignal,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error("stub fetch: no answer left");
    if (next instanceof Response) return next;
    if (typeof next === "function") return next();
    throw next.reject;
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const envelope = (status: number, code: string, details?: Record<string, unknown>): Response =>
  json(status, { code, message: "x", ...(details !== undefined ? { details } : {}) });

const DEVICE = {
  id: "dev_AbCdEfGhIjK",
  displayName: "Example iPhone",
  pairedAt: "2026-11-01T10:00:00.000Z",
  seenAt: "2026-11-20T09:00:00.000Z",
  environment: "production",
  preferences: { critical: true, warning: true, info: false },
  tokenSuffix: "a1b2c3",
  lastDelivery: { outcome: "delivered", at: "2026-11-20T09:00:00.000Z", reason: null },
} as const;

function secretOrThrow() {
  const r = readPushOperatorSecret({ [OPERATOR_SECRET_ENV]: SECRET });
  if (!r.ok) throw new Error("sentinel secret refused");
  return r.secret;
}

function clientWith(answers: Answer[], extra: { timeoutMs?: number; testTimeoutMs?: number } = {}) {
  const stub = stubFetch(answers);
  const traces: string[] = [];
  const client = createPushClient({
    fetch: stub.fetch,
    baseUrl: BASE,
    secret: secretOrThrow(),
    trace: (l) => {
      traces.push(l);
      captured.push(l);
    },
    ...extra,
  });
  return { client, calls: stub.calls, traces };
}

const CTX: FailureContext = { baseUrl: BASE, insecure: false, timeoutMs: PUSH_HTTP_TIMEOUT_MS };

function failureOf<T>(r: { ok: true; value: T } | { ok: false; failure: PushCallFailure }): PushCallFailure {
  if (r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r.value)}`);
  return r.failure;
}

describe("readPushOperatorSecret", () => {
  test("unset and empty give PUSH_OPERATOR_SECRET_MISSING with the set message", () => {
    for (const env of [{}, { [OPERATOR_SECRET_ENV]: "" }]) {
      const r = readPushOperatorSecret(env);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.finding).toEqual({
          severity: "error",
          code: FINDING_CODES.PUSH_OPERATOR_SECRET_MISSING,
          file: "",
          path: "",
          message: "The operator secret is not set: set PULSE_PUSH_OPERATOR_SECRET.",
          fix: "Export PULSE_PUSH_OPERATOR_SECRET with the server's operator secret. It is never read from pulse.config.yaml or a flag.",
        });
      }
    }
  });

  test("a leading space, a newline or é gives the same code without echoing the value", () => {
    for (const value of [` ${SECRET}`, `${SECRET}\n`, `${SECRET}é`]) {
      const r = readPushOperatorSecret({ [OPERATOR_SECRET_ENV]: value });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        captured.push(JSON.stringify(r.finding));
        expect(r.finding.code).toBe(FINDING_CODES.PUSH_OPERATOR_SECRET_MISSING);
        expect(r.finding.message).toBe(
          "PULSE_PUSH_OPERATOR_SECRET contains spaces, control characters or non-ASCII characters and cannot be sent.",
        );
        expect(r.finding.fix).toBe(
          "Use a printable ASCII secret, for example one generated with openssl rand -base64 48, on both the server and the CLI.",
        );
      }
    }
  });

  test("the wrapped secret prints as [secret] and bears the exact header value", () => {
    expect(SECRET.length).toBe(48);
    const secret = secretOrThrow();
    expect(String(secret)).toBe("[secret]");
    expect(`${secret}`).toBe("[secret]");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[secret]"}');
    expect(Bun.inspect(secret).includes(SECRET)).toBe(false);
    expect(secret.bearer()).toBe(`Bearer ${SECRET}`);
  });
});

describe("classifyPushResponse", () => {
  const notFound = { code: "API_NOT_FOUND", message: "x" };
  const unavailable = { code: "PUSH_UNAVAILABLE", message: "x" };
  const ROWS: ReadonlyArray<[string, PushCallKind, number, unknown, PushStatusClass]> = [
    ["pair 201 success", "pair", 201, {}, "success"],
    ["devices 200 success", "devices", 200, {}, "success"],
    ["revoke 204 success", "revoke", 204, undefined, "success"],
    ["test 200 success", "test", 200, {}, "success"],
    ["test-device 200 success", "test-device", 200, {}, "success"],
    ["pair 200 is not its success", "pair", 200, {}, { kind: "unexpected", status: 200, cause: "status" }],
    ["401 refused", "devices", 401, undefined, { kind: "refused" }],
    ["401 refused on revoke", "revoke", 401, notFound, { kind: "refused" }],
    ["revoke 404 API_NOT_FOUND probes", "revoke", 404, notFound, "probe"],
    ["test-device 404 API_NOT_FOUND probes", "test-device", 404, notFound, "probe"],
    ["revoke 404 plain body", "revoke", 404, undefined, { kind: "not-configured", status: 404 }],
    ["revoke 404 other code", "revoke", 404, { code: "X", message: "x" }, { kind: "not-configured", status: 404 }],
    ["devices 404", "devices", 404, notFound, { kind: "not-configured", status: 404 }],
    ["pair 404", "pair", 404, notFound, { kind: "not-configured", status: 404 }],
    ["test 404 (no device)", "test", 404, notFound, { kind: "not-configured", status: 404 }],
    ["revoke 405", "revoke", 405, undefined, { kind: "not-configured", status: 405 }],
    ["pair 405", "pair", 405, undefined, { kind: "not-configured", status: 405 }],
    ["503 PUSH_UNAVAILABLE", "devices", 503, unavailable, { kind: "misconfigured" }],
    ["503 other body", "devices", 503, { code: "X", message: "x" }, { kind: "unexpected", status: 503, cause: "status" }],
    ["503 no body", "test", 503, undefined, { kind: "unexpected", status: 503, cause: "status" }],
    [
      "pair 409 no-usable-address",
      "pair",
      409,
      { code: "X", message: "x", details: { reason: "no-usable-address" } },
      { kind: "no-usable-address", reason: "no-usable-address" },
    ],
    [
      "pair 409 address-too-long",
      "pair",
      409,
      { code: "X", message: "x", details: { reason: "address-too-long" } },
      { kind: "no-usable-address", reason: "address-too-long" },
    ],
    [
      "pair 409 other reason",
      "pair",
      409,
      { code: "X", message: "x", details: { reason: "device-cap" } },
      { kind: "unexpected", status: 409, cause: "status" },
    ],
    [
      "devices 409 with the reason",
      "devices",
      409,
      { code: "X", message: "x", details: { reason: "no-usable-address" } },
      { kind: "unexpected", status: 409, cause: "status" },
    ],
    ["400", "pair", 400, undefined, { kind: "unexpected", status: 400, cause: "status" }],
    ["403", "devices", 403, undefined, { kind: "unexpected", status: 403, cause: "status" }],
    ["429", "test", 429, undefined, { kind: "unexpected", status: 429, cause: "status" }],
    ["500", "revoke", 500, undefined, { kind: "unexpected", status: 500, cause: "status" }],
    ["302", "devices", 302, undefined, { kind: "unexpected", status: 302, cause: "status" }],
  ];
  for (const [name, call, status, body, expected] of ROWS) {
    test(name, () => {
      expect(classifyPushResponse(call, status, body)).toEqual(expected);
    });
  }
});

describe("findingForFailure", () => {
  const REACH_FIX = "Check the address and that the server is running and reachable from here.";
  const UNEXPECTED_FIX =
    "Check that the address points at a Pulse server with push support, and that no proxy rewrites /api/push/.";
  const ROWS: ReadonlyArray<[string, PushCallFailure, FailureContext, string, string, string]> = [
    [
      "unreachable timeout (10 s)",
      { kind: "unreachable", cause: "timeout" },
      CTX,
      FINDING_CODES.PUSH_SERVER_UNREACHABLE,
      `Could not reach the Pulse server at ${BASE}: no answer within 10 s.`,
      REACH_FIX,
    ],
    [
      "unreachable timeout (60 s)",
      { kind: "unreachable", cause: "timeout" },
      { ...CTX, timeoutMs: PUSH_TEST_TIMEOUT_MS },
      FINDING_CODES.PUSH_SERVER_UNREACHABLE,
      `Could not reach the Pulse server at ${BASE}: no answer within 60 s.`,
      REACH_FIX,
    ],
    [
      "unreachable network",
      { kind: "unreachable", cause: "network" },
      CTX,
      FINDING_CODES.PUSH_SERVER_UNREACHABLE,
      `Could not reach the Pulse server at ${BASE}: network error (connection refused, DNS, TLS, or a redirect).`,
      `${REACH_FIX} Redirects are not followed; use the server's final https address.`,
    ],
    [
      "unexpected status",
      { kind: "unexpected", status: 500, cause: "status" },
      CTX,
      FINDING_CODES.PUSH_SERVER_UNREACHABLE,
      `The server at ${BASE} gave an unexpected answer (HTTP 500).`,
      UNEXPECTED_FIX,
    ],
    [
      "unexpected body",
      { kind: "unexpected", status: 200, cause: "body" },
      CTX,
      FINDING_CODES.PUSH_SERVER_UNREACHABLE,
      `The server at ${BASE} sent a response that is not a valid push response (HTTP 200).`,
      UNEXPECTED_FIX,
    ],
    [
      "refused",
      { kind: "refused" },
      CTX,
      FINDING_CODES.PUSH_OPERATOR_REFUSED,
      "The server refused the operator secret.",
      "Check that PULSE_PUSH_OPERATOR_SECRET matches the server's value exactly.",
    ],
    [
      "not-configured",
      { kind: "not-configured", status: 405 },
      CTX,
      FINDING_CODES.PUSH_NOT_CONFIGURED,
      `Push is not configured on the server at ${BASE}, or the server predates push.`,
      "Set the PULSE_PUSH_APNS_* variables on the server and restart it (see the operator guide).",
    ],
    [
      "misconfigured",
      { kind: "misconfigured" },
      CTX,
      FINDING_CODES.PUSH_MISCONFIGURED,
      "Push is misconfigured on the server, or its operator commands are off.",
      "Check the server's config_warning log lines and pulse_web_push_state. Operator commands need PULSE_PUSH_OPERATOR_SECRET set on the server.",
    ],
    [
      "no-usable-address",
      { kind: "no-usable-address", reason: "no-usable-address" },
      CTX,
      FINDING_CODES.PUSH_PAIR_NO_ADDRESS,
      "The server has no usable https address to put in the pairing link.",
      "Set PULSE_WEB_EXTERNAL_URL on the server to its https address, or pass that address with --server.",
    ],
    [
      "no-usable-address under --insecure-local",
      { kind: "no-usable-address", reason: "no-usable-address" },
      { ...CTX, baseUrl: "http://127.0.0.1:8080", insecure: true },
      FINDING_CODES.PUSH_PAIR_NO_ADDRESS,
      "The server has no usable https address to put in the pairing link.",
      "Set PULSE_WEB_EXTERNAL_URL on the server to its https address, or pass that address with --server. A --insecure-local address can never go into a link.",
    ],
    [
      "address-too-long",
      { kind: "no-usable-address", reason: "address-too-long" },
      CTX,
      FINDING_CODES.PUSH_PAIR_NO_ADDRESS,
      "The server's address makes the pairing link longer than 256 characters.",
      "Use a shorter https address in PULSE_WEB_EXTERNAL_URL or --server.",
    ],
    [
      "device-not-found",
      { kind: "device-not-found", deviceId: "dev_AbCdEfGhIjK" },
      CTX,
      FINDING_CODES.PUSH_DEVICE_NOT_FOUND,
      "No paired device has the id dev_AbCdEfGhIjK.",
      "Run pulse push devices to list device ids.",
    ],
  ];
  for (const [name, failure, ctx, code, message, fix] of ROWS) {
    test(name, () => {
      expect(findingForFailure(failure, ctx)).toEqual({ severity: "error", code, file: "", path: "", message, fix } as never);
    });
  }
});

describe("PUSH_ADMIN_PATHS", () => {
  test("equals the server's admin paths", () => {
    expect(PUSH_ADMIN_PATHS.pairingTokens).toBe(PUSH_PATHS.adminPairingTokens);
    expect(PUSH_ADMIN_PATHS.devices).toBe(PUSH_PATHS.adminDevices);
    expect(PUSH_ADMIN_PATHS.test).toBe(PUSH_PATHS.adminTest);
    expect(PUSH_ADMIN_PATHS.deviceById("dev_AbCdEfGhIjK")).toBe(
      PUSH_PATHS.adminDeviceById.replace(":id", "dev_AbCdEfGhIjK"),
    );
    const adminKeys = Object.keys(PUSH_PATHS).filter((k) => k.startsWith("admin"));
    expect(adminKeys).toHaveLength(Object.keys(PUSH_ADMIN_PATHS).length);
  });

  test("the constants have their documented values", () => {
    expect(PUSH_HTTP_TIMEOUT_MS).toBe(10_000);
    expect(PUSH_TEST_TIMEOUT_MS).toBe(60_000);
    expect(PUSH_MAX_RESPONSE_CHARS).toBe(1_048_576);
  });
});

describe("createPushClient — requests", () => {
  test("every call sends exactly Authorization: Bearer <secret>, Accept, redirect error and a timeout signal", async () => {
    const { client, calls, traces } = clientWith([
      json(201, { link: LINK, expiresAt: EXPIRES }),
      json(200, { devices: [DEVICE] }),
      new Response(null, { status: 204 }),
      json(200, { results: [] }),
      json(200, { results: [{ deviceId: DEVICE.id, displayName: "Example iPhone", outcome: "delivered" }] }),
    ]);
    expect(await client.issuePairingToken()).toEqual({ ok: true, value: { link: LINK, expiresAt: EXPIRES } });
    expect(await client.listDevices()).toEqual({ ok: true, value: { devices: [DEVICE] } } as never);
    expect(await client.revokeDevice(DEVICE.id)).toEqual({ ok: true, value: null });
    expect((await client.testSend(null)).ok).toBe(true);
    expect((await client.testSend(DEVICE.id)).ok).toBe(true);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${BASE}/api/push/admin/pairing-tokens`,
      `GET ${BASE}/api/push/admin/devices`,
      `DELETE ${BASE}/api/push/admin/devices/dev_AbCdEfGhIjK`,
      `POST ${BASE}/api/push/admin/test`,
      `POST ${BASE}/api/push/admin/test`,
    ]);
    expect(calls.map((c) => c.body)).toEqual([
      JSON.stringify({ baseUrl: BASE }),
      null,
      null,
      "{}",
      '{"deviceId":"dev_AbCdEfGhIjK"}',
    ]);
    for (const c of calls) {
      expect(c.headers.authorization).toBe(`Bearer ${SECRET}`);
      expect(c.headers.accept).toBe("application/json");
      expect(c.headers["content-type"]).toBe(c.body === null ? undefined : "application/json");
      expect(c.redirect).toBe("error");
      expect(c.hasSignal).toBe(true);
    }
    expect(traces).toEqual([
      `POST ${BASE}/api/push/admin/pairing-tokens → 201`,
      `GET ${BASE}/api/push/admin/devices → 200`,
      `DELETE ${BASE}/api/push/admin/devices/dev_AbCdEfGhIjK → 204`,
      `POST ${BASE}/api/push/admin/test → 200`,
      `POST ${BASE}/api/push/admin/test → 200`,
    ]);
    // The pair response is a secret: it never reaches the trace.
    for (const t of traces) expect(t.includes(TOKEN)).toBe(false);
  });

  test("a 302 is never followed", async () => {
    const { client, calls } = clientWith([
      new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.com/" } }),
    ]);
    const failure = failureOf(await client.listDevices());
    expect(failure).toEqual({ kind: "unexpected", status: 302, cause: "status" });
    expect(calls).toHaveLength(1);
  });

  test("the real fetch rejects a redirect under redirect: error", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 302, headers: { Location: "/elsewhere" } }),
    });
    try {
      const client = createPushClient({
        fetch: ((input, init) => fetch(input, init)) as typeof fetch,
        baseUrl: `http://127.0.0.1:${server.port}`,
        secret: secretOrThrow(),
      });
      expect(failureOf(await client.listDevices())).toEqual({ kind: "unreachable", cause: "network" });
    } finally {
      await server.stop(true);
    }
  });
});

describe("createPushClient — failures", () => {
  const timeoutError = () => new DOMException("The operation timed out.", "TimeoutError");
  const ROWS: ReadonlyArray<{
    name: string;
    run: (c: ReturnType<typeof clientWith>["client"]) => Promise<unknown>;
    answers: Answer[];
    failure: PushCallFailure;
    timeoutMs?: number;
    code: string;
  }> = [
    {
      name: "TypeError rejection → network",
      run: (c) => c.listDevices(),
      answers: [{ reject: new TypeError("fetch failed") }],
      failure: { kind: "unreachable", cause: "network" },
      code: FINDING_CODES.PUSH_SERVER_UNREACHABLE,
    },
    {
      name: "TimeoutError rejection → timeout (10 s)",
      run: (c) => c.listDevices(),
      answers: [{ reject: timeoutError() }],
      failure: { kind: "unreachable", cause: "timeout" },
      code: FINDING_CODES.PUSH_SERVER_UNREACHABLE,
    },
    {
      name: "test TimeoutError → timeout (60 s)",
      run: (c) => c.testSend(null),
      answers: [{ reject: timeoutError() }],
      failure: { kind: "unreachable", cause: "timeout" },
      timeoutMs: PUSH_TEST_TIMEOUT_MS,
      code: FINDING_CODES.PUSH_SERVER_UNREACHABLE,
    },
    {
      name: "a body read that rejects → network",
      run: (c) => c.listDevices(),
      answers: [
        () =>
          ({ status: 200, text: () => Promise.reject(new TypeError("reset")) }) as unknown as Response,
      ],
      failure: { kind: "unreachable", cause: "network" },
      code: FINDING_CODES.PUSH_SERVER_UNREACHABLE,
    },
    {
      name: "401",
      run: (c) => c.listDevices(),
      answers: [envelope(401, "UNAUTHORIZED")],
      failure: { kind: "refused" },
      code: FINDING_CODES.PUSH_OPERATOR_REFUSED,
    },
    {
      name: "404 on GET devices",
      run: (c) => c.listDevices(),
      answers: [envelope(404, "API_NOT_FOUND")],
      failure: { kind: "not-configured", status: 404 },
      code: FINDING_CODES.PUSH_NOT_CONFIGURED,
    },
    {
      name: "405 on DELETE",
      run: (c) => c.revokeDevice(DEVICE.id),
      answers: [envelope(405, "METHOD_NOT_ALLOWED")],
      failure: { kind: "not-configured", status: 405 },
      code: FINDING_CODES.PUSH_NOT_CONFIGURED,
    },
    {
      name: "503 PUSH_UNAVAILABLE",
      run: (c) => c.listDevices(),
      answers: [envelope(503, "PUSH_UNAVAILABLE")],
      failure: { kind: "misconfigured" },
      code: FINDING_CODES.PUSH_MISCONFIGURED,
    },
    {
      name: "503 with another body",
      run: (c) => c.listDevices(),
      answers: [new Response("<html>bad gateway</html>", { status: 503 })],
      failure: { kind: "unexpected", status: 503, cause: "status" },
      code: FINDING_CODES.PUSH_SERVER_UNREACHABLE,
    },
    {
      name: "409 no-usable-address",
      run: (c) => c.issuePairingToken(),
      answers: [envelope(409, "PUSH_PAIRING_UNAVAILABLE", { reason: "no-usable-address" })],
      failure: { kind: "no-usable-address", reason: "no-usable-address" },
      code: FINDING_CODES.PUSH_PAIR_NO_ADDRESS,
    },
    {
      name: "409 address-too-long",
      run: (c) => c.issuePairingToken(),
      answers: [envelope(409, "PUSH_PAIRING_UNAVAILABLE", { reason: "address-too-long" })],
      failure: { kind: "no-usable-address", reason: "address-too-long" },
      code: FINDING_CODES.PUSH_PAIR_NO_ADDRESS,
    },
    {
      name: "400",
      run: (c) => c.issuePairingToken(),
      answers: [envelope(400, "INVALID_REQUEST")],
      failure: { kind: "unexpected", status: 400, cause: "status" },
      code: FINDING_CODES.PUSH_SERVER_UNREACHABLE,
    },
    {
      name: "429",
      run: (c) => c.testSend(null),
      answers: [envelope(429, "RATE_LIMITED")],
      failure: { kind: "unexpected", status: 429, cause: "status" },
      code: FINDING_CODES.PUSH_SERVER_UNREACHABLE,
    },
    {
      name: "500",
      run: (c) => c.listDevices(),
      answers: [envelope(500, "INTERNAL_ERROR")],
      failure: { kind: "unexpected", status: 500, cause: "status" },
      code: FINDING_CODES.PUSH_SERVER_UNREACHABLE,
    },
    {
      name: "200 with an HTML body",
      run: (c) => c.listDevices(),
      answers: [new Response("<html>login</html>", { status: 200 })],
      failure: { kind: "unexpected", status: 200, cause: "body" },
      code: FINDING_CODES.PUSH_SERVER_UNREACHABLE,
    },
    {
      name: "201 whose link has no pair parameter",
      run: (c) => c.issuePairingToken(),
      answers: [json(201, { link: `pulse://connect?v=1&url=${encodeURIComponent(BASE)}`, expiresAt: EXPIRES })],
      failure: { kind: "unexpected", status: 201, cause: "body" },
      code: FINDING_CODES.PUSH_SERVER_UNREACHABLE,
    },
    {
      name: "a body over 1 MiB",
      run: (c) => c.listDevices(),
      answers: [new Response(`{"devices":[],"pad":"${"x".repeat(PUSH_MAX_RESPONSE_CHARS)}"}`, { status: 200 })],
      failure: { kind: "unexpected", status: 200, cause: "body" },
      code: FINDING_CODES.PUSH_SERVER_UNREACHABLE,
    },
    {
      name: "a test result with an unknown outcome",
      run: (c) => c.testSend(null),
      answers: [json(200, { results: [{ deviceId: DEVICE.id, displayName: "x", outcome: "maybe" }] })],
      failure: { kind: "unexpected", status: 200, cause: "body" },
      code: FINDING_CODES.PUSH_SERVER_UNREACHABLE,
    },
  ];

  for (const row of ROWS) {
    test(row.name, async () => {
      const { client, calls } = clientWith(row.answers);
      const result = (await row.run(client)) as { ok: false; failure: PushCallFailure };
      const failure = failureOf(result);
      expect(failure).toEqual(row.failure);
      expect(calls).toHaveLength(1);
      const finding = findingForFailure(failure, { ...CTX, timeoutMs: row.timeoutMs ?? PUSH_HTTP_TIMEOUT_MS });
      captured.push(JSON.stringify(finding));
      expect(finding.code).toBe(row.code as never);
      if (failure.kind === "unreachable" && failure.cause === "timeout") {
        expect(finding.message).toContain(row.timeoutMs === PUSH_TEST_TIMEOUT_MS ? "60 s" : "10 s");
      }
    });
  }

  test("timeout and network failures trace without a status", async () => {
    const { client, traces } = clientWith([{ reject: timeoutError() }, { reject: new TypeError("x") }]);
    await client.listDevices();
    await client.listDevices();
    expect(traces).toEqual([
      `GET ${BASE}/api/push/admin/devices → timeout`,
      `GET ${BASE}/api/push/admin/devices → network error`,
    ]);
  });
});

describe("createPushClient — 404 probe", () => {
  const nf = () => envelope(404, "API_NOT_FOUND");
  const seen = (calls: Recorded[]) => calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);

  test("revoke 404 then a 200 probe → device-not-found", async () => {
    const { client, calls } = clientWith([nf(), json(200, { devices: [] })]);
    expect(failureOf(await client.revokeDevice(DEVICE.id))).toEqual({ kind: "device-not-found", deviceId: DEVICE.id });
    expect(seen(calls)).toEqual(["DELETE /api/push/admin/devices/dev_AbCdEfGhIjK", "GET /api/push/admin/devices"]);
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  test("revoke 404 then a 404 probe → not-configured", async () => {
    const { client, calls } = clientWith([nf(), nf()]);
    expect(failureOf(await client.revokeDevice(DEVICE.id))).toEqual({ kind: "not-configured", status: 404 });
    expect(calls).toHaveLength(2);
  });

  test("revoke 404 then a 401 probe → refused", async () => {
    const { client, calls } = clientWith([nf(), envelope(401, "UNAUTHORIZED")]);
    expect(failureOf(await client.revokeDevice(DEVICE.id))).toEqual({ kind: "refused" });
    expect(calls).toHaveLength(2);
  });

  test("revoke 404 then a 503 probe → misconfigured", async () => {
    const { client } = clientWith([nf(), envelope(503, "PUSH_UNAVAILABLE")]);
    expect(failureOf(await client.revokeDevice(DEVICE.id))).toEqual({ kind: "misconfigured" });
  });

  test("revoke 404 with a plain-text body → not-configured, no probe", async () => {
    const { client, calls } = clientWith([new Response("Not Found", { status: 404 })]);
    expect(failureOf(await client.revokeDevice(DEVICE.id))).toEqual({ kind: "not-configured", status: 404 });
    expect(calls).toHaveLength(1);
  });

  test("test --device 404 then a 200 probe → device-not-found", async () => {
    const { client, calls } = clientWith([nf(), json(200, { devices: [DEVICE] })]);
    expect(failureOf(await client.testSend(DEVICE.id))).toEqual({ kind: "device-not-found", deviceId: DEVICE.id });
    expect(seen(calls)).toEqual(["POST /api/push/admin/test", "GET /api/push/admin/devices"]);
  });

  test("test without --device and a 404 → not-configured, no probe", async () => {
    const { client, calls } = clientWith([nf()]);
    expect(failureOf(await client.testSend(null))).toEqual({ kind: "not-configured", status: 404 });
    expect(calls).toHaveLength(1);
  });
});

describe("runCli push — shell wiring", () => {
  async function run(args: string[], env: NodeJS.ProcessEnv, answers: Answer[] = []) {
    const stub = stubFetch(answers);
    const result = await runCli(args, { env, fetch: stub.fetch });
    captured.push(result.stdout, result.stderr);
    return { ...result, calls: stub.calls };
  }

  test("no server and no secret give both findings in order, exit 1, and no request", async () => {
    const r = await run(["push", "devices", "--json"], {});
    expect(r.exitCode).toBe(1);
    expect(r.calls).toHaveLength(0);
    const env = JSON.parse(r.stdout) as { ok: boolean; command: string; data: unknown; findings: { code: string }[] };
    expect(env.command).toBe("push");
    expect(env.ok).toBe(false);
    expect(env.data).toBeNull();
    expect(env.findings.map((f) => f.code)).toEqual([
      FINDING_CODES.PUSH_SERVER_MISSING,
      FINDING_CODES.PUSH_OPERATOR_SECRET_MISSING,
    ]);
  });

  test("text mode reports the same two findings on stderr, stdout empty", async () => {
    const r = await run(["push", "devices"], {});
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("push_server_missing");
    expect(r.stderr).toContain("set PULSE_PUSH_OPERATOR_SECRET");
    expect(r.stderr.indexOf("push_server_missing")).toBeLessThan(r.stderr.indexOf("push_operator_secret_missing"));
  });

  test("a missing secret alone is one finding and no request", async () => {
    const r = await run(["push", "devices", "--server", BASE], {});
    expect(r.exitCode).toBe(1);
    expect(r.calls).toHaveLength(0);
    expect(r.stderr).toContain("push_operator_secret_missing");
    expect(r.stderr).not.toContain("push_server_missing");
  });

  test("with server and secret the unimplemented sub-command is a fault (exit 2), secret never printed", async () => {
    const r = await run(["push", "devices", "--server", BASE, "--json", "--verbose"], { [OPERATOR_SECRET_ENV]: SECRET });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("pulse push devices is not implemented");
    expect(r.stderr).toContain(`Server: ${BASE} (from --server)`);
  });

  test("--insecure-local prints its warning even with --quiet", async () => {
    const r = await run(["push", "devices", "--server", "http://127.0.0.1:8080", "--insecure-local", "--quiet"], {
      [OPERATOR_SECRET_ENV]: SECRET,
    });
    expect(r.stderr).toContain(
      "warning: --insecure-local: talking to http://127.0.0.1:8080 over plain HTTP; the operator secret is sent unencrypted. Development only.",
    );
  });

  test("a secret with a newline is refused without echoing it", async () => {
    const r = await run(["push", "devices", "--server", BASE], { [OPERATOR_SECRET_ENV]: `${SECRET}\n` });
    expect(r.exitCode).toBe(1);
    expect(r.calls).toHaveLength(0);
    expect(r.stderr).toContain("push_operator_secret_missing");
  });
});
