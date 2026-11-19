/**
 * Rule engine of the public-safe lint. Every rule has synthetic inputs proving it fires and a precision corpus
 * proving it stays quiet. Firing inputs are built at runtime from fragments (see helpers.ts), so this file never
 * contains a literal the lint would flag.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { globToRegExp, pathMatches } from "../../scripts/public-safe/glob.js";
import {
  findDenyTerms,
  findHomePaths,
  findHostnames,
  findIpAddresses,
  formatViolation,
  maskValue,
  scan,
  suggestFor,
} from "../../scripts/public-safe/rules.js";
import type { RuleMatch } from "../../scripts/public-safe/rules.js";
import type { LintException, ScanInput, Violation } from "../../scripts/public-safe/types.js";
import { colon, dot, slash } from "./helpers.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** A firing sample: the line, the value expected to be reported and (optionally) its 1-based column. */
interface Firing {
  readonly name: string;
  readonly line: string;
  readonly value: string;
  readonly column?: number;
}

const summary = (matches: readonly RuleMatch[]): Array<{ value: string; column: number }> =>
  matches.map((m) => ({ value: m.value, column: m.index + 1 }));

function expectOne(matches: readonly RuleMatch[], sample: Firing): RuleMatch {
  expect([sample.name, matches.map((m) => m.value)]).toEqual([sample.name, [sample.value]]);
  const match = matches[0] as RuleMatch;
  expect([sample.name, match.index + 1]).toEqual([sample.name, sample.column ?? sample.line.indexOf(sample.value) + 1]);
  return match;
}

function runScan(
  files: readonly ScanInput[],
  options: { exceptions?: readonly LintException[]; denyTerms?: readonly string[]; contractFileCount?: number } = {},
) {
  return scan({
    files,
    exceptions: options.exceptions ?? [],
    denyTerms: options.denyTerms ?? [],
    contractFileCount: options.contractFileCount ?? 1,
  });
}

// ── P1 hostname ──────────────────────────────────────────────────────────────────────────────────────────────

const NAS = dot("nas", "lan");
const ACME_NET = dot("acme", "net");

const HOST_FIRING: readonly Firing[] = [
  { name: "URL, private suffix", line: `see https://${NAS}/x`, value: NAS, column: 13 },
  { name: "URL, non-standard suffix + port", line: `http://${dot("grafana", "acme")}:3000`, value: dot("grafana", "acme") },
  { name: "URL, userinfo", line: `https://ops@${NAS}/x`, value: NAS },
  { name: "URL, trailing dot", line: `https://${NAS}. Then`, value: NAS },
  { name: "URL, any TLD", line: `wss://${dot("pulse", "acme", "dev")}/api`, value: dot("pulse", "acme", "dev") },
  { name: "encoded URL", line: `pulse://connect?v=1&url=https%3A%2F%2F${NAS}`, value: NAS },
  { name: "encoded URL, lower-case escapes + port", line: `url=https%3a%2f%2f${NAS}%3A8443`, value: NAS },
  { name: "host:port", line: `${dot("db", "acme")}:5432`, value: dot("db", "acme") },
  { name: "host:port in prose", line: `scrape ${dot("node", "acme", "io")}:9100 every minute`, value: dot("node", "acme", "io") },
  { name: "bare public TLD", line: `mirror ${dot("downloads", "acme", "com")}`, value: dot("downloads", "acme", "com") },
  { name: "bare public TLD, sentence-final", line: `It lives at ${dot("acme", "org")}.`, value: dot("acme", "org") },
  { name: "bare private suffix", line: dot("printer", "home", "arpa"), value: dot("printer", "home", "arpa") },
  { name: "bare private suffix, upper case", line: dot("NAS", "LAN"), value: dot("NAS", "LAN") },
  { name: "bare, JSON string", line: `{"host":"${dot("web-01", "corp")}"}`, value: dot("web-01", "corp") },
  { name: "bare, after encoded slash", line: `next=%2F${NAS}`, value: NAS },
  { name: "reverse-DNS of a real name", line: dot("com", "acme", "uk"), value: dot("com", "acme", "uk") },
  { name: "subdomain of a well-known host", line: dot("gist", "github", "com"), value: dot("gist", "github", "com") },
];

