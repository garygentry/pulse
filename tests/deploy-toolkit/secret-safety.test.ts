/// <reference path="./bun-test.d.ts" />
/**
 * secret-safety.test.ts — REQ-NFSEC-01 / REQ-SEC-02. META-GUARD (spec 06 §6).
 *
 * Enumerated repo-time scan over the deploy-toolkit corpus (examples/** + docs/operator +
 * docs/runbooks) asserting EXACTLY the four §6.1 checks and no more:
 *   1. Credential-bearing fields (`credential`, `deadman_hook`) are ${ENV}/op:// SecretRefs,
 *      never literals — with the minimal fixture's plain-URL `deadman_hook` as the one
 *      documented exception (00 §3.1). Parsed structurally from each fixture estate.yaml.
 *   2. No public IPv4 outside RFC1918 / loopback / RFC5737 documentation ranges.
 *   3. No real-looking public hostname/domain outside the reserved test TLDs.
 *   4. No known secret prefixes (AKIA/ASIA, gh?_/github_pat_, sk-/sk_live_, xoxb-/xoxp-, PEM).
 *
 * Contract = this declared set (06 §6.1); the §6.3 non-goals (entropy scan, scanning
 * node_modules/.git/dist/apps-docs, SecretRef resolvability) are OUT of scope by design
 * (anti-churn meta-guard norm). Adding a new secret *shape* later is a deliberate spec change.
 *
 * SCOPE NOTE (§6.2): the scan roots are examples/, docs/operator/, docs/runbooks/ — the
 * deploy-toolkit corpus this feature owns. docs/architecture/** is generated architecture docs, READ-ONLY
 * to this feature (01 §1) and outside this corpus; its prose legitimately cites real registry
 * domains (e.g. gcr.io, grafana.com), so it is not scanned here. apps/docs (the symlinked docs
 * aggregation + its dist) are outside these roots by construction (§6.3).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/** Repo root: tests/deploy-toolkit → up two. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** §6.2 enumerated scan roots (deploy-toolkit corpus only — see SCOPE NOTE above). */
const SCAN_ROOTS = [
  join(REPO_ROOT, "examples"),
  join(REPO_ROOT, "docs", "operator"),
  join(REPO_ROOT, "docs", "runbooks"),
];

/** Text file kinds scanned; everything else (binaries) is skipped by extension (§6.2). */
const SCAN_EXT = new Set([".yaml", ".yml", ".json", ".md"]);

/** Directories never descended into (§6.2 / §6.3 non-goals). */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

/** Readable repo-relative path for failure messages. */
const rel = (p: string): string => p.slice(REPO_ROOT.length + 1);

/**
 * Recursively collect scannable files under a root. Uses `lstatSync` so symlinks are detected
 * as symlinks and never followed (§6.2 — the apps/docs aggregation link is one such symlink).
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue; // never follow symlinks
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...walk(p));
    } else if (st.isFile() && SCAN_EXT.has(extname(p))) {
      out.push(p);
    }
  }
  return out;
}

const FILES = SCAN_ROOTS.filter((r) => existsSync(r)).flatMap(walk);

// ── Check 4: known secret prefixes (06 §6.1.4) ──────────────────────────────────────────────
/** Fixed, enumerated list — NOT an open-ended secret scanner (06 §6.3 non-goal). */
const SECRET_PREFIXES: readonly RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/, // AWS temporary access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, // GitHub fine-grained PAT
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI secret key (boundary-anchored: "disk-…" cannot match)
  /\bsk_live_[A-Za-z0-9]{20,}\b/, // Stripe live secret key
  /\bxox[bp]-[A-Za-z0-9-]{10,}\b/, // Slack bot/user token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key block
];

// ── Check 2: public IPv4 outside allowed ranges (06 §6.1.2) ─────────────────────────────────
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

/**
 * The renderer defaults Gatus DNS checks to Cloudflare's public anycast resolver 1.1.1.1
 * when an estate omits `dns_resolver` (packages/renderer/src/render/gatus.ts). Default-path
 * golden outputs therefore contain this well-known public resolver, not a leaked host.
 * Documented allowlist entry.
 */
const ALLOWED_PUBLIC_IPS = new Set(["1.1.1.1"]);

/** True iff the dotted quad is a private/loopback/documentation address (or the allowlist). */
function isAllowedIp(a: number, b: number, c: number, whole: string): boolean {
  if (ALLOWED_PUBLIC_IPS.has(whole)) return true;
  if (a === 10 || a === 127) return true; // RFC1918 10/8, loopback 127/8
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
  if (a === 192 && b === 168) return true; // RFC1918 192.168/16
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (RFC5737 doc)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (RFC5737 doc)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (RFC5737 doc)
  if (a === 0 || a >= 224) return true; // unspecified / multicast+reserved — not a real host
  return false;
}

