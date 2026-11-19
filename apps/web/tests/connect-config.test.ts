// apps/web/tests/connect-config.test.ts — `PULSE_WEB_EXTERNAL_URL` parsing.
//
// Unset/empty reads as unset; a usable address carries a prebuilt link; a soft refusal keeps the
// server bootable with one warning; an unparseable, credential-bearing or control-character value
// is a fatal ConfigError. Neither the error nor the warning ever contains the configured value.

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";

import { buildConnectLink } from "@pulse/web-data/contract";

import { loadServerConfig, parseExternalUrl, UNSET_EXTERNAL_URL } from "../src/server/config.js";
import type { ExternalUrlSoftRefusal } from "../src/shared/connect-link.js";
import { ConfigError } from "../src/shared/errors.js";

const VAR = "PULSE_WEB_EXTERNAL_URL";
const FATAL_TEXT = "must be an absolute https URL without credentials";

/** A full required env map (four engine URLs) plus optional overrides. */
function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PULSE_VM_URL: "http://victoriametrics:8428",
    PULSE_ALERTMANAGER_URL: "http://alertmanager:9093",
    PULSE_GATUS_URL: "http://gatus:8080",
    PULSE_VMALERT_URL: "http://vmalert:8880",
    ...over,
  };
}

let logSpy: Mock<(...args: unknown[]) => void>;
beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  logSpy.mockRestore();
});

/** Parsed JSON log lines emitted during the test. */
function logLines(): Array<Record<string, unknown>> {
  return logSpy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
}

/** Run `fn`, expect a ConfigError, and return it. */
function configErrorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error("expected a ConfigError, but nothing was thrown");
}

describe("unset", () => {
  for (const [name, value] of [
    ["absent", undefined],
    ["empty", ""],
    ["whitespace", "   "],
  ] as const) {
    test(`${name} reads as unset with no log line`, () => {
      const cfg = loadServerConfig(env({ [VAR]: value }));
      expect(cfg.externalUrl).toEqual({ state: "unset" });
      expect(cfg.externalUrl).toBe(UNSET_EXTERNAL_URL);
      expect(logLines()).toEqual([]);
    });
  }
});

describe("usable", () => {
  test("an https address is normalised and carries the prebuilt connect link", () => {
    const cfg = loadServerConfig(env({ [VAR]: "https://pulse.example.com/" }));
    const built = buildConnectLink("https://pulse.example.com");
    if (!built.ok) throw new Error("placeholder address must build");
    expect(cfg.externalUrl).toEqual({
      state: "usable",
      baseUrl: "https://pulse.example.com",
      link: built.link,
    });
    expect(logLines()).toEqual([]);
  });

  test("surrounding whitespace is trimmed and the result is deterministic", () => {
    const a = parseExternalUrl({ [VAR]: "  https://pulse.example.com  " });
    const b = parseExternalUrl({ [VAR]: "https://pulse.example.com" });
    expect(a).toEqual(b);
    expect(a.state).toBe("usable");
  });
});

describe("fatal values", () => {
  const cases: readonly (readonly [string, string, readonly string[]])[] = [
    ["credentials", "https://user:pw@pulse.example.com", ["pw", "user", "pulse.example.com"]],
    ["unparseable", "not a url", ["not a url"]],
    ["trailing newline", "https://pulse.example.com\n", ["pulse.example.com"]],
    ["leading tab", "\thttps://pulse.example.com", ["pulse.example.com"]],
  ];
  for (const [name, value, secrets] of cases) {
    test(`${name} throws a ConfigError that never echoes the value`, () => {
      const err = configErrorOf(() => loadServerConfig(env({ [VAR]: value })));
      expect(err.envVar).toBe(VAR);
      expect(err.message).toContain(FATAL_TEXT);
      expect(err.message).not.toContain(value);
      for (const secret of secrets) expect(err.message).not.toContain(secret);
      // Nothing about the value was logged on the way out either.
      for (const secret of secrets) expect(JSON.stringify(logLines())).not.toContain(secret);
    });
  }
});

describe("soft refusals", () => {
  const longValue = `https://pulse.example.com/${"a".repeat(600)}`;
  const cases: readonly (readonly [string, ExternalUrlSoftRefusal, string])[] = [
    ["http://pulse.example.com", "not-https", "pulse.example.com"],
    ["https://127.0.0.1", "loopback", "127.0.0.1"],
    ["https://[::1]", "loopback", "::1"],
    ["https://localhost", "loopback", "localhost"],
    [longValue, "too-long", "pulse.example.com"],
  ];
  for (const [value, reason, fragment] of cases) {
    test(`${value.slice(0, 40)} is refused as ${reason} with exactly one warning`, () => {
      const cfg = loadServerConfig(env({ [VAR]: value }));
      expect(cfg.externalUrl).toEqual({ state: "refused", refusal: reason });
      const lines = logLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: "config_warning", ok: false, envVar: VAR, reason });
      const serialized = JSON.stringify(lines);
      expect(serialized).not.toContain(value);
      expect(serialized).not.toContain(fragment);
    });
  }
});

describe("ConfigError order is unchanged", () => {
  test("a missing engine URL is reported before a fatal external URL", () => {
    const err = configErrorOf(() =>
      loadServerConfig(env({ PULSE_VM_URL: undefined, [VAR]: "https://user:pw@pulse.example.com" })),
    );
    expect(err.envVar).toBe("PULSE_VM_URL");
  });

  test("a write-path error is reported before a fatal external URL", () => {
    const err = configErrorOf(() =>
      loadServerConfig(
        env({
          PULSE_WEB_AUTH_MODE: "proxy-header",
          PULSE_WEB_TRUSTED_PROXIES: "192.0.2.0/24",
          PULSE_WEB_DATA_DIR: "relative/data",
          [VAR]: "https://user:pw@pulse.example.com",
        }),
      ),
    );
    expect(err.envVar).toBe("PULSE_WEB_DATA_DIR");
  });
});
