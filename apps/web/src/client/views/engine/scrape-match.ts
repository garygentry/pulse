// src/client/views/engine/scrape-match.ts — scrape target instance → declared estate host
// (REQ-ELINK-02). Exact, case-sensitive matching: where there is no single match there is no
// link, which is the safe outcome, never a wrong link. Pure and total.

import type { HostStatus } from "@pulse/web-data/wire";

const DIGITS = /^[0-9]+$/;
const FORBIDDEN = /[\s/@]/;

/**
 * Split a scrape `instance` into its host part and optional port. Null when the instance is not a
 * plain host[:port] form (contains "/", "@" or whitespace, is empty after trimming, has a
 * non-numeric port, or an empty host part).
 *
 * - "[v6]:port" / "[v6]"            → host inside brackets; port digits after "]:" or null.
 * - exactly one ":" and digits after → host before ":", port after.
 * - no ":"                           → whole string, port null.
 * - two or more ":" without brackets → bare IPv6: whole string, port null.
 */
export function splitInstance(instance: string): { readonly host: string; readonly port: string | null } | null {
  if (typeof instance !== "string") return null;
  const s = instance.trim();
  if (s === "" || FORBIDDEN.test(s)) return null;

  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0) return null;
    const host = s.slice(1, close);
    const rest = s.slice(close + 1);
    if (host === "") return null;
    if (rest === "") return { host, port: null };
    if (rest.startsWith(":") && DIGITS.test(rest.slice(1))) return { host, port: rest.slice(1) };
    return null;
  }

  const colons = s.split(":").length - 1;
  if (colons === 0) return { host: s, port: null };
  if (colons >= 2) return { host: s, port: null };
  const i = s.indexOf(":");
  const host = s.slice(0, i);
  const port = s.slice(i + 1);
  if (host === "" || !DIGITS.test(port)) return null;
  return { host, port };
}

/**
 * Match a scrape instance to exactly one declared host. The split host part is compared by exact
 * string equality with each host's `name` and each of its `addresses`; counted per host.
 * @param instance - `ScrapeTarget.instance`.
 * @param hosts - `snapshot.hosts` (empty when the snapshot is null).
 * @returns The single matching host's `name`, or null when zero or several hosts match, or the
 *   instance does not split.
 */
export function matchScrapeInstanceToHost(instance: string, hosts: readonly HostStatus[]): string | null {
  const split = splitInstance(instance);
  if (split === null) return null;
  let match: string | null = null;
  for (const h of hosts) {
    const addresses: readonly string[] = Array.isArray(h.addresses) ? h.addresses : [];
    if (h.name === split.host || addresses.includes(split.host)) {
      if (match !== null) return null;
      match = h.name;
    }
  }
  return match;
}

/** `/estate/host/${encodeURIComponent(name)}` (REQ-SEC-04). */
export function estateHostPath(hostName: string): string {
  return `/estate/host/${encodeURIComponent(String(hostName))}`;
}
