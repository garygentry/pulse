/** args.test.ts — argv → ParsedInvocation via node:util parseArgs (04 §3, REQ-CLI-01/02b).
 *
 *  Asserts parseInvocation parses each verb + its flags, short-circuits --version, and throws
 *  UsageError for an unknown verb, an unknown flag, no verb, --verbose+--quiet, and a bad
 *  --only kind (validated against RENDER_KINDS). No I/O. */

import { expect, test, describe } from "bun:test";

import { parseInvocation, UsageError } from "../src/args.js";

describe("parseInvocation — verbs", () => {
  test("validate parses to a command invocation with default global flags", () => {
    const inv = parseInvocation(["validate"]);
    expect(inv).toEqual({
      kind: "command",
      command: "validate",
      global: { json: false, strict: false, verbose: false, quiet: false },
    });
  });

  test("coverage parses to a command invocation", () => {
    const inv = parseInvocation(["coverage"]);
    expect(inv.kind).toBe("command");
    if (inv.kind === "command") expect(inv.command).toBe("coverage");
  });

  test("global flags parse in any position around the verb", () => {
    const inv = parseInvocation(["--json", "validate", "--strict", "--config", "cfg.yaml"]);
    expect(inv).toEqual({
      kind: "command",
      command: "validate",
      global: { json: true, strict: true, verbose: false, quiet: false, configPath: "cfg.yaml" },
    });
  });

  test("render parses its own flags: --check, --only, --output-root", () => {
    const inv = parseInvocation([
      "render",
      "--check",
      "--only",
      "scrape,gatus",
      "--output-root",
      "out",
    ]);
    expect(inv).toEqual({
      kind: "command",
      command: "render",
      global: { json: false, strict: false, verbose: false, quiet: false },
      render: { check: true, only: ["scrape", "gatus"], outputRoot: "out" },
    });
  });

  test("render without --only omits the only key (exactOptionalPropertyTypes)", () => {
    const inv = parseInvocation(["render"]);
    expect(inv.kind === "command" && inv.command === "render" && inv.render).toEqual({
      check: false,
    });
  });

  test("--only trims whitespace and drops empties", () => {
    const inv = parseInvocation(["render", "--only", " scrape , web "]);
    if (inv.kind === "command" && inv.command === "render") {
      expect(inv.render.only).toEqual(["scrape", "web"]);
    } else {
      throw new Error("expected render");
    }
  });

  test("init parses --force", () => {
    const inv = parseInvocation(["init", "--force"]);
    expect(inv).toEqual({
      kind: "command",
      command: "init",
      global: { json: false, strict: false, verbose: false, quiet: false },
      init: { force: true },
    });
  });

  test("init without --force defaults force false", () => {
    const inv = parseInvocation(["init"]);
    expect(inv.kind === "command" && inv.command === "init" && inv.init.force).toBe(false);
  });
});

describe("parseInvocation — --version short-circuit", () => {
  test("--version with no verb", () => {
    expect(parseInvocation(["--version"])).toEqual({ kind: "version" });
  });

  test("--version with a verb still short-circuits", () => {
    expect(parseInvocation(["render", "--version"])).toEqual({ kind: "version" });
    expect(parseInvocation(["--version", "validate"])).toEqual({ kind: "version" });
  });
});

describe("parseInvocation — usage errors (exit 2)", () => {
  test("unknown verb throws UsageError", () => {
    expect(() => parseInvocation(["frobnicate"])).toThrow(UsageError);
  });

  test("no verb (and no --version) throws UsageError", () => {
    expect(() => parseInvocation([])).toThrow(UsageError);
    expect(() => parseInvocation(["--json"])).toThrow(UsageError);
  });

  test("unknown flag throws UsageError", () => {
    expect(() => parseInvocation(["validate", "--bogus"])).toThrow(UsageError);
  });

  test("--verbose together with --quiet throws UsageError", () => {
    expect(() => parseInvocation(["validate", "--verbose", "--quiet"])).toThrow(UsageError);
  });

  test("a bad --only kind throws UsageError", () => {
    expect(() => parseInvocation(["render", "--only", "scrape,nope"])).toThrow(UsageError);
  });

  test("an empty --only value throws UsageError", () => {
    expect(() => parseInvocation(["render", "--only", " , "])).toThrow(UsageError);
  });

  test("a render-only flag on a non-render verb throws UsageError", () => {
    expect(() => parseInvocation(["validate", "--check"])).toThrow(UsageError);
  });

  test("UsageError carries its name and is an Error", () => {
    try {
      parseInvocation(["frobnicate"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).name).toBe("UsageError");
    }
  });
});
