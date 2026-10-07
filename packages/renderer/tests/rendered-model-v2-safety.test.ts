/** rendered-model-v2-safety.test.ts — the pure safety layer (03-web-safety-and-findings.md).
 *
 *  Covers: display-only POSIX argv formatting (web-command.ts); credential display projection;
 *  lexical estate-relative provenance; URL-userinfo removal for every URL slot pattern; sensitive
 *  channel-option tokenization; canary finalization; and the eight-rule recursive three-artifact
 *  assertion with deterministic, non-echoing first failure. Also proves no secret/environment/
 *  network resolution occurs during projection. These are the four renderer-produced finding
 *  codes' covering cases (see packages/core/tests/meta.test.ts). */

import { describe, expect, test } from "bun:test";

import type { Finding, Provenance, SecretRef } from "@pulse/core";

import { displayPosixArgv, quotePosixArg } from "../src/render/web-command.js";
import {
  assertWebArtifactsSafe,
  createWebSafetyContext,
  finalizeCanaries,
  projectCredential,
  projectProvenance,
  sanitizeChannelOptions,
  sanitizeUrl,
  type WebProjectionResult,
} from "../src/render/web-safety.js";
import type { WebProvenance } from "../src/render/web-model.js";

const SRC: WebProvenance = { file: "estate.yaml", path: "hosts[0].detail.apiEndpoint", line: 3, col: 5 };

/** Assert no finding field reproduces any of the given withheld literals. */
function assertNoEcho(findings: readonly Finding[], withheld: readonly string[]): void {
  for (const f of findings) {
    for (const literal of withheld) {
      expect(f.file).not.toContain(literal);
      expect(f.path).not.toContain(literal);
      expect(f.message).not.toContain(literal);
      expect(f.fix).not.toContain(literal);
    }
  }
}

// ───────────────────────────── web-command: POSIX argv ─────────────────────────────

describe("displayPosixArgv / quotePosixArg", () => {
  test("preserves argv boundaries for safe, empty, spaced, quoted, apostrophe, newline tokens", () => {
    expect(quotePosixArg("/usr/bin/check")).toBe("/usr/bin/check");
    expect(quotePosixArg("--name")).toBe("--name");
    expect(quotePosixArg("a_b@c%d+e=f:g,h.i/j-k")).toBe("a_b@c%d+e=f:g,h.i/j-k");
    expect(quotePosixArg("")).toBe("''");
    expect(quotePosixArg("daily backup")).toBe("'daily backup'");
    expect(quotePosixArg('has"dquote')).toBe(`'has"dquote'`);
    expect(quotePosixArg("it's ready")).toBe(`'it'"'"'s ready'`);
    expect(quotePosixArg("line1\nline2")).toBe("'line1\nline2'");
  });

  test("matches spec worked examples and joins with a single space", () => {
    expect(displayPosixArgv(["/usr/bin/check", "--name", "daily backup"])).toBe(
      "/usr/bin/check --name 'daily backup'",
    );
    expect(displayPosixArgv(["printf", "%s", "it's ready", ""])).toBe(
      `printf %s 'it'"'"'s ready' ''`,
    );
  });

  test("empty argv renders as the empty string and never executes", () => {
    expect(displayPosixArgv([])).toBe("");
  });
});

// ───────────────────────────── credential display ─────────────────────────────

describe("projectCredential", () => {
  test("env and op references project to exactly { kind, display } with no core-internal field", () => {
    const env = projectCredential({ kind: "env", raw: "${SLACK_TOKEN}", varName: "SLACK_TOKEN" });
    expect(env).toEqual({ kind: "env", display: "${SLACK_TOKEN}" });
    expect(Object.keys(env).sort()).toEqual(["display", "kind"]);

    const op = projectCredential({
      kind: "op",
      raw: "op://vault/item/field",
      vault: "vault",
      item: "item",
      field: "field",
    });
    expect(op).toEqual({ kind: "op", display: "op://vault/item/field" });
    expect(op).not.toHaveProperty("vault");
    expect(op).not.toHaveProperty("raw");
  });
});

// ───────────────────────────── provenance ─────────────────────────────

