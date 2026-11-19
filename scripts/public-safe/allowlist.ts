import * as ipaddr from "ipaddr.js";

/** RFC 2606 second-level example domains; the name itself and every subdomain pass. */
export const RESERVED_EXAMPLE_DOMAINS: readonly string[] = ["example.com", "example.net", "example.org"];
/** RFC 2606 / RFC 6761 reserved TLDs; any name whose last label is one of these passes. */
export const RESERVED_TLDS: readonly string[] = ["example", "test", "invalid", "localhost"];
/** IPv4 allowlist: RFC 5737 documentation, loopback (RFC 1122), unspecified (exact). */
export const ALLOWED_IPV4_CIDRS: readonly string[] = ["192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "127.0.0.0/8", "0.0.0.0/32"];
/** IPv6 allowlist: RFC 3849 documentation, loopback and unspecified (RFC 4291). */
export const ALLOWED_IPV6_CIDRS: readonly string[] = ["2001:db8::/32", "::1/128", "::/128"];

type Cidr = [ipaddr.IPv4 | ipaddr.IPv6, number];

// Parsed once at module load. A parse failure here is a programming error and throws at import time.
const IPV4_RANGES: readonly Cidr[] = ALLOWED_IPV4_CIDRS.map((cidr) => ipaddr.parseCIDR(cidr));
const IPV6_RANGES: readonly Cidr[] = ALLOWED_IPV6_CIDRS.map((cidr) => ipaddr.parseCIDR(cidr));

/**
 * True when a hostname (any case, optional trailing dot) is allowlisted: `localhost`, an example domain or a
 * subdomain of one, or any name under a reserved TLD. Well-known public hosts are checked separately (tlds.ts).
 */
export function isAllowedHostname(name: string): boolean {
  let lower = name.toLowerCase();
  if (lower.endsWith(".")) lower = lower.slice(0, -1);
  if (lower === "" || lower.startsWith(".") || lower.endsWith(".")) return false;
  if (RESERVED_EXAMPLE_DOMAINS.some((domain) => lower === domain || lower.endsWith(`.${domain}`))) return true;
  const lastLabel = lower.slice(lower.lastIndexOf(".") + 1);
  return RESERVED_TLDS.includes(lastLabel);
}

/**
 * True when a parsed address is in an allowlisted range. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is
 * unwrapped and judged by the IPv4 table. The range tables are split by kind because `match()` throws on a
 * kind mismatch.
 */
export function isAllowedIp(addr: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  let subject = addr;
  if (subject.kind() === "ipv6" && (subject as ipaddr.IPv6).isIPv4MappedAddress()) {
    subject = (subject as ipaddr.IPv6).toIPv4Address();
  }
  const ranges = subject.kind() === "ipv4" ? IPV4_RANGES : IPV6_RANGES;
  return ranges.some((range) => subject.match(range));
}
