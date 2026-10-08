// apps/web/tests/security-headers.test.ts — the Content-Security-Policy and hardening headers (issue #2).
//
// Pins, per response type, the exact headers `createFetchHandler` sends (SPA shell, estate error page,
// `/assets/*`, `/api/*` JSON, health/metrics, 404/405), the inline-script hashing rules, and — over a
// real `build-client.ts` build — that the hashes the shell's policy allows are exactly the hashes of
// the inline scripts the build ships, and follow an edited inline script on rebuild. The in-browser
// zero-violation proof is tests/browser/csp.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadStaticAssets, MANIFEST_FILENAME, SHELL_MARKERS, type ClientManifest, type StaticAssets } from "../src/server/assets.js";
import type { ServerConfig } from "../src/server/config.js";
import { ERROR_PAGE_CSP } from "../src/server/estate/error-page.js";
import type { RuntimeStatus, ServerRuntime } from "../src/server/refresh.js";
import { createFetchHandler } from "../src/server/router.js";
import {
  BASE_SECURITY_HEADERS,
  CSP_NONCE_META,
  DOCUMENT_SECURITY_HEADERS,
  PERMISSIONS_POLICY,
  inlineScriptHashes,
  shellContentSecurityPolicy,
  staticPageContentSecurityPolicy,
  withCspNonceMeta,
  withSecurityHeaders,
  type CspHash,
} from "../src/server/security-headers.js";
import { EstateBundleError } from "../src/shared/errors.js";
import type { ServerContext } from "../src/shared/registry.js";

const BUILD_CLIENT = resolve(import.meta.dir, "../scripts/build-client.ts");
const CLIENT_INDEX = resolve(import.meta.dir, "../src/client/index.html");

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** SHA-256/base64 of `text`, computed independently of the module under test. */
function sha(text: string): CspHash {
  return `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`;
}

/** The text of each `<script>` without `src` whose type is absent or JavaScript, via Bun's HTMLRewriter
 *  (a real HTML tokenizer, independent of the regex scan in security-headers.ts). */
async function inlineScriptsByRewriter(html: string): Promise<string[]> {
  const scripts: string[] = [];
  let current: string | null = null;
  const rewriter = new HTMLRewriter().on("script", {
    element(el) {
      const type = (el.getAttribute("type") ?? "").trim().toLowerCase();
      const executable = !el.hasAttribute("src") && (type === "" || type === "module" || type === "text/javascript");
      current = executable ? "" : null;
      if (executable) {
        el.onEndTag(() => {
          scripts.push(current ?? "");
          current = null;
        });
      }
    },
    text(chunk) {
      if (current !== null) current += chunk.text;
    },
  });
  await rewriter.transform(new Response(html)).text();
  return scripts;
}

// ── fixtures for the router ─────────────────────────────────────────────────────────────────────

function status(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  const ok = { ok: true, lastSuccess: "2026-08-22T12:00:00.000Z", error: null };
  return {
    sources: { metrics: ok, alerts: ok, checks: ok },
    model: { loaded: true, formatVersion: 1, error: null },
    lastSnapshotAt: Date.parse("2026-08-22T12:00:00.000Z"),
    ...over,
  };
}

function fakeRuntime(st: RuntimeStatus): ServerRuntime {
  const context: ServerContext = {
    estate: null,
    cycle: null,
    history: {} as ServerContext["history"],
    events: {} as ServerContext["events"],
    sources: {} as ServerContext["sources"],
    config: {} as ServerConfig,
    identity: null,
    snapshot: null,
  };
  return {
    getContext: () => context,
    identityConfig: { mode: "none", headerName: "Remote-User", trustedProxies: [] },
    getStatus: () => st,
    runOnce: async () => {},
    start: async () => {},
    close: () => {},
  };
}

const HASH = sha("console.log(1)");
const assets: StaticAssets = {
  get: (p) => (p === "/assets/app.js" ? { body: new ArrayBuffer(3), contentType: "text/javascript; charset=utf-8" } : undefined),
  shell: () => "<!doctype html><html><head><title>t</title></head><body><div id=app></div></body></html>",
  inlineScriptHashes: () => [HASH],
};