describe("projectProvenance", () => {
  test("accepts single-file, nested multi-file, and overlay relative paths; normalizes separators", () => {
    const single = projectProvenance({ file: "estate.yaml", path: "estate.name", line: 1, col: 1 });
    expect(single).toEqual({
      ok: true,
      value: { file: "estate.yaml", path: "estate.name", line: 1, col: 1 },
      findings: [],
    });

    const nested = projectProvenance({ file: "hosts/web.yaml", path: "hosts[0]", line: 2, col: 3 });
    expect(nested.ok && nested.value.file).toBe("hosts/web.yaml");

    const overlay = projectProvenance({ file: "overlays\\prod\\estate.yaml", path: "x", line: 4, col: 2 });
    expect(overlay.ok && overlay.value.file).toBe("overlays/prod/estate.yaml");

    const dotSegments = projectProvenance({ file: "./a/./b/../c", path: "y", line: 1, col: 1 });
    expect(dotSegments.ok && dotSegments.value.file).toBe("a/c");
  });

  test("copies path/line/col unchanged and ignores estateRoot without I/O", () => {
    const r = projectProvenance({ file: "a/b.yaml", path: "svc[1].kind", line: 9, col: 8 }, "/abs/root");
    expect(r.ok && r.value).toEqual({ file: "a/b.yaml", path: "svc[1].kind", line: 9, col: 8 });
  });

  test.each([
    ["empty", ""],
    ["dot only", "."],
    ["leading ..", "../secrets.yaml"],
    ["nested escape", "a/../../b.yaml"],
    ["absolute posix", "/etc/estate.yaml"],
    ["unc", "//server/share/estate.yaml"],
    ["drive-qualified", "C:\\estate.yaml"],
    ["drive-relative", "C:estate.yaml"],
    ["NUL", "a\0b.yaml"],
  ])("rejects %s as fatal WEB_UNSAFE_PROVENANCE without echoing the file", (_name, file) => {
    const prov: Provenance = { file, path: "hosts[0].name", line: 7, col: 2 };
    const r = projectProvenance(prov);
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    const finding = r.findings[0]!;
    expect(finding.severity).toBe("error");
    expect(finding.code).toBe("web_unsafe_provenance");
    expect(finding.file).toBe("<estate>");
    expect(finding.path).toBe("hosts[0].name");
    // The unsafe file value must never be echoed anywhere in the finding.
    assertNoEcho([finding], [file].filter((v) => v !== "" && v !== "."));
  });
});

// ───────────────────────────── URL sanitization ─────────────────────────────

describe("sanitizeUrl", () => {
  test.each([
    ["username-only", "https://alice9@example.com/p", "https://example.com/p", ["alice9"]],
    [
      "password-bearing",
      "https://alice9:pw7secret@example.com:8443/p?q=1#f",
      "https://example.com:8443/p?q=1#f",
      ["alice9", "pw7secret", "alice9:pw7secret"],
    ],
    ["percent-encoded", "http://%41x:%42y@ex.com/", "http://ex.com/", ["%41x", "%42y", "%41x:%42y"]],
    ["ipv6+port", "http://usr9:pss9@[::1]:8080/x", "http://[::1]:8080/x", ["usr9", "pss9", "usr9:pss9"]],
    [
      "network-path",
      "//usr9:pss9@cdn.example.com/a.js",
      "//cdn.example.com/a.js",
      ["usr9", "pss9", "usr9:pss9"],
    ],
  ])("%s: removes userinfo, keeps context, one warning, collects canaries", (_n, input, expected, canaries) => {
    const ctx = createWebSafetyContext();
    const out = sanitizeUrl(input, SRC, ctx);
    expect(out).toBe(expected);
    expect(ctx.findings).toHaveLength(1);
    const warn = ctx.findings[0]!;
    expect(warn.severity).toBe("warning");
    expect(warn.code).toBe("web_url_userinfo_removed");
    expect(warn.file).toBe(SRC.file);
    expect(warn.path).toBe(SRC.path);
    for (const c of canaries) expect(ctx.canaries.has(c)).toBe(true);
    // The warning never echoes removed userinfo.
    assertNoEcho(ctx.findings, canaries);
    // The sanitized output never contains the userinfo either.
    for (const c of canaries) expect(out).not.toContain(c);
  });

  test.each([
    ["no-userinfo", "https://api.example.com:9090/metrics?x=1#top"],
    ["malformed", "http://%zz not a url"],
    ["plain token", "${NOT_A_URL}"],
  ])("%s: preserves the value and adds no finding or canary", (_n, input) => {
    const ctx = createWebSafetyContext();
    const out = sanitizeUrl(input, SRC, ctx);
    expect(out).toBe(input);
    expect(ctx.findings).toHaveLength(0);
    expect(ctx.canaries.size).toBe(0);
  });
});

