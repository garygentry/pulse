import { describe, expect, test } from "bun:test";
import * as ipaddr from "ipaddr.js";
import {
  ALLOWED_IPV4_CIDRS,
  ALLOWED_IPV6_CIDRS,
  RESERVED_EXAMPLE_DOMAINS,
  RESERVED_TLDS,
  isAllowedHostname,
  isAllowedIp,
} from "../../scripts/public-safe/allowlist.js";
import {
  EXTENSION_TLDS,
  IDENTIFIER_COLLIDING_TLDS,
  PRIVATE_USE_SUFFIXES,
  PUBLIC_TLDS,
  WELL_KNOWN_PUBLIC_HOSTS,
  hasPrivateUseSuffix,
  isWellKnownPublicHost,
} from "../../scripts/public-safe/tlds.js";
import { colon, dot } from "./helpers.js";

const allowed = (text: string): boolean => isAllowedIp(ipaddr.parse(text));
const FFFF = "ffff";

interface CidrEdges {
  readonly cidr: string;
  readonly inside: readonly string[];
  readonly outside: readonly string[];
}

/** First and last address of every allowlisted range, and the addresses one below and one above. */
const IPV4_EDGES: readonly CidrEdges[] = [
  {
    cidr: "192.0.2.0/24",
    inside: ["192.0.2.0", "192.0.2.255"],
    outside: [dot("192", "0", "1", "255"), dot("192", "0", "3", "0")],
  },
  {
    cidr: "198.51.100.0/24",
    inside: ["198.51.100.0", "198.51.100.255"],
    outside: [dot("198", "51", "99", "255"), dot("198", "51", "101", "0")],
  },
  {
    cidr: "203.0.113.0/24",
    inside: ["203.0.113.0", "203.0.113.255"],
    outside: [dot("203", "0", "112", "255"), dot("203", "0", "114", "0")],
  },
  {
    cidr: "127.0.0.0/8",
    inside: ["127.0.0.0", "127.0.0.1", "127.255.255.255"],
    outside: [dot("126", "255", "255", "255"), dot("128", "0", "0", "0")],
  },
  // Exact: the unspecified address has no address below it.
  { cidr: "0.0.0.0/32", inside: ["0.0.0.0"], outside: [dot("0", "0", "0", "1"), dot("0", "255", "255", "255")] },
];

const IPV6_EDGES: readonly CidrEdges[] = [
  {
    cidr: "2001:db8::/32",
    inside: ["2001:db8::", "2001:db8::10", colon("2001", "db8", FFFF, FFFF, FFFF, FFFF, FFFF, FFFF)],
    outside: [colon("2001", "db7", FFFF, FFFF, FFFF, FFFF, FFFF, FFFF), colon("2001", "db9", "", "")],
  },
  // `::1` and `::` are neighbours, so the address below loopback is the (allowed) unspecified address.
  { cidr: "::1/128", inside: ["::1"], outside: [colon("", "", "2")] },
  { cidr: "::/128", inside: ["::"], outside: [colon("", "", "2"), colon("", "", "1", "0")] },
];

describe("public-safe allowlist: IP ranges", () => {
  test("the edge table covers every allowlisted CIDR", () => {
    expect(IPV4_EDGES.map((e) => e.cidr)).toEqual([...ALLOWED_IPV4_CIDRS]);
    expect(IPV6_EDGES.map((e) => e.cidr)).toEqual([...ALLOWED_IPV6_CIDRS]);
  });

  for (const edges of [...IPV4_EDGES, ...IPV6_EDGES]) {
    test(`${edges.cidr}: first and last address allowed, neighbours denied`, () => {
      for (const text of edges.inside) expect([edges.cidr, allowed(text)]).toEqual([edges.cidr, true]);
      for (const text of edges.outside) expect([edges.cidr, allowed(text)]).toEqual([edges.cidr, false]);
    });
  }

  test("private and link-local ranges are denied", () => {
    for (const text of [
      dot("10", "0", "0", "5"),
      dot("172", "16", "4", "2"),
      dot("192", "168", "1", "1"),
      dot("169", "254", "0", "1"),
      colon("fd00", "", "1"),
      colon("fe80", "", "1"),
    ]) {
      expect(allowed(text)).toBe(false);
    }
  });

  test("an IPv4-mapped IPv6 address is judged by the IPv4 table", () => {
    const mapped = (v4: string): boolean => isAllowedIp(ipaddr.IPv6.parse(`::${FFFF}:${v4}`));
    // In range for each IPv4 CIDR, including loopback and unspecified.
    for (const edges of IPV4_EDGES) {
      for (const v4 of edges.inside) expect([v4, mapped(v4)]).toEqual([v4, true]);
      for (const v4 of edges.outside) expect([edges.cidr, mapped(v4)]).toEqual([edges.cidr, false]);
    }
    expect(mapped(dot("10", "1", "2", "3"))).toBe(false);
    // The hex spelling of the same mapped address behaves identically.
    expect(isAllowedIp(ipaddr.IPv6.parse(colon("", "", FFFF, "c000", "201")))).toBe(true);
    expect(isAllowedIp(ipaddr.IPv6.parse(colon("", "", FFFF, "a01", "203")))).toBe(false);
  });

  test("unspecified is exact in both families", () => {
    expect(allowed("0.0.0.0")).toBe(true);
    expect(allowed("::")).toBe(true);
    expect(allowed(dot("0", "0", "0", "1"))).toBe(false);
    expect(allowed(colon("", "", "2"))).toBe(false);
  });

  test("an IPv4 address is never matched against the IPv6 table (no kind-mismatch throw)", () => {
    expect(() => isAllowedIp(ipaddr.IPv4.parse("192.0.2.1"))).not.toThrow();
    expect(() => isAllowedIp(ipaddr.IPv6.parse("2001:db8::1"))).not.toThrow();
  });
});

