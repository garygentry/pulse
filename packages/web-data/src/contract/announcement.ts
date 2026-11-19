// packages/web-data/src/contract/announcement.ts — optional client announcement headers and the bounded
// metric labels derived from them. Browser-safe and pure. Raw header values never leave this module:
// only the grammar-validated name and integer requirement do, and neither is used for access decisions.

import { CONTRACT_VERSION, decideCompatibility, parseContractVersion } from "./version.js";
import type { ClientRequirement } from "./version.js";

/** Request header naming the client. Lower-case, as `Headers.get` normalises names. */
export const CLIENT_HEADER = "x-pulse-client";
/** Request header carrying the client's ClientRequirement as "<major>.<minMinor>". */
export const CONTRACT_HEADER = "x-pulse-contract";
/** Grammar for X-Pulse-Client values. */
export const CLIENT_NAME_PATTERN: RegExp = /^[a-z0-9-]{1,32}$/;
/** First-party client names given their own metric label value; any other well-formed name buckets to "other". */
export const KNOWN_CLIENTS = Object.freeze(["ios", "ios-widget"] as const);
/** A first-party client name. */
export type KnownClient = (typeof KNOWN_CLIENTS)[number];

/** Longest valid client name; longer input is rejected before the regex runs. */
const MAX_CLIENT_NAME_LENGTH = 32;

/** A parsed announcement. A null field means that header was absent, repeated (comma-joined), malformed or oversized. */
export interface ClientAnnouncement {
  /** Validated client name (CLIENT_NAME_PATTERN), or null. */
  readonly name: string | null;
  /** Validated requirement parsed with CONTRACT_VERSION_PATTERN, or null. */
  readonly requirement: ClientRequirement | null;
}

/**
 * Pure; never throws. The two headers are independent. A header that appears twice reaches `Headers.get`
 * as "a, b" and fails the grammar, so it counts as not announced.
 */
export function parseClientAnnouncement(headers: Headers): ClientAnnouncement {
  const rawName = headers.get(CLIENT_HEADER);
  const name =
    rawName !== null && rawName.length <= MAX_CLIENT_NAME_LENGTH && CLIENT_NAME_PATTERN.test(rawName)
      ? rawName
      : null;
  const rawReq = headers.get(CONTRACT_HEADER);
  const v = rawReq === null ? null : parseContractVersion(rawReq);
  const requirement = v === null ? null : Object.freeze({ major: v.major, minMinor: v.minor });
  return Object.freeze({ name, requirement });
}

/** Metric label for the client. */
export type HandshakeClientLabel = KnownClient | "other" | "none";
/** Metric label for the outcome. */
export type HandshakeOutcomeLabel = "compatible" | "server_too_old" | "client_too_old" | "not_announced";

/** The three bounded labels of pulse_web_client_handshakes_total. */
export interface HandshakeLabels {
  /** KNOWN_CLIENTS member, "other" for any other valid name, "none" when not announced. */
  readonly client: HandshakeClientLabel;
  /** Decimal major 0..CONTRACT_VERSION.major+1, "other" outside that range, "none" when the contract header is absent or invalid. */
  readonly contractMajor: string;
  /** decideCompatibility outcome with "-" → "_", or "not_announced" when requirement is null. */
  readonly outcome: HandshakeOutcomeLabel;
}

const OUTCOME_LABELS = Object.freeze({
  compatible: "compatible",
  "server-too-old": "server_too_old",
  "client-too-old": "client_too_old",
} as const);

/** Map an announcement to bounded labels using decideCompatibility against CONTRACT_VERSION. Pure. */
export function handshakeLabels(announcement: ClientAnnouncement): HandshakeLabels {
  const known = KNOWN_CLIENTS.find((k) => k === announcement.name);
  const client: HandshakeClientLabel = announcement.name === null ? "none" : (known ?? "other");
  if (announcement.requirement === null) {
    return Object.freeze({ client, contractMajor: "none", outcome: "not_announced" });
  }
  const m = announcement.requirement.major;
  const contractMajor = m <= CONTRACT_VERSION.major + 1 ? String(m) : "other";
  const outcome = OUTCOME_LABELS[decideCompatibility(announcement.requirement, CONTRACT_VERSION)];
  return Object.freeze({ client, contractMajor, outcome });
}
