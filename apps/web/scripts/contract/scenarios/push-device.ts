// Device registration fixtures: the request bodies a paired client sends to register for push notifications,
// checked against a stub server, plus the server's success and error answers.

import { CONTRACT_LIMITS } from "@pulse/web-data/contract";
import type { ApiErrorCode, DeviceRegistrationRequest, DeviceRegistrationResponse } from "@pulse/web-data/wire";

import { PUSH_PATHS } from "../../../src/server/push/constants.js";
import { ContractToolError } from "../errors.js";
import { responseBody, type StubPushRuntime } from "../stub-context.js";
import type { ScenarioFixture } from "../types.js";
import { jsonFixture } from "./common.js";
import type { ScenarioModule } from "./index.js";
import { APNS_TOKEN_PLACEHOLDER, assertRegistrationResponse } from "./push-common.js";
import { pushErrorBody, verdictOf, withStub } from "./push-stub.js";

const GROUP = "push-device";

const TYPICAL = {
  apnsToken: APNS_TOKEN_PLACEHOLDER,
  environment: "production",
  preferences: { critical: true, warning: true, info: true },
} as const satisfies DeviceRegistrationRequest;

const { preferences: _omitted, ...WITHOUT_PREFERENCES } = TYPICAL;

/** A syntactically valid credential that no server issued. */
const PLACEHOLDER_CREDENTIAL = "A".repeat(43);

/** Request rows: scenario, body, and the error code the server answers for a rejected body (null: accepted). */
export const DEVICE_REQUEST_ROWS: readonly (readonly [scenario: string, body: unknown, rejection: "INVALID_REQUEST" | null])[] = [
  ["typical", TYPICAL, null],
  ["all-muted", { ...TYPICAL, preferences: { critical: false, warning: false, info: false } }, null],
  ["sandbox", { ...TYPICAL, environment: "sandbox" }, null],
  ["reject-token-format", { ...TYPICAL, apnsToken: "g".repeat(64) }, "INVALID_REQUEST"],
  ["reject-missing-preferences", WITHOUT_PREFERENCES, "INVALID_REQUEST"],
  ["reject-unknown-environment", { ...TYPICAL, environment: "staging" }, "INVALID_REQUEST"],
];

/** PUT the device route with `body`, authorised by `credential` when given. */
function register(stub: StubPushRuntime, body: unknown, credential: string | null): Promise<Response> {
  return stub.send("PUT", PUSH_PATHS.device, {
    body,
    ...(credential !== null ? { headers: { authorization: `Bearer ${credential}` } } : {}),
  });
}

/** Pair a device on `stub` and PUT `body` with its credential. */
async function registerPaired(stub: StubPushRuntime, body: unknown): Promise<Response> {
  const { credential } = await stub.pair();
  return register(stub, body, credential);
}

function errorBody(res: Response, status: number, code: ApiErrorCode, scenario: string): Promise<unknown> {
  return pushErrorBody(res, status, code, `${GROUP}/${scenario}`);
}

/**
 * Send a registration request fixture to a fresh configured server as a freshly paired device. An accepted body
 * must register (200); a rejected body must be refused with 400 and the fixture's code.
 *
 * @returns null when the server agrees, else why it does not
 */
export function deviceServerVerdict(body: unknown, rejection: ApiErrorCode | null): Promise<string | null> {
  return withStub({}, async (stub) => verdictOf(await registerPaired(stub, body), 200, rejection));
}

async function requestFixtures(target: ScenarioModule): Promise<ScenarioFixture[]> {
  const out: ScenarioFixture[] = [];
  for (const [scenario, body, rejection] of DEVICE_REQUEST_ROWS) {
    const disagreement = await deviceServerVerdict(body, rejection);
    if (disagreement !== null) {
      throw new ContractToolError("SCENARIO_INVALID", `${GROUP}/${scenario}`, `the server disagrees with the fixture (${disagreement})`);
    }
    out.push(jsonFixture(target, scenario, "request", null, body, rejection === null ? {} : { expect: "reject", rejection }));
  }
  return out;
}

export const pushDeviceScenarios: ScenarioModule = {
  group: GROUP,
  operation: `PUT ${PUSH_PATHS.device}`,
  async build() {
    const fixtures = await requestFixtures(this);

    const registered = await withStub({}, async (stub) => {
      const body = await responseBody(await registerPaired(stub, TYPICAL), 200);
      assertRegistrationResponse(body, `${GROUP}/registered`);
      return body satisfies DeviceRegistrationResponse;
    });

    const unauthorized = await withStub({}, async (stub) =>
      errorBody(await register(stub, TYPICAL, null), 401, "UNAUTHORIZED", "unauthorized"),
    );

    const invalidRequest = await withStub({}, async (stub) =>
      errorBody(await registerPaired(stub, "{"), 400, "INVALID_REQUEST", "invalid-request"),
    );

    const tooLarge = await withStub({}, async (stub) => {
      const body = JSON.stringify("a".repeat(CONTRACT_LIMITS.request.bodyBytes - 1)); // bodyBytes + 1 bytes
      return errorBody(await registerPaired(stub, body), 413, "PAYLOAD_TOO_LARGE", "payload-too-large");
    });

    const unavailable = await withStub({ state: "misconfigured" }, async (stub) =>
      errorBody(await register(stub, TYPICAL, PLACEHOLDER_CREDENTIAL), 503, "PUSH_UNAVAILABLE", "push-unavailable"),
    );

    fixtures.push(
      jsonFixture(this, "registered", "response", 200, registered),
      jsonFixture(this, "unauthorized", "error", 401, unauthorized),
      jsonFixture(this, "invalid-request", "error", 400, invalidRequest),
      jsonFixture(this, "payload-too-large", "error", 413, tooLarge),
      jsonFixture(this, "push-unavailable", "error", 503, unavailable),
    );
    return fixtures;
  },
};
