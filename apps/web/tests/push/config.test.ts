// Push configuration parsing: the disabled rule, every APNs/data-dir/cap rule, optional secrets, rule ordering and
// the guarantee that no configured value leaks into a result.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadServerConfig } from "../../src/server/config.js";
import { WRITE_PATH_ENV } from "../../src/server/mutations/constants.js";
import {
  DISABLED_PUSH_CONFIG,
  parsePushConfig,
  parsePushDataDir,
  type PushConfigReason,
  type PushConfigState,
} from "../../src/server/push/config.js";
import { PUSH_APNS_ENV_NAMES, PUSH_ENV } from "../../src/server/push/constants.js";
import { ENV } from "../../src/shared/constants.js";
import { writeTestKeyFile } from "./helpers/keys.js";

type Env = Record<string, string | undefined>;

let dir: string;
let keyPath: string;
let keyPem: string;
let dataDir: string;
const WEBHOOK_SECRET = randomBytes(24).toString("base64url"); // 32 chars
const OPERATOR_SECRET = randomBytes(30).toString("base64url"); // 40 chars

/** Paths of refused key variants, written in beforeAll. */
const keys: Record<string, string> = {};

function writePem(name: string, pem: string | Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, pem, { mode: 0o600 });
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "push-config-"));
  const key = writeTestKeyFile(dir);
  keyPath = key.path;
  keyPem = key.pem;
  dataDir = join(dir, "data");

  const pkcs8 = { type: "pkcs8", format: "pem" } as const;
  keys.p384 = writePem("p384.p8", generateKeyPairSync("ec", { namedCurve: "secp384r1", privateKeyEncoding: pkcs8 }).privateKey);
  keys.rsa = writePem("rsa.p8", generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: pkcs8 }).privateKey);
  keys.ed25519 = writePem("ed25519.p8", generateKeyPairSync("ed25519", { privateKeyEncoding: pkcs8 }).privateKey);
  keys.sec1 = writePem(
    "sec1.p8",
    generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { type: "sec1", format: "pem" } }).privateKey,
  );
  keys.encrypted = writePem(
    "encrypted.p8",
    generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { ...pkcs8, cipher: "aes-256-cbc", passphrase: "test-only-passphrase" },
    }).privateKey,
  );
  keys.der = writePem(
    "der.p8",
    generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { type: "pkcs8", format: "der" } }).privateKey,
  );
  keys.notPem = writePem("not-pem.p8", "this is not a key\n");
  keys.oversized = writePem("oversized.p8", keyPem + "\n".repeat(17_000));
  keys.directory = join(dir, "a-directory");
  mkdirSync(keys.directory);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** All valid: four APNs variables and the data directory. */
function valid(over: Env = {}): Env {
  return {
    [PUSH_ENV.keyFile]: keyPath,
    [PUSH_ENV.keyId]: "ABCDE12345",
    [PUSH_ENV.teamId]: "TEAM123456",
    [PUSH_ENV.topic]: "com.example.pulse",
    [PUSH_ENV.dataDir]: dataDir,
    ...over,
  };
}

/** All valid plus both secrets. */
function full(over: Env = {}): Env {
  return valid({ [PUSH_ENV.webhookSecret]: WEBHOOK_SECRET, [PUSH_ENV.operatorSecret]: OPERATOR_SECRET, ...over });
}

const r = (envVar: string, reason: PushConfigReason["reason"]): PushConfigReason => ({ envVar, reason });

function reasonsOf(state: PushConfigState): readonly PushConfigReason[] {
  if (state.state !== "misconfigured") throw new Error(`expected misconfigured, got ${state.state}`);
  return state.reasons;
}

function configured(state: PushConfigState): Extract<PushConfigState, { state: "configured" }> {
  if (state.state !== "configured") throw new Error(`expected configured, got ${JSON.stringify(state)}`);
  return state;
}

/** Every parse result from this file, with its env, for the leak check at the end. */
const seen: Array<{ env: Env; result: PushConfigState }> = [];
function parse(env: Env, deps?: Parameters<typeof parsePushConfig>[1]): PushConfigState {
  const result = parsePushConfig(env, deps);
  seen.push({ env, result });
  return result;
}

