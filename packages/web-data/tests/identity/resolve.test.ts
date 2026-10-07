import { describe, expect, test } from "bun:test";
import { parseIdentityConfig, type IdentityConfig } from "../../src/identity/config.js";
import { resolveIdentity } from "../../src/identity/resolve.js";

function config(mode: string, trustedProxies: string | null, headerName: string | null = null): IdentityConfig {
  const r = parseIdentityConfig({ mode, headerName, trustedProxies });
  if (!r.ok) throw new Error(`bad test config: ${r.error.code}`);
  return r.config;
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://pulse.internal/api/session", { headers });
}

const PROXY_10 = config("proxy-header", "10.0.0.0/24");

describe("resolveIdentity — denial paths", () => {
  test("none mode never resolves even with a matching peer and header present", () => {
    const cfg = config("none", "10.0.0.0/24", "Remote-User");
    expect(resolveIdentity(req({ "Remote-User": "alice" }), "10.0.0.9", cfg)).toBeNull();
  });

  test("empty trusted list denies every peer", () => {
    const cfg = config("proxy-header", null);
    expect(resolveIdentity(req({ "Remote-User": "alice" }), "10.0.0.9", cfg)).toBeNull();
  });

  test("missing peer IP is untrusted", () => {
    expect(resolveIdentity(req({ "Remote-User": "alice" }), null, PROXY_10)).toBeNull();
    expect(resolveIdentity(req({ "Remote-User": "alice" }), "", PROXY_10)).toBeNull();
  });

  test("malformed peer IP is untrusted", () => {
    expect(resolveIdentity(req({ "Remote-User": "alice" }), "not-an-ip", PROXY_10)).toBeNull();
  });

  test("peer outside every configured CIDR is untrusted", () => {
    expect(resolveIdentity(req({ "Remote-User": "alice" }), "10.0.1.1", PROXY_10)).toBeNull();
    expect(resolveIdentity(req({ "Remote-User": "alice" }), "127.0.0.1", PROXY_10)).toBeNull();
  });
});

describe("resolveIdentity — trust matching", () => {
  test("accepts an in-range IPv4 peer and exposes exactly subject/displayName/source", () => {
    const id = resolveIdentity(req({ "Remote-User": "alice" }), "10.0.0.42", PROXY_10);
    expect(id).toEqual({ subject: "alice", displayName: "alice", source: "proxy-header" });
    expect(Object.keys(id!).sort()).toEqual(["displayName", "source", "subject"]);
  });

  test("matches an IPv6 peer within a configured IPv6 CIDR", () => {
    const cfg = config("proxy-header", "2001:db8::/32");
    expect(resolveIdentity(req({ "Remote-User": "bob" }), "2001:db8::5", cfg)?.subject).toBe("bob");
    expect(resolveIdentity(req({ "Remote-User": "bob" }), "2001:dead::5", cfg)).toBeNull();
  });

  test("normalizes an IPv4-mapped IPv6 peer to match an IPv4 CIDR", () => {
    expect(resolveIdentity(req({ "Remote-User": "alice" }), "::ffff:10.0.0.9", PROXY_10)?.subject).toBe("alice");
  });

  test("honors the exact prefix boundary", () => {
    const cfg = config("proxy-header", "10.0.0.128/25");
    expect(resolveIdentity(req({ "Remote-User": "a" }), "10.0.0.128", cfg)?.subject).toBe("a");
    expect(resolveIdentity(req({ "Remote-User": "a" }), "10.0.0.127", cfg)).toBeNull();
  });

  test("matches when the peer is in any of multiple configured ranges", () => {
    const cfg = config("proxy-header", "10.0.0.0/24,192.168.5.0/24,2001:db8::/48");
    expect(resolveIdentity(req({ "Remote-User": "a" }), "192.168.5.7", cfg)?.subject).toBe("a");
    expect(resolveIdentity(req({ "Remote-User": "a" }), "2001:db8::1", cfg)?.subject).toBe("a");
  });

  test("respects a custom configured header name", () => {
    const cfg = config("proxy-header", "10.0.0.0/24", "X-Auth-User");
    expect(resolveIdentity(req({ "X-Auth-User": "carol" }), "10.0.0.9", cfg)?.subject).toBe("carol");
    expect(resolveIdentity(req({ "Remote-User": "carol" }), "10.0.0.9", cfg)).toBeNull();
  });
});

