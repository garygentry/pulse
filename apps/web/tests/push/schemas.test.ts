// Push request schemas and the JSON body pipeline (readPushBody).

import { describe, expect, test } from "bun:test";
import type { ZodType, ZodTypeDef } from "zod";
import { formatInvalidFields, zodIssuePaths } from "../../src/server/mutations/guards.js";
import {
  adminPairingRequestSchema,
  adminTestRequestSchema,
  deviceRegistrationRequestSchema,
  pairingRedeemRequestSchema,
  utf8Bytes,
} from "../../src/server/push/handlers/schemas.js";
import { pushErrorResponse } from "../../src/server/push/refusal.js";
import { readPushBody } from "../../src/server/push/routes.js";

type Outcome<T> = { ok: true; value: T } | { ok: false; fields: string | undefined };

function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown): Outcome<T> {
  const r = schema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, fields: formatInvalidFields(zodIssuePaths(r.error.issues)) };
}

const HEX64 = "0123456789abcdef".repeat(4);
const PREFS = { critical: true, warning: false, info: true };

describe("pairingRedeemRequestSchema", () => {
  test("accepts an empty token (the handler refuses it uniformly)", () => {
    expect(parse(pairingRedeemRequestSchema, { token: "", displayName: "Example iPhone" })).toEqual({
      ok: true,
      value: { token: "", displayName: "Example iPhone" },
    });
  });

  test("rejects an absent token with fields token, and a 65-byte token", () => {
    expect(parse(pairingRedeemRequestSchema, { displayName: "Example iPhone" })).toEqual({ ok: false, fields: "token" });
    expect(parse(pairingRedeemRequestSchema, { token: "a".repeat(64), displayName: "Example iPhone" }).ok).toBe(true);
    expect(parse(pairingRedeemRequestSchema, { token: "a".repeat(65), displayName: "Example iPhone" })).toEqual({
      ok: false,
      fields: "token",
    });
  });

  test("trims the display name", () => {
    const r = parse(pairingRedeemRequestSchema, { token: "x", displayName: "  Example iPhone  " });
    expect(r).toEqual({ ok: true, value: { token: "x", displayName: "Example iPhone" } });
  });

  test.each([
    ["empty", ""],
    ["blank", "   "],
    ["65 bytes", "a".repeat(65)],
    ["angle bracket", "a<b"],
    ["newline", "a\nb"],
  ])("rejects a %s display name", (_name, displayName) => {
    expect(parse(pairingRedeemRequestSchema, { token: "x", displayName })).toEqual({ ok: false, fields: "displayName" });
  });

  test("accepts a 64-byte multi-byte name", () => {
    const name = "é".repeat(32);
    expect(utf8Bytes(name)).toBe(64);
    expect(parse(pairingRedeemRequestSchema, { token: "x", displayName: name }).ok).toBe(true);
    expect(parse(pairingRedeemRequestSchema, { token: "x", displayName: `${name}e` }).ok).toBe(false);
  });

  test("rejects an extra key with fields $", () => {
    expect(parse(pairingRedeemRequestSchema, { token: "x", displayName: "Example iPhone", secretKey: 1 })).toEqual({
      ok: false,
      fields: "$",
    });
  });
});

describe("deviceRegistrationRequestSchema", () => {
  const valid = { apnsToken: HEX64, environment: "sandbox", preferences: PREFS };

  test("accepts an upper-case 64-character token and lowercases it", () => {
    const r = parse(deviceRegistrationRequestSchema, { ...valid, apnsToken: HEX64.toUpperCase() });
    expect(r).toEqual({ ok: true, value: { apnsToken: HEX64, environment: "sandbox", preferences: PREFS } });
    expect(parse(deviceRegistrationRequestSchema, { ...valid, environment: "production" }).ok).toBe(true);
    expect(parse(deviceRegistrationRequestSchema, { ...valid, apnsToken: "a".repeat(200) }).ok).toBe(true);
  });

  test.each([
    ["63 hex characters", HEX64.slice(1)],
    ["201 characters", "a".repeat(201)],
    ["non-hex", `${HEX64.slice(1)}g`],
  ])("rejects %s", (_name, apnsToken) => {
    expect(parse(deviceRegistrationRequestSchema, { ...valid, apnsToken })).toEqual({ ok: false, fields: "apnsToken" });
  });

  test("rejects an unknown environment", () => {
    expect(parse(deviceRegistrationRequestSchema, { ...valid, environment: "staging" })).toEqual({
      ok: false,
      fields: "environment",
    });
  });

  test("rejects a missing preferences.info and an extra key inside preferences", () => {
    expect(
      parse(deviceRegistrationRequestSchema, { ...valid, preferences: { critical: true, warning: true } }),
    ).toEqual({ ok: false, fields: "preferences.info" });
    expect(
      parse(deviceRegistrationRequestSchema, { ...valid, preferences: { ...PREFS, sound: true } }),
    ).toEqual({ ok: false, fields: "preferences" });
  });

  test("rejects an extra top-level key with fields $", () => {
    expect(parse(deviceRegistrationRequestSchema, { ...valid, extra: 1 })).toEqual({ ok: false, fields: "$" });
  });
});

