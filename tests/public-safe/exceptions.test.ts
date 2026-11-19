/**
 * Exceptions file and local deny list: schema validation, loaders, path globs through the public module, and
 * suppression / stale detection driven by parsed entries. Firing values are built from fragments (helpers.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PublicSafeConfigError } from "../../scripts/public-safe/errors.js";
import {
  DENY_FILE,
  EXCEPTIONS_FILE,
  globToRegExp,
  loadDenyTerms,
  loadExceptions,
  MIN_DENY_TERM_LENGTH,
  parseDenyTerms,
  parseExceptions,
  pathMatches,
} from "../../scripts/public-safe/exceptions.js";
import { scan } from "../../scripts/public-safe/rules.js";
import { dot } from "./helpers.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const NAS = dot("nas", "lan");

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  value: "some-value",
  path: "contract/CONTRACT.md",
  reason: "not deployment data",
  ...over,
});
const file = (...exceptions: unknown[]): string => JSON.stringify({ formatVersion: 1, exceptions });

function invalid(text: string): PublicSafeConfigError {
  try {
    parseExceptions(text);
  } catch (error) {
    expect(error).toBeInstanceOf(PublicSafeConfigError);
    const config = error as PublicSafeConfigError;
    expect(config.code).toBe("EXCEPTIONS_INVALID");
    expect(config.file).toBe(EXCEPTIONS_FILE);
    return config;
  }
  throw new Error("parseExceptions accepted invalid input");
}

describe("parseExceptions", () => {
  test("accepts the empty file and a well-formed entry", () => {
    expect(parseExceptions('{"formatVersion":1,"exceptions":[]}')).toEqual({ formatVersion: 1, exceptions: [] });
    expect(parseExceptions(file(entry(), entry({ path: "contract/**/*.json" }))).exceptions).toEqual([
      { value: "some-value", path: "contract/CONTRACT.md", reason: "not deployment data" },
      { value: "some-value", path: "contract/**/*.json", reason: "not deployment data" },
    ]);
  });

  test("the committed exceptions file is valid and empty", async () => {
    expect(await loadExceptions(REPO_ROOT)).toEqual({ formatVersion: 1, exceptions: [] });
  });

  const cases: ReadonlyArray<readonly [name: string, text: string, message: RegExp]> = [
    ["bad JSON", "{ nope", /^invalid JSON: /],
    ["root array", "[]", /^root: /],
    ["root null", "null", /^root: /],
    ["extra root key", JSON.stringify({ formatVersion: 1, exceptions: [], extra: 1 }), /^root: /],
    ["missing root key", JSON.stringify({ formatVersion: 1 }), /^root: /],
    ["formatVersion 2", JSON.stringify({ formatVersion: 2, exceptions: [] }), /^formatVersion: must be 1$/],
    ["formatVersion string", JSON.stringify({ formatVersion: "1", exceptions: [] }), /^formatVersion: must be 1$/],
    ["non-array exceptions", JSON.stringify({ formatVersion: 1, exceptions: {} }), /^exceptions: must be an array$/],
    ["entry not an object", file("x"), /^exceptions\[0\]: /],
    ["entry extra key", file(entry({ note: "x" })), /^exceptions\[0\]: /],
    ["entry missing key", file({ value: "v", path: "contract/a" }), /^exceptions\[0\]: /],
    ["non-string value", file(entry({ value: 7 })), /^exceptions\[0\]\.value: /],
    ["non-string reason", file(entry({ reason: null })), /^exceptions\[0\]\.reason: /],
    ["empty value", file(entry({ value: "" })), /^exceptions\[0\]\.value: /],
    ["line break in value", file(entry({ value: "a\nb" })), /^exceptions\[0\]\.value: /],
    ["value too long", file(entry({ value: "v".repeat(513) })), /^exceptions\[0\]\.value: /],
    ["path with a space", file(entry({ path: "contract/a b" })), /^exceptions\[0\]\.path: /],
    ["leading /", file(entry({ path: "/contract/a" })), /^exceptions\[0\]\.path: /],
    ["leading ./", file(entry({ path: "./contract/a" })), /^exceptions\[0\]\.path: /],
    ["double slash", file(entry({ path: "contract//a" })), /^exceptions\[0\]\.path: /],
    [".. segment", file(entry({ path: "contract/../a" })), /^exceptions\[0\]\.path: /],
    ["empty path", file(entry({ path: "" })), /^exceptions\[0\]\.path: /],
    ["empty reason", file(entry({ reason: "   " })), /^exceptions\[0\]\.reason: /],
    ["second entry located", file(entry(), entry({ value: "other", reason: "" })), /^exceptions\[1\]\.reason: /],
    ["duplicate pair", file(entry(), entry({ value: "b" }), entry({ reason: "again" })), /^exceptions\[2\]: duplicate of exceptions\[0\]$/],
  ];
  for (const [name, text, message] of cases) {
    test(`rejects: ${name}`, () => {
      expect(invalid(text).message).toMatch(message);
    });
  }

  test("a 512-character value is accepted and the same value under two paths is not a duplicate", () => {
    expect(parseExceptions(file(entry({ value: "v".repeat(512) }))).exceptions).toHaveLength(1);
    expect(parseExceptions(file(entry(), entry({ path: "contract/**" }))).exceptions).toHaveLength(2);
  });

  test("error messages name the location and never echo a value", () => {
    const secret = "zz-secret-zz";
    for (const text of [
      file(entry({ value: `${secret}\n` })),
      file(entry({ value: secret, path: `/${secret}` })),
      file(entry({ value: secret, reason: "" })),
      file(entry({ value: secret }), entry({ value: secret })),
      `{"formatVersion":1,"exceptions":[{"value":"${secret}" oops`,
    ]) {
      expect(invalid(text).message).not.toContain(secret);
    }
  });
});

