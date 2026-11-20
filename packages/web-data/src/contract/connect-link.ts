// packages/web-data/src/contract/connect-link.ts — the `pulse://connect` link a phone scans or opens to learn the
// server's base address. Browser-safe: the only imports are `ipaddr.js` and ./errors.js.
//
// Producers (server, CLI) call `buildConnectLink`; clients validate with `parseConnectLink`. Both are written as
// short ordered checks so a client in another language can follow them line by line.

import * as ipaddr from "ipaddr.js";
import { ContractError } from "./errors.js";

/** URL scheme of a connect link, including the colon (WHATWG `URL.protocol` form). */
export const CONNECT_LINK_SCHEME = "pulse:";
/** Host part of the link: pulse://connect. */
export const CONNECT_LINK_HOST = "connect";
/** Link format version, independent of CONTRACT_VERSION. */
export const CONNECT_LINK_FORMAT_VERSION = 1;
/** Optional link parameters with defined meaning (`pair` carries a pairing token); additions need no format bump. */
export const KNOWN_LINK_PARAMS: readonly string[] = Object.freeze(["pair"]);
/** Reserved parameter names an extra may not use. */
export const RESERVED_LINK_PARAMS = Object.freeze(["v", "url"] as const);
/** Grammar for an extra parameter name. */
export const LINK_PARAM_NAME_PATTERN: RegExp = /^[a-z][a-z0-9-]{0,31}$/;
/** Maximum total link length in characters (ASCII after percent-encoding); fits QR version 12 at ECC M. */
export const CONNECT_LINK_MAX_LENGTH = 256;

/** Why a base URL cannot be used in a link (server/CLI side). */
export type ConnectLinkRefusal = "unparseable" | "credentials" | "not-https" | "loopback" | "too-long";

/** Why a link is rejected (client side). */
export type ConnectLinkRejection = "wrong-scheme" | "unsupported-version" | "missing-url" | "malformed-url" | "not-https";

/** Result of normaliseBaseUrl. */
export type NormaliseResult =
  | {
      /** Discriminant: success. */
      readonly ok: true;
      /** Normalised https base, no trailing slash. */
      readonly baseUrl: string;
    }
  | {
      /** Discriminant: refused. */
      readonly ok: false;
      /** Why it was refused. */
      readonly refusal: ConnectLinkRefusal;
    };

/** Result of buildConnectLink. */
export type ConnectLinkBuildResult =
  | {
      /** Discriminant: success. */
      readonly ok: true;
      /** The full pulse://connect link. */
      readonly link: string;
      /** The normalised base it carries. */
      readonly baseUrl: string;
    }
  | {
      /** Discriminant: refused. */
      readonly ok: false;
      /** Why no link was produced. */
      readonly refusal: ConnectLinkRefusal;
    };

/** Result of parseConnectLink. */
export type ConnectLinkParseResult =
  | {
      /** Discriminant: accepted. */
      readonly ok: true;
      /** The `v` value (always CONNECT_LINK_FORMAT_VERSION when ok). */
      readonly formatVersion: number;
      /** The normalised https base URL. */
      readonly baseUrl: string;
      /** Every parameter except v and url, known or not (clients ignore the unknown ones). */
      readonly params: Readonly<Record<string, string>>;
    }
  | {
      /** Discriminant: rejected. */
      readonly ok: false;
      /** First failing check, in documented order. */
      readonly rejection: ConnectLinkRejection;
    };

const refused = (refusal: ConnectLinkRefusal): { readonly ok: false; readonly refusal: ConnectLinkRefusal } =>
  Object.freeze({ ok: false, refusal });
const rejected = (rejection: ConnectLinkRejection): ConnectLinkParseResult => Object.freeze({ ok: false, rejection });

/**
 * True for loopback/unspecified hosts: localhost, *.localhost, 127.0.0.0/8, ::1, 0.0.0.0/8, ::, and IPv4-mapped
 * forms. Accepts a bracketed IPv6 host (the `URL.hostname` form). Never resolves DNS; never throws.
 */
