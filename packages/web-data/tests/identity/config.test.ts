import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  IDENTITY_CONFIG_ERROR_MESSAGES,
  parseIdentityConfig,
  type IdentityConfigInput,
  type IdentityConfigResult,
} from "../../src/identity/config.js";

const ALL_NULL: IdentityConfigInput = { mode: null, headerName: null, trustedProxies: null };

function ok(result: IdentityConfigResult) {
  if (!result.ok) throw new Error(`expected ok, got error ${result.error.code}`);
  return result;
}
function err(result: IdentityConfigResult) {
  if (result.ok) throw new Error("expected error, got ok");
  return result;
}

describe("parseIdentityConfig — defaults & mode", () => {
  test("all-null input yields the none/Remote-User/empty defaults with no warnings", () => {
    const r = ok(parseIdentityConfig(ALL_NULL));
    expect(r.config).toEqual({ mode: "none", headerName: "Remote-User", trustedProxies: [] });
    expect(r.warnings).toEqual([]);
  });

  test("accepts the two literal modes and trims surrounding whitespace", () => {
    expect(ok(parseIdentityConfig({ ...ALL_NULL, mode: "proxy-header" })).config.mode).toBe("proxy-header");
    expect(ok(parseIdentityConfig({ ...ALL_NULL, mode: "  none  " })).config.mode).toBe("none");
  });

  test("rejects an unknown mode with the exact message and env var, no value echoed", () => {
    const e = err(parseIdentityConfig({ ...ALL_NULL, mode: "trust-me" }));
    expect(e.error.code).toBe("invalid-mode");
    expect(e.error.message).toBe(IDENTITY_CONFIG_ERROR_MESSAGES["invalid-mode"]);
    expect(e.error.envVar).toBe("PULSE_WEB_AUTH_MODE");
    expect(e.error.message).not.toContain("trust-me");
  });
});

describe("parseIdentityConfig — header", () => {
  test("accepts a valid RFC token header and trims it", () => {
    expect(ok(parseIdentityConfig({ ...ALL_NULL, headerName: " X-Auth-User " })).config.headerName).toBe("X-Auth-User");
  });

  test.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["contains space", "Remote User"],
    ["contains colon", "Remote:User"],
    ["contains non-ascii", "Rémote"],
    ["over 128 bytes", "x".repeat(129)],
  ])("rejects invalid header (%s)", (_label, value) => {
    const e = err(parseIdentityConfig({ ...ALL_NULL, headerName: value }));
    expect(e.error.code).toBe("invalid-header");
    expect(e.error.envVar).toBe("PULSE_WEB_AUTH_HEADER");
    expect(e.error.message).toBe(IDENTITY_CONFIG_ERROR_MESSAGES["invalid-header"]);
  });

  test("accepts a header at the 128-byte boundary", () => {
    expect(ok(parseIdentityConfig({ ...ALL_NULL, headerName: "x".repeat(128) })).config.headerName.length).toBe(128);
  });

  test("invalid-header error never echoes the rejected header value (no raw values in diagnostics)", () => {
    const e = err(parseIdentityConfig({ ...ALL_NULL, headerName: "Secret Header:Value" }));
    expect(e.error.code).toBe("invalid-header");
    expect(e.error.message).not.toContain("Secret");
    expect(e.error.message).not.toContain("Value");
  });
});

