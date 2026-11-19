/**
 * Pure rule engine of the public-safe lint. No file I/O: callers hand in file texts, exceptions and deny terms.
 *
 * Four content rules run per line (no match spans lines):
 * - `hostname`: a dotted name that is not allowlisted, in a URL authority (plain or percent-encoded), as
 *   `host:port`, after `@`, or bare with a curated public TLD or a private-use suffix.
 * - `ip-address`: a four-part decimal IPv4 literal or a strictly recognised IPv6 literal outside the allowlist.
 * - `home-path`: `/home/<name>/`, `/Users/<name>/`, `C:\Users\<name>\` or `~<name>/`.
 * - `local-deny`: a term from the operator's local deny list.
 *
 * Every regex quantifier is bounded, so the work per start position is bounded.
 */
import * as ipaddr from "ipaddr.js";
import { isAllowedHostname, isAllowedIp } from "./allowlist.js";
import { globToRegExp } from "./glob.js";
import { EXTENSION_TLDS, PUBLIC_TLDS, WELL_KNOWN_PUBLIC_HOSTS, hasPrivateUseSuffix, isWellKnownPublicHost } from "./tlds.js";
import type { LintResult, LintRunInput, RuleId, Violation } from "./types.js";

/** One raw rule hit inside a single line, before exceptions. */
export interface RuleMatch {
  /** Content rule that matched. */ readonly rule: "hostname" | "ip-address" | "home-path" | "local-deny";
  /** Exact matched text, unmasked. Compared verbatim against LintException.value. */ readonly value: string;
  /** 0-based UTF-16 offset of the match start within the line. */ readonly index: number;
  /** Position kind for suggestions: "email" for the after-@ position, "ipv6" for IPv6 literals, else "default". */ readonly kind: "default" | "email" | "ipv6";
}

type Span = readonly [start: number, end: number];

function overlaps(spans: readonly Span[], start: number, end: number): boolean {
  return spans.some(([a, b]) => start < b && a < end);
}

function byIndex(a: RuleMatch, b: RuleMatch): number {
  return a.index - b.index;
}

// ── Hostname rule ────────────────────────────────────────────────────────────────────────────────────────────

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** The last label starts with a letter, so it is never numeric (versions, dotted quads). */
const LAST = "[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** Two or more labels. */
const NAME = `(?:${LABEL}\\.){1,126}${LAST}`;
/** The match is the whole dotted chain; a sentence-final "." is allowed. */
const NAME_END = "(?![a-z0-9_-]|\\.[a-z0-9])";
const DNS_NAME_RE = new RegExp(`^${NAME}$`, "i");

