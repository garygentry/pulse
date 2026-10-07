// packages/web-data/src/identity/resolve.ts — trusted identity resolution
// (09-identity-audit-and-dark-mutation-seams.md §§3–4; `Identity` contract from
// 01-core-definitions.md §8). Pure, deny-by-default: identity is granted only in
// proxy-header mode, from a peer whose direct address matches a configured CIDR, and
// only when the configured header carries one bounded control-free value. Never trusts
// forwarding headers, mutates request/config/global state, or logs a raw value.

import * as ipaddr from "ipaddr.js";
import type { IdentityConfig } from "./config.js";

/**
 * Minimized trusted identity derived from the configured proxy header. It exposes exactly
 * a stable subject, a human-readable display name, and its fixed provenance — never a raw
 * header value, peer address, or any other request metadata.
 */
export interface Identity {
  /** Stable minimized subject derived from the trusted header. */ readonly subject: string;
  /** Human-readable minimized display name. */ readonly displayName: string;
  /** Fixed trusted identity provenance. */ readonly source: "proxy-header";
}

/** Maximum accepted trimmed header value length, in UTF-8 bytes. */
const MAX_VALUE_BYTES = 256;

const UTF8 = new TextEncoder();

/** True when the peer's direct address matches at least one configured CIDR of the same kind. */
function peerIsTrusted(peer: ipaddr.IPv4 | ipaddr.IPv6, trustedProxies: readonly string[]): boolean {
  for (const cidr of trustedProxies) {
    let parsed: [ipaddr.IPv4 | ipaddr.IPv6, number];
    try {
      parsed = ipaddr.parseCIDR(cidr);
    } catch {
      continue;
    }
    const [range, prefix] = parsed;
    // `match` throws on a kind mismatch, so only compare compatible kinds.
    if (range.kind() === peer.kind() && peer.match([range, prefix])) return true;
  }
  return false;
}

/** True when the trimmed value contains no C0/C1 control, DEL, or newline code point. */
function isControlFree(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return false;
  }
  return true;
}

/**
 * Resolve the trusted identity for a request, or null when none is established. Returns null
 * unless the mode is proxy-header, the direct peer IP parses and matches a configured CIDR,
 * and the configured header carries one trimmed, non-empty, ≤256-byte, control-free value —
 * which becomes both `subject` and `displayName`. A missing/invalid identity is anonymous,
 * not an error. Never trusts forwarding headers or mutates request/config/global state.
 */
export function resolveIdentity(request: Request, peerIp: string | null, config: IdentityConfig): Identity | null {
  if (config.mode !== "proxy-header") return null;
  if (peerIp === null || peerIp === "") return null;
  if (config.trustedProxies.length === 0) return null;

  let peer: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    peer = ipaddr.parse(peerIp);
  } catch {
    return null;
  }
  // Normalize IPv4-mapped IPv6 peers to their IPv4 form before matching.
  if (peer.kind() === "ipv6" && (peer as ipaddr.IPv6).isIPv4MappedAddress()) {
    peer = (peer as ipaddr.IPv6).toIPv4Address();
  }

  if (!peerIsTrusted(peer, config.trustedProxies)) return null;

  const raw = request.headers.get(config.headerName);
  if (raw === null) return null;
  const value = raw.trim();
  if (value === "") return null;
  if (UTF8.encode(value).length > MAX_VALUE_BYTES) return null;
  if (!isControlFree(value)) return null;

  return { subject: value, displayName: value, source: "proxy-header" };
}