// ───────────────────────────── channel-option tokenization ─────────────────────────────

describe("sanitizeChannelOptions", () => {
  test("undefined options and all-omitted options both return null", () => {
    const ctx = createWebSafetyContext();
    expect(sanitizeChannelOptions(undefined, SRC, ctx)).toBeNull();
    expect(sanitizeChannelOptions({ apiToken: "abc", webhook_url: "https://h/x" }, SRC, ctx)).toBeNull();
    expect(ctx.findings).toHaveLength(2);
  });

  test.each([
    ["apiToken", true],
    ["API_TOKEN", true],
    ["password-file", true],
    ["signingKey", true],
    ["webhook_url", true],
    ["monkey", false],
    ["tokenizer", false],
    ["hockey", false],
    ["secretary", false],
  ])("%s omitted=%p per exact-token match", (key, sensitive) => {
    const ctx = createWebSafetyContext();
    const out = sanitizeChannelOptions({ [key]: "VALUE" }, SRC, ctx);
    if (sensitive) {
      expect(out).toBeNull();
      expect(ctx.findings).toHaveLength(1);
      expect(ctx.findings[0]!.code).toBe("web_sensitive_channel_option_omitted");
      expect(ctx.canaries.has("VALUE")).toBe(true);
    } else {
      expect(out).toEqual({ [key]: "VALUE" });
      expect(ctx.findings).toHaveLength(0);
    }
  });

  test("mixed keys: preserves safe primitives, omits sensitive, warns once per omitted key, no value echo", () => {
    const ctx = createWebSafetyContext();
    const out = sanitizeChannelOptions(
      { channel: "ops", retries: 3, verbose: true, apiToken: "TOK", signingKey: "SIG" },
      SRC,
      ctx,
    );
    expect(out).toEqual({ channel: "ops", retries: 3, verbose: true });
    expect(ctx.findings).toHaveLength(2);
    expect(ctx.canaries.has("TOK")).toBe(true);
    expect(ctx.canaries.has("SIG")).toBe(true);
    assertNoEcho(ctx.findings, ["TOK", "SIG"]);
    // Warning paths mention the safe key but never the value.
    const paths = ctx.findings.map((f) => f.path).sort();
    expect(paths).toEqual([
      "hosts[0].detail.apiEndpoint.options.apiToken",
      "hosts[0].detail.apiEndpoint.options.signingKey",
    ]);
  });

  test("non-string sensitive values collect no canary but still omit", () => {
    const ctx = createWebSafetyContext();
    const out = sanitizeChannelOptions({ apiToken: 12345, webhook_url: true }, SRC, ctx);
    expect(out).toBeNull();
    expect(ctx.canaries.size).toBe(0);
    expect(ctx.findings).toHaveLength(2);
  });
});

// ───────────────────────────── canary finalization ─────────────────────────────

describe("finalizeCanaries", () => {
  test("removes empty, deduplicates, and sorts longest-first then raw code point", () => {
    const ctx = createWebSafetyContext();
    for (const v of ["", "aa", "bb", "aa", "cccc", "bbbb"]) ctx.canaries.add(v);
    expect(finalizeCanaries(ctx)).toEqual({ values: ["bbbb", "cccc", "aa", "bb"] });
  });
});

// ───────────────────────────── recursive assertion ─────────────────────────────

const OK_ID = `sha256:${"a".repeat(64)}` as const;

