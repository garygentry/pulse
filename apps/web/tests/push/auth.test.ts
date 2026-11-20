// Push authorisers and the refusal model: the device credential, shared secrets, the browser gate, the refusal
// policy table and the error response builder.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { IdentityConfig } from "@pulse/web-data/identity";
import type { RefusalReason } from "../../src/server/mutations/refusal.js";
import { REFUSAL_POLICY } from "../../src/server/mutations/refusal.js";
import { authoriseBrowser, authoriseDevice, authoriseSecret } from "../../src/server/push/auth.js";
import type { DeviceRecord } from "../../src/server/push/registry/schema.js";
import {
  fromGuardReason,
  PUSH_REFUSAL_POLICY,
  pushErrorResponse,
  type PushRefusal,
} from "../../src/server/push/refusal.js";
import { hashCredential, loadPushSecret, type PushSecret } from "../../src/server/push/secrets.js";

const CREDENTIAL = "A".repeat(21) + "b_-" + "9".repeat(19); // 43 chars
const OTHER_CREDENTIAL = "Z".repeat(43);

function record(credential: string, id = "dev_AAAAAAAAAAA"): DeviceRecord {
  return {
    id,
    displayName: "Example iPhone",
    credentialHash: hashCredential(credential),
    apnsToken: null,
    environment: null,
    preferences: { critical: true, warning: true, info: true },
    pairedAt: "2026-01-01T00:00:00.000Z",
    seenAt: "2026-01-01T00:00:00.000Z",
    lastDelivery: null,
  };
}

function indexOf(records: readonly DeviceRecord[]): { byCredentialHash(hash: string): DeviceRecord | undefined } {
  const map = new Map(records.map((r) => [r.credentialHash, r]));
  return { byCredentialHash: (hash) => map.get(hash) };
}

function headersWith(...values: string[]): Headers {
  const h = new Headers();
  for (const v of values) h.append("authorization", v);
  return h;
}

async function bodyText(r: Response): Promise<string> {
  return await r.text();
}

describe("PUSH_REFUSAL_POLICY", () => {
  const EXPECTED: Record<PushRefusal, [number, string, boolean]> = {
    "cross-origin": [403, "INVALID_REQUEST", false],
    "untrusted-identity": [403, "INVALID_REQUEST", false],
    "invalid-body": [400, "INVALID_REQUEST", false],
    "body-too-large": [413, "PAYLOAD_TOO_LARGE", false],
    unauthorized: [401, "UNAUTHORIZED", false],
    "pairing-refused": [403, "PAIRING_REFUSED", false],
    "device-cap-reached": [409, "DEVICE_CAP_REACHED", false],
    "rate-limited": [429, "RATE_LIMITED", false],
    unavailable: [503, "PUSH_UNAVAILABLE", false],
    "not-found": [404, "API_NOT_FOUND", false],
    "no-usable-address": [409, "INVALID_REQUEST", true],
    "address-too-long": [409, "INVALID_REQUEST", true],
    "unsupported-version": [400, "INVALID_REQUEST", false],
    internal: [500, "INTERNAL_ERROR", false],
  };

  test("is frozen and equals the 14-row table", () => {
    expect(Object.isFrozen(PUSH_REFUSAL_POLICY)).toBe(true);
    expect(Object.keys(PUSH_REFUSAL_POLICY).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(Object.keys(PUSH_REFUSAL_POLICY)).toHaveLength(14);
    for (const [refusal, [status, code, exposeReason]] of Object.entries(EXPECTED)) {
      const row = PUSH_REFUSAL_POLICY[refusal as PushRefusal];
      expect(Object.isFrozen(row)).toBe(true);
      expect(row).toEqual({ status: status as 400, code: code as "INVALID_REQUEST", exposeReason });
    }
  });

  test("fromGuardReason maps the four named reasons and everything else to internal", () => {
    const named: Partial<Record<RefusalReason, PushRefusal>> = {
      "cross-origin": "cross-origin",
      "untrusted-identity": "untrusted-identity",
      "invalid-body": "invalid-body",
      "body-too-large": "body-too-large",
    };
    const all = Object.keys(REFUSAL_POLICY) as RefusalReason[];
    expect(all.length).toBeGreaterThan(4);
    for (const reason of all) expect(fromGuardReason(reason)).toBe(named[reason] ?? "internal");
  });
});

describe("pushErrorResponse", () => {
  test("every refusal sets the status, JSON type and private no-store", async () => {
    for (const refusal of Object.keys(PUSH_REFUSAL_POLICY) as PushRefusal[]) {
      const r = pushErrorResponse(refusal);
      expect(r.status).toBe(PUSH_REFUSAL_POLICY[refusal].status);
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(r.headers.get("retry-after")).toBeNull();
      const body = (await r.json()) as { code: string; message: string };
      expect(body.code).toBe(PUSH_REFUSAL_POLICY[refusal].code);
      expect(typeof body.message).toBe("string");
    }
  });

  test("unauthorized and pairing-refused never carry details, even when extras are given", async () => {
    for (const refusal of ["unauthorized", "pairing-refused"] as const) {
      const plain = await bodyText(pushErrorResponse(refusal));
      const withExtra = await bodyText(pushErrorResponse(refusal, { fields: "token" }));
      expect(plain).toBe(withExtra);
      expect(JSON.parse(plain)).not.toHaveProperty("details");
    }
  });

  test("exposeReason refusals carry details.reason", async () => {
    expect(await pushErrorResponse("no-usable-address").json()).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "no-usable-address" },
    });
    expect(await pushErrorResponse("address-too-long").json()).toMatchObject({
      details: { reason: "address-too-long" },
    });
  });

  test("fields appear only for invalid-body", async () => {
    expect(await pushErrorResponse("invalid-body", { fields: "token" }).json()).toMatchObject({
      details: { fields: "token" },
    });
    expect(await pushErrorResponse("invalid-body").json()).not.toHaveProperty("details");
    expect(await pushErrorResponse("body-too-large", { fields: "token" }).json()).not.toHaveProperty("details");
  });

  test("rate-limited with retryAfterSeconds sets Retry-After", () => {
    const r = pushErrorResponse("rate-limited", { retryAfterSeconds: 7 });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("7");
  });
});