/** `scheme://[userinfo@]host` — group 1 is the scheme, group 2 the host. */
export const URL_AUTHORITY_RE = /\b([a-z][a-z0-9+.-]{0,31}):\/\/(?:[^\s\/?#@"'`<>]{0,256}@)?([^\s\/?#:"'`<>()[\]{}\\,;|]{1,253})/gi;
/** The percent-encoded form of the same (`scheme%3A%2F%2Fhost`), as carried inside connect links. */
export const ENCODED_URL_AUTHORITY_RE = /\b([a-z][a-z0-9+.-]{0,31})%3a%2f%2f(?:[^\s\/?#@&"'`<>%]{0,256}%40)?([a-z0-9.-]{1,253})/gi;
/** `name:port`, not preceded by an identifier, path, `@` or `:` character. */
export const HOST_PORT_RE = new RegExp(`(?<![a-z0-9_.@/\\\\:-])(${NAME}):(\\d{1,5})(?!\\d)`, "gi");
/** A dotted name after `<local-part>@`. Package scopes (`@scope/name`) have no local part and never match. */
export const EMAIL_DOMAIN_RE = new RegExp(`(?<=[a-z0-9_.+-]@)(${NAME})${NAME_END}`, "gi");
/**
 * A bare dotted name. A chain preceded by an identifier character, `.`, `$`, `#`, `-`, `/`, `\` or `%` continues
 * an identifier, selector, path or percent escape and is not a candidate. Percent-encoded `/`, `@` and `:` count
 * as boundaries.
 */
export const BARE_NAME_RE = new RegExp(`(?<=^|[^a-z0-9_.@$#/\\\\%-]|%2f|%40|%3a)(${NAME})${NAME_END}`, "gi");

function lastLabelOf(lowerName: string): string {
  return lowerName.slice(lowerName.lastIndexOf(".") + 1);
}

/** The hostname allow test: reserved names and the well-known public services. */
function passesHostAllowTest(name: string): boolean {
  return isAllowedHostname(name) || isWellKnownPublicHost(name);
}

/** True for a reverse-DNS identifier (bundle id, entitlement key) whose forward name is allowed. */
function isAllowedReverseDns(lowerName: string): boolean {
  const labels = lowerName.split(".");
  if (!PUBLIC_TLDS.has(labels[0] ?? "")) return false;
  const reversed = labels.reverse().join(".");
  if (passesHostAllowTest(reversed)) return true;
  for (const host of WELL_KNOWN_PUBLIC_HOSTS) {
    if (reversed.endsWith(`.${host}`)) return true;
  }
  return false;
}

/** Hostname candidates in one line that are not allowlisted. Pure. */
export function findHostnames(line: string): RuleMatch[] {
  const out: RuleMatch[] = [];
  // A judged candidate claims its span, whether it fired or was allowlisted; later positions skip claimed text.
  const claimed: Span[] = [];
  const judge = (value: string, index: number, kind: RuleMatch["kind"]): void => {
    const end = index + value.length;
    if (overlaps(claimed, index, end)) return;
    claimed.push([index, end]);
    if (!passesHostAllowTest(value)) out.push({ rule: "hostname", value, index, kind });
  };

  // A. URL authority, plain then percent-encoded. Any non-allowlisted dotted host in a URL fires.
  for (const re of [URL_AUTHORITY_RE, ENCODED_URL_AUTHORITY_RE]) {
    for (const m of line.matchAll(re)) {
      const rawHost = m[2] ?? "";
      // `pulse://connect` names a link action, not a host.
      if ((m[1] ?? "").toLowerCase() === "pulse") continue;
      const host = rawHost.endsWith(".") ? rawHost.slice(0, -1) : rawHost;
      // Drops single labels, dotted quads and templates such as ${HOST} or <host>.
      if (!DNS_NAME_RE.test(host)) continue;
      judge(host, m.index + m[0].length - rawHost.length, "default");
    }
  }

  // B. host:port. An extension last label is a `file.ts:12` source reference.
  for (const m of line.matchAll(HOST_PORT_RE)) {
    const name = m[1] ?? "";
    if (Number(m[2]) > 65535) continue;
    if (EXTENSION_TLDS.has(lastLabelOf(name.toLowerCase()))) continue;
    judge(name, m.index, "default");
  }

  // C. After `@`.
  for (const m of line.matchAll(EMAIL_DOMAIN_RE)) {
    judge(m[1] ?? "", m.index, "email");
  }

  // D. Bare dotted name: only with a curated public TLD or a private-use suffix.
  for (const m of line.matchAll(BARE_NAME_RE)) {
    const value = m[1] ?? "";
    const lower = value.toLowerCase();
    const last = lastLabelOf(lower);
    if (EXTENSION_TLDS.has(last)) continue;
    if (!PUBLIC_TLDS.has(last) && !hasPrivateUseSuffix(lower)) continue;
    // A call or an index (`utils.cn(a)`) is member access.
    const next = line[m.index + value.length];
    if (next === "(" || next === "[") continue;
    if (isAllowedReverseDns(lower)) continue;
    judge(value, m.index, "default");
  }

  return out.sort(byIndex);
}

// ── IP address rule ──────────────────────────────────────────────────────────────────────────────────────────

/** An IPv6-shaped run: group 1 is the literal, group 2 an optional zone. */
export const IPV6_RE = /(?<![0-9a-z_:.])((?:[0-9a-f]{0,4}:){2,8}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4})?)(%[0-9a-z]{1,15})?(?![0-9a-z_:]|\.\d)/gi;
/** Exactly four decimal parts; rejects `v1.2.3.4`, `1.2.3.4.5` and `1.2.3.4-rc1`. */
export const IPV4_RE = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\w|\.\d|-[a-z])/gi;
const ISO_DATE_BEFORE_RE = /\d{4}-\d{2}-\d{2}[T ]$/;
const TIME_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const UUID_BEFORE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:?$/i;

/** True when an IPV6_RE literal has the shape of an address rather than a time, ratio, MAC or scope path. */
function looksLikeIpv6(text: string, before: string): boolean {
  const parts = text.split(":").filter((part) => part !== "");
  const hexGroups = parts.filter((part) => !part.includes("."));
  const groupCount = hexGroups.length + 2 * (parts.length - hexGroups.length);
  // Compressed, or the full eight groups. Drops `12:34`, `10:30:00` and six-group MAC addresses.
  if (!text.includes("::") && groupCount !== 8) return false;
  // `::` alone is the unspecified address, which is allowlisted.
  if (parts.length === 0) return false;
  // Drops eight-group runs of two-digit numbers (clock or ratio strings).
  if (!hexGroups.some((group) => /[a-f]/i.test(group) || group.length !== 2)) return false;
  // Pure-letter scope paths (`a::b`) are not addresses.
  if (!/\d/.test(text)) return false;
  if (TIME_RE.test(text) || ISO_DATE_BEFORE_RE.test(before.slice(-11))) return false;
  // The `<uuid>:<seq>` id of an event-stream frame.
  if (UUID_BEFORE_RE.test(before.slice(-37))) return false;
  return true;
}

/** IP literals in one line outside the allowlisted ranges. Pure. */
export function findIpAddresses(line: string): RuleMatch[] {
  const out: RuleMatch[] = [];
  // IPv6 runs first so the IPv4 pass can skip the tail of an IPv4-mapped literal.
  const ipv6Spans: Span[] = [];
  for (const m of line.matchAll(IPV6_RE)) {
    const text = m[1] ?? "";
    if (!looksLikeIpv6(text, line.slice(Math.max(0, m.index - 37), m.index))) continue;
    if (!ipaddr.IPv6.isValid(text)) continue;
    ipv6Spans.push([m.index, m.index + m[0].length]);
    if (isAllowedIp(ipaddr.IPv6.parse(text))) continue;
    out.push({ rule: "ip-address", value: m[0], index: m.index, kind: "ipv6" });
  }

  for (const m of line.matchAll(IPV4_RE)) {
    const octets = [m[1], m[2], m[3], m[4]].map(Number);
    if (octets.some((octet) => octet > 255)) continue;
    if (overlaps(ipv6Spans, m.index, m.index + m[0].length)) continue;
    // Number() strips leading zeros, which the strict parser would read as octal.
    const normalised = octets.join(".");
    if (!ipaddr.IPv4.isValidFourPartDecimal(normalised)) continue;
    if (isAllowedIp(ipaddr.IPv4.parse(normalised))) continue;
    out.push({ rule: "ip-address", value: m[0], index: m.index, kind: "default" });
  }

  return out.sort(byIndex);
}

// ── Home-directory path rule ─────────────────────────────────────────────────────────────────────────────────

const SEG = "[\\p{L}\\p{N}._-]{1,255}";
const SEG_END = "(?=[\\\\/\\s\"'`)\\]},;:]|$)";
/** `/home/<name>` and `/Users/<name>`. A preceding `/` is allowed (`file:///home/…`); a preceding letter is not. */
export const POSIX_HOME_RE = new RegExp(`(?<![\\p{L}\\p{N}_.~%-])/(home|Users)/(${SEG})${SEG_END}`, "gu");
/** `C:\Users\<name>`, also JSON-escaped (`C:\\Users\\…`) and with forward slashes. */
export const WINDOWS_HOME_RE = new RegExp(`(?<![\\p{L}\\p{N}_])[A-Za-z]:(?:\\\\{1,2}|/)Users(?:\\\\{1,2}|/)(${SEG})${SEG_END}`, "giu");
/** `~<name>/`. `~/` never matches: a name character must follow the tilde. */
export const TILDE_HOME_RE = new RegExp(`(?<![\\p{L}\\p{N}_.~/-])~([\\p{L}_][\\p{L}\\p{N}._-]{0,254})/`, "gu");
/** Placeholder segments that never fire. `USER` and `NAME` are case-sensitive. */
export const PLACEHOLDER_SEGMENT_RE = /^(USER|NAME|<[^>]+>|\{[^}]+\})$/;

