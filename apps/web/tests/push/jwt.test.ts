// apps/web/tests/push/jwt.test.ts — the APNs provider-token signer: exact encoding, signature verification and the
// cache/refresh rules. ECDSA signatures are randomised, so tokens are compared by decoded iat, never by bytes.

import { describe, expect, spyOn, test } from "bun:test";
import { createPrivateKey, verify } from "node:crypto";

import { createProviderTokenSigner } from "../../src/server/push/apns/jwt.js";
import { PUSH_LIMITS } from "../../src/server/push/constants.js";
import { createFakeClock } from "./helpers/fakes.js";
import { createTestApnsKey } from "./helpers/keys.js";

const KEY_ID = "ABC123DEFG";
const TEAM_ID = "TEAM456XYZ";
const START_MS = 1_763_640_000_123;
const B64URL = /^[A-Za-z0-9_-]+$/;

function setup() {
  const testKey = createTestApnsKey();
  const key = createPrivateKey(testKey.pem);
  const clock = createFakeClock(START_MS);
  const signer = createProviderTokenSigner(key, KEY_ID, TEAM_ID, clock);
  return { testKey, key, clock, signer };
}

function decode(segment: string): string {
  return Buffer.from(segment, "base64url").toString("utf8");
}

function iatOf(token: string): number {
  const claims = token.split(".")[1];
  if (claims === undefined) throw new Error("no claims segment");
  return (JSON.parse(decode(claims)) as { iat: number }).iat;
}

describe("provider token signer: encoding", () => {
  test("three unpadded base64url segments with exact header and claims JSON", () => {
    const { signer } = setup();
    const token = signer.current();
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part).toMatch(B64URL);
      expect(part.includes("=")).toBe(false);
    }
    expect(decode(parts[0] ?? "")).toBe(JSON.stringify({ alg: "ES256", kid: KEY_ID }));
    expect(decode(parts[0] ?? "")).toBe(`{"alg":"ES256","kid":"${KEY_ID}"}`);
    expect(decode(parts[1] ?? "")).toBe(`{"iss":"${TEAM_ID}","iat":${Math.floor(START_MS / 1000)}}`);
  });

  test("the signature is 64 raw bytes and verifies with ieee-p1363 against the public key", () => {
    const { signer, testKey } = setup();
    const [header, claims, sig] = signer.current().split(".") as [string, string, string];
    const signature = Buffer.from(sig, "base64url");
    expect(signature.length).toBe(64);
    const input = Buffer.from(`${header}.${claims}`, "utf8");
    expect(verify("sha256", input, { key: testKey.publicKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
    // A tampered input does not verify.
    const tampered = Buffer.from(`${header}.${claims}x`, "utf8");
    expect(verify("sha256", tampered, { key: testKey.publicKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(false);
  });

  test("the signer exposes no toString/toJSON and does not log", () => {
    const logSpy = spyOn(console, "log");
    try {
      const { signer } = setup();
      const token = signer.current();
      expect(Object.keys(signer).sort()).toEqual(["current", "invalidate"]);
      expect(Object.isFrozen(signer)).toBe(true);
      expect(JSON.stringify(signer)).not.toContain(token);
      expect(String(signer)).not.toContain(token);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("provider token signer: caching", () => {
  test("refresh interval is 50 minutes", () => {
    expect(PUSH_LIMITS.jwtRefreshMs).toBe(50 * 60_000);
  });

  test("returns the cached token at +49:59 and re-signs at +50:00", () => {
    const { signer, clock } = setup();
    const first = signer.current();
    clock.advance(49 * 60_000 + 59_000);
    const cached = signer.current();
    expect(cached).toBe(first); // same cached string, not a fresh signature
    expect(iatOf(cached)).toBe(Math.floor(START_MS / 1000));
    clock.advance(1_000);
    const renewed = signer.current();
    expect(iatOf(renewed)).toBe(Math.floor((START_MS + 50 * 60_000) / 1000));
  });

  test("invalidate() forces a re-sign at the current time", () => {
    const { signer, clock } = setup();
    signer.current();
    clock.advance(5_000);
    expect(iatOf(signer.current())).toBe(Math.floor(START_MS / 1000));
    signer.invalidate();
    expect(iatOf(signer.current())).toBe(Math.floor((START_MS + 5_000) / 1000));
  });

  test("a backwards clock forces a re-sign", () => {
    const { signer, clock } = setup();
    signer.current();
    clock.set(START_MS - 120_000);
    expect(iatOf(signer.current())).toBe(Math.floor((START_MS - 120_000) / 1000));
  });

});