describe("rule D: disabled", () => {
  test("1: no push variable set returns the frozen disabled constant", () => {
    const result = parse({});
    expect(result).toBe(DISABLED_PUSH_CONFIG);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toEqual({ state: "disabled" });
  });

  test("2: every push variable empty (shipped compose) is disabled", () => {
    const env: Env = {};
    for (const name of Object.values(PUSH_ENV)) env[name] = "";
    expect(parse(env)).toBe(DISABLED_PUSH_CONFIG);
  });

  test("3: a whitespace-only key file is unset", () => {
    expect(parse({ [PUSH_ENV.keyFile]: "  " })).toBe(DISABLED_PUSH_CONFIG);
  });

  test("4: only the two secrets set is disabled", () => {
    expect(parse({ [PUSH_ENV.webhookSecret]: WEBHOOK_SECRET, [PUSH_ENV.operatorSecret]: OPERATOR_SECRET })).toBe(
      DISABLED_PUSH_CONFIG,
    );
  });

  test("5: only the device cap set is disabled", () => {
    expect(parse({ [PUSH_ENV.maxDevices]: "500" })).toBe(DISABLED_PUSH_CONFIG);
  });

  test("reads nothing but the four APNs variables and never touches a file", () => {
    const read: string[] = [];
    const target: Env = {
      [PUSH_ENV.keyFile]: " ",
      [PUSH_ENV.webhookSecret]: WEBHOOK_SECRET,
      [PUSH_ENV.operatorSecret]: OPERATOR_SECRET,
      [PUSH_ENV.maxDevices]: "500",
      [PUSH_ENV.dataDir]: dataDir,
    };
    const env = new Proxy(target, {
      get(t, key) {
        if (typeof key === "string") read.push(key);
        return t[key as string];
      },
    });
    let fileReads = 0;
    const result = parsePushConfig(env, {
      readFile: () => {
        fileReads += 1;
        return new Uint8Array(0);
      },
    });
    expect(result).toBe(DISABLED_PUSH_CONFIG);
    expect(fileReads).toBe(0);
    expect(read.length).toBeGreaterThan(0);
    for (const name of read) expect(PUSH_APNS_ENV_NAMES).toContain(name);
  });
});