/** Lines that must produce no hostname finding. */
const HOST_QUIET: Readonly<Record<string, readonly string[]>> = {
  allowlist: [
    "pulse.example.com",
    "https://grafana.example.net:3000",
    "ops@example.org",
    "a.b.example",
    "svc.test",
    "x.invalid",
    "app.localhost",
    "localhost:8080",
    "https://localhost",
    "https://PULSE.EXAMPLE.COM/x",
    "See pulse.example.com.",
    "web-01.example.com:9100",
    "https://operator@pulse.example.com/",
  ],
  "file names": [
    "routes/overview.ts:56",
    "snapshot.ts:45",
    "README.md",
    "docker-compose.yml",
    "App.swift",
    "rules.test.ts:3",
    "bun.lock",
    "contract/fixtures/events/stream-typical.sse",
    "web-estate-model.json",
  ],
  "member access": [
    "ctx.config",
    "ctx.config.identity.mode",
    "user.id",
    "item.name",
    "log.info",
    "this.app",
    "utils.cn(a)",
    "rows.co[0]",
    "CONTRACT_LIMITS.overview.hosts",
    "process.env.PULSE_WEB_EXTERNAL_URL",
    "estate.liveness",
    "$.data.io",
    "obj_a.io",
  ],
  "package ids": [
    "@pulse/web-data",
    "@radix-ui/react-dialog",
    "ipaddr.js@2.5.0",
    "com.example.pulse",
    "com.example.uk",
    "com.apple.developer.associated-domains",
    "com.apple.security",
    "qrcode-generator@2.0.4",
  ],
  "well-known": [
    "https://github.com/owner/repo",
    "api.push.apple.com:443",
    "ghcr.io/owner/image",
    "developer.apple.com",
    "https://api.sandbox.push.apple.com",
    "GitHub.com",
  ],
  "scheme, suffix-only, templates": [
    "pulse://connect?v=1&url=https%3A%2F%2Fpulse.example.com",
    "pulse://connect?v=1&url=https%3A%2F%2Fpulse.example.com%3A8443&name=home",
    ".lan",
    "home.arpa",
    "https://${HOST}",
    "https://<host>/",
    "https://{{ .Host }}/",
    "http://192.0.2.10:8080/metrics",
    "http://[2001:db8::10]:8080",
    "file:///var/lib/pulse/rendered/web-estate-model.json",
  ],
  "versions, times, ids": [
    "1.2.3",
    "v0.5.0",
    "2026-01-01T10:30:00.000Z",
    "sha256:10b0c2a9b830c8c4ebc2acace59f0d8e227dff8a41aa2f2c18f158e39463b853",
    "0.0.0-fixture",
    "svc-001",
    "nas",
  ],
};

describe("hostname rule (P1)", () => {
  for (const sample of HOST_FIRING) {
    test(`fires: ${sample.name}`, () => {
      const match = expectOne(findHostnames(sample.line), sample);
      expect(match.rule).toBe("hostname");
      expect(suggestFor(match)).toBe("pulse.example.com");
    });
  }

  test("fires after @ with the email suggestion", () => {
    const line = `ops@${ACME_NET}`;
    const match = expectOne(findHostnames(line), { name: "after @", line, value: ACME_NET, column: 5 });
    expect(match.kind).toBe("email");
    expect(suggestFor(match)).toBe("example.com");
  });

  test("a port above 65535 is not a host:port, but the bare name still fires", () => {
    expect(summary(findHostnames(`${NAS}:99999`))).toEqual([{ value: NAS, column: 1 }]);
    expect(findHostnames(`${dot("db", "acme")}:99999`)).toEqual([]);
  });

  test("one name is reported once, however many positions it fits", () => {
    // URL + host:port + bare all describe the same span.
    expect(summary(findHostnames(`https://${NAS}:8443/`))).toEqual([{ value: NAS, column: 9 }]);
    expect(summary(findHostnames(`${NAS}:8443`))).toEqual([{ value: NAS, column: 1 }]);
    // Two distinct names on one line are both reported, in column order.
    expect(findHostnames(`${NAS} and ops@${ACME_NET}`).map((m) => m.value)).toEqual([NAS, ACME_NET]);
  });

  for (const [group, lines] of Object.entries(HOST_QUIET)) {
    test(`quiet: ${group}`, () => {
      for (const line of lines) expect([line, summary(findHostnames(line))]).toEqual([line, []]);
    });
  }
});