describe("public-safe allowlist: hostnames", () => {
  test("every reserved example domain and its subdomains pass", () => {
    for (const domain of RESERVED_EXAMPLE_DOMAINS) {
      expect(isAllowedHostname(domain)).toBe(true);
      expect(isAllowedHostname(`pulse.${domain}`)).toBe(true);
      expect(isAllowedHostname(`a.b.${domain}`)).toBe(true);
      expect(isAllowedHostname(domain.toUpperCase())).toBe(true);
      expect(isAllowedHostname(`${domain}.`)).toBe(true);
      // Just outside: a look-alike second-level label, and the domain used as a subdomain of something else.
      expect(isAllowedHostname(`not${domain}`)).toBe(false);
      expect(isAllowedHostname(dot(domain, "acme", "com"))).toBe(false);
    }
    expect(isAllowedHostname(dot("example", "co"))).toBe(false);
    expect(isAllowedHostname(dot("notexample", "com"))).toBe(false);
    expect(isAllowedHostname(dot("example", "com", "evil"))).toBe(false);
  });

  test("every reserved TLD passes, with and without labels before it", () => {
    for (const tld of RESERVED_TLDS) {
      expect(isAllowedHostname(`svc.${tld}`)).toBe(true);
      expect(isAllowedHostname(`a.b.${tld}`)).toBe(true);
      expect(isAllowedHostname(`SVC.${tld.toUpperCase()}`)).toBe(true);
      // Just outside: the reserved word as a non-final label, or as a prefix of the last label.
      expect(isAllowedHostname(dot(tld, "acme"))).toBe(false);
      expect(isAllowedHostname(dot("svc", `${tld}s`))).toBe(false);
    }
    expect(isAllowedHostname("localhost")).toBe(true);
    expect(isAllowedHostname("LOCALHOST")).toBe(true);
    expect(isAllowedHostname(dot("localhost", "lan"))).toBe(false);
  });

  test("other names, the empty string and stray dots are denied", () => {
    for (const name of ["", ".", dot("nas", "lan"), dot("acme", "net"), "nas", ".example.com.."]) {
      expect(isAllowedHostname(name)).toBe(false);
    }
  });

  test("well-known public hosts match exactly, not by subdomain", () => {
    for (const host of WELL_KNOWN_PUBLIC_HOSTS) {
      expect(isWellKnownPublicHost(host)).toBe(true);
      expect(isWellKnownPublicHost(host.toUpperCase())).toBe(true);
      expect(isAllowedHostname(host)).toBe(false);
    }
    expect(isWellKnownPublicHost(dot("gist", "github", "com"))).toBe(false);
    expect(isWellKnownPublicHost(dot("github", "co"))).toBe(false);
  });

  test("a private-use suffix needs a label before it", () => {
    for (const suffix of PRIVATE_USE_SUFFIXES) {
      expect(hasPrivateUseSuffix(dot("printer", suffix))).toBe(true);
      expect(hasPrivateUseSuffix(dot("PRINTER", suffix.toUpperCase()))).toBe(true);
      expect(hasPrivateUseSuffix(suffix)).toBe(false);
      expect(hasPrivateUseSuffix(`.${suffix}`)).toBe(false);
      expect(hasPrivateUseSuffix(`printer${suffix}`)).toBe(false);
    }
    expect(hasPrivateUseSuffix("pulse.example.com")).toBe(false);
  });
});

describe("public-safe name sets", () => {
  const sets = { PUBLIC_TLDS, EXTENSION_TLDS, IDENTIFIER_COLLIDING_TLDS, WELL_KNOWN_PUBLIC_HOSTS };

  test("PUBLIC_TLDS has 60 entries and is disjoint from both exclusion sets", () => {
    expect(PUBLIC_TLDS.size).toBe(60);
    expect([...PUBLIC_TLDS].filter((tld) => EXTENSION_TLDS.has(tld))).toEqual([]);
    expect([...PUBLIC_TLDS].filter((tld) => IDENTIFIER_COLLIDING_TLDS.has(tld))).toEqual([]);
  });

  test("every entry is lower-case", () => {
    for (const [name, set] of Object.entries(sets)) {
      expect([name, [...set].filter((entry) => entry !== entry.toLowerCase())]).toEqual([name, []]);
    }
    expect(PRIVATE_USE_SUFFIXES.filter((s) => s !== s.toLowerCase())).toEqual([]);
    expect(RESERVED_TLDS.filter((s) => s !== s.toLowerCase())).toEqual([]);
    expect(RESERVED_EXAMPLE_DOMAINS.filter((s) => s !== s.toLowerCase())).toEqual([]);
  });
});
