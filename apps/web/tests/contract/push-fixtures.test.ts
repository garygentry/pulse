// The push fixtures: request bodies agree with the server's schemas and with a stub server, payloads follow the
// per-kind rules, and the server's success and error bodies keep their documented structure.

import { describe, expect, test } from "bun:test";

import { CONTRACT_LIMITS, currentServerCapabilities, PUSH_CATEGORIES } from "@pulse/web-data/contract";
import { ERROR_MESSAGES, type ApiErrorCode } from "@pulse/web-data/wire";

import {
  assertPushErrorBody,
  assertRedeemResponse,
  assertRegistrationResponse,
} from "../../scripts/contract/scenarios/push-common.js";
import { deviceServerVerdict } from "../../scripts/contract/scenarios/push-device.js";
import { pairingServerVerdict } from "../../scripts/contract/scenarios/push-pairing.js";
import type { FixtureIndexEntry } from "../../scripts/contract/types.js";
import {
  deviceRegistrationRequestSchema,
  pairingRedeemRequestSchema,
} from "../../src/server/push/handlers/schemas.js";
import { getRuntimeStatus } from "../../src/server/refresh.js";
import { renderMetrics } from "../../src/server/routes/metrics.js";
import { fixtureIndex, generatedText, GENERATION_TIMEOUT } from "./generated.js";

const UTF8 = new TextEncoder();
const bytes = (s: string): number => UTF8.encode(s).byteLength;

async function entries(): Promise<readonly FixtureIndexEntry[]> {
  return (await fixtureIndex()).fixtures.filter((entry) => entry.group.startsWith("push-"));
}

async function body(entry: FixtureIndexEntry): Promise<unknown> {
  return JSON.parse(await generatedText(`contract/${entry.path}`));
}

const SCHEMA_BY_GROUP = {
  "push-pairing": pairingRedeemRequestSchema,
  "push-device": deviceRegistrationRequestSchema,
} as const;

const PAYLOAD_SCENARIOS = [
  "firing-critical",
  "firing-warning",
  "firing-info",
  "firing-unknown-severity",
  "repeat",
  "resolved",
  "summary-mixed",
  "summary-resolved-only",
  "test",
  "no-badge",
  "truncated-max-length",
  "unknown-field",
] as const;

/** Loose view of a decoded payload for the rule checks. */
interface LoosePayload {
  aps: { alert: { title: string; body: string }; category: string; "interruption-level": string; sound?: unknown; badge?: unknown };
  pulse: {
    v: unknown;
    kind: string;
    collapseId: string | null;
    alert?: { status: string; fingerprint: string; severity: string };
    summary?: { severity: string | null };
    target: { screen: string; fingerprint?: string };
  };
}