describe("misconfigured rows", () => {
  test("6: only KEY_ID set, data dir unset", () => {
    expect(reasonsOf(parse({ [PUSH_ENV.keyId]: "ABCDE12345" }))).toEqual([
      r(PUSH_ENV.keyFile, "missing"),
      r(PUSH_ENV.teamId, "missing"),
      r(PUSH_ENV.topic, "missing"),
      r(PUSH_ENV.dataDir, "data-dir-missing"),
    ]);
  });

  test("6: only KEY_ID set, data dir valid", () => {
    expect(reasonsOf(parse({ [PUSH_ENV.keyId]: "ABCDE12345", [PUSH_ENV.dataDir]: dataDir }))).toEqual([
      r(PUSH_ENV.keyFile, "missing"),
      r(PUSH_ENV.teamId, "missing"),
      r(PUSH_ENV.topic, "missing"),
    ]);
  });

  test("7: relative key file is not-absolute", () => {
    expect(reasonsOf(parse(full({ [PUSH_ENV.keyFile]: "keys/a.p8" })))).toEqual([r(PUSH_ENV.keyFile, "not-absolute")]);
  });

  test("8: key file path with a newline is invalid", () => {
    expect(reasonsOf(parse(full({ [PUSH_ENV.keyFile]: `${keyPath}\n` })))).toEqual([r(PUSH_ENV.keyFile, "invalid")]);
  });

  test("9: absent key file is unreadable", () => {
    expect(reasonsOf(parse(full({ [PUSH_ENV.keyFile]: join(dir, "absent.p8") })))).toEqual([
      r(PUSH_ENV.keyFile, "unreadable"),
    ]);
  });

  test("9: a reader failing with EACCES is unreadable", () => {
    const readFile = (): Uint8Array => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    expect(reasonsOf(parse(full(), { readFile }))).toEqual([r(PUSH_ENV.keyFile, "unreadable")]);
  });

  test("10: key file is a directory → unreadable", () => {
    expect(reasonsOf(parse(full({ [PUSH_ENV.keyFile]: keys.directory })))).toEqual([r(PUSH_ENV.keyFile, "unreadable")]);
  });

  for (const variant of ["notPem", "der", "sec1", "encrypted"] as const) {
    test(`11: ${variant} key is invalid`, () => {
      expect(reasonsOf(parse(full({ [PUSH_ENV.keyFile]: keys[variant] })))).toEqual([r(PUSH_ENV.keyFile, "invalid")]);
    });
  }

  for (const variant of ["rsa", "ed25519"] as const) {
    test(`12: PKCS#8 ${variant} key is invalid`, () => {
      expect(reasonsOf(parse(full({ [PUSH_ENV.keyFile]: keys[variant] })))).toEqual([r(PUSH_ENV.keyFile, "invalid")]);
    });
  }

  test("13: PKCS#8 EC P-384 key is invalid", () => {
    expect(reasonsOf(parse(full({ [PUSH_ENV.keyFile]: keys.p384 })))).toEqual([r(PUSH_ENV.keyFile, "invalid")]);
  });

  test("14: key file over 16 KiB is invalid", () => {
    expect(reasonsOf(parse(full({ [PUSH_ENV.keyFile]: keys.oversized })))).toEqual([r(PUSH_ENV.keyFile, "invalid")]);
  });

  test("the key bytes handed to the parser are zero-filled afterwards", () => {
    const buffers: Uint8Array[] = [];
    const readFile = (): Uint8Array => {
      const b = new Uint8Array(Buffer.from(keyPem));
      buffers.push(b);
      return b;
    };
    configured(parse(full(), { readFile }));
    reasonsOf(parse(full({ [PUSH_ENV.keyId]: "bad" }), { readFile }));
    expect(buffers.length).toBe(2);
    for (const b of buffers) expect(b.every((x) => x === 0)).toBe(true);
  });

  for (const keyId of ["abcde12345", "ABCDE1234"]) {
    test(`15: key id ${JSON.stringify(keyId)} is invalid`, () => {
      expect(reasonsOf(parse(full({ [PUSH_ENV.keyId]: keyId })))).toEqual([r(PUSH_ENV.keyId, "invalid")]);
    });
  }

  test("16: an 11-character team id is invalid", () => {
    expect(reasonsOf(parse(full({ [PUSH_ENV.teamId]: "TEAM1234567" })))).toEqual([r(PUSH_ENV.teamId, "invalid")]);
  });

  for (const topic of ["app", `com.${"a".repeat(160)}`]) {
    test(`17: topic of ${topic.length} chars (${topic.slice(0, 8)}) is invalid`, () => {
      expect(reasonsOf(parse(full({ [PUSH_ENV.topic]: topic })))).toEqual([r(PUSH_ENV.topic, "invalid")]);
    });
  }

  test("18: data dir unset is data-dir-missing", () => {
    expect(reasonsOf(parse(full({ [PUSH_ENV.dataDir]: undefined })))).toEqual([r(PUSH_ENV.dataDir, "data-dir-missing")]);
  });

  test("19: relative data dir is invalid", () => {
    expect(reasonsOf(parse(full({ [PUSH_ENV.dataDir]: "data" })))).toEqual([r(PUSH_ENV.dataDir, "invalid")]);
  });

  for (const md of ["0", "101", "abc", "1e1", "-5", "20.0", "1000"]) {
    test(`20: device cap ${JSON.stringify(md)} is invalid`, () => {
      expect(reasonsOf(parse(full({ [PUSH_ENV.maxDevices]: md })))).toEqual([r(PUSH_ENV.maxDevices, "invalid")]);
    });
  }

  test("21: key id, team id and cap invalid give three reasons in rule order", () => {
    expect(
      reasonsOf(
        parse(full({ [PUSH_ENV.keyId]: "short", [PUSH_ENV.teamId]: "lowercase1", [PUSH_ENV.maxDevices]: "0" })),
      ),
    ).toEqual([r(PUSH_ENV.keyId, "invalid"), r(PUSH_ENV.teamId, "invalid"), r(PUSH_ENV.maxDevices, "invalid")]);
  });

  test("every rule failing gives reasons in K1, K2, K3, K4, P, M order", () => {
    const result = parse({
      [PUSH_ENV.keyFile]: "relative.p8",
      [PUSH_ENV.keyId]: "nope",
      [PUSH_ENV.teamId]: "nope",
      [PUSH_ENV.topic]: "nope",
      [PUSH_ENV.dataDir]: "relative",
      [PUSH_ENV.maxDevices]: "0",
      [PUSH_ENV.webhookSecret]: WEBHOOK_SECRET,
    });
    expect(reasonsOf(result)).toEqual([
      r(PUSH_ENV.keyFile, "not-absolute"),
      r(PUSH_ENV.keyId, "invalid"),
      r(PUSH_ENV.teamId, "invalid"),
      r(PUSH_ENV.topic, "invalid"),
      r(PUSH_ENV.dataDir, "invalid"),
      r(PUSH_ENV.maxDevices, "invalid"),
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(reasonsOf(result))).toBe(true);
  });

  test("a misconfigured state carries no secret and no warning", () => {
    const result = parse(full({ [PUSH_ENV.topic]: "app" }));
    expect(Object.keys(result).sort()).toEqual(["reasons", "state"]);
  });

  test("an unexpected exception ends the parse as misconfigured with the reasons so far", () => {
    const throwing = (over: Env): Env =>
      new Proxy(full(over), {
        get(t, key) {
          if (key === PUSH_ENV.maxDevices) throw new Error("boom");
          return t[key as string];
        },
      });
    expect(reasonsOf(parsePushConfig(throwing({ [PUSH_ENV.keyId]: "bad" })))).toEqual([r(PUSH_ENV.keyId, "invalid")]);
    const none = reasonsOf(parsePushConfig(throwing({})));
    expect(none.length).toBe(1);
  });
});

describe("configured rows", () => {
  test("22/23: all valid with both secrets → configured, default cap, both surfaces on, no warnings", () => {
    const c = configured(parse(full()));
    expect(c.maxDevices).toBe(20);
    expect(c.webhook).toBe("on");
    expect(c.admin).toBe("on");
    expect(c.webhookSecret).not.toBeNull();
    expect(c.operatorSecret).not.toBeNull();
    expect(c.warnings).toEqual([]);
    expect(c.dataDir).toBe(dataDir);
    expect(c.apns.keyId).toBe("ABCDE12345");
    expect(c.apns.teamId).toBe("TEAM123456");
    expect(c.apns.topic).toBe("com.example.pulse");
    expect(c.apns.key.asymmetricKeyType).toBe("ec");
    expect(c.apns.key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.apns)).toBe(true);
    expect(Object.isFrozen(c.warnings)).toBe(true);
  });

  test("values are trimmed and the data dir normalised", () => {
    const c = configured(
      parse(
        full({
          [PUSH_ENV.keyFile]: `  ${keyPath}  `,
          [PUSH_ENV.keyId]: " ABCDE12345 ",
          [PUSH_ENV.dataDir]: ` ${dataDir}/./x/.. `,
        }),
      ),
    );
    expect(c.apns.keyId).toBe("ABCDE12345");
    expect(c.dataDir).toBe(dataDir);
  });

  test("24: webhook secret unset → webhook off with a missing warning", () => {
    const c = configured(parse(full({ [PUSH_ENV.webhookSecret]: undefined })));
    expect(c.webhook).toBe("off");
    expect(c.webhookSecret).toBeNull();
    expect(c.admin).toBe("on");
    expect(c.warnings).toEqual([r(PUSH_ENV.webhookSecret, "missing")]);
  });

  test("25: a 31-byte webhook secret is too-short", () => {
    const c = configured(parse(full({ [PUSH_ENV.webhookSecret]: "x".repeat(31) })));
    expect(c.webhook).toBe("off");
    expect(c.warnings).toEqual([r(PUSH_ENV.webhookSecret, "too-short")]);
  });

  test("26: an operator secret containing \\r is invalid", () => {
    const c = configured(parse(full({ [PUSH_ENV.operatorSecret]: `${OPERATOR_SECRET}\r` })));
    expect(c.admin).toBe("off");
    expect(c.operatorSecret).toBeNull();
    expect(c.webhook).toBe("on");
    expect(c.warnings).toEqual([r(PUSH_ENV.operatorSecret, "invalid")]);
  });

  test("27: both secrets unset → both off, webhook warning first", () => {
    const c = configured(parse(valid()));
    expect(c.webhook).toBe("off");
    expect(c.admin).toBe("off");
    expect(c.warnings).toEqual([r(PUSH_ENV.webhookSecret, "missing"), r(PUSH_ENV.operatorSecret, "missing")]);
  });

  test("the 32-byte minimum counts UTF-8 bytes: 11 three-byte characters pass, 10 are too-short", () => {
    const ok = configured(parse(full({ [PUSH_ENV.webhookSecret]: "€".repeat(11) })));
    expect(ok.webhook).toBe("on");
    const short = configured(parse(full({ [PUSH_ENV.webhookSecret]: "€".repeat(10) })));
    expect(short.webhook).toBe("off");
    expect(short.warnings).toEqual([r(PUSH_ENV.webhookSecret, "too-short")]);
    expect(configured(parse(full({ [PUSH_ENV.webhookSecret]: "x".repeat(32) }))).webhook).toBe("on");
  });

  for (const [md, expected] of [
    ["1", 1],
    ["100", 100],
    [" 42 ", 42],
    ["020", 20],
    ["", 20],
  ] as const) {
    test(`28: device cap ${JSON.stringify(md)} → ${expected}`, () => {
      expect(configured(parse(full({ [PUSH_ENV.maxDevices]: md }))).maxDevices).toBe(expected);
    });
  }

  test("the P-256 key is accepted from the default file reader", () => {
    expect(configured(parsePushConfig(full())).apns.key.type).toBe("private");
  });
});

