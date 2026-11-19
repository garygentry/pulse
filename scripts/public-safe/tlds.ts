/**
 * Curated name sets for the hostname rule. Every set is lower-case and every lookup lower-cases its input first,
 * so matching is case-insensitive. Changing a set changes what the lint recognises: update CONTRIBUTING.md
 * "What the check recognises" in the same change.
 */

/**
 * Curated public TLDs for bare dotted names. 60 entries: the legacy generic TLDs, a few common new ones and the
 * most common country codes. It is deliberately not the IANA root zone, and it is disjoint from the two exclusion
 * sets below. URL, `host:port` and after-`@` candidates do not consult it.
 */
export const PUBLIC_TLDS: ReadonlySet<string> = new Set([
  "com", "net", "org", "edu", "gov", "mil", "int", "biz",
  "io", "co", "ai", "xyz", "tv", "gg", "club",
  "uk", "de", "fr", "eu", "us", "ca", "au", "nz", "nl", "be", "ch", "se", "no", "dk", "fi", "ie",
  "es", "pt", "cz", "hu", "ro", "gr", "ru", "ua", "jp", "cn", "kr", "tw", "hk", "sg", "br", "ar",
  "mx", "cl", "za", "il", "vn", "lu", "ee", "lv", "lt", "si", "hr", "bg", "sk",
]);

/** Private-use / non-public suffixes. A candidate needs at least one label before the suffix. */
export const PRIVATE_USE_SUFFIXES: readonly string[] = [
  "lan", "local", "home", "internal", "corp", "intranet", "localdomain", "home.arpa",
];

/** Last labels that are file extensions. Never a hostname in the bare or host:port positions (file:line references). */
export const EXTENSION_TLDS: ReadonlySet<string> = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc", "json5", "yml", "yaml", "md", "mdx",
  "sh", "bash", "zsh", "fish", "swift", "py", "rs", "go", "txt", "css", "scss", "html", "htm", "xml", "toml",
  "ini", "cfg", "conf", "env", "lock", "log", "ndjson", "sse", "csv", "tsv", "sql", "proto", "plist", "pbxproj",
  "xcconfig", "entitlements", "strings", "storyboard", "xib", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico",
  "pdf", "zip", "gz", "tgz", "cc", "pl", "mk", "kt", "java", "rb", "cpp", "hpp",
]);

/** Real TLDs deliberately left out of PUBLIC_TLDS because they are common property/member names (`user.id`, `item.name`). */
export const IDENTIFIER_COLLIDING_TLDS: ReadonlySet<string> = new Set([
  "app", "dev", "id", "name", "info", "page", "site", "host", "live", "email", "link", "run", "tools", "network",
  "systems", "world", "online", "store", "cloud", "tech", "digital", "new", "one", "top", "zone", "events", "news",
  "media", "group", "is", "it", "in", "at", "to", "me", "by", "as", "do", "so", "am", "my", "th", "tr", "ms", "pm",
]);

/** Public services that may be named as they are. Exact match after lower-casing; subdomains are not implied. */
export const WELL_KNOWN_PUBLIC_HOSTS: ReadonlySet<string> = new Set([
  "github.com", "apple.com", "developer.apple.com", "api.push.apple.com", "api.sandbox.push.apple.com",
  "tailscale.com", "grafana.com", "gcr.io", "ghcr.io", "docker.io",
]);

/** True when `name` (any case) is exactly a WELL_KNOWN_PUBLIC_HOSTS entry. */
export function isWellKnownPublicHost(name: string): boolean {
  return WELL_KNOWN_PUBLIC_HOSTS.has(name.toLowerCase());
}

/** True when `name` ends with ".<suffix>" for a PRIVATE_USE_SUFFIXES entry and has at least one label before it. */
export function hasPrivateUseSuffix(name: string): boolean {
  const lower = name.toLowerCase();
  return PRIVATE_USE_SUFFIXES.some((suffix) => lower.length > suffix.length + 1 && lower.endsWith(`.${suffix}`));
}