/** A coherent, safe three-artifact set that passes the assertion with no canaries. */
function safeArtifacts(): Record<string, unknown> {
  return {
    "web-coverage.json": {
      formatVersion: 2,
      bundleId: OK_ID,
      covered: [
        {
          kind: "host",
          name: "alpha",
          collectionClass: "managed-linux",
          artifacts: ["scrape/file_sd/alpha.json"],
          suppressed: null,
        },
      ],
      gaps: [],
      suppressed: [],
    },
    "web-estate-model.json": {
      formatVersion: 2,
      bundleId: OK_ID,
      estate: {
        name: "home estate",
        domains: ["example.com"],
        timezone: "America/Chicago",
        dnsResolver: null,
        retention: null,
        schemaMajor: 1,
        deadman: { configured: true, kind: "plain" },
      },
      hosts: [
        {
          name: "alpha",
          collectionClass: "hypervisor-api",
          addresses: ["10.0.0.1"],
          suppressed: null,
          drilldownId: "host:alpha",
          expectedChurn: false,
          scrapeIntervalClass: null,
          provenance: { file: "estate.yaml", path: "hosts[0]", line: 1, col: 1 },
          scrapeTargets: [],
          artifacts: ["scrape/file_sd/alpha.json"],
          detail: {
            apiEndpoint: "https://api.example.com",
            credential: { kind: "env", display: "${TOKEN}" },
          },
        },
      ],
      services: [
        {
          name: "web",
          host: "alpha",
          managed: true,
          deepHealth: true,
          suppressed: null,
          drilldownId: "svc:alpha/web",
          kind: "http",
          provenance: { file: "estate.yaml", path: "services[0]", line: 5, col: 1 },
          gatusEndpoints: ["alpha/web"],
          artifacts: ["gatus/alpha_web.yaml"],
          deepHealthDetail: {
            endpoint: "https://api.example.com/health",
            metrics: ["cpu"],
            responseMapping: { cpu: "$.cpu", raw: "$.raw" },
            alertExpression: "cpu > 90",
            hostLocal: true,
            credential: null,
          },
          backupFreshness: null,
          alerts: [],
        },
      ],
      channels: [
        {
          name: "ops",
          kind: "slack",
          credential: { kind: "op", display: "op://vault/item/field" },
          options: { channelName: "ops" },
          provenance: { file: "estate.yaml", path: "channels[0]", line: 8, col: 1 },
        },
      ],
      routingOverrides: [],
      suppressions: [],
    },
    "web-findings.json": {
      formatVersion: 2,
      bundleId: OK_ID,
      findings: [
        {
          severity: "warning",
          code: "web_url_userinfo_removed",
          file: "estate.yaml",
          path: "services[0].ingressUrl",
          message: "URL user information was removed from the web projection.",
          fix: "Remove user information from this URL and use a credential reference instead.",
        },
      ],
    },
  };
}

const NO_CANARIES = { values: [] as const };

function assertLeak(result: WebProjectionResult<true>, expectedPath: string): Finding {
  expect(result.ok).toBe(false);
  expect(result.findings).toHaveLength(1);
  const f = result.findings[0]!;
  expect(f.code).toBe("web_artifact_leak_detected");
  expect(f.severity).toBe("error");
  expect(f.file).toBe("<rendered>");
  expect(f.path).toBe(expectedPath);
  return f;
}

