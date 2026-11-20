import { describe, expect, test } from "bun:test";

import { devicesFileSchema, type DeviceRecord } from "../../src/server/push/registry/schema.js";
import { toDeviceSummary } from "../../src/server/push/registry/summary.js";

const TOKEN = `${"ab".repeat(29)}c0ffee`; // 64 lowercase hex chars

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dev_AbCdEfGhIjK",
    displayName: "Example iPhone",
    credentialHash: "0".repeat(63) + "f",
    apnsToken: TOKEN,
    environment: "sandbox",
    preferences: { critical: true, warning: true, info: false },
    pairedAt: "2026-11-01T00:00:00.000Z",
    seenAt: "2026-11-02T00:00:00.000Z",
    lastDelivery: { outcome: "delivered", at: "2026-11-02T00:00:00.000Z", reason: null },
    ...overrides,
  };
}

function file(devices: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { formatVersion: 1, devices, ...extra };
}

describe("devicesFileSchema", () => {
  test("accepts a valid file", () => {
    const parsed = devicesFileSchema.safeParse(
      file([
        record(),
        record({
          id: "dev_ZyXwVuTsRqP",
          apnsToken: null,
          environment: null,
          lastDelivery: null,
          credentialHash: "a".repeat(64),
        }),
      ]),
    );
    expect(parsed.success).toBe(true);
  });

  test("accepts an empty device list", () => {
    expect(devicesFileSchema.safeParse(file([])).success).toBe(true);
  });

  test.each([
    ["top level", file([record()], { extra: 1 })],
    ["device", file([record({ credential: "x" })])],
    ["preferences", file([record({ preferences: { critical: true, warning: true, info: true, debug: true } })])],
    [
      "lastDelivery",
      file([record({ lastDelivery: { outcome: "failed", at: "2026-11-02T00:00:00.000Z", reason: null, x: 1 } })]),
    ],
  ])("refuses an unknown member at the %s level", (_level, input) => {
    expect(devicesFileSchema.safeParse(input).success).toBe(false);
  });

  test.each([["not-an-id"], ["dev_short"], ["DEV_AbCdEfGhIjK"], ["dev_AbCdEfGhIj!"]])("refuses bad id %p", (id) => {
    expect(devicesFileSchema.safeParse(file([record({ id })])).success).toBe(false);
  });

  test("refuses an uppercase APNs token", () => {
    expect(devicesFileSchema.safeParse(file([record({ apnsToken: TOKEN.toUpperCase() })])).success).toBe(false);
  });

  test("refuses formatVersion 2", () => {
    expect(devicesFileSchema.safeParse({ formatVersion: 2, devices: [] }).success).toBe(false);
  });

  test.each([
    ["uppercase credentialHash", { credentialHash: "A".repeat(64) }],
    ["short credentialHash", { credentialHash: "a".repeat(63) }],
    ["display name with a control char", { displayName: "bad\u0007name" }],
    ["empty display name", { displayName: "" }],
    ["display name over 64 bytes", { displayName: "é".repeat(33) }],
    ["unknown environment", { environment: "staging" }],
    ["non-boolean preference", { preferences: { critical: 1, warning: true, info: true } }],
    ["unparseable instant", { pairedAt: "yesterday" }],
    ["short token", { apnsToken: "ab".repeat(31) }],
    ["unknown delivery outcome", { lastDelivery: { outcome: "lost", at: "2026-11-02T00:00:00.000Z", reason: null } }],
  ])("refuses %s", (_name, overrides) => {
    expect(devicesFileSchema.safeParse(file([record(overrides)])).success).toBe(false);
  });

  test("accepts a 64-byte display name", () => {
    expect(devicesFileSchema.safeParse(file([record({ displayName: "é".repeat(32) })])).success).toBe(true);
  });
});

describe("toDeviceSummary", () => {
  const parsed = devicesFileSchema.parse(file([record()]));
  const rec: DeviceRecord = parsed.devices[0] as DeviceRecord;

  test("has exactly the eight DeviceSummary keys", () => {
    expect(Object.keys(toDeviceSummary(rec)).sort()).toEqual(
      ["displayName", "environment", "id", "lastDelivery", "pairedAt", "preferences", "seenAt", "tokenSuffix"].sort(),
    );
  });

  test("tokenSuffix is the last 6 hex chars; credentialHash and the full token never appear", () => {
    const summary = toDeviceSummary(rec);
    expect(summary.tokenSuffix).toBe("c0ffee");
    const json = JSON.stringify(summary);
    expect(json).not.toContain(rec.credentialHash);
    expect(json).not.toContain(TOKEN);
    expect(summary).toEqual({
      id: rec.id,
      displayName: rec.displayName,
      pairedAt: rec.pairedAt,
      seenAt: rec.seenAt,
      environment: rec.environment,
      preferences: rec.preferences,
      tokenSuffix: "c0ffee",
      lastDelivery: rec.lastDelivery,
    });
  });

  test("tokenSuffix is null before registration", () => {
    expect(toDeviceSummary({ ...rec, apnsToken: null }).tokenSuffix).toBeNull();
  });
});