async function fetchVia(path: string, init: RequestInit = {}, st: RuntimeStatus = status()): Promise<Response> {
  const handler = createFetchHandler(fakeRuntime(st), assets);
  return handler(new Request(`http://web:8080${path}`, init));
}

/** The response headers that matter here, lower-cased, minus the per-type payload headers. */
function securityHeaders(res: Response): Record<string, string> {
  const names = [
    "content-security-policy",
    "x-content-type-options",
    "referrer-policy",
    "cross-origin-opener-policy",
    "permissions-policy",
    "strict-transport-security",
    "x-frame-options",
  ];
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = res.headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

const NONCE = /'nonce-([A-Za-z0-9+/]{22}==)'/;

// ── policy text ─────────────────────────────────────────────────────────────────────────────────

describe("policy text", () => {
  test("the shell policy, exactly", () => {
    expect(shellContentSecurityPolicy([HASH], "abc")).toBe(
      "default-src 'self'; " +
        `script-src 'self' '${HASH}'; ` +
        "style-src 'self' 'nonce-abc'; " +
        "img-src 'self' data:; " +
        "font-src 'self'; " +
        "connect-src 'self'; " +
        "object-src 'none'; " +
        "base-uri 'none'; " +
        "form-action 'self'; " +
        "frame-ancestors 'none'",
    );
  });

  test("no 'unsafe-inline' and no 'unsafe-eval' anywhere", () => {
    for (const policy of [shellContentSecurityPolicy([HASH], "abc"), shellContentSecurityPolicy([]), ERROR_PAGE_CSP]) {
      expect(policy).not.toContain("unsafe-");
    }
  });

  test("without a nonce no runtime <style> element is allowed", () => {
    expect(shellContentSecurityPolicy([])).toContain("style-src 'self';");
  });

  test("the static-page policy fetches nothing and allows only the hashed stylesheets", () => {
    expect(staticPageContentSecurityPolicy([HASH])).toBe(
      `default-src 'none'; style-src '${HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
  });
});

// ── inline-script hashing ───────────────────────────────────────────────────────────────────────

describe("inlineScriptHashes", () => {
  test("hashes classic and module inline scripts, in order, deduplicated", () => {
    const html = `<script>a()</script><script type="module">b()</script><script type="text/javascript">a()</script>`;
    expect(inlineScriptHashes(html)).toEqual([sha("a()"), sha("b()")]);
  });

  test("skips external scripts, data blocks (the chunk-css island), and commented-out scripts", () => {
    const html = [
      `<script type="module" src="/assets/main.js"></script>`,
      `<script type="application/json" id="${SHELL_MARKERS.chunkCssIsland}">{"a":["/assets/x.css"]}</script>`,
      `<script type="importmap">{}</script>`,
      `<!-- <script>evil()</script> -->`,
      `<script data-src="x">kept()</script>`,
    ].join("\n");
    expect(inlineScriptHashes(html)).toEqual([sha("kept()")]);
  });

  test("hashes the exact element text, CRLF normalised to LF as the HTML parser does", () => {
    expect(inlineScriptHashes("<script>\r\n  x();\r\n</script>")).toEqual([sha("\n  x();\n")]);
  });

  test("agrees with an HTML tokenizer on the real index.html", async () => {
    const html = readFileSync(CLIENT_INDEX, "utf8");
    const scripts = await inlineScriptsByRewriter(html);
    expect(scripts.length).toBeGreaterThan(0); // the pre-paint theme/density stamp
    expect(inlineScriptHashes(html)).toEqual(scripts.map(sha));
  });
});

// ── per response type ───────────────────────────────────────────────────────────────────────────

describe("headers per response type", () => {
  test("SPA shell: the full document set, a fresh style nonce in policy and meta, never stored", async () => {
    const res = await fetchVia("/overview");
    expect(res.status).toBe(200);
    const headers = securityHeaders(res);
    const nonce = NONCE.exec(headers["content-security-policy"] ?? "")?.[1];
    expect(nonce).toBeDefined();
    expect(headers).toEqual({
      "content-security-policy": shellContentSecurityPolicy([HASH], nonce),
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "cross-origin-opener-policy": "same-origin",
      "permissions-policy": PERMISSIONS_POLICY,
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain(`<meta name="${CSP_NONCE_META}" nonce="${nonce}">`);
    expect(html.indexOf(CSP_NONCE_META)).toBeLessThan(html.indexOf("</head>"));

    const again = NONCE.exec((await fetchVia("/alerts")).headers.get("content-security-policy") ?? "")?.[1];
    expect(again).toBeDefined();
    expect(again).not.toBe(nonce);
  });

  test("estate error page: its own policy (hash of its one <style>), plus the document set", async () => {
    const err = new EstateBundleError("missing", "model", "/rendered/web-estate-model.json", "not found");
    const res = await fetchVia("/overview", {}, status({ model: { loaded: false, formatVersion: null, error: err } }));
    const html = await res.text();
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
    expect(style).toBeDefined();
    expect(securityHeaders(res)).toEqual({
      "content-security-policy": staticPageContentSecurityPolicy([sha(style!)]),
      ...BASE_SECURITY_HEADERS,
      ...DOCUMENT_SECURITY_HEADERS,
    });
    expect(ERROR_PAGE_CSP).toBe(staticPageContentSecurityPolicy([sha(style!)]));
    expect(html).not.toContain("<script");
  });

  test("/assets/*: nosniff and referrer policy only; immutable caching kept", async () => {
    const res = await fetchVia("/assets/app.js");
    expect(securityHeaders(res)).toEqual(BASE_SECURITY_HEADERS);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(securityHeaders(await fetchVia("/assets/missing.js"))).toEqual(BASE_SECURITY_HEADERS);
  });

  test("/api/* JSON, /healthz, /metrics, 405, and an internal error: nosniff and referrer policy only", async () => {
    for (const res of [
      await fetchVia("/api/nope"),
      await fetchVia("/healthz"),
      await fetchVia("/metrics"),
      await fetchVia("/api/session", { method: "POST" }),
    ]) {
      expect(securityHeaders(res)).toEqual(BASE_SECURITY_HEADERS);
    }
    const broken: StaticAssets = { ...assets, get: () => { throw new Error("boom"); } };
    const res = await createFetchHandler(fakeRuntime(status()), broken)(new Request("http://web:8080/assets/x.js"));
    expect(res.status).toBe(500);
    expect(securityHeaders(res)).toEqual(BASE_SECURITY_HEADERS);
  });

  test("no HSTS: TLS terminates at the operator's reverse proxy", async () => {
    expect((await fetchVia("/overview")).headers.has("strict-transport-security")).toBe(false);
  });
});

describe("withSecurityHeaders", () => {
  test("never overwrites a header the response already carries", () => {
    const res = withSecurityHeaders(
      new Response("<p>", { headers: { "content-type": "text/html", "content-security-policy": "default-src 'none'" } }),
      "default-src 'self'",
    );
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("copies a response whose headers are immutable", async () => {
    const immutable = Response.redirect("http://web:8080/overview", 302);
    const res = withSecurityHeaders(immutable, "default-src 'self'");
    expect(res.status).toBe(302);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("withCspNonceMeta stamps the meta before </head>, or appends without one", () => {
    expect(withCspNonceMeta("<head></head>", "n")).toBe(`<head>    <meta name="${CSP_NONCE_META}" nonce="n">\n  </head>`);
    expect(withCspNonceMeta("<p>", "n")).toBe(`<p>    <meta name="${CSP_NONCE_META}" nonce="n">\n`);
  });
});

// ── build-time hashes ───────────────────────────────────────────────────────────────────────────

function build(outdir: string, extra: string[] = []): ClientManifest {
  const proc = Bun.spawnSync({ cmd: ["bun", BUILD_CLIENT, "--outdir", outdir, ...extra], stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`build-client exited ${proc.exitCode}\n${proc.stderr.toString()}`);
  return JSON.parse(readFileSync(join(outdir, MANIFEST_FILENAME), "utf8")) as ClientManifest;
}

async function servedShellPolicy(dir: string): Promise<string> {
  const handler = createFetchHandler(fakeRuntime(status()), loadStaticAssets(dir));
  return (await handler(new Request("http://web:8080/overview"))).headers.get("content-security-policy") ?? "";
}

describe("build-time inline-script hashes", () => {
  test("the production build records exactly the shipped index.html's inline-script hashes, and the shell serves them", async () => {
    const outdir = tmp("pulse-csp-build-");
    const manifest = build(outdir, ["--minify", "--sourcemap", "none"]);
    const shipped = readFileSync(join(outdir, "index.html"), "utf8");
    const expected = (await inlineScriptsByRewriter(shipped)).map(sha);
    expect(expected.length).toBeGreaterThan(0);
    expect(manifest.inlineScriptHashes).toEqual(expected);

    const policy = await servedShellPolicy(outdir);
    const scriptSrc = /script-src ([^;]*)/.exec(policy)?.[1];
    expect(scriptSrc).toBe(["'self'", ...expected.map((h) => `'${h}'`)].join(" "));

    // The composed shell adds the chunk-css island and entry tags but no inline executable script.
    expect(inlineScriptHashes(loadStaticAssets(outdir).shell())).toEqual(expected);
  }, 120_000);

  test("an edited inline script ships its new hash on rebuild — never a stale one", async () => {
    const root = tmp("pulse-csp-entry-");
    const entry = join(root, "main.tsx");
    writeFileSync(entry, "console.log('csp');\n");
    const page = (script: string): string =>
      `<!doctype html><html><head><script>${script}</script></head><body><div id="app"></div></body></html>`;
    const outdir = tmp("pulse-csp-rebuild-");

    writeFileSync(join(root, "index.html"), page("self.a = 1;"));
    expect(build(outdir, ["--entry", entry]).inlineScriptHashes).toEqual([sha("self.a = 1;")]);
    expect(await servedShellPolicy(outdir)).toContain(`'${sha("self.a = 1;")}'`);

    writeFileSync(join(root, "index.html"), page("self.a = 2;"));
    expect(build(outdir, ["--entry", entry, "--no-clean"]).inlineScriptHashes).toEqual([sha("self.a = 2;")]);
    const policy = await servedShellPolicy(outdir);
    expect(policy).toContain(`'${sha("self.a = 2;")}'`);
    expect(policy).not.toContain(sha("self.a = 1;"));
  }, 120_000);

  test("a shell that drifted from its manifest is served with the hashes of the bytes it serves", async () => {
    const dir = tmp("pulse-csp-drift-");
    writeFileSync(join(dir, "index.html"), "<html><head><script>edited()</script></head><body></body></html>");
    writeFileSync(join(dir, "main-aaaa.js"), "");
    const manifest: ClientManifest = {
      buildId: "000000000000",
      entries: { js: ["/assets/main-aaaa.js"], css: [] },
      chunks: [],
      chunkCss: {},
      inlineScriptHashes: [sha("original()")],
    };
    writeFileSync(join(dir, MANIFEST_FILENAME), JSON.stringify(manifest));
    expect(loadStaticAssets(dir).inlineScriptHashes?.()).toEqual([sha("edited()")]);
  });

  test("a manifest with a malformed hash is rejected (directory-scan fallback)", () => {
    const dir = tmp("pulse-csp-bad-");
    writeFileSync(join(dir, "index.html"), "<html><head><script>x()</script></head><body></body></html>");
    writeFileSync(
      join(dir, MANIFEST_FILENAME),
      JSON.stringify({ buildId: "0", entries: { js: [], css: [] }, chunks: [], inlineScriptHashes: ["'unsafe-inline'"] }),
    );
    const loaded = loadStaticAssets(dir);
    expect(loaded.buildId?.()).toBeNull();
    expect(loaded.inlineScriptHashes?.()).toEqual([sha("x()")]);
  });
});