describe("assertWebArtifactsSafe", () => {
  test("a coherent safe artifact set passes with no findings", () => {
    const result = assertWebArtifactsSafe(safeArtifacts() as never, NO_CANARIES);
    expect(result).toEqual({ ok: true, value: true, findings: [] });
  });

  test("rule 8: missing or extra artifact root is fatal", () => {
    const missing = safeArtifacts();
    delete missing["web-findings.json"];
    expect(assertWebArtifactsSafe(missing as never, NO_CANARIES).ok).toBe(false);

    const extra = safeArtifacts();
    extra["web-extra.json"] = { formatVersion: 2 };
    expect(assertWebArtifactsSafe(extra as never, NO_CANARIES).ok).toBe(false);
  });

  test("rule 1: a canary substring in any scalar (model, coverage, findings, nested) is fatal, no echo", () => {
    const canaries = { values: ["S3KRET"] };
    const locations: Array<[string, (a: Record<string, unknown>) => void, string]> = [
      [
        "estate.name",
        (a) => {
          (a["web-estate-model.json"] as any).estate.name = "home S3KRET";
        },
        "estate.name",
      ],
      [
        "finding.message",
        (a) => {
          (a["web-findings.json"] as any).findings[0].message = "leak S3KRET here";
        },
        "findings[0].message",
      ],
      [
        "coverage entry name",
        (a) => {
          (a["web-coverage.json"] as any).covered[0].name = "S3KRET";
        },
        "covered[0].name",
      ],
      [
        "nested option value",
        (a) => {
          (a["web-estate-model.json"] as any).channels[0].options.channelName = "S3KRET";
        },
        "channels[0].options.channelName",
      ],
    ];
    for (const [, mutate, path] of locations) {
      const artifacts = safeArtifacts();
      mutate(artifacts);
      const f = assertLeak(assertWebArtifactsSafe(artifacts as never, canaries), path);
      assertNoEcho([f], ["S3KRET"]);
    }
  });

  test("rule 1: longest-first canary overlap and arrival-order independence", () => {
    const a1 = safeArtifacts();
    (a1["web-estate-model.json"] as any).estate.name = "AABBBB";
    const forward = assertWebArtifactsSafe(a1 as never, finalizeCanaries(seed(["AA", "BBBB", "AABBBB"])));
    const a2 = safeArtifacts();
    (a2["web-estate-model.json"] as any).estate.name = "AABBBB";
    const reverse = assertWebArtifactsSafe(a2 as never, finalizeCanaries(seed(["AABBBB", "BBBB", "AA"])));
    expect(forward.ok).toBe(false);
    expect(reverse.ok).toBe(false);
    expect(forward.findings[0]!.path).toBe(reverse.findings[0]!.path);
  });

  test("rule 2: URL userinfo in a plain scalar is fatal", () => {
    const artifacts = safeArtifacts();
    (artifacts["web-estate-model.json"] as any).hosts[0].detail.apiEndpoint =
      "https://user:pass@api.example.com";
    assertLeak(assertWebArtifactsSafe(artifacts as never, NO_CANARIES), "hosts[0].detail.apiEndpoint");
  });

  test("rule 3: a sensitive tokenized key below options is fatal", () => {
    const artifacts = safeArtifacts();
    (artifacts["web-estate-model.json"] as any).channels[0].options = { apiToken: "x" };
    assertLeak(assertWebArtifactsSafe(artifacts as never, NO_CANARIES), "channels[0].options.apiToken");
  });

  test("rule 4: an invalid credential shape is fatal (bad display and extra key)", () => {
    const bad = safeArtifacts();
    (bad["web-estate-model.json"] as any).channels[0].credential = { kind: "env", display: "plain" };
    assertLeak(assertWebArtifactsSafe(bad as never, NO_CANARIES), "channels[0].credential");

    const extra = safeArtifacts();
    (extra["web-estate-model.json"] as any).channels[0].credential = {
      kind: "op",
      display: "op://vault/item/field",
      vault: "vault",
    };
    // The extra core-internal key `vault` is caught by rule 5 during descent; either way fatal.
    expect(assertWebArtifactsSafe(extra as never, NO_CANARIES).ok).toBe(false);
  });

  test("rule 5: a core-internal key outside labels/responseMapping is fatal; map data is allowed", () => {
    const artifacts = safeArtifacts();
    (artifacts["web-estate-model.json"] as any).estate.varName = "SECRET";
    const f = assertLeak(assertWebArtifactsSafe(artifacts as never, NO_CANARIES), "estate.varName");
    assertNoEcho([f], ["SECRET"]);

    // responseMapping already carries a `raw` key in the safe fixture; it must remain allowed.
    expect(assertWebArtifactsSafe(safeArtifacts() as never, NO_CANARIES).ok).toBe(true);
  });

  test("rule 6: a forbidden deadman descendant key is fatal", () => {
    const artifacts = safeArtifacts();
    (artifacts["web-estate-model.json"] as any).estate.deadman = {
      configured: true,
      kind: "plain",
      hook: "https://hooks.example.com/deadman",
    };
    assertLeak(assertWebArtifactsSafe(artifacts as never, NO_CANARIES), "estate.deadman.hook");
  });

  test.each([
    ["absolute posix", "/etc/passwd"],
    ["drive-qualified", "C:\\secrets"],
    ["unc", "//srv/share/x"],
    ["traversal", "../../etc"],
    ["empty", ""],
  ])("rule 7: unsafe provenance file (%s) is fatal", (_n, file) => {
    const artifacts = safeArtifacts();
    (artifacts["web-estate-model.json"] as any).hosts[0].provenance.file = file;
    assertLeak(assertWebArtifactsSafe(artifacts as never, NO_CANARIES), "hosts[0].provenance.file");
  });

  test("rule 7: an unsafe artifacts[] element and finding file are fatal", () => {
    const artifacts = safeArtifacts();
    (artifacts["web-estate-model.json"] as any).hosts[0].artifacts = ["../escape.json"];
    assertLeak(assertWebArtifactsSafe(artifacts as never, NO_CANARIES), "hosts[0].artifacts[0]");

    const findingsBad = safeArtifacts();
    (findingsBad["web-findings.json"] as any).findings[0].file = "/abs/finding.yaml";
    assertLeak(assertWebArtifactsSafe(findingsBad as never, NO_CANARIES), "findings[0].file");
  });

  test("non-contract values (NaN, bigint, undefined, class instance, cyclic) are fatal", () => {
    const nan = safeArtifacts();
    (nan["web-estate-model.json"] as any).estate.schemaMajor = Number.NaN;
    expect(assertWebArtifactsSafe(nan as never, NO_CANARIES).ok).toBe(false);

    const big = safeArtifacts();
    (big["web-estate-model.json"] as any).estate.schemaMajor = 1n;
    expect(assertWebArtifactsSafe(big as never, NO_CANARIES).ok).toBe(false);

    const cls = safeArtifacts();
    (cls["web-estate-model.json"] as any).estate.domains = new Set(["example.com"]);
    expect(assertWebArtifactsSafe(cls as never, NO_CANARIES).ok).toBe(false);

    const cyclic = safeArtifacts();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    (cyclic["web-estate-model.json"] as any).estate.loop = loop;
    // `loop` also carries an unexpected `self` object; cyclic detection triggers on the back-edge.
    expect(assertWebArtifactsSafe(cyclic as never, NO_CANARIES).ok).toBe(false);
  });

  test("deterministic first failure: coverage (sorted first) wins over a model violation", () => {
    const artifacts = safeArtifacts();
    (artifacts["web-coverage.json"] as any).covered[0].name = "LEAK";
    (artifacts["web-estate-model.json"] as any).estate.name = "LEAK";
    const f = assertLeak(assertWebArtifactsSafe(artifacts as never, { values: ["LEAK"] }), "covered[0].name");
    expect(f.message).toContain("web-coverage.json");
  });
});