describe("parsePushDataDir", () => {
  test("unset, blank, invalid and valid", () => {
    expect(parsePushDataDir({})).toBeNull();
    expect(parsePushDataDir({ [PUSH_ENV.dataDir]: "   " })).toBeNull();
    expect(parsePushDataDir({ [PUSH_ENV.dataDir]: "rel/dir" })).toBe("invalid");
    expect(parsePushDataDir({ [PUSH_ENV.dataDir]: "/data\u0007" })).toBe("invalid");
    expect(parsePushDataDir({ [PUSH_ENV.dataDir]: " /data//push/../x " })).toBe("/data/x");
  });
});

describe("ENV and ServerConfig", () => {
  test("every PUSH_ENV value except dataDir is in ENV; dataDir is the write-path variable", () => {
    const envValues: string[] = Object.values(ENV);
    for (const [key, value] of Object.entries(PUSH_ENV)) {
      if (key === "dataDir") continue;
      expect(envValues).toContain(value);
    }
    expect(PUSH_ENV.dataDir).toBe(WRITE_PATH_ENV.dataDir);
    expect(envValues.filter((v) => v.startsWith("PULSE_PUSH_")).length).toBe(7);
  });

  const engines: Env = {
    PULSE_VM_URL: "http://localhost:8428",
    PULSE_ALERTMANAGER_URL: "http://localhost:9093",
    PULSE_GATUS_URL: "http://localhost:8080",
    PULSE_VMALERT_URL: "http://localhost:8880",
  };

  // loadServerConfig logs its own (non-push) config warnings; keep them out of the test output.
  let logSpy: Mock<(...args: unknown[]) => void>;
  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  test("loadServerConfig sets push last; disabled without push variables", () => {
    const config = loadServerConfig({ ...engines });
    expect(config.push).toBe(DISABLED_PUSH_CONFIG);
    expect(Object.keys(config).at(-1)).toBe("push");
  });

  test("loadServerConfig parses a configured push and serialises secrets as [secret]", () => {
    const config = loadServerConfig({ ...engines, ...full() });
    expect(configured(config.push).maxDevices).toBe(20);
    const json = JSON.stringify(config);
    expect(json).toContain('"webhookSecret":"[secret]"');
    expect(json).not.toContain(WEBHOOK_SECRET);
    expect(json).not.toContain(OPERATOR_SECRET);
    for (const call of logSpy.mock.calls) expect(String(call[0])).not.toContain("PULSE_PUSH_");
  });

  test("a push misconfiguration is never fatal", () => {
    expect(loadServerConfig({ ...engines, [PUSH_ENV.keyId]: "x" }).push.state).toBe("misconfigured");
  });
});

describe("no value leaks", () => {
  test("no secret or key material appears in any result; non-configured results carry no env value", () => {
    expect(seen.length).toBeGreaterThan(40);
    const pemBody = keyPem.split("\n").filter((l) => l.length > 0 && !l.startsWith("-----"));
    for (const { env, result } of seen) {
      const json = JSON.stringify(result);
      expect(json).not.toContain(WEBHOOK_SECRET);
      expect(json).not.toContain(OPERATOR_SECRET);
      for (const line of pemBody) expect(json).not.toContain(line);
      for (const [name, value] of Object.entries(env)) {
        if (value === undefined || value.trim().length < 3) continue;
        const isSecret = name === PUSH_ENV.webhookSecret || name === PUSH_ENV.operatorSecret;
        if (isSecret || result.state !== "configured") expect(json).not.toContain(JSON.stringify(value).slice(1, -1));
      }
    }
  });
});