/** Home-directory paths in one line. Pure. */
export function findHomePaths(line: string): RuleMatch[] {
  const out: RuleMatch[] = [];
  const claimed: Span[] = [];
  const add = (value: string, index: number, segment: string): void => {
    if (PLACEHOLDER_SEGMENT_RE.test(segment)) return;
    if (overlaps(claimed, index, index + value.length)) return;
    claimed.push([index, index + value.length]);
    out.push({ rule: "home-path", value, index, kind: "default" });
  };
  // Windows first: `C:/Users/<name>` also contains the POSIX form, which must not be reported twice.
  for (const m of line.matchAll(WINDOWS_HOME_RE)) add(m[0], m.index, m[1] ?? "");
  for (const m of line.matchAll(POSIX_HOME_RE)) add(m[0], m.index, m[2] ?? "");
  for (const m of line.matchAll(TILDE_HOME_RE)) add(`~${m[1] ?? ""}`, m.index, m[1] ?? "");
  return out.sort(byIndex);
}

// ── Local deny-list rule ─────────────────────────────────────────────────────────────────────────────────────

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Case-insensitive with ASCII-alphanumeric boundaries: a term fires wherever it is joined by `.`, `-`, `_`,
 * `:`, `/` or `@`, but not inside a longer word.
 */