describe("authoriseDevice", () => {
  const known = record(CREDENTIAL);
  const store = indexOf([known]); // OTHER_CREDENTIAL stands in for a revoked device: no longer indexed

  test("a valid credential resolves to its device", () => {
    const result = authoriseDevice(headersWith(`Bearer ${CREDENTIAL}`), store);
    expect(result).toEqual({ ok: true, device: known });
  });

  const CASES: ReadonlyArray<[string, Headers]> = [
    ["missing header", new Headers()],
    ["42-char credential", headersWith(`Bearer ${CREDENTIAL.slice(0, 42)}`)],
    ["44-char credential", headersWith(`Bearer ${CREDENTIAL}x`)],
    ["lowercase bearer", headersWith(`bearer ${CREDENTIAL}`)],
    ["unknown credential", headersWith(`Bearer ${"Q".repeat(43)}`)],
    ["revoked credential", headersWith(`Bearer ${OTHER_CREDENTIAL}`)],
    ["two Headers.append lines", headersWith(`Bearer ${CREDENTIAL}`, `Bearer ${CREDENTIAL}`)],
    ["comma-joined", headersWith(`Bearer ${CREDENTIAL}, Bearer ${CREDENTIAL}`)],
  ];

  test.each(CASES)("%s is refused with the single unauthorized value", (_name, headers) => {
    const result = authoriseDevice(headers, store);
    expect(result).toEqual({ ok: false, refusal: "unauthorized" });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("every refusal is the same object and answers byte-identical 401 bodies", async () => {
    const results = CASES.map(([, h]) => authoriseDevice(h, store));
    for (const r of results) expect(r).toBe(results[0]!);
    const bodies = await Promise.all(
      results.map(async (r) => {
        if (r.ok) throw new Error("unexpected ok");
        const resp = pushErrorResponse(r.refusal);
        expect(resp.status).toBe(401);
        return await resp.text();
      }),
    );
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).not.toHaveProperty("details");
  });

  test("an index hit whose digest does not match is refused", () => {
    const corrupted: DeviceRecord = { ...known, credentialHash: "0".repeat(64) };
    const lying = { byCredentialHash: (): DeviceRecord => corrupted };
    expect(authoriseDevice(headersWith(`Bearer ${CREDENTIAL}`), lying)).toEqual({ ok: false, refusal: "unauthorized" });
  });

  test("a throwing store is refused, never thrown", () => {
    const broken = {
      byCredentialHash: (): DeviceRecord => {
        throw new Error("boom");
      },
    };
    expect(authoriseDevice(headersWith(`Bearer ${CREDENTIAL}`), broken)).toEqual({ ok: false, refusal: "unauthorized" });
  });
});

describe("authoriseSecret", () => {
  const RAW = "webhook-secret-0123456789abcdefghijklmnop";
  const OTHER = "operator-secret-0123456789abcdefghijklmno";
  function held(raw: string): PushSecret {
    const r = loadPushSecret({ S: raw }, "S");
    if (!r.ok) throw new Error("bad test secret");
    return r.secret;
  }
  const webhook = held(RAW);
  const operator = held(OTHER);
  const req = (...values: string[]): Request =>
    new Request("http://localhost/api/push/alertmanager", { method: "POST", headers: headersWith(...values) });

  let logSpy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => {
    logSpy?.mockRestore();
    logSpy = null;
  });

  test("accepts only the exact secret and logs nothing", () => {
    logSpy = spyOn(console, "log");
    expect(authoriseSecret(req(`Bearer ${RAW}`), webhook)).toBe(true);
    expect(authoriseSecret(req(`Bearer ${RAW.slice(0, -1)}x`), webhook)).toBe(false); // wrong
    expect(authoriseSecret(req(), webhook)).toBe(false); // missing
    expect(authoriseSecret(req("Bearer "), webhook)).toBe(false); // empty
    expect(authoriseSecret(req(""), webhook)).toBe(false); // empty header
    expect(authoriseSecret(req(`Bearer ${RAW}`, `Bearer ${RAW}`), webhook)).toBe(false); // repeated
    expect(authoriseSecret(req(`Bearer ${RAW}, Bearer ${RAW}`), webhook)).toBe(false); // comma-joined
    expect(authoriseSecret(req(`Basic ${RAW}`), webhook)).toBe(false); // wrong scheme
    expect(authoriseSecret(req(`bearer ${RAW}`), webhook)).toBe(false); // wrong scheme case
    expect(authoriseSecret(req(RAW), webhook)).toBe(false); // no scheme
    expect(authoriseSecret(req(`Bearer ${OTHER}`), webhook)).toBe(false); // swapped
    expect(authoriseSecret(req(`Bearer ${RAW}`), operator)).toBe(false); // swapped
    expect(authoriseSecret(req(`Bearer ${OTHER}`), operator)).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("authoriseBrowser", () => {
  const NONE: IdentityConfig = { mode: "none", headerName: "Remote-User", trustedProxies: [] };
  const PROXY: IdentityConfig = { mode: "proxy-header", headerName: "Remote-User", trustedProxies: ["127.0.0.1/32"] };
  const request = (method: string, headers: Record<string, string>): Request =>
    new Request("http://pulse.example.com/api/push/pairing-tokens", { method, headers });

  describe("no-auth mode", () => {
    test("a cross-site write is refused", () => {
      const r = request("POST", { "sec-fetch-site": "cross-site", host: "pulse.example.com" });
      expect(authoriseBrowser(r, null, NONE, "write")).toEqual({ ok: false, refusal: "cross-origin" });
    });

    test("a write with neither Origin nor Sec-Fetch-Site is refused", () => {
      const r = request("POST", { host: "pulse.example.com" });
      expect(authoriseBrowser(r, null, NONE, "write")).toEqual({ ok: false, refusal: "cross-origin" });
    });

    test("a same-origin write passes", () => {
      const r = request("POST", { origin: "http://pulse.example.com", host: "pulse.example.com" });
      expect(authoriseBrowser(r, null, NONE, "write")).toEqual({ ok: true, identity: null });
      const s = request("POST", { "sec-fetch-site": "same-origin" });
      expect(authoriseBrowser(s, null, NONE, "write")).toEqual({ ok: true, identity: null });
    });

    test("a cross-site read passes", () => {
      const r = request("GET", { "sec-fetch-site": "cross-site" });
      expect(authoriseBrowser(r, null, NONE, "read")).toEqual({ ok: true, identity: null });
    });
  });

  describe("proxy-header mode", () => {
    test("an untrusted peer is refused on a read", () => {
      const r = request("GET", { "remote-user": "ops" });
      expect(authoriseBrowser(r, "192.0.2.10", PROXY, "read")).toEqual({ ok: false, refusal: "untrusted-identity" });
      expect(authoriseBrowser(r, null, PROXY, "read")).toEqual({ ok: false, refusal: "untrusted-identity" });
    });

    test("a trusted peer without the identity header is refused on a read", () => {
      const r = request("GET", {});
      expect(authoriseBrowser(r, "127.0.0.1", PROXY, "read")).toEqual({ ok: false, refusal: "untrusted-identity" });
    });

    test("a trusted identity passes a read", () => {
      const r = request("GET", { "remote-user": "ops", "sec-fetch-site": "cross-site" });
      const result = authoriseBrowser(r, "127.0.0.1", PROXY, "read");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.identity?.subject).toBe("ops");
    });

    test("a trusted identity is refused on a cross-origin write and passes same-origin", () => {
      const cross = request("DELETE", { "remote-user": "ops", "sec-fetch-site": "cross-site" });
      expect(authoriseBrowser(cross, "127.0.0.1", PROXY, "write")).toEqual({ ok: false, refusal: "cross-origin" });
      const same = request("DELETE", { "remote-user": "ops", "sec-fetch-site": "same-origin" });
      const result = authoriseBrowser(same, "127.0.0.1", PROXY, "write");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.identity?.subject).toBe("ops");
    });

    test("an untrusted peer on a cross-origin write is refused (identity first)", () => {
      const r = request("POST", { "sec-fetch-site": "cross-site" });
      expect(authoriseBrowser(r, "192.0.2.10", PROXY, "write")).toEqual({ ok: false, refusal: "untrusted-identity" });
    });
  });

  test("both refusals answer the same 403 body", async () => {
    const a = await pushErrorResponse("cross-origin").text();
    const b = await pushErrorResponse("untrusted-identity").text();
    expect(a).toBe(b);
    expect(pushErrorResponse("cross-origin").status).toBe(403);
  });
});
