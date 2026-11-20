// The push route table: its twelve rows, path matching and labels, and the compile-time agreement between each json
// row's schema output and the body parameter of the binding it names.

import { describe, expect, test } from "bun:test";
import type { z } from "zod";

import { CONTRACT_LIMITS } from "@pulse/web-data/contract";

import { PUSH_PATHS } from "../../src/server/push/constants.js";
import {
  adminPairingRequestSchema,
  adminTestRequestSchema,
  deviceRegistrationRequestSchema,
  pairingRedeemRequestSchema,
} from "../../src/server/push/handlers/schemas.js";
import {
  isPushPath,
  matchPushPath,
  PUSH_ROUTES,
  pushRouteLabel,
  type PushHandlerName,
  type PushHandlers,
} from "../../src/server/push/routes.js";

// ---------------------------------------------------------------------------------------------------------------
// Compile-time: each json schema's output is assignable to its binding's body parameter (checked by typecheck).
// ---------------------------------------------------------------------------------------------------------------

type Assignable<From, To> = [From] extends [To] ? true : false;
type Assert<T extends true> = T;
/** The last parameter of a binding: its validated body. */
type BodyParam<N extends PushHandlerName> = Parameters<PushHandlers[N]> extends [...unknown[], infer B] ? B : never;

export type _RedeemBody = Assert<Assignable<z.output<typeof pairingRedeemRequestSchema>, BodyParam<"redeem">>>;
export type _RegisterBody = Assert<
  Assignable<z.output<typeof deviceRegistrationRequestSchema>, BodyParam<"registerDevice">>
>;
export type _AdminIssueBody = Assert<
  Assignable<z.output<typeof adminPairingRequestSchema>, BodyParam<"issueAdminToken">>
>;
export type _AdminTestBody = Assert<Assignable<z.output<typeof adminTestRequestSchema>, BodyParam<"adminTest">>>;

/** The json rows and the schema each must carry (the mapping the compile-time checks above rely on). */
const JSON_ROWS: ReadonlyArray<readonly [PushHandlerName, unknown, number]> = [
  ["redeem", pairingRedeemRequestSchema, CONTRACT_LIMITS.request.bodyBytes],
  ["registerDevice", deviceRegistrationRequestSchema, CONTRACT_LIMITS.request.bodyBytes],
  ["issueAdminToken", adminPairingRequestSchema, 4096],
  ["adminTest", adminTestRequestSchema, 4096],
];

// ---------------------------------------------------------------------------------------------------------------
// V-2.1 the table
// ---------------------------------------------------------------------------------------------------------------

const EXPECTED = [
  ["POST", "/api/push/pairings/redeem", "contract", "pairing-token", "redeem"],
  ["PUT", "/api/push/device", "contract", "device-credential", "registerDevice"],
  ["DELETE", "/api/push/device", "contract", "device-credential", "removeDevice"],
  ["POST", "/api/push/alertmanager", "webhook", "webhook-secret", "webhook"],
  ["GET", "/api/push/status", "web", "browser-read", "status"],
  ["POST", "/api/push/pairing-tokens", "web", "browser-write", "issueWebToken"],
  ["DELETE", "/api/push/pairing-tokens/current", "web", "browser-write", "cancelWebToken"],
  ["DELETE", "/api/push/devices/:id", "web", "browser-write", "revokeDevice"],
  ["POST", "/api/push/admin/pairing-tokens", "operator", "operator-secret", "issueAdminToken"],
  ["GET", "/api/push/admin/devices", "operator", "operator-secret", "listDevices"],
  ["DELETE", "/api/push/admin/devices/:id", "operator", "operator-secret", "adminRevokeDevice"],
  ["POST", "/api/push/admin/test", "operator", "operator-secret", "adminTest"],
] as const;

