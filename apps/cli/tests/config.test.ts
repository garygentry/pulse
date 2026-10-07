/** config.test.ts — flag > env (PULSE_*) > pulse.config.yaml > default resolution (04 §7,
 *  tech spec §3.4). All sources (fs via a temp dir, env, cwd) are injected so tests never
 *  touch the real process environment. The only thrown type is ConfigIoError. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { ConfigIoError } from "@pulse/core";

import { resolveConfig } from "../src/config.js";
import type { ConfigInputs } from "../src/config.js";
import type { GlobalFlags } from "../src/args.js";

/** Default (all-off) global flags; overrides layer on top. */
function makeFlags(overrides: Partial<GlobalFlags> = {}): GlobalFlags {
  return { json: false, strict: false, verbose: false, quiet: false, ...overrides };
}

/** Build ConfigInputs with sane empty defaults; caller supplies cwd + any overrides. */
function makeInputs(cwd: string, overrides: Partial<ConfigInputs> = {}): ConfigInputs {
  return {
    flags: overrides.flags ?? makeFlags(),
    env: overrides.env ?? {},
    cwd,
    ...(overrides.outputRootFlag !== undefined
      ? { outputRootFlag: overrides.outputRootFlag }
      : {}),
  };
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-config-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a pulse.config.yaml into `dir` and return its path. */
function writeConfig(contents: string, name = "pulse.config.yaml"): string {
  const p = join(dir, name);
  writeFileSync(p, contents, "utf8");
  return p;
}

describe("resolveConfig — defaults", () => {
  test("a missing DEFAULT pulse.config.yaml yields defaults with no error", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "pulse-empty-"));
    try {
      const cfg = resolveConfig(makeInputs(emptyDir));
      expect(cfg).toEqual({
        estateDir: resolve(emptyDir, "estate"),
        outputRoot: resolve(emptyDir, "rendered"),
        strict: false,
      });
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("resolveConfig — precedence per field (flag > env > file > default)", () => {
  test("estateDir: env > file > default (no flag in v1)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pulse-estate-"));
    try {
      // default
      expect(resolveConfig(makeInputs(cwd)).estateDir).toBe(resolve(cwd, "estate"));
      // file beats default
      writeFileSync(join(cwd, "pulse.config.yaml"), "estateDir: from-file\n");
      expect(resolveConfig(makeInputs(cwd)).estateDir).toBe(resolve(cwd, "from-file"));
      // env beats file
      expect(
        resolveConfig(makeInputs(cwd, { env: { PULSE_ESTATE_DIR: "from-env" } })).estateDir,
      ).toBe(resolve(cwd, "from-env"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("outputRoot: flag > env > file > default", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pulse-output-"));
    try {
      // default
      expect(resolveConfig(makeInputs(cwd)).outputRoot).toBe(resolve(cwd, "rendered"));
      // file beats default
      writeFileSync(join(cwd, "pulse.config.yaml"), "outputRoot: from-file\n");
      expect(resolveConfig(makeInputs(cwd)).outputRoot).toBe(resolve(cwd, "from-file"));
      // env beats file
      expect(
        resolveConfig(makeInputs(cwd, { env: { PULSE_OUTPUT_ROOT: "from-env" } })).outputRoot,
      ).toBe(resolve(cwd, "from-env"));
      // flag beats env
      expect(
        resolveConfig(
          makeInputs(cwd, {
            env: { PULSE_OUTPUT_ROOT: "from-env" },
            outputRootFlag: "from-flag",
          }),
        ).outputRoot,
      ).toBe(resolve(cwd, "from-flag"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("strict: flag > env > file > default", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pulse-strict-"));
    try {
      // default false
      expect(resolveConfig(makeInputs(cwd)).strict).toBe(false);
      // file true beats default
      writeFileSync(join(cwd, "pulse.config.yaml"), "strict: true\n");
      expect(resolveConfig(makeInputs(cwd)).strict).toBe(true);
      // file false, env "1" turns it on
      writeFileSync(join(cwd, "pulse.config.yaml"), "strict: false\n");
      expect(resolveConfig(makeInputs(cwd, { env: { PULSE_STRICT: "1" } })).strict).toBe(true);
      // env "true" (case-insensitive) turns it on
      expect(resolveConfig(makeInputs(cwd, { env: { PULSE_STRICT: "TRUE" } })).strict).toBe(true);
      // env other value does not
      expect(resolveConfig(makeInputs(cwd, { env: { PULSE_STRICT: "no" } })).strict).toBe(false);
      // flag turns it on even when everything else is off/false
      expect(resolveConfig(makeInputs(cwd, { flags: makeFlags({ strict: true }) })).strict).toBe(
        true,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("resolveConfig — explicit --config", () => {
  test("an explicit --config that is missing throws ConfigIoError", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pulse-missing-"));
    try {
      const inputs = makeInputs(cwd, {
        flags: makeFlags({ configPath: join(cwd, "nope.yaml") }),
      });
      expect(() => resolveConfig(inputs)).toThrow(ConfigIoError);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("an explicit --config that is a directory (non-file) throws ConfigIoError UNREADABLE", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pulse-dir-"));
    try {
      const inputs = makeInputs(cwd, { flags: makeFlags({ configPath: cwd }) });
      try {
        resolveConfig(inputs);
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigIoError);
        expect((err as ConfigIoError).code).toBe("UNREADABLE");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a valid explicit --config is honored", () => {
    const p = writeConfig("estateDir: e\noutputRoot: o\nstrict: true\n", "custom.yaml");
    const cfg = resolveConfig(makeInputs(dir, { flags: makeFlags({ configPath: p }) }));
    expect(cfg).toEqual({
      estateDir: resolve(dir, "e"),
      outputRoot: resolve(dir, "o"),
      strict: true,
    });
  });
});

describe("resolveConfig — malformed content throws ConfigIoError INVALID_ARG", () => {
  test("non-mapping root (a scalar) throws INVALID_ARG", () => {
    const p = writeConfig("just a string\n", "scalar.yaml");
    try {
      resolveConfig(makeInputs(dir, { flags: makeFlags({ configPath: p }) }));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIoError);
      expect((err as ConfigIoError).code).toBe("INVALID_ARG");
    }
  });

  test("a sequence root throws INVALID_ARG", () => {
    const p = writeConfig("- a\n- b\n", "seq.yaml");
    try {
      resolveConfig(makeInputs(dir, { flags: makeFlags({ configPath: p }) }));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIoError);
      expect((err as ConfigIoError).code).toBe("INVALID_ARG");
    }
  });

  test("malformed YAML throws INVALID_ARG", () => {
    const p = writeConfig("estateDir: [unterminated\n", "bad.yaml");
    try {
      resolveConfig(makeInputs(dir, { flags: makeFlags({ configPath: p }) }));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIoError);
      expect((err as ConfigIoError).code).toBe("INVALID_ARG");
    }
  });

  test("a mis-typed field (strict: not-a-bool) throws INVALID_ARG", () => {
    const p = writeConfig("strict: yes-please\n", "mistyped-bool.yaml");
    try {
      resolveConfig(makeInputs(dir, { flags: makeFlags({ configPath: p }) }));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIoError);
      expect((err as ConfigIoError).code).toBe("INVALID_ARG");
    }
  });

  test("a mis-typed field (estateDir: a number) throws INVALID_ARG", () => {
    const p = writeConfig("estateDir: 42\n", "mistyped-str.yaml");
    try {
      resolveConfig(makeInputs(dir, { flags: makeFlags({ configPath: p }) }));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIoError);
      expect((err as ConfigIoError).code).toBe("INVALID_ARG");
    }
  });

  test("an empty config file yields defaults (no error)", () => {
    const p = writeConfig("", "empty.yaml");
    const cfg = resolveConfig(makeInputs(dir, { flags: makeFlags({ configPath: p }) }));
    expect(cfg.strict).toBe(false);
    expect(cfg.estateDir).toBe(resolve(dir, "estate"));
    expect(cfg.outputRoot).toBe(resolve(dir, "rendered"));
  });
});

describe("resolveConfig — path resolution", () => {
  test("relative estateDir/outputRoot resolve against cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pulse-rel-"));
    try {
      const cfg = resolveConfig(
        makeInputs(cwd, {
          env: { PULSE_ESTATE_DIR: "rel/estate", PULSE_OUTPUT_ROOT: "rel/out" },
        }),
      );
      expect(cfg.estateDir).toBe(resolve(cwd, "rel/estate"));
      expect(cfg.outputRoot).toBe(resolve(cwd, "rel/out"));
      expect(isAbsolute(cfg.estateDir)).toBe(true);
      expect(isAbsolute(cfg.outputRoot)).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("absolute estateDir/outputRoot are kept as-is", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pulse-abs-"));
    const absEstate = join(tmpdir(), "abs-estate");
    const absOut = join(tmpdir(), "abs-out");
    try {
      const cfg = resolveConfig(
        makeInputs(cwd, {
          env: { PULSE_ESTATE_DIR: absEstate, PULSE_OUTPUT_ROOT: absOut },
        }),
      );
      expect(cfg.estateDir).toBe(absEstate);
      expect(cfg.outputRoot).toBe(absOut);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