// ── P2 IP address ────────────────────────────────────────────────────────────────────────────────────────────

const TEN = dot("10", "1", "2", "3");
const ULA = colon("fd00", "", "1");
const V6_SUGGESTION = "2001:db8::10";

const IPV4_FIRING: readonly Firing[] = [
  { name: "private 10/8", line: dot("10", "0", "0", "5"), value: dot("10", "0", "0", "5") },
  { name: "private 172.16/12", line: dot("172", "16", "4", "2"), value: dot("172", "16", "4", "2") },
  { name: "with port", line: `${TEN}:9090`, value: TEN },
  { name: "sentence-final", line: `scrape ${TEN}.`, value: TEN, column: 8 },
  { name: "leading zeros", line: dot("10", "0", "0", "05"), value: dot("10", "0", "0", "05") },
  { name: "just outside a documentation range", line: dot("192", "0", "3", "1"), value: dot("192", "0", "3", "1") },
  { name: "in a URL", line: `http://${TEN}:3000/d/abc`, value: TEN, column: 8 },
  { name: "unspecified /8 is not allowlisted", line: dot("0", "1", "2", "3"), value: dot("0", "1", "2", "3") },
];

const LINK_LOCAL_FULL = colon("fe80", "0", "0", "0", "1", "2", "3", "4");
const LINK_LOCAL_ZONED = `${colon("fe80", "", "1")}%en0`;
const MAPPED_PRIVATE = `::ffff:${TEN}`;

const IPV6_FIRING: readonly Firing[] = [
  { name: "compressed", line: ULA, value: ULA },
  { name: "8-group", line: LINK_LOCAL_FULL, value: LINK_LOCAL_FULL },
  { name: "zoned", line: LINK_LOCAL_ZONED, value: LINK_LOCAL_ZONED },
  { name: "bracketed in a URL", line: `http://[${ULA}]:8080`, value: ULA, column: 9 },
  { name: "just outside the documentation range", line: colon("2001", "db9", "", "1"), value: colon("2001", "db9", "", "1") },
  { name: "IPv4-mapped private", line: MAPPED_PRIVATE, value: MAPPED_PRIVATE },
  { name: "in a JSON string", line: `{"address":"${ULA}"}`, value: ULA },
];

const IP_QUIET: Readonly<Record<string, readonly string[]>> = {
  "every allowlist range": [
    "192.0.2.1",
    "198.51.100.200",
    "203.0.113.9",
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "2001:db8::10",
    "2001:db8:ffff::1",
    "::1",
    "::",
    "::ffff:192.0.2.1",
    "::ffff:127.0.0.1",
    "::ffff:0.0.0.0",
    "http://192.0.2.10:8080 and [2001:db8::10]:9090",
  ],
  versions: ["1.2.3", "v1.2.3.4", "1.2.3.4-rc1", "1.2.3.4.5", "999.1.1.1", "ipaddr.js@2.5.0", "0.0.0-fixture", "build 1.62.1"],
  "times / ids": [
    "2026-01-01T10:30:00.000Z",
    "2026-01-01 10:30:00",
    "10:30:00",
    "12:34",
    "id: 3f2b8c1e-9d4a-4c1b-8e2f-0a1b2c3d4e5f:42",
    "id: 00000000-0000-4000-8000-000000000001:1",
    '{"observedAt":"2026-01-01T00:00:00.000Z","at":"2026-01-01T23:59:59Z"}',
    "retry: 10000",
  ],
  "look-alikes": [
    "std::vector",
    "a::b",
    "cafe::face",
    "aa:bb:cc:dd:ee:ff",
    "16:9",
    "sha256:abc123",
    "12:34:56:78:90:12:34:56",
    "sha256:10b0c2a9b830c8c4ebc2acace59f0d8e227dff8a41aa2f2c18f158e39463b853",
    '{"a":1,"b":2,"c":{"d":3}}',
    "Foo::Bar::baz2",
    "key: value: other",
  ],
};