describe("admin schemas", () => {
  test("both accept {}", () => {
    expect(parse(adminPairingRequestSchema, {})).toEqual({ ok: true, value: {} });
    expect(parse(adminTestRequestSchema, {})).toEqual({ ok: true, value: {} });
  });

  test("baseUrl rejects empty and 2049 bytes, accepts 300 bytes", () => {
    expect(parse(adminPairingRequestSchema, { baseUrl: "" })).toEqual({ ok: false, fields: "baseUrl" });
    expect(parse(adminPairingRequestSchema, { baseUrl: "a".repeat(2049) })).toEqual({ ok: false, fields: "baseUrl" });
    expect(parse(adminPairingRequestSchema, { baseUrl: "a".repeat(2048) }).ok).toBe(true);
    const base = `https://pulse.example.com/${"a".repeat(300 - 26)}`;
    expect(utf8Bytes(base)).toBe(300);
    expect(parse(adminPairingRequestSchema, { baseUrl: base })).toEqual({ ok: true, value: { baseUrl: base } });
  });

  test("deviceId must match the device id pattern", () => {
    expect(parse(adminTestRequestSchema, { deviceId: "dev_short" })).toEqual({ ok: false, fields: "deviceId" });
    expect(parse(adminTestRequestSchema, { deviceId: "dev_AbCdEfGhIjK" }).ok).toBe(true);
  });

  test("unknown keys report $", () => {
    expect(parse(adminPairingRequestSchema, { url: "x" })).toEqual({ ok: false, fields: "$" });
    expect(parse(adminTestRequestSchema, { all: true })).toEqual({ ok: false, fields: "$" });
  });
});

describe("readPushBody", () => {
  const CAP = 4096;
  const URL_ = "http://localhost/api/push/admin/test";
  const json = (body: BodyInit | null, headers: Record<string, string> = {}): Request =>
    new Request(URL_, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  test("a valid body is parsed", async () => {
    expect(await readPushBody(json('{"deviceId":"dev_AbCdEfGhIjK"}'), CAP, adminTestRequestSchema)).toEqual({
      ok: true,
      body: { deviceId: "dev_AbCdEfGhIjK" },
    });
    const charset = json("{}", { "content-type": "application/json; charset=utf-8" });
    expect(await readPushBody(charset, CAP, adminTestRequestSchema)).toEqual({ ok: true, body: {} });
  });

  test("text/plain is invalid-body and the body is not read", async () => {
    const r = new Request(URL_, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(await readPushBody(r, CAP, adminTestRequestSchema)).toEqual({ ok: false, refusal: "invalid-body" });
    expect(r.bodyUsed).toBe(false);
    const none = new Request(URL_, { method: "POST", body: "{}" });
    none.headers.delete("content-type");
    expect(await readPushBody(none, CAP, adminTestRequestSchema)).toEqual({ ok: false, refusal: "invalid-body" });
  });

  test("a declared Content-Length over the cap is body-too-large", async () => {
    const r = json("{}", { "content-length": "5000" });
    const result = await readPushBody(r, CAP, adminTestRequestSchema);
    expect(result).toEqual({ ok: false, refusal: "body-too-large" });
    expect(pushErrorResponse("body-too-large").status).toBe(413);
  });

  test("a streamed body over the cap is body-too-large", async () => {
    const big = JSON.stringify({ deviceId: "x".repeat(CAP) });
    expect(await readPushBody(json(big), CAP, adminTestRequestSchema)).toEqual({ ok: false, refusal: "body-too-large" });
  });

  test("an empty JSON body is invalid-body", async () => {
    expect(await readPushBody(json(""), CAP, adminTestRequestSchema)).toEqual({ ok: false, refusal: "invalid-body" });
    expect(await readPushBody(json(null), CAP, adminTestRequestSchema)).toEqual({ ok: false, refusal: "invalid-body" });
    expect(pushErrorResponse("invalid-body").status).toBe(400);
  });

  test("malformed JSON and a malformed Content-Length are invalid-body", async () => {
    expect(await readPushBody(json("{"), CAP, adminTestRequestSchema)).toEqual({ ok: false, refusal: "invalid-body" });
    const bad = json("{}", { "content-length": "abc" });
    expect(await readPushBody(bad, CAP, adminTestRequestSchema)).toEqual({ ok: false, refusal: "invalid-body" });
  });

  test("a schema failure names the failing path, never the value", async () => {
    const body = JSON.stringify({ apnsToken: HEX64, environment: "sandbox", preferences: { critical: true, warning: 1 } });
    const result = await readPushBody(json(body), CAP, deviceRegistrationRequestSchema);
    expect(result).toEqual({ ok: false, refusal: "invalid-body", fields: "preferences.warning,preferences.info" });
    const strict = await readPushBody(json('{"deviceId":"dev_AbCdEfGhIjK","sneaky":"value"}'), CAP, adminTestRequestSchema);
    expect(strict).toEqual({ ok: false, refusal: "invalid-body", fields: "$" });
    if (!result.ok) {
      const resp = pushErrorResponse(result.refusal, { fields: result.fields });
      expect(resp.status).toBe(400);
      expect(await resp.json()).toMatchObject({ code: "INVALID_REQUEST", details: { fields: "preferences.warning,preferences.info" } });
    }
  });

  test("an already-consumed body is refused, never thrown", async () => {
    const r = json("{}");
    await r.text();
    expect(await readPushBody(r, CAP, adminTestRequestSchema)).toEqual({ ok: false, refusal: "invalid-body" });
  });
});