function compileDenyTerms(terms: readonly string[]): RegExp[] {
  return terms.map((term) => new RegExp(`(?<![a-z0-9])${escapeRegExp(term)}(?![a-z0-9])`, "gi"));
}

function findDenyMatches(line: string, compiled: readonly RegExp[]): RuleMatch[] {
  const out: RuleMatch[] = [];
  for (const re of compiled) {
    for (const m of line.matchAll(re)) {
      out.push({ rule: "local-deny", value: m[0], index: m.index, kind: "default" });
    }
  }
  return out.sort(byIndex);
}

/** Local deny-term hits in one line. `terms` are lower-cased, at least 3 characters. Pure. */
export function findDenyTerms(line: string, terms: readonly string[]): RuleMatch[] {
  return findDenyMatches(line, compileDenyTerms(terms));
}

// ── Masking, suggestions, formatting ─────────────────────────────────────────────────────────────────────────

const ELLIPSIS = "…";

/**
 * Masked form of a value: never more than one label, octet or group, or two characters, of the offending text.
 */
export function maskValue(rule: RuleId, value: string): string {
  switch (rule) {
    case "hostname":
      return (value.split(".")[0] ?? "") + ELLIPSIS;
    case "ip-address":
      if (!value.includes(":")) return (value.split(".")[0] ?? "") + ELLIPSIS;
      return value.startsWith("::") ? `::${ELLIPSIS}` : (value.split(":")[0] ?? "") + ELLIPSIS;
    case "home-path":
      if (value.startsWith("/home/")) return `/home/${ELLIPSIS}`;
      if (value.startsWith("/Users/")) return `/Users/${ELLIPSIS}`;
      if (value.startsWith("~")) return `~${ELLIPSIS}`;
      if (/^[A-Za-z]:/.test(value)) return `${value.slice(0, 1)}:\\Users\\${ELLIPSIS}`;
      return ELLIPSIS;
    case "local-deny":
    case "stale-exception":
      return value.slice(0, 2) + ELLIPSIS;
    case "empty-scope":
      return "";
  }
}