describe("IP address rule (P2)", () => {
  for (const sample of IPV4_FIRING) {
    test(`fires (IPv4): ${sample.name}`, () => {
      const match = expectOne(findIpAddresses(sample.line), sample);
      expect(match.rule).toBe("ip-address");
      expect(match.kind).toBe("default");
      expect(suggestFor(match)).toBe("192.0.2.10");
      expect(maskValue("ip-address", match.value)).toBe(`${match.value.split(".")[0]}…`);
    });
  }

  for (const sample of IPV6_FIRING) {
    test(`fires (IPv6): ${sample.name}`, () => {
      const match = expectOne(findIpAddresses(sample.line), sample);
      expect(match.rule).toBe("ip-address");
      expect(match.kind).toBe("ipv6");
      expect(suggestFor(match)).toBe(V6_SUGGESTION);
    });
  }

  test("an IPv4-mapped literal is one finding, not an IPv6 and an IPv4 one", () => {
    expect(summary(findIpAddresses(`bind ${MAPPED_PRIVATE} now`))).toEqual([{ value: MAPPED_PRIVATE, column: 6 }]);
  });

  test("both ends of an a.b.c.d-e.f.g.h range are reported", () => {
    const end = dot("10", "1", "2", "9");
    expect(findIpAddresses(`${TEN}-${end}`).map((m) => m.value)).toEqual([TEN, end]);
  });

  test("masks keep one octet or group", () => {
    expect(maskValue("ip-address", dot("10", "0", "0", "5"))).toBe("10…");
    expect(maskValue("ip-address", dot("172", "16", "4", "2"))).toBe("172…");
    expect(maskValue("ip-address", ULA)).toBe("fd00…");
    expect(maskValue("ip-address", MAPPED_PRIVATE)).toBe("::…");
  });

  for (const [group, lines] of Object.entries(IP_QUIET)) {
    test(`quiet: ${group}`, () => {
      for (const line of lines) expect([line, summary(findIpAddresses(line))]).toEqual([line, []]);
    });
  }

  test("quiet: a committed event-stream transcript, frame by frame", () => {
    const transcript = readFileSync(resolve(REPO_ROOT, "contract/fixtures/events/stream-typical.sse"), "utf8");
    const lines = transcript.split(/\r?\n/);
    expect(lines.some((line) => /^id: [0-9a-f-]{36}:\d+$/.test(line))).toBe(true);
    for (const line of lines) expect(summary(findIpAddresses(line))).toEqual([]);
  });
});

// ── P3 home path ─────────────────────────────────────────────────────────────────────────────────────────────

const SOMEONE = "someone";
const POSIX_HOME = slash("", "home", SOMEONE);
const MAC_HOME = `/${"Users"}/${SOMEONE}`;
const WINDOWS_HOME = ["C:", "Users", SOMEONE].join("\\");
const WINDOWS_HOME_JSON = ["C:", "Users", SOMEONE].join("\\\\");
const TILDE_HOME = `~${SOMEONE}`;

const HOME_FIRING: ReadonlyArray<Firing & { readonly masked: string }> = [
  { name: "/home/<name>/x", line: `${POSIX_HOME}/x`, value: POSIX_HOME, masked: "/home/…" },
  { name: "/Users/<name>/", line: `${MAC_HOME}/`, value: MAC_HOME, masked: "/Users/…" },
  { name: "Windows", line: `${WINDOWS_HOME}\\`, value: WINDOWS_HOME, masked: "C:\\Users\\…" },
  { name: "Windows, JSON-escaped", line: `"${WINDOWS_HOME_JSON}\\\\notes"`, value: WINDOWS_HOME_JSON, masked: "C:\\Users\\…" },
  { name: "Windows, forward slashes (one finding)", line: `d:/Users/${SOMEONE}/x`, value: `d:/Users/${SOMEONE}`, masked: "d:\\Users\\…" },
  { name: "~<name>/", line: `${TILDE_HOME}/notes`, value: TILDE_HOME, masked: "~…" },
  { name: "file:// URL", line: `file://${POSIX_HOME}/`, value: POSIX_HOME, column: 8, masked: "/home/…" },
  { name: "lower-case placeholder", line: slash("", "home", "user", ""), value: slash("", "home", "user"), masked: "/home/…" },
  { name: "end of line", line: `cd ${POSIX_HOME}`, value: POSIX_HOME, masked: "/home/…" },
  { name: "quoted", line: `"cwd":"${MAC_HOME}"`, value: MAC_HOME, masked: "/Users/…" },
];