describe("resolveIdentity — address-kind boundaries (item 032)", () => {
  test("an IPv4-mapped IPv6 peer outside the IPv4 CIDR is untrusted (mapping does not over-match)", () => {
    // ::ffff:10.0.1.1 normalizes to 10.0.1.1, which is outside 10.0.0.0/24.
    expect(resolveIdentity(req({ "Remote-User": "alice" }), "::ffff:10.0.1.1", PROXY_10)).toBeNull();
  });

  test("an IPv4 peer against an IPv6-only trust list is denied without throwing", () => {
    const cfg = config("proxy-header", "2001:db8::/48");
    expect(resolveIdentity(req({ "Remote-User": "a" }), "10.0.0.9", cfg)).toBeNull();
  });

  test("an IPv6 peer against an IPv4-only trust list is denied without throwing", () => {
    expect(resolveIdentity(req({ "Remote-User": "a" }), "2001:db8::5", PROXY_10)).toBeNull();
  });

  test("honors the exact IPv6 prefix boundary", () => {
    // /127 covers exactly ::0 and ::1; ::2 falls outside.
    const cfg = config("proxy-header", "2001:db8::/127");
    expect(resolveIdentity(req({ "Remote-User": "a" }), "2001:db8::1", cfg)?.subject).toBe("a");
    expect(resolveIdentity(req({ "Remote-User": "a" }), "2001:db8::2", cfg)).toBeNull();
  });
});

describe("resolveIdentity — header value validation", () => {
  test("missing configured header is anonymous", () => {
    expect(resolveIdentity(req({}), "10.0.0.9", PROXY_10)).toBeNull();
  });

  test("empty or whitespace-only value is anonymous, non-empty is trimmed", () => {
    expect(resolveIdentity(req({ "Remote-User": "   " }), "10.0.0.9", PROXY_10)).toBeNull();
    expect(resolveIdentity(req({ "Remote-User": "  dave  " }), "10.0.0.9", PROXY_10)?.subject).toBe("dave");
  });

  test("value over 256 UTF-8 bytes is anonymous; 256 is accepted", () => {
    expect(resolveIdentity(req({ "Remote-User": "x".repeat(256) }), "10.0.0.9", PROXY_10)?.subject.length).toBe(256);
    expect(resolveIdentity(req({ "Remote-User": "x".repeat(257) }), "10.0.0.9", PROXY_10)).toBeNull();
    // A 2-byte code point exceeds the byte bound at 128 characters + 1.
    expect(resolveIdentity(req({ "Remote-User": "é".repeat(129) }), "10.0.0.9", PROXY_10)).toBeNull();
  });

  test.each([
    ["C0 control (tab)", "al\tice"],
    ["DEL", "al\x7fice"],
    ["C1 control", "al\x85ice"],
  ])("value with %s is anonymous", (_label, value) => {
    expect(resolveIdentity(req({ "Remote-User": value }), "10.0.0.9", PROXY_10)).toBeNull();
  });

  test.each([
    ["newline", "al\nice"],
    ["carriage return", "al\rice"],
  ])("value with %s is anonymous (platform rejects it at Headers, guard covers it defensively)", (_label, value) => {
    // The Fetch Headers guard forbids newline/CR in a real request, so they can never reach
    // resolveIdentity through a Request; assert both the platform boundary AND the defensive check.
    expect(() => req({ "Remote-User": value })).toThrow();
    const stub = { headers: { get: () => value } } as unknown as Request;
    expect(resolveIdentity(stub, "10.0.0.9", PROXY_10)).toBeNull();
  });
});

describe("resolveIdentity — spoofing & purity", () => {
  test("a spoofed X-Forwarded-For does not establish trust for an untrusted peer", () => {
    const spoof = req({ "Remote-User": "attacker", "X-Forwarded-For": "10.0.0.9" });
    expect(resolveIdentity(spoof, "203.0.113.7", PROXY_10)).toBeNull();
  });

  test("identity derives from the configured header, never from a forwarding header", () => {
    const r = req({ "Remote-User": "real", "X-Forwarded-User": "spoofed" });
    expect(resolveIdentity(r, "10.0.0.9", PROXY_10)?.subject).toBe("real");
  });

  test("does not mutate the request headers or the config", () => {
    const cfg = config("proxy-header", "10.0.0.0/24,192.168.5.0/24");
    const before = [...cfg.trustedProxies];
    const r = req({ "Remote-User": "alice" });
    const headerSnapshot = [...r.headers.entries()];
    resolveIdentity(r, "10.0.0.9", cfg);
    expect([...cfg.trustedProxies]).toEqual(before);
    expect([...r.headers.entries()]).toEqual(headerSnapshot);
  });
});