/** Suggested safe replacement for a match. */
export function suggestFor(match: RuleMatch): string {
  switch (match.rule) {
    case "hostname":
      return match.kind === "email" ? "example.com" : "pulse.example.com";
    case "ip-address":
      return match.kind === "ipv6" ? "2001:db8::10" : "192.0.2.10";
    case "home-path":
      return `~/${ELLIPSIS}`;
    case "local-deny":
      return 'a placeholder from CONTRIBUTING.md "Public-safe placeholders"';
  }
}

/** Path that stale-exception findings are reported against. */
const EXCEPTIONS_PATH = "public-safe-exceptions.json";

/** One output line for a violation. For `stale-exception`, `line` is the 1-based entry number. */
export function formatViolation(v: Violation): string {
  if (v.rule === "empty-scope") return `contract/ empty-scope → ${v.suggestion}`;
  if (v.rule === "stale-exception") {
    return `${v.path} exceptions[${v.line - 1}] stale-exception ${v.masked} → ${v.suggestion}`;
  }
  return `${v.path}:${v.line}:${v.column} ${v.rule} ${v.masked} → ${v.suggestion}`;
}

// ── scan ─────────────────────────────────────────────────────────────────────────────────────────────────────

function compareViolations(a: Violation, b: Violation): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.column !== b.column) return a.column - b.column;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  return 0;
}

/**
 * Run every rule over every file, apply exceptions, add stale-exception and empty-scope findings, and sort.
 * Content problems are always violations; this throws only on a programming error.
 */
export function scan(input: LintRunInput): LintResult {
  const violations: Violation[] = [];
  if (input.contractFileCount === 0) {
    violations.push({
      path: "contract",
      line: 1,
      column: 1,
      rule: "empty-scope",
      masked: "",
      suggestion: "contract/ yielded no scannable files; the scan cannot pass vacuously",
    });
  }

  const hits = new Array<number>(input.exceptions.length).fill(0);
  const globCache = new Map<string, RegExp>();
  const exceptionPaths = input.exceptions.map((ex) => {
    let re = globCache.get(ex.path);
    if (re === undefined) {
      re = globToRegExp(ex.path);
      globCache.set(ex.path, re);
    }
    return re;
  });
  const denyTerms = compileDenyTerms(input.denyTerms);

  for (const file of input.files) {
    // Which exceptions apply to this file is the same for every match in it.
    const applicable: number[] = [];
    exceptionPaths.forEach((re, i) => {
      if (re.test(file.path)) applicable.push(i);
    });
    const lines = file.text.split(/\r?\n/);
    lines.forEach((line, lineIndex) => {
      if (line === "") return;
      const matches = [
        ...findHostnames(line),
        ...findIpAddresses(line),
        ...findHomePaths(line),
        ...findDenyMatches(line, denyTerms),
      ];
      for (const match of matches) {
        // Every matching entry is credited, so overlapping entries never look stale.
        let excepted = false;
        for (const i of applicable) {
          if (input.exceptions[i]?.value === match.value) {
            hits[i] = (hits[i] ?? 0) + 1;
            excepted = true;
          }
        }
        if (excepted) continue;
        violations.push({
          path: file.path,
          line: lineIndex + 1,
          column: match.index + 1,
          rule: match.rule,
          masked: maskValue(match.rule, match.value),
          suggestion: suggestFor(match),
        });
      }
    });
  }

  input.exceptions.forEach((ex, i) => {
    if (hits[i] !== 0) return;
    violations.push({
      path: EXCEPTIONS_PATH,
      line: i + 1,
      column: 1,
      rule: "stale-exception",
      masked: maskValue("stale-exception", ex.value),
      suggestion: `remove this entry; nothing under ${ex.path} contains it any more`,
    });
  });

  violations.sort(compareViolations);
  return { violations, scanned: input.files.length };
}