const HOME_QUIET: readonly string[] = [
  "/home/USER/",
  "/Users/NAME/x",
  "/Users/USER/Library",
  "/home/<name>/",
  "/home/{user}/",
  "~/x",
  "$HOME/x",
  "/home/$USER/",
  "/home/",
  "https://example.com/home/page/",
  "/var/home/USER/",
  "/home/…",
  "C:\\Users\\USER\\",
  "~USER/x",
  "a ~ b / c",
  "/var/lib/pulse/rendered/web-estate-model.json",
];

describe("home-path rule (P3)", () => {
  for (const sample of HOME_FIRING) {
    test(`fires: ${sample.name}`, () => {
      const match = expectOne(findHomePaths(sample.line), sample);
      expect(match.rule).toBe("home-path");
      expect(suggestFor(match)).toBe("~/…");
      expect(maskValue("home-path", match.value)).toBe(sample.masked);
      expect(maskValue("home-path", match.value)).not.toContain(SOMEONE);
    });
  }

  test("quiet: placeholders, ~/, $HOME and non-home paths", () => {
    for (const line of HOME_QUIET) expect([line, summary(findHomePaths(line))]).toEqual([line, []]);
  });
});

// ── P4 local deny list ───────────────────────────────────────────────────────────────────────────────────────

describe("local deny-list rule (P4)", () => {
  const TERMS = ["acme"];

  test("fires case-insensitively wherever the term stands alone or is joined by punctuation", () => {
    expect(summary(findDenyTerms("build on ACME today", TERMS))).toEqual([{ value: "ACME", column: 10 }]);
    expect(summary(findDenyTerms("host_acme", TERMS))).toEqual([{ value: "acme", column: 6 }]);
    expect(summary(findDenyTerms("acme-nas", TERMS))).toEqual([{ value: "acme", column: 1 }]);
    expect(findDenyTerms("acme.acme/acme:acme@acme", TERMS)).toHaveLength(5);
  });

  test("quiet inside a longer word", () => {
    expect(findDenyTerms("acmecorp", TERMS)).toEqual([]);
    expect(findDenyTerms("xacme and 9acme and acme2", TERMS)).toEqual([]);
    expect(findDenyTerms("dashboard", ["ash"])).toEqual([]);
    expect(findDenyTerms("anything at all", [])).toEqual([]);
  });

  test("a term with regex metacharacters is matched literally", () => {
    expect(summary(findDenyTerms("see a.b+c here", ["a.b+c"]))).toEqual([{ value: "a.b+c", column: 5 }]);
    expect(findDenyTerms("see axb+c here", ["a.b+c"])).toEqual([]);
  });

  test("mask keeps two characters; the suggestion points at the contributor guide", () => {
    const [match] = findDenyTerms("acme-nas", TERMS);
    expect(maskValue("local-deny", (match as RuleMatch).value)).toBe("ac…");
    expect(suggestFor(match as RuleMatch)).toContain("CONTRIBUTING.md");
  });
});

// ── Masking ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("masking", () => {
  test("no mask of a firing sample contains the value", () => {
    const all: RuleMatch[] = [
      ...HOST_FIRING.flatMap((s) => findHostnames(s.line)),
      ...IPV4_FIRING.flatMap((s) => findIpAddresses(s.line)),
      ...IPV6_FIRING.flatMap((s) => findIpAddresses(s.line)),
      ...HOME_FIRING.flatMap((s) => findHomePaths(s.line)),
      ...findDenyTerms("acme-nas", ["acme"]),
    ];
    expect(all.length).toBeGreaterThan(30);
    for (const match of all) {
      const masked = maskValue(match.rule, match.value);
      expect(masked.endsWith("…")).toBe(true);
      expect(masked).not.toContain(match.value);
      expect(masked.length).toBeLessThan(match.value.length + 1);
    }
  });

  test("hostname mask is the first label only", () => {
    expect(maskValue("hostname", dot("downloads", "acme", "com"))).toBe("downloads…");
    expect(maskValue("stale-exception", "abcdef")).toBe("ab…");
    expect(maskValue("empty-scope", "anything")).toBe("");
  });
});