describe("parseIdentityConfig — trusted proxy CIDRs", () => {
  test("canonicalizes IPv4/IPv6 network bits and preserves prefix", () => {
    const r = ok(parseIdentityConfig({ mode: "proxy-header", headerName: null, trustedProxies: "10.0.0.5/24, 2001:db8::1/48" }));
    expect(r.config.trustedProxies).toEqual(["10.0.0.0/24", "2001:db8:0:0:0:0:0:0/48"]);
  });

  test("dedupes canonically-equivalent CIDRs, preserving first-seen order", () => {
    const r = ok(parseIdentityConfig({ mode: "proxy-header", headerName: null, trustedProxies: "10.0.0.0/24,10.0.0.9/24,192.168.1.0/24" }));
    expect(r.config.trustedProxies).toEqual(["10.0.0.0/24", "192.168.1.0/24"]);
  });

  test.each([
    ["bare address without prefix", "10.0.0.0"],
    ["zone id", "fe80::1%eth0/64"],
    ["empty member (trailing comma)", "10.0.0.0/24,"],
    ["out-of-range prefix", "10.0.0.0/33"],
    ["garbage", "not-an-ip/24"],
  ])("rejects invalid CIDR (%s)", (_label, value) => {
    const e = err(parseIdentityConfig({ mode: "proxy-header", headerName: null, trustedProxies: value }));
    expect(e.error.code).toBe("invalid-cidr");
    expect(e.error.envVar).toBe("PULSE_WEB_TRUSTED_PROXIES");
    expect(e.error.message).toBe(IDENTITY_CONFIG_ERROR_MESSAGES["invalid-cidr"]);
    expect(e.error.message).not.toContain(value);
  });

  test("accepts exactly 64 CIDRs and rejects 65", () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => `10.${i >> 8}.${i & 255}.0/24`).join(",");
    expect(ok(parseIdentityConfig({ mode: "proxy-header", headerName: null, trustedProxies: make(64) })).config.trustedProxies.length).toBe(64);
    const e = err(parseIdentityConfig({ mode: "proxy-header", headerName: null, trustedProxies: make(65) }));
    expect(e.error.code).toBe("too-many-cidrs");
    expect(e.error.envVar).toBe("PULSE_WEB_TRUSTED_PROXIES");
    // No configured CIDR value is echoed into the diagnostic message.
    expect(e.error.message).not.toContain("10.");
    expect(e.error.message).not.toContain("/24");
  });

  test("empty/whitespace trustedProxies string is a valid empty list", () => {
    expect(ok(parseIdentityConfig({ mode: "proxy-header", headerName: null, trustedProxies: "" })).config.trustedProxies).toEqual([]);
    expect(ok(parseIdentityConfig({ mode: "proxy-header", headerName: null, trustedProxies: "   " })).config.trustedProxies).toEqual([]);
  });
});

describe("parseIdentityConfig — warnings", () => {
  test("none mode with supplied trust settings warns identity-settings-ignored (categorical, no value)", () => {
    const r = ok(parseIdentityConfig({ mode: "none", headerName: "X-Auth", trustedProxies: "10.0.0.0/24" }));
    expect(r.warnings.map((w) => w.code)).toEqual(["identity-settings-ignored"]);
    expect(r.warnings[0]!.message).not.toContain("10.0.0.0");
    expect(r.warnings[0]!.message).not.toContain("X-Auth");
    // Settings are still validated (config carries the canonical values) but disabled by mode.
    expect(r.config.mode).toBe("none");
    expect(r.config.trustedProxies).toEqual(["10.0.0.0/24"]);
  });

  test("none mode with no supplied settings emits no warning", () => {
    expect(ok(parseIdentityConfig(ALL_NULL)).warnings).toEqual([]);
  });

  test("proxy-header mode with empty trust warns proxy_mode_deny_all (trusted-proxies-empty)", () => {
    const r = ok(parseIdentityConfig({ mode: "proxy-header", headerName: null, trustedProxies: null }));
    expect(r.warnings.map((w) => w.code)).toEqual(["trusted-proxies-empty"]);
  });

  test("proxy-header mode with a trusted CIDR emits no warning", () => {
    expect(ok(parseIdentityConfig({ mode: "proxy-header", headerName: null, trustedProxies: "10.0.0.0/24" })).warnings).toEqual([]);
  });
});

describe("ipaddr.js dependency provenance", () => {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("ipaddr.js/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string; license: string; types?: string };

  test("is pinned to 2.5.0 under an MIT license with bundled declarations", () => {
    expect(pkg.version).toBe("2.5.0");
    expect(pkg.license).toBe("MIT");
    expect(pkg.types).toBeTruthy();
  });
});