/** Build a context seeded with the given canary strings. */
function seed(values: readonly string[]): ReturnType<typeof createWebSafetyContext> {
  const ctx = createWebSafetyContext();
  for (const v of values) ctx.canaries.add(v);
  return ctx;
}

// ───────────────────────────── no secret / env / network resolution ─────────────────────────────

describe("purity: no secret, environment, or network resolution", () => {
  test("projection helpers never read a fixture env var or the network", () => {
    const VAR = "PULSE_RMV2_FIXTURE_SECRET";
    let envTouched = false;
    Object.defineProperty(process.env, VAR, {
      configurable: true,
      get() {
        envTouched = true;
        throw new Error("resolver touched process.env");
      },
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network access attempted");
    }) as typeof fetch;

    try {
      const ref: SecretRef = { kind: "env", raw: `\${${VAR}}`, varName: VAR };
      expect(projectCredential(ref)).toEqual({ kind: "env", display: `\${${VAR}}` });

      const ctx = createWebSafetyContext();
      projectProvenance({ file: "estate.yaml", path: "x", line: 1, col: 1 });
      sanitizeUrl("https://u:p@example.com/x", SRC, ctx);
      sanitizeChannelOptions({ apiToken: "x", channel: "ops" }, SRC, ctx);
      assertWebArtifactsSafe(safeArtifacts() as never, finalizeCanaries(ctx));
    } finally {
      delete process.env[VAR];
      globalThis.fetch = origFetch;
    }

    expect(envTouched).toBe(false);
  });
});
