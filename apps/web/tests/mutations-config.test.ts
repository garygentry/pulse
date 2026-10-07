// mutations-config.test.ts — write-path env parsing and the proposal-secret closure (04 §2).
//
// Covers the 04 §2.1 parse table in proxy-header mode (REQ-CFG-01), the inert none-mode behaviour
// (REQ-CFG-03) and the secret status / closure accessor (REQ-SEC-04).

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";

import { PROPOSAL_SECRET_MIN_BYTES } from "@pulse/core/proposals";

import {
  loadProposalSecret,
  loadServerConfig,
  NONE_WRITE_PATH_CONFIG,
  parseWritePath,
  secretStatusOf,
} from "../src/server/config.js";
import { WRITE_PATH_ENV } from "../src/server/mutations/constants.js";
import { ConfigError } from "../src/shared/errors.js";

const BASE_ENV: Record<string, string> = {
  PULSE_VM_URL: "http://vm:8428",
  PULSE_ALERTMANAGER_URL: "http://am:9093",
  PULSE_GATUS_URL: "http://gatus:8080",
  PULSE_VMALERT_URL: "http://vmalert:8880",
};

function proxyEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ...BASE_ENV,
    PULSE_WEB_AUTH_MODE: "proxy-header",
    PULSE_WEB_TRUSTED_PROXIES: "10.0.0.0/24",
    ...over,
  };
}

const SECRET_32 = "s".repeat(32);

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
  throw new Error("expected a ConfigError");
}

describe("write-path parse table, proxy-header mode (REQ-CFG-01, 04 §2.1)", () => {
  test("REQ-CFG-01: $DATA alone derives every store default", () => {
    const wp = parseWritePath({ PULSE_WEB_DATA_DIR: "/data" }, "proxy-header");
    expect(wp).toEqual({
      dataDir: "/data",
      auditPath: "/data/audit/audit.jsonl",
      ackStorePath: "/data/acks.json",
      proposalsDir: "/data/proposals",
      secret: { present: false, reason: "secret-missing" },
    });
    expect(Object.isFrozen(wp)).toBe(true);
  });

  test("REQ-CFG-01: an explicit path wins over the $DATA default", () => {
    const wp = parseWritePath(
      {
        PULSE_WEB_DATA_DIR: "/data",
        PULSE_WEB_AUDIT_PATH: "/var/log/pulse/audit.jsonl",
        PULSE_WEB_ACK_STORE_PATH: "/state/acks.json",
        PULSE_WEB_PROPOSALS_DIR: "/srv/proposals",
      },
      "proxy-header",
    );
    expect(wp.auditPath).toBe("/var/log/pulse/audit.jsonl");
    expect(wp.ackStorePath).toBe("/state/acks.json");
    expect(wp.proposalsDir).toBe("/srv/proposals");
    expect(wp.dataDir).toBe("/data");
  });

  test("REQ-CFG-01: explicit paths work without $DATA; unset stores are null", () => {
    const wp = parseWritePath({ PULSE_WEB_AUDIT_PATH: "/a/audit.jsonl" }, "proxy-header");
    expect(wp.dataDir).toBeNull();
    expect(wp.auditPath).toBe("/a/audit.jsonl");
    expect(wp.ackStorePath).toBeNull();
    expect(wp.proposalsDir).toBeNull();
  });

  test("REQ-CFG-01: nothing set → every path null; empty and whitespace count as unset", () => {
    expect(parseWritePath({}, "proxy-header")).toEqual({
      dataDir: null,
      auditPath: null,
      ackStorePath: null,
      proposalsDir: null,
      secret: { present: false, reason: "secret-missing" },
    });
    const wp = parseWritePath({ PULSE_WEB_DATA_DIR: "", PULSE_WEB_AUDIT_PATH: "   " }, "proxy-header");
    expect(wp.dataDir).toBeNull();
    expect(wp.auditPath).toBeNull();
  });

  test("REQ-CFG-01: paths are trimmed and normalized", () => {
    const wp = parseWritePath({ PULSE_WEB_DATA_DIR: "  /data//x/../y/ " }, "proxy-header");
    expect(wp.dataDir).toBe("/data/y/");
    expect(wp.ackStorePath).toBe("/data/y/acks.json");
  });

  for (const name of Object.values(WRITE_PATH_ENV).filter((n) => n !== WRITE_PATH_ENV.secret)) {
    test(`REQ-CFG-01: relative ${name} → ConfigError naming the var, not echoing the value`, () => {
      const value = "relative/secretish-dir";
      const err = configErrorOf(() => parseWritePath({ [name]: value }, "proxy-header"));
      expect(err.code).toBe("CONFIG_MISSING_ENV");
      expect(err.message).toContain(name);
      expect(err.message).toContain("must be an absolute path");
      expect(err.message).not.toContain(value);
    });

    test(`REQ-CFG-01: raw control char in ${name} ("\\n/data") → ConfigError without the value`, () => {
      for (const value of ["\n/data", "/da\u0000ta", "/data\u007f", "/data\u0085x"]) {
        const err = configErrorOf(() => parseWritePath({ [name]: value }, "proxy-header"));
        expect(err.message).toContain(name);
        expect(err.message).toContain("must not contain control characters");
        expect(err.message).not.toContain(value);
        expect(err.message).not.toContain("/data");
      }
    });
  }

  test("REQ-CFG-01: the secret is reduced to a status in the parsed config", () => {
    const wp = parseWritePath({ PULSE_PROPOSAL_SECRET: SECRET_32 }, "proxy-header");
    expect(wp.secret).toEqual({ present: true });
    expect(JSON.stringify(wp)).not.toContain(SECRET_32);
  });

  test("REQ-CFG-01: loadServerConfig carries writePath and raises pre-existing errors first", () => {
    const cfg = loadServerConfig(proxyEnv({ PULSE_WEB_DATA_DIR: "/data" }));
    expect(cfg.writePath.auditPath).toBe("/data/audit/audit.jsonl");
    expect(cfg.vmUrl).toBe("http://vm:8428");

    // Engine URL missing AND a bad write-path var: the engine-URL error wins (base literal first).
    const env = proxyEnv({ PULSE_VM_URL: undefined, PULSE_WEB_DATA_DIR: "relative" });
    const err = configErrorOf(() => loadServerConfig(env));
    expect(err.message).toContain("PULSE_VM_URL");

    const err2 = configErrorOf(() => loadServerConfig(proxyEnv({ PULSE_WEB_DATA_DIR: "relative" })));
    expect(err2.message).toContain("PULSE_WEB_DATA_DIR");
  });
});