// ── scan ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("scan", () => {
  const P1_LINE = `see https://${NAS}/x`;
  const P2_LINE = `  addr ${TEN}`;
  const P3_LINE = `cd ${POSIX_HOME}/src`;
  const P4_LINE = "deploy to acme-prod";

  test("reports each of P1–P4 with path, line, column and rule, and masks the value", () => {
    const text = ["# title", P1_LINE, P2_LINE, "", P3_LINE, P4_LINE].join("\n");
    const result = runScan([{ path: "contract/CONTRACT.md", text }], { denyTerms: ["acme"] });
    expect(result.scanned).toBe(1);
    expect(result.violations).toEqual([
      { path: "contract/CONTRACT.md", line: 2, column: 13, rule: "hostname", masked: "nas…", suggestion: "pulse.example.com" },
      { path: "contract/CONTRACT.md", line: 3, column: 8, rule: "ip-address", masked: "10…", suggestion: "192.0.2.10" },
      { path: "contract/CONTRACT.md", line: 5, column: 4, rule: "home-path", masked: "/home/…", suggestion: "~/…" },
      {
        path: "contract/CONTRACT.md",
        line: 6,
        column: 11,
        rule: "local-deny",
        masked: "ac…",
        suggestion: 'a placeholder from CONTRIBUTING.md "Public-safe placeholders"',
      },
    ]);
    const lines = result.violations.map(formatViolation);
    expect(lines[0]).toBe("contract/CONTRACT.md:2:13 hostname nas… → pulse.example.com");
    expect(lines[1]).toBe("contract/CONTRACT.md:3:8 ip-address 10… → 192.0.2.10");
    expect(lines[2]).toBe("contract/CONTRACT.md:5:4 home-path /home/… → ~/…");
    for (const line of lines) {
      expect(line).toMatch(/^\S+:\d+:\d+ [a-z-]+ \S+ → .+$/);
      for (const raw of [NAS, TEN, POSIX_HOME, SOMEONE, "acme"]) expect(line).not.toContain(raw);
    }
  });

  test("line and column are correct on line 3 after CRLF line endings", () => {
    const text = `first\r\nsecond\r\n  ${TEN}\r\n`;
    expect(runScan([{ path: "contract/a.txt", text }]).violations).toEqual([
      { path: "contract/a.txt", line: 3, column: 3, rule: "ip-address", masked: "10…", suggestion: "192.0.2.10" },
    ]);
  });

  test("columns count UTF-16 code units", () => {
    const text = `😀 ${TEN}`;
    expect(runScan([{ path: "contract/a.txt", text }]).violations.map((v) => v.column)).toEqual([4]);
  });

  test("violations are sorted by path, line, column, then rule", () => {
    const both = `${TEN} ${NAS}`;
    const result = runScan(
      [
        { path: "contract/b.md", text: `${NAS}\n${both}` },
        { path: "contract/a.md", text: `\n\n${dot("acme", "lan")}` },
      ],
      { denyTerms: ["acme"] },
    );
    expect(result.scanned).toBe(2);
    expect(result.violations.map((v) => [v.path, v.line, v.column, v.rule])).toEqual([
      ["contract/a.md", 3, 1, "hostname"],
      ["contract/a.md", 3, 1, "local-deny"],
      ["contract/b.md", 1, 1, "hostname"],
      ["contract/b.md", 2, 1, "ip-address"],
      ["contract/b.md", 2, TEN.length + 2, "hostname"],
    ]);
  });

  test("contractFileCount 0 yields exactly one empty-scope violation", () => {
    const result = runScan([], { contractFileCount: 0 });
    expect(result).toEqual({
      scanned: 0,
      violations: [
        {
          path: "contract",
          line: 1,
          column: 1,
          rule: "empty-scope",
          masked: "",
          suggestion: "contract/ yielded no scannable files; the scan cannot pass vacuously",
        },
      ],
    });
    expect(formatViolation(result.violations[0] as Violation)).toBe(
      "contract/ empty-scope → contract/ yielded no scannable files; the scan cannot pass vacuously",
    );
    expect(runScan([], { contractFileCount: 3 }).violations).toEqual([]);
  });

  test("an exception with the exact value and a matching path suppresses the violation", () => {
    const files = [{ path: "contract/fixtures/x/a.json", text: `{"h":"${NAS}"}` }];
    const ex = (value: string, path: string): LintException => ({ value, path, reason: "test" });
    expect(runScan(files, { exceptions: [ex(NAS, "contract/fixtures/x/a.json")] }).violations).toEqual([]);
    expect(runScan(files, { exceptions: [ex(NAS, "contract/**")] }).violations).toEqual([]);
    // Not suppressed: another case of the value, another path, `*` not crossing "/". Each such entry is stale too.
    for (const miss of [ex(NAS.toUpperCase(), "contract/**"), ex(NAS, "contract/other.json"), ex(NAS, "contract/*")]) {
      expect(runScan(files, { exceptions: [miss] }).violations.map((v) => v.rule)).toEqual(["hostname", "stale-exception"]);
    }
  });

  test("a stale exception is reported by entry number; overlapping entries are all credited", () => {
    const files = [{ path: "contract/a.md", text: NAS }];
    const live: LintException = { value: NAS, path: "contract/a.md", reason: "test" };
    const overlapping: LintException = { value: NAS, path: "contract/**", reason: "test" };
    const stale: LintException = { value: "gone-value", path: "contract/**", reason: "test" };
    const result = runScan(files, { exceptions: [live, stale, overlapping] });
    expect(result.violations).toEqual([
      {
        path: "public-safe-exceptions.json",
        line: 2,
        column: 1,
        rule: "stale-exception",
        masked: "go…",
        suggestion: "remove this entry; nothing under contract/** contains it any more",
      },
    ]);
    expect(formatViolation(result.violations[0] as Violation)).toBe(
      "public-safe-exceptions.json exceptions[1] stale-exception go… → remove this entry; nothing under contract/** contains it any more",
    );
  });

  test("the precision corpus produces zero findings through scan", () => {
    const corpus = [
      ...Object.values(HOST_QUIET).flat(),
      ...Object.values(IP_QUIET).flat(),
      ...HOME_QUIET,
      // Prose and data of the kind the scanned trees hold.
      "GET /api/overview returns 200 with an ETag; see apps/web/src/server/routes/overview.ts:56.",
      "Run `bun run contract:gen` (bun 1.3.9) and commit contract/**.",
      'data: {"generation":"00000000-0000-4000-8000-000000000041","sources":{"prometheus":{"state":"ok"}}}',
      "import { CONTRACT_VERSION } from \"@pulse/web-data/contract\";",
      "Use /home/USER/ or /Users/USER/ when an absolute path matters.",
      "X-Pulse-Client: ios/1.4.0 (contract 1.0; min 0)",
      "| `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` | RFC 5737 |",
      "| `2001:db8::/32` | RFC 3849 | `127.0.0.0/8`, `::1`, `0.0.0.0`, `::` |",
    ];
    const result = runScan([{ path: "contract/corpus.md", text: corpus.join("\r\n") }]);
    expect(result.violations.map(formatViolation)).toEqual([]);
  });
});

