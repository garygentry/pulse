// Push secrets: held-as-digest secrets that never serialise, constant-time matching, credential hashing and the
// APNs key reader.

import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { inspect } from "node:util";

import { PUSH_ENV } from "../../src/server/push/constants.js";
import {
  digestEquals,
  hashCredential,
  loadPushSecret,
  matchesSecret,
  readApnsKey,
  type PushSecret,
} from "../../src/server/push/secrets.js";
import { createTestApnsKey } from "./helpers/keys.js";

const NAME = PUSH_ENV.webhookSecret;
const SECRET = randomBytes(36).toString("base64url"); // 48 chars

function held(raw: string = SECRET): PushSecret {
  const loaded = loadPushSecret({ [NAME]: raw }, NAME);
  if (!loaded.ok) throw new Error(`expected ok, got ${loaded.reason}`);
  return loaded.secret;
}

describe("loadPushSecret", () => {
  test("missing when undefined or empty; whitespace is not trimmed", () => {
    expect(loadPushSecret({}, NAME)).toEqual({ ok: false, reason: "missing" });
    expect(loadPushSecret({ [NAME]: "" }, NAME)).toEqual({ ok: false, reason: "missing" });
    expect(loadPushSecret({ [NAME]: " ".repeat(40) }, NAME).ok).toBe(true);
  });

  test("a control character is invalid, checked before length", () => {
    expect(loadPushSecret({ [NAME]: "a\n" }, NAME)).toEqual({ ok: false, reason: "invalid" });
    expect(loadPushSecret({ [NAME]: `${SECRET}\u007f` }, NAME)).toEqual({ ok: false, reason: "invalid" });
    expect(loadPushSecret({ [NAME]: `${SECRET}\u0085` }, NAME)).toEqual({ ok: false, reason: "invalid" });
  });

  test("the minimum is 32 UTF-8 bytes", () => {
    expect(loadPushSecret({ [NAME]: "x".repeat(31) }, NAME)).toEqual({ ok: false, reason: "too-short" });
    expect(loadPushSecret({ [NAME]: "x".repeat(32) }, NAME).ok).toBe(true);
    expect(loadPushSecret({ [NAME]: "é".repeat(16) }, NAME).ok).toBe(true); // 32 bytes, 16 chars
    expect(loadPushSecret({ [NAME]: "é".repeat(15) }, NAME)).toEqual({ ok: false, reason: "too-short" });
  });
});

describe("PushSecret", () => {
  test("JSON.stringify gives \"[secret]\" and inspect shows [secret]", () => {
    const secret = held();
    expect(JSON.stringify(secret)).toBe('"[secret]"');
    expect(JSON.stringify({ webhookSecret: secret })).toBe('{"webhookSecret":"[secret]"}');
    expect(inspect(secret)).toBe("[secret]");
    expect(Bun.inspect(secret)).not.toContain(SECRET);
    expect(String(secret)).toBe("[object Object]");
  });

  test("is frozen and exposes only functions", () => {
    const secret = held();
    expect(Object.isFrozen(secret)).toBe(true);
    expect(Object.keys(secret).sort()).toEqual(["sha256", "toJSON"]);
    for (const value of Object.values(secret)) expect(typeof value).toBe("function");
  });

  test("sha256() is the digest of the UTF-8 secret and returns a copy", () => {
    const secret = held();
    const first = secret.sha256();
    expect(first.byteLength).toBe(32);
    expect(Buffer.from(first).toString("hex")).toBe(createHash("sha256").update(SECRET, "utf8").digest("hex"));
    first.fill(0);
    const second = secret.sha256();
    expect(second).not.toBe(first);
    expect(second.every((b) => b === 0)).toBe(false);
    expect(matchesSecret(SECRET, secret)).toBe(true);
  });
});

describe("matchesSecret", () => {
  const secret = held();

  test("true for the exact secret", () => {
    expect(matchesSecret(SECRET, secret)).toBe(true);
  });

  test("false for a one-byte change", () => {
    const last = SECRET.at(-1) === "A" ? "B" : "A";
    expect(matchesSecret(`${SECRET.slice(0, -1)}${last}`, secret)).toBe(false);
    expect(matchesSecret(`${SECRET}x`, secret)).toBe(false);
    expect(matchesSecret(SECRET.slice(0, -1), secret)).toBe(false);
  });

  test("false for empty input", () => {
    expect(matchesSecret("", secret)).toBe(false);
  });

  test("false for wrong-scheme or untrimmed input", () => {
    expect(matchesSecret(`Bearer ${SECRET}`, secret)).toBe(false);
    expect(matchesSecret(`Basic ${SECRET}`, secret)).toBe(false);
    expect(matchesSecret(` ${SECRET}`, secret)).toBe(false);
    expect(matchesSecret(`${SECRET}${SECRET}`, secret)).toBe(false);
  });
});

describe("hashCredential and digestEquals", () => {
  test("hashCredential is lowercase hex SHA-256", () => {
    const h = hashCredential("credential-value");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(createHash("sha256").update("credential-value", "utf8").digest("hex"));
    expect(hashCredential("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("digestEquals is true only for equal digests", () => {
    const a = hashCredential("a");
    expect(digestEquals(a, a)).toBe(true);
    expect(digestEquals(a, `${a}`.slice(0))).toBe(true);
    expect(digestEquals(a, hashCredential("b"))).toBe(false);
    const flipped = `${a.slice(0, -1)}${a.endsWith("0") ? "1" : "0"}`;
    expect(digestEquals(a, flipped)).toBe(false);
  });

  test("digestEquals is false on a length mismatch without throwing", () => {
    const a = hashCredential("a");
    expect(digestEquals(a, a.slice(0, 63))).toBe(false);
    expect(digestEquals(a, `${a}0`)).toBe(false);
    expect(digestEquals("", a)).toBe(false);
    expect(digestEquals("", "")).toBe(true);
  });
});

describe("readApnsKey", () => {
  const pemBytes = (pem: string): (() => Uint8Array) => () => new Uint8Array(Buffer.from(pem));

  test("accepts a P-256 PKCS#8 key and zero-fills the read buffer", () => {
    const { pem } = createTestApnsKey();
    const buffer = new Uint8Array(Buffer.from(pem));
    const result = readApnsKey("/keys/a.p8", () => buffer);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(buffer.every((b) => b === 0)).toBe(true);
  });

  test("a throwing reader is unreadable", () => {
    expect(
      readApnsKey("/keys/a.p8", () => {
        throw Object.assign(new Error("x"), { code: "ENOENT" });
      }),
    ).toEqual({ ok: false, reason: "unreadable" });
  });

  test("refused keys are invalid and still zero-filled", () => {
    const pkcs8 = { type: "pkcs8", format: "pem" } as const;
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1", privateKeyEncoding: pkcs8 }).privateKey;
    const buffer = new Uint8Array(Buffer.from(p384));
    expect(readApnsKey("/keys/a.p8", () => buffer)).toEqual({ ok: false, reason: "invalid" });
    expect(buffer.every((b) => b === 0)).toBe(true);
    expect(readApnsKey("/k", pemBytes("garbage"))).toEqual({ ok: false, reason: "invalid" });
    const { pem } = createTestApnsKey();
    const corrupt = pem.replace(/[A-Za-z]{8}/, "########");
    expect(readApnsKey("/k", pemBytes(corrupt))).toEqual({ ok: false, reason: "invalid" });
    expect(readApnsKey("/k", pemBytes(pem + " ".repeat(16_385)))).toEqual({ ok: false, reason: "invalid" });
  });
});