describe("PUSH_ROUTES", () => {
  test("V-2.1 exactly twelve rows matching the route list, with unique (method, template) pairs", () => {
    expect(PUSH_ROUTES).toHaveLength(12);
    expect(PUSH_ROUTES.map((r) => [r.method, r.template, r.cls, r.auth, r.handler])).toEqual(
      EXPECTED.map((row) => [...row]),
    );
    expect(new Set(PUSH_ROUTES.map((r) => `${r.method} ${r.template}`)).size).toBe(12);
    expect(new Set(PUSH_ROUTES.map((r) => r.handler)).size).toBe(12);
  });

  test("the table and every row are frozen", () => {
    expect(Object.isFrozen(PUSH_ROUTES)).toBe(true);
    for (const r of PUSH_ROUTES) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.body)).toBe(true);
    }
  });

  test("one authoriser per route, by class", () => {
    const byClass: Record<string, readonly string[]> = {
      contract: ["pairing-token", "device-credential"],
      webhook: ["webhook-secret"],
      web: ["browser-read", "browser-write"],
      operator: ["operator-secret"],
    };
    for (const r of PUSH_ROUTES) {
      expect(typeof r.auth).toBe("string");
      expect(byClass[r.cls]).toContain(r.auth);
      // Only GET routes use the read gate; every other web route is a write.
      if (r.cls === "web") expect(r.auth).toBe(r.method === "GET" ? "browser-read" : "browser-write");
    }
  });

  test("V-2.3 json rows carry the schema whose output fits the binding, and their caps", () => {
    const json = PUSH_ROUTES.filter((r) => r.body.kind === "json");
    expect(json.map((r) => r.handler).sort()).toEqual(JSON_ROWS.map(([h]) => h).sort());
    for (const [handler, schema, cap] of JSON_ROWS) {
      const row = PUSH_ROUTES.find((r) => r.handler === handler);
      if (row?.body.kind !== "json") throw new Error(`${handler} is not a json row`);
      expect(row.body.schema).toBe(schema as typeof row.body.schema);
      expect(row.body.cap).toBe(cap);
    }
    // The webhook reads its own body; every GET and DELETE row reads none.
    for (const r of PUSH_ROUTES) {
      if (r.handler === "webhook" || r.method === "GET" || r.method === "DELETE") expect(r.body.kind).toBe("none");
    }
    expect(PUSH_ROUTES.find((r) => r.handler === "issueWebToken")?.body.kind).toBe("none");
  });

  test("every template is a PUSH_PATHS value other than the prefix", () => {
    const paths = new Set<string>(Object.values(PUSH_PATHS).filter((p) => p !== PUSH_PATHS.prefix));
    expect(new Set<string>(PUSH_ROUTES.map((r) => r.template))).toEqual(paths);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// V-2.2 matching and labels
// ---------------------------------------------------------------------------------------------------------------

describe("matchPushPath and pushRouteLabel", () => {
  test("each literal template matches itself with no id", () => {
    for (const r of PUSH_ROUTES.filter((x) => !x.template.endsWith(":id"))) {
      expect(matchPushPath(r.template)).toEqual({ template: r.template, id: null, idValid: true });
    }
  });

  test("id templates: valid, invalid and percent-encoded ids", () => {
    expect(matchPushPath("/api/push/devices/dev_AAAAAAAAAAA")).toEqual({
      template: "/api/push/devices/:id",
      id: "dev_AAAAAAAAAAA",
      idValid: true,
    });
    expect(matchPushPath("/api/push/admin/devices/dev_AAAAAAAAAAA")).toEqual({
      template: "/api/push/admin/devices/:id",
      id: "dev_AAAAAAAAAAA",
      idValid: true,
    });
    expect(matchPushPath("/api/push/devices/x")).toEqual({ template: "/api/push/devices/:id", id: "x", idValid: false });
    expect(matchPushPath("/api/push/devices/dev%5FAAAAAAAAAAA")?.idValid).toBe(false);
  });

  test("non-matches: trailing slashes, empty and multi-segment ids, prefixes, case", () => {
    for (const p of [
      "/api/push/",
      "/api/push/status/",
      "/api/push/devices/",
      "/api/push/devices/a/b",
      "/api/push/admin",
      "/api/push/admin/",
      "/api/push/admin/devices/",
      "/api/push/Status",
      "/api/push/unknown",
      "/api/push/devicesx",
    ]) {
      expect(matchPushPath(p)).toBeNull();
    }
  });

  test("/api/push/device is never confused with /api/push/devices/…", () => {
    expect(matchPushPath("/api/push/device")?.template).toBe("/api/push/device");
    expect(matchPushPath("/api/push/device/dev_AAAAAAAAAAA")).toBeNull();
    expect(matchPushPath("/api/push/devices")).toBeNull();
  });

  test("labels are the template for every method, and null for an unmatched path", () => {
    for (const r of PUSH_ROUTES) {
      const path = r.template.replace(":id", "dev_AAAAAAAAAAA");
      for (const m of ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) expect(pushRouteLabel(m, path)).toBe(r.template);
    }
    expect(pushRouteLabel("DELETE", "/api/push/devices/x")).toBe("/api/push/devices/:id");
    expect(pushRouteLabel("GET", "/api/push/unknown")).toBeNull();
    // Bounded: twelve templates (eleven distinct) and nothing else.
    expect(new Set(PUSH_ROUTES.map((r) => r.template)).size).toBe(11);
  });

  test("isPushPath is the prefix test", () => {
    expect(isPushPath("/api/push/")).toBe(true);
    expect(isPushPath("/api/push/x/y")).toBe(true);
    expect(isPushPath("/api/push")).toBe(false);
    expect(isPushPath("/api/pushx")).toBe(false);
  });
});
