// apps/web/tests/push/classify.test.ts — APNs result classification (one case per table row) and reason sanitising.

import { describe, expect, test } from "bun:test";

import type { ApnsClassification, ApnsResult } from "../../src/server/push/apns/client.js";
import { classifyApnsResponse, sanitizeApnsReason } from "../../src/server/push/dispatch/classify.js";

function res(status: number, reason: string | null = null): ApnsResult {
  return { kind: "response", status, reason };
}

const ROWS: ReadonlyArray<readonly [string, ApnsResult, ApnsClassification]> = [
  ["200 → delivered", res(200), { kind: "delivered" }],
  ["200 with a reason → delivered", res(200, "Whatever"), { kind: "delivered" }],
  ["410 Unregistered → dead-token", res(410, "Unregistered"), { kind: "dead-token", reason: "Unregistered" }],
  ["410 ExpiredToken → dead-token", res(410, "ExpiredToken"), { kind: "dead-token", reason: "ExpiredToken" }],
  ["410 null → dead-token Unregistered", res(410, null), { kind: "dead-token", reason: "Unregistered" }],
  ["410 unknown reason → permanent", res(410, "SomethingNew"), { kind: "permanent", reason: "SomethingNew" }],
  ["410 malformed reason → permanent other", res(410, "Bad Token"), { kind: "permanent", reason: "other" }],
  ["400 BadDeviceToken → permanent", res(400, "BadDeviceToken"), { kind: "permanent", reason: "BadDeviceToken" }],
  [
    "400 DeviceTokenNotForTopic → permanent",
    res(400, "DeviceTokenNotForTopic"),
    { kind: "permanent", reason: "DeviceTokenNotForTopic" },
  ],
  ["400 other → permanent", res(400, "BadCollapseId"), { kind: "permanent", reason: "BadCollapseId" }],
  ["403 ExpiredProviderToken → auth-expired", res(403, "ExpiredProviderToken"), { kind: "auth-expired" }],
  [
    "403 InvalidProviderToken → auth-failed",
    res(403, "InvalidProviderToken"),
    { kind: "auth-failed", reason: "InvalidProviderToken" },
  ],
  [
    "403 MissingProviderToken → auth-failed",
    res(403, "MissingProviderToken"),
    { kind: "auth-failed", reason: "MissingProviderToken" },
  ],
  ["403 other → permanent", res(403, "BadCertificate"), { kind: "permanent", reason: "BadCertificate" }],
  ["413 → permanent", res(413, "PayloadTooLarge"), { kind: "permanent", reason: "PayloadTooLarge" }],
  ["429 TooManyRequests → transient", res(429, "TooManyRequests"), { kind: "transient", reason: "TooManyRequests" }],
  [
    "429 TooManyProviderTokenUpdates → transient",
    res(429, "TooManyProviderTokenUpdates"),
    { kind: "transient", reason: "TooManyProviderTokenUpdates" },
  ],
  ["500 → transient", res(500, "InternalServerError"), { kind: "transient", reason: "InternalServerError" }],
  ["503 → transient", res(503, "ServiceUnavailable"), { kind: "transient", reason: "ServiceUnavailable" }],
  ["502 → transient", res(502), { kind: "transient", reason: "other" }],
  ["504 → transient", res(504), { kind: "transient", reason: "other" }],
  ["404 BadPath → permanent", res(404, "BadPath"), { kind: "permanent", reason: "BadPath" }],
  ["405 → permanent", res(405, "MethodNotAllowed"), { kind: "permanent", reason: "MethodNotAllowed" }],
  ["201 → permanent", res(201), { kind: "permanent", reason: "other" }],
  ["302 → permanent", res(302), { kind: "permanent", reason: "other" }],
  ["error timeout → transient", { kind: "error", error: "timeout" }, { kind: "transient", reason: "timeout" }],
  ["error connection → transient", { kind: "error", error: "connection" }, { kind: "transient", reason: "connection" }],
  ["error session → transient", { kind: "error", error: "session" }, { kind: "transient", reason: "session" }],
];

describe("classifyApnsResponse", () => {
  for (const [name, input, expected] of ROWS) {
    test(name, () => {
      expect(classifyApnsResponse(input)).toEqual(expected);
    });
  }

  test("only 410 with Unregistered/ExpiredToken/null is dead-token", () => {
    const reasons = [null, "Unregistered", "ExpiredToken", "BadDeviceToken", "other", "Bad Token"];
    for (let status = 100; status <= 599; status += 1) {
      for (const reason of reasons) {
        const c = classifyApnsResponse(res(status, reason));
        const dead = status === 410 && (reason === null || reason === "Unregistered" || reason === "ExpiredToken");
        expect(c.kind === "dead-token").toBe(dead);
      }
    }
  });
});

describe("sanitizeApnsReason", () => {
  test("malformed or missing reasons become other", () => {
    for (const raw of ["Bad Token", "x".repeat(65), "", "Bäd", null]) {
      expect(sanitizeApnsReason(raw)).toBe("other");
    }
  });

  test("well-formed reasons pass through, including the 64-character maximum", () => {
    expect(sanitizeApnsReason("BadDeviceToken")).toBe("BadDeviceToken");
    expect(sanitizeApnsReason("x".repeat(64))).toBe("x".repeat(64));
  });
});