// ── Check 3: real-looking public hostnames/domains (06 §6.1.3) ──────────────────────────────
/** Reserved test/example TLDs that always pass (00 §7). */
const ALLOWED_TLD = /\.(?:example|test|invalid|localhost)$/i;
/** Reserved example second-level domains that always pass. */
const ALLOWED_EXAMPLE_DOMAIN = /\.example\.(?:com|org|net)$/i;
/**
 * Real public TLDs. A FQDN whose final label is one of these — and is not a reserved example
 * domain above — is a real-looking domain and fails. This is the robust reading of "real-looking
 * domain": labels that merely look like a FQDN but end in a file extension (`docker-compose.yml`,
 * `config.ts`) or a dotted identifier (`process.cwd`, `build.version`) are NOT domains and pass,
 * so legitimate prose/filenames never red the guard (anti-churn norm). Extension-colliding TLDs
 * (`ts`, `sh`, `md`, `js`) are deliberately excluded.
 */
const REAL_PUBLIC_TLDS = new Set([
  "com", "org", "net", "io", "dev", "app", "cloud", "ai", "co", "gov", "edu",
  "info", "biz", "xyz", "me", "us", "uk", "eu", "de", "fr", "ca", "au", "tech",
  "live", "page", "site", "store", "online", "network", "host", "email",
  "digital", "tools", "systems", "world", "run",
]);
const FQDN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi;

// ── Check 1: credential fields must be SecretRefs (06 §6.1.1, mirrors 00 §2.3) ──────────────
const ENV_REF_RE = /^\$\{[A-Z_][A-Z0-9_]*\}$/; // ${UPPER_SNAKE}
const OP_REF_RE = /^op:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+$/; // op://vault/item/field
/** Keys whose scalar value carries a credential and must therefore be a SecretRef. */
const CREDENTIAL_KEYS = new Set(["credential", "deadman_hook"]);

interface CredHit {
  key: string;
  value: string;
}

/** Structurally walk a parsed estate tree, collecting every credential-bearing scalar. */
function collectCredentials(node: unknown, hits: CredHit[]): void {
  if (Array.isArray(node)) {
    for (const el of node) collectCredentials(el, hits);
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (CREDENTIAL_KEYS.has(k) && typeof v === "string") {
        hits.push({ key: k, value: v });
      } else {
        collectCredentials(v, hits);
      }
    }
  }
}

const FIXTURES = ["minimal", "reference"] as const;

describe("secret-safety meta-guard (REQ-NFSEC-01, REQ-SEC-02)", () => {
  test("scan covers a non-empty enumerated file set (§6.2)", () => {
    // Guards against a broken walk silently making every scan vacuously pass.
    expect(FILES.length > 0, "secret-safety scan found no files — walk/roots broken").toBe(true);
  });

  test("no known secret prefix in any scanned file (§6.1.4)", () => {
    for (const f of FILES) {
      const text = readFileSync(f, "utf8");
      for (const re of SECRET_PREFIXES) {
        expect(re.test(text), `known secret prefix ${re} in ${rel(f)}`).toBe(false);
      }
    }
  });

  test("no public IPv4 outside RFC1918/RFC5737/loopback (§6.1.2)", () => {
    for (const f of FILES) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(IPV4_RE)) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        const c = Number(m[3]);
        const d = Number(m[4]);
        if (a > 255 || b > 255 || c > 255 || d > 255) continue; // not an IP (e.g. a version)
        expect(isAllowedIp(a, b, c, m[0]), `public IPv4 ${m[0]} in ${rel(f)}`).toBe(true);
      }
    }
  });

  test("no real-looking public hostname/domain (§6.1.3)", () => {
    for (const f of FILES) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(FQDN_RE)) {
        const fqdn = m[0].toLowerCase();
        if (/^\d+(?:\.\d+)+$/.test(fqdn)) continue; // pure numeric (version/IP-ish)
        if (ALLOWED_TLD.test(fqdn) || ALLOWED_EXAMPLE_DOMAIN.test(fqdn)) continue; // reserved
        const label = fqdn.slice(fqdn.lastIndexOf(".") + 1);
        // Only a genuine public TLD is a "real-looking domain"; file extensions / dotted
        // identifiers keep their non-TLD final label and pass.
        expect(REAL_PUBLIC_TLDS.has(label), `real-looking public domain ${m[0]} in ${rel(f)}`)
          .toBe(false);
      }
    }
  });

  test("credential fields are SecretRefs, not literals (§6.1.1)", () => {
    for (const name of FIXTURES) {
      const estatePath = join(REPO_ROOT, "examples", name, "estate", "estate.yaml");
      const hits: CredHit[] = [];
      collectCredentials(parseYaml(readFileSync(estatePath, "utf8")), hits);
      expect(hits.length > 0, `no credential fields found in ${name} estate.yaml`).toBe(true);

      for (const { key, value } of hits) {
        if (name === "minimal" && key === "deadman_hook") {
          // The one documented exception (00 §3.1): the minimal fixture's plain-URL
          // deadman_hook. Assert it really IS a plain URL (not a SecretRef) so the exemption
          // stays load-bearing rather than silently masking a future regression.
          const isRef = ENV_REF_RE.test(value) || OP_REF_RE.test(value);
          expect(isRef, `minimal deadman_hook unexpectedly a SecretRef: ${value}`).toBe(false);
          expect(value.startsWith("http"), `minimal deadman_hook not a plain URL: ${value}`)
            .toBe(true);
          continue;
        }
        const isRef = ENV_REF_RE.test(value) || OP_REF_RE.test(value);
        expect(isRef, `credential ${key}=${value} in ${name} estate.yaml is not a SecretRef`)
          .toBe(true);
      }
    }
  });
});