// ── Exception path globs ─────────────────────────────────────────────────────────────────────────────────────

describe("exception path globs", () => {
  test("** spans whole segments, * and ? stay within one", () => {
    expect(pathMatches("contract/**", "contract/fixtures/a.json")).toBe(true);
    expect(pathMatches("contract/**", "contracts/a.json")).toBe(false);
    expect(pathMatches("**/typical.json", "contract/fixtures/overview/typical.json")).toBe(true);
    expect(pathMatches("**/typical.json", "typical.json")).toBe(true);
    expect(pathMatches("contract/*.md", "contract/CONTRACT.md")).toBe(true);
    expect(pathMatches("contract/*.md", "contract/fixtures/x.md")).toBe(false);
    expect(pathMatches("a/**/b", "a/b")).toBe(true);
    expect(pathMatches("a/**/b", "a/x/y/b")).toBe(true);
    expect(pathMatches("a/**/b", "a/xb")).toBe(false);
    expect(pathMatches("a/?.md", "a/x.md")).toBe(true);
    expect(pathMatches("a/?.md", "a/xy.md")).toBe(false);
    expect(pathMatches("a/?.md", "a//.md")).toBe(false);
  });

  test("a pattern without wildcards is an exact path, and '.' is literal", () => {
    expect(pathMatches("contract/CONTRACT.md", "contract/CONTRACT.md")).toBe(true);
    expect(pathMatches("contract/CONTRACT.md", "contract/CONTRACTxmd")).toBe(false);
    expect(pathMatches("contract/CONTRACT.md", "contract/CONTRACT.md/x")).toBe(false);
    expect(globToRegExp("a/b.json").test("a/b.json")).toBe(true);
    expect(globToRegExp("a/b.json").test("a/bxjson")).toBe(false);
  });
});
