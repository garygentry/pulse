/** push.test.ts — `pulse push` argument parsing, the --insecure-local rule and server resolution. */

import { describe, expect, test } from "bun:test";

import { FINDING_CODES } from "@pulse/core";

import { GLOBAL_OPTIONS } from "../src/args.js";
import type { ConnectLinkAddress, PushServerAddress } from "../src/config.js";
import { PUSH_SUBVERBS, parsePushArgs } from "../src/commands/push/args.js";
import type { PushArgsResult } from "../src/commands/push/args.js";
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