export function isLoopbackHost(hostname: string): boolean {
  try {
    let h = hostname.toLowerCase();
    if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
    if (h.length > 1 && h.endsWith(".")) h = h.slice(0, -1);
    if (h === "localhost" || h.endsWith(".localhost")) return true;
    if (ipaddr.isValid(h)) {
      // `process` unwraps an IPv4-mapped IPv6 address to its IPv4 form.
      const range = ipaddr.process(h).range();
      return range === "loopback" || range === "unspecified";
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Normalise and vet a base URL. Pure; never throws. Checks run in order and the first failure is returned:
 * parseable, no credentials, https, not loopback. The result is `https://<host><path>` with repeated slashes
 * collapsed, percent-escapes upper-cased, and no trailing slash, query or fragment. Normalising a result again
 * returns it unchanged.
 */
export function normaliseBaseUrl(input: string): NormaliseResult {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return refused("unparseable");
  }
  // Credentials come before the scheme so `http://user:pw@host` is reported as the more serious problem.
  if (url.username !== "" || url.password !== "") return refused("credentials");
  if (url.protocol !== "https:") return refused("not-https");
  if (isLoopbackHost(url.hostname)) return refused("loopback");
  let path = url.pathname.replace(/\/{2,}/g, "/");
  path = path.replace(/%[0-9a-fA-F]{2}/g, (escape) => escape.toUpperCase());
  if (path.endsWith("/")) path = path.slice(0, -1);
  return Object.freeze({ ok: true, baseUrl: `https://${url.host}${path}` });
}

/**
 * Build a link: `pulse://connect?v=1&url=<base>` followed by `extras` sorted by name. `extras` names must match
 * LINK_PARAM_NAME_PATTERN and must not be reserved; names are checked before the base, so misuse surfaces even
 * when the base is refused. Deterministic for a given input.
 * @throws {ContractError} code LINK_PARAM_INVALID for an invalid or reserved extra name (a programming error, not input)
 */
export function buildConnectLink(base: string, extras: Readonly<Record<string, string>> = {}): ConnectLinkBuildResult {
  const names = Object.keys(extras);
  for (const name of names) {
    if (!LINK_PARAM_NAME_PATTERN.test(name) || (RESERVED_LINK_PARAMS as readonly string[]).includes(name)) {
      throw new ContractError(
        "LINK_PARAM_INVALID",
        name,
        "link parameter name is reserved or does not match LINK_PARAM_NAME_PATTERN",
      );
    }
  }
  const normalised = normaliseBaseUrl(base);
  if (!normalised.ok) return refused(normalised.refusal);
  const query = new URLSearchParams();
  query.append("v", String(CONNECT_LINK_FORMAT_VERSION));
  query.append("url", normalised.baseUrl);
  for (const name of [...names].sort()) query.append(name, extras[name] as string);
  // The form-urlencoded serialiser leaves only ASCII, so `.length` is also the byte length.
  const link = `${CONNECT_LINK_SCHEME}//${CONNECT_LINK_HOST}?${query.toString()}`;
  if (link.length > CONNECT_LINK_MAX_LENGTH) return refused("too-long");
  return Object.freeze({ ok: true, link, baseUrl: normalised.baseUrl });
}

/**
 * Reference client-side validator. Pure; never throws. Checks run in this order and the first failure wins:
 *
 * 1. the link parses as a URL, else `wrong-scheme`;
 * 2. its scheme is `pulse:`, else `wrong-scheme`;
 * 3. its host is `connect` (any case) with no port, credentials or path beyond `/`, else `wrong-scheme`;
 * 4. there is exactly one `v` and it is exactly `"1"`, else `unsupported-version`;
 * 5. there is a non-empty `url`, else `missing-url`;
 * 6. there is exactly one `url`, else `malformed-url`;
 * 7. `url` normalises: a non-https scheme is `not-https`, any other refusal is `malformed-url`.
 *
 * The query is `application/x-www-form-urlencoded` (`+` is a space). Every other parameter is kept, known or not,
 * first occurrence winning. Length is not limited here: CONNECT_LINK_MAX_LENGTH bounds producers only.
 */
export function parseConnectLink(link: string): ConnectLinkParseResult {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return rejected("wrong-scheme");
  }
  if (url.protocol !== CONNECT_LINK_SCHEME) return rejected("wrong-scheme");
  if (
    url.host.toLowerCase() !== CONNECT_LINK_HOST
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || (url.pathname !== "" && url.pathname !== "/")
  ) {
    return rejected("wrong-scheme");
  }
  const versions = url.searchParams.getAll("v");
  if (versions.length !== 1 || versions[0] !== String(CONNECT_LINK_FORMAT_VERSION)) return rejected("unsupported-version");
  const urls = url.searchParams.getAll("url");
  const first = urls[0];
  if (first === undefined || first === "") return rejected("missing-url");
  if (urls.length !== 1) return rejected("malformed-url");
  const normalised = normaliseBaseUrl(first);
  if (!normalised.ok) return rejected(normalised.refusal === "not-https" ? "not-https" : "malformed-url");
  const params = new Map<string, string>();
  for (const [name, value] of url.searchParams) {
    if (name === "v" || name === "url" || params.has(name)) continue;
    params.set(name, value);
  }
  // `fromEntries` defines own data properties, so a parameter named `__proto__` cannot reach the prototype.
  return Object.freeze({
    ok: true,
    formatVersion: CONNECT_LINK_FORMAT_VERSION,
    baseUrl: normalised.baseUrl,
    params: Object.freeze(Object.fromEntries(params)),
  });
}