describe("loadExceptions / loadDenyTerms", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "public-safe-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a missing exceptions file is EXCEPTIONS_UNREADABLE with a relative file and no root path", async () => {
    const error = await loadExceptions(join(root, "nowhere")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublicSafeConfigError);
    const config = error as PublicSafeConfigError;
    expect(config.code).toBe("EXCEPTIONS_UNREADABLE");
    expect(config.file).toBe(EXCEPTIONS_FILE);
    expect(config.message).toBe("cannot read (ENOENT)");
  });

  test("an unreadable exceptions path (a directory) is EXCEPTIONS_UNREADABLE", async () => {
    const dir = join(root, "as-dir");
    await mkdir(join(dir, EXCEPTIONS_FILE), { recursive: true });
    const error = await loadExceptions(dir).catch((e: unknown) => e);
    expect((error as PublicSafeConfigError).code).toBe("EXCEPTIONS_UNREADABLE");
    expect((error as PublicSafeConfigError).message).not.toContain(root);
  });

  test("an invalid exceptions file is EXCEPTIONS_INVALID", async () => {
    const dir = join(root, "invalid");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, EXCEPTIONS_FILE), '{"formatVersion":2,"exceptions":[]}');
    const error = await loadExceptions(dir).catch((e: unknown) => e);
    expect((error as PublicSafeConfigError).code).toBe("EXCEPTIONS_INVALID");
  });

  test("an absent deny list is empty; a present one is parsed; another read error propagates", async () => {
    const dir = join(root, "deny");
    await mkdir(dir, { recursive: true });
    expect(await loadDenyTerms(dir)).toEqual({ terms: [], ignoredShort: 0 });
    await writeFile(join(dir, DENY_FILE), "# mine\nAcme\nab\n");
    expect(await loadDenyTerms(dir)).toEqual({ terms: ["acme"], ignoredShort: 1 });

    const asDir = join(root, "deny-dir");
    await mkdir(join(asDir, DENY_FILE), { recursive: true });
    const error = await loadDenyTerms(asDir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PublicSafeConfigError);
  });
});

describe("parseDenyTerms", () => {
  test("comments, blanks, case, de-duplication, CRLF and short terms", () => {
    expect(MIN_DENY_TERM_LENGTH).toBe(3);
    const text = ["# comment", "", "  Acme  ", "acme", "   # indented comment", "ab", "x", "term#1", "Other"].join("\r\n");
    expect(parseDenyTerms(text)).toEqual({ terms: ["acme", "term#1", "other"], ignoredShort: 2 });
    expect(parseDenyTerms("")).toEqual({ terms: [], ignoredShort: 0 });
  });
});

describe("globs through the exceptions module", () => {
  test("whole-path semantics", () => {
    expect(pathMatches("contract/**", "contract/fixtures/a.json")).toBe(true);
    expect(pathMatches("**/typical.json", "contract/fixtures/overview/typical.json")).toBe(true);
    expect(pathMatches("**/typical.json", "typical.json")).toBe(true);
    expect(pathMatches("contract/*.md", "contract/CONTRACT.md")).toBe(true);
    expect(pathMatches("contract/*.md", "contract/fixtures/x.md")).toBe(false);
    expect(pathMatches("a/?.md", "a/b.md")).toBe(true);
    expect(pathMatches("a/?.md", "a/bc.md")).toBe(false);
    expect(pathMatches("a/b.json", "a/bxjson")).toBe(false);
    expect(globToRegExp("a/**/b").test("a/b")).toBe(true);
    expect(globToRegExp("a/**/b").test("a/x/y/b")).toBe(true);
    expect(globToRegExp("a/**/b").test("a/x/c")).toBe(false);
  });
});

describe("parsed exceptions drive suppression and stale detection", () => {
  const files = [{ path: "contract/fixtures/x/a.json", text: `{"h":"${NAS}"}` }];
  const run = (...entries: unknown[]) =>
    scan({ files, exceptions: parseExceptions(file(...entries)).exceptions, denyTerms: [], contractFileCount: 1 });

  test("exact value and matching path suppress", () => {
    expect(run(entry({ value: NAS, path: "contract/fixtures/x/a.json" })).violations).toEqual([]);
    expect(run(entry({ value: NAS, path: "contract/**" })).violations).toEqual([]);
  });

  test("another case, another path, or `*` across a slash do not suppress and are stale", () => {
    for (const miss of [
      entry({ value: NAS.toUpperCase(), path: "contract/**" }),
      entry({ value: NAS, path: "contract/other.json" }),
      entry({ value: NAS, path: "contract/*" }),
    ]) {
      expect(run(miss).violations.map((v) => v.rule)).toEqual(["hostname", "stale-exception"]);
    }
  });

  test("a stale entry is reported by entry number; overlapping entries are both credited", () => {
    const result = run(
      entry({ value: NAS, path: "contract/fixtures/x/a.json" }),
      entry({ value: "gone-value", path: "contract/**" }),
      entry({ value: NAS, path: "contract/**" }),
    );
    expect(result.violations.map((v) => [v.rule, v.path, v.line, v.masked])).toEqual([
      ["stale-exception", EXCEPTIONS_FILE, 2, "go…"],
    ]);
  });
});