describe("write-path configuration is inert in auth mode none (REQ-CFG-03)", () => {
  test("REQ-CFG-03: malformed paths do not throw; one warning names set vars, never values", () => {
    const env = {
      PULSE_WEB_DATA_DIR: "relative/bad",
      PULSE_WEB_AUDIT_PATH: "\n/data",
      PULSE_PROPOSAL_SECRET: SECRET_32,
      PULSE_WEB_ACK_STORE_PATH: "",
    };
    const wp = parseWritePath(env, "none");
    expect(wp).toBe(NONE_WRITE_PATH_CONFIG);

    const lines = logLines();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line["event"]).toBe("config_warning");
    const text = String(line["error"]);
    expect(text).toContain("PULSE_WEB_DATA_DIR");
    expect(text).toContain("PULSE_WEB_AUDIT_PATH");
    expect(text).toContain("PULSE_PROPOSAL_SECRET");
    expect(text).not.toContain("PULSE_WEB_ACK_STORE_PATH");
    expect(text).not.toContain("PULSE_WEB_PROPOSALS_DIR");
    const raw = JSON.stringify(logSpy.mock.calls);
    expect(raw).not.toContain("relative/bad");
    expect(raw).not.toContain(SECRET_32);
  });

  test("REQ-CFG-03: no warning when nothing is set", () => {
    expect(parseWritePath({}, "none")).toBe(NONE_WRITE_PATH_CONFIG);
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("REQ-CFG-03: loadServerConfig in default (none) mode yields NONE_WRITE_PATH_CONFIG", () => {
    const cfg = loadServerConfig({ ...BASE_ENV, PULSE_WEB_DATA_DIR: "not-absolute" });
    expect(cfg.identity.mode).toBe("none");
    expect(cfg.writePath).toBe(NONE_WRITE_PATH_CONFIG);
    expect(logLines().filter((l) => l["event"] === "config_warning")).toHaveLength(1);
  });

  test("REQ-CFG-03: NONE_WRITE_PATH_CONFIG is frozen, all paths null, secret missing", () => {
    expect(Object.isFrozen(NONE_WRITE_PATH_CONFIG)).toBe(true);
    expect(Object.isFrozen(NONE_WRITE_PATH_CONFIG.secret)).toBe(true);
    expect(NONE_WRITE_PATH_CONFIG).toEqual({
      dataDir: null,
      auditPath: null,
      ackStorePath: null,
      proposalsDir: null,
      secret: { present: false, reason: "secret-missing" },
    });
  });
});

describe("proposal secret status and closure (REQ-SEC-04)", () => {
  test("REQ-SEC-04: the bound is the core constant (32)", () => {
    expect(PROPOSAL_SECRET_MIN_BYTES).toBe(32);
  });

  test("REQ-SEC-04: secretStatusOf — missing, 31 vs 32 UTF-8 bytes, not trimmed", () => {
    expect(secretStatusOf(undefined)).toEqual({ present: false, reason: "secret-missing" });
    expect(secretStatusOf("")).toEqual({ present: false, reason: "secret-missing" });
    expect(secretStatusOf("x".repeat(31))).toEqual({ present: false, reason: "secret-too-short" });
    expect(secretStatusOf("x".repeat(32))).toEqual({ present: true });
    // Whitespace counts: 31 chars + a trailing space is 32 bytes.
    expect(secretStatusOf(`${"x".repeat(31)} `)).toEqual({ present: true });
  });

  test("REQ-SEC-04: multibyte input is counted in bytes, not characters", () => {
    // "é" is 2 UTF-8 bytes: 16 × é = 32 bytes (16 chars) → present; 15 × é + "x" = 31 bytes → too short.
    expect(secretStatusOf("é".repeat(16))).toEqual({ present: true });
    expect(secretStatusOf(`${"é".repeat(15)}x`)).toEqual({ present: false, reason: "secret-too-short" });
    // 8 × 4-byte emoji = 32 bytes.
    expect(secretStatusOf("😀".repeat(8))).toEqual({ present: true });
  });

  test("REQ-SEC-04: loadProposalSecret status equals secretStatusOf and bytes() is UTF-8", () => {
    for (const raw of [undefined, "", "x".repeat(31), SECRET_32, "é".repeat(16)]) {
      const env = raw === undefined ? {} : { PULSE_PROPOSAL_SECRET: raw };
      const provider = loadProposalSecret(env);
      expect(provider.status).toEqual(secretStatusOf(raw));
      if (provider.status.present) {
        expect(provider.bytes()).toEqual(new TextEncoder().encode(raw));
      } else {
        expect(provider.bytes()).toBeNull();
      }
    }
  });

  test("REQ-SEC-04: status matches config.writePath.secret", () => {
    const env = proxyEnv({ PULSE_PROPOSAL_SECRET: "é".repeat(16) });
    expect(loadProposalSecret(env).status).toEqual(loadServerConfig(env).writePath.secret);
  });

  test("REQ-SEC-04: JSON.stringify(provider) contains no secret text; exactly two own props, frozen", () => {
    const secret = "canary-secret-value-0123456789-abcdef";
    const provider = loadProposalSecret({ PULSE_PROPOSAL_SECRET: secret });
    const json = JSON.stringify(provider);
    expect(json).toBe('{"status":{"present":true}}');
    expect(json).not.toContain(secret);
    expect(Object.keys(provider).sort()).toEqual(["bytes", "status"]);
    expect(Object.isFrozen(provider)).toBe(true);
    expect(Object.isFrozen(provider.status)).toBe(true);
  });

  test("REQ-SEC-04: bytes() returns a copy — mutating it does not change a second call", () => {
    const provider = loadProposalSecret({ PULSE_PROPOSAL_SECRET: SECRET_32 });
    const first = provider.bytes()!;
    first.fill(0);
    const second = provider.bytes()!;
    expect(second).not.toBe(first);
    expect(new TextDecoder().decode(second)).toBe(SECRET_32);
  });

  test("REQ-SEC-04: loadProposalSecret never logs and never throws", () => {
    expect(() => loadProposalSecret({ PULSE_PROPOSAL_SECRET: "\u0000\n" })).not.toThrow();
    loadProposalSecret({ PULSE_PROPOSAL_SECRET: SECRET_32 });
    loadProposalSecret({});
    expect(logSpy).not.toHaveBeenCalled();
  });
});