describe("push fixtures", () => {
  test(
    "1. accepted request fixtures pass the server's body schema",
    async () => {
      const requests = (await entries()).filter((entry) => entry.kind === "request");
      expect(requests.length).toBe(12);
      for (const entry of requests) {
        const schema = SCHEMA_BY_GROUP[entry.group as keyof typeof SCHEMA_BY_GROUP];
        expect(schema).toBeDefined();
        const parsed = schema.safeParse(await body(entry));
        if (entry.expect === "accept") expect(`${entry.path} ${parsed.success}`).toBe(`${entry.path} true`);
      }
    },
    GENERATION_TIMEOUT,
  );

  test(
    "2. every request fixture gets the recorded verdict from a stub server, including the derived unknown-enum one",
    async () => {
      const requests = (await entries()).filter((entry) => entry.kind === "request");
      expect(requests.map((entry) => entry.scenario)).toContain("unknown-enum-push-environment");
      for (const entry of requests) {
        const rejection = entry.expect === "reject" ? (entry.rejection as ApiErrorCode) : null;
        const verdict =
          entry.group === "push-pairing"
            ? await pairingServerVerdict(await body(entry), rejection)
            : await deviceServerVerdict(await body(entry), rejection);
        expect(`${entry.path}: ${verdict ?? "agrees"}`).toBe(`${entry.path}: agrees`);
      }
    },
    GENERATION_TIMEOUT,
  );

  test(
    "3. every payload is at most the push payload limit",
    async () => {
      for (const entry of (await entries()).filter((e) => e.kind === "payload")) {
        const text = await generatedText(`contract/${entry.path}`);
        expect(bytes(JSON.stringify(JSON.parse(text)))).toBeLessThanOrEqual(CONTRACT_LIMITS.push.payloadBytes);
      }
    },
    GENERATION_TIMEOUT,
  );

  test(
    "4. payloads follow the per-kind rules",
    async () => {
      const payloads = (await entries()).filter((e) => e.kind === "payload" && !e.scenario.startsWith("unknown-"));
      expect(payloads.length).toBe(PAYLOAD_SCENARIOS.length - 1);
      for (const entry of payloads) {
        const { aps, pulse } = (await body(entry)) as LoosePayload;
        const where = entry.scenario;
        expect(pulse.v).toBe(1);
        expect(`${where} alert ${"alert" in pulse}`).toBe(`${where} alert ${pulse.kind === "alert"}`);
        expect(`${where} summary ${"summary" in pulse}`).toBe(`${where} summary ${pulse.kind === "summary"}`);
        expect(`${where} collapse ${pulse.collapseId === null}`).toBe(`${where} collapse ${pulse.kind === "test"}`);
        expect((PUSH_CATEGORIES as readonly string[]).includes(aps.category)).toBe(true);
        if (pulse.kind === "alert") {
          expect(aps.category).toBe(pulse.alert!.status === "resolved" ? "PULSE_ALERT_RESOLVED" : "PULSE_ALERT_FIRING");
          expect(pulse.target).toEqual({ screen: "alert", fingerprint: pulse.alert!.fingerprint });
        } else if (pulse.kind === "summary") {
          expect(aps.category).toBe("PULSE_ALERT_SUMMARY");
          expect(pulse.target).toEqual({ screen: "alerts" });
        } else {
          expect(pulse.kind).toBe("test");
          expect(aps.category).toBe("PULSE_TEST");
          expect(pulse.target).toEqual({ screen: "home" });
          expect(aps["interruption-level"]).toBe("active");
        }
        if (!("sound" in aps)) expect(`${where} ${aps["interruption-level"]}`).toBe(`${where} passive`);
        expect(bytes(aps.alert.title)).toBeLessThanOrEqual(CONTRACT_LIMITS.push.titleBytes);
        expect(bytes(aps.alert.body)).toBeLessThanOrEqual(CONTRACT_LIMITS.push.bodyBytes);
        if ("badge" in aps) expect(Number.isSafeInteger(aps.badge) && (aps.badge as number) >= 0).toBe(true);
      }
    },
    GENERATION_TIMEOUT,
  );

  test(
    "5. the payload scenarios cover every kind, every severity and the badge-less case",
    async () => {
      const payloads = (await entries()).filter((e) => e.group === "push-payload");
      const scenarios = payloads.map((e) => e.scenario);
      for (const name of PAYLOAD_SCENARIOS) expect(scenarios).toContain(name);
      const severities = new Set<string>();
      for (const entry of payloads.filter((e) => !e.scenario.startsWith("unknown-"))) {
        const { pulse } = (await body(entry)) as LoosePayload;
        if (pulse.alert !== undefined) severities.add(pulse.alert.severity);
        if (pulse.summary?.severity != null) severities.add(pulse.summary.severity);
      }
      for (const severity of ["critical", "warning", "info", "unknown"]) expect(severities.has(severity)).toBe(true);
      const noBadge = payloads.find((e) => e.scenario === "no-badge")!;
      expect("badge" in ((await body(noBadge)) as LoosePayload).aps).toBe(false);
    },
    GENERATION_TIMEOUT,
  );

  test(
    "6. success bodies pass the builders' guards and every error body is the catalogued envelope",
    async () => {
      const all = await entries();
      const redeemed = all.find((e) => e.group === "push-pairing" && e.scenario === "redeemed")!;
      const registered = all.find((e) => e.group === "push-device" && e.scenario === "registered")!;
      expect(redeemed.status).toBe(201);
      expect(registered.status).toBe(200);
      expect(() => assertRedeemResponse(undefined, "x")).toThrow();
      const redeemBody = await body(redeemed);
      assertRedeemResponse(redeemBody, redeemed.path);
      const registerBody = await body(registered);
      assertRegistrationResponse(registerBody, registered.path);

      const errors = all.filter((e) => e.kind === "error");
      expect(errors.map((e) => `${e.group}/${e.scenario} ${e.status}`).sort()).toEqual([
        "push-device/invalid-request 400",
        "push-device/payload-too-large 413",
        "push-device/push-unavailable 503",
        "push-device/unauthorized 401",
        "push-pairing/device-cap-reached 409",
        "push-pairing/invalid-request 400",
        "push-pairing/pairing-refused 403",
        "push-pairing/payload-too-large 413",
        "push-pairing/push-unavailable 503",
        "push-pairing/rate-limited 429",
      ]);
      for (const entry of errors) {
        const value = (await body(entry)) as { code: ApiErrorCode; message: string };
        expect(Object.keys(value).sort()).toEqual(["code", "message"]);
        expect(value.message).toBe(ERROR_MESSAGES[value.code]);
        assertPushErrorBody(value, value.code, entry.path);
      }
    },
    GENERATION_TIMEOUT,
  );

  test(
    "7. every push entry has no web validator",
    async () => {
      const all = await entries();
      expect(all.length).toBe(42);
      for (const entry of all) expect(`${entry.path} ${entry.webValidator}`).toBe(`${entry.path} null`);
    },
    GENERATION_TIMEOUT,
  );

  test(
    "generation leaves no capability or metrics provider installed",
    async () => {
      await fixtureIndex();
      expect(currentServerCapabilities()).toEqual([]);
      const pushLines = renderMetrics(getRuntimeStatus(), Date.now()).split("\n").filter((line) => line.startsWith("pulse_web_push_"));
      expect(pushLines).toEqual([
        'pulse_web_push_state{state="disabled"} 1',
        'pulse_web_push_state{state="configured"} 0',
        'pulse_web_push_state{state="misconfigured"} 0',
      ]);
    },
    GENERATION_TIMEOUT,
  );
});
