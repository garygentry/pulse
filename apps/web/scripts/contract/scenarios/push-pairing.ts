// Pairing redemption fixtures: the request bodies a client sends to redeem a pairing token, checked against a stub
// server, plus the server's success and error answers.

import { CONTRACT_LIMITS } from "@pulse/web-data/contract";
import type { ApiErrorCode, PairingRedeemResponse } from "@pulse/web-data/wire";

import { PUSH_LIMITS, PUSH_PATHS } from "../../../src/server/push/constants.js";
import { ContractToolError } from "../errors.js";
import { responseBody, type StubPushRuntime } from "../stub-context.js";
import type { ScenarioFixture } from "../types.js";
import { jsonFixture, utf8OfBytes } from "./common.js";
import type { ScenarioModule } from "./index.js";
import {
  assertRedeemResponse,
  DISPLAY_NAME_PLACEHOLDER,
  PAIR_TOKEN_PLACEHOLDER,
} from "./push-common.js";
import { pushErrorBody, verdictOf, withStub } from "./push-stub.js";

const GROUP = "push-pairing";
const TYPICAL = { token: PAIR_TOKEN_PLACEHOLDER, displayName: DISPLAY_NAME_PLACEHOLDER } as const;

/** Request rows: scenario, body, and the error code the server answers for a rejected body (null: accepted). */
export const PAIRING_REQUEST_ROWS: readonly (readonly [scenario: string, body: unknown, rejection: "INVALID_REQUEST" | null])[] = [
  ["typical", TYPICAL, null],
  ["max-length-name", { ...TYPICAL, displayName: utf8OfBytes(64) }, null],
  ["reject-name-too-long", { ...TYPICAL, displayName: utf8OfBytes(65) }, "INVALID_REQUEST"],
  ["reject-name-charset", { ...TYPICAL, displayName: `${DISPLAY_NAME_PLACEHOLDER}!` }, "INVALID_REQUEST"],
  ["reject-unknown-field", { ...TYPICAL, "future-field": "1" }, "INVALID_REQUEST"],
];

/** POST the redeem route with `body`. */
function redeem(stub: StubPushRuntime, body: unknown): Promise<Response> {
  return stub.send("POST", PUSH_PATHS.redeem, { body });
}

function errorBody(res: Response, status: number, code: ApiErrorCode, scenario: string): Promise<unknown> {
  return pushErrorBody(res, status, code, `${GROUP}/${scenario}`);
}

/**
 * Send a pairing request fixture to a fresh configured server. An accepted body has its token replaced by a freshly
 * issued one and must redeem (201); a rejected body must be refused with 400 and the fixture's code.
 *
 * @returns null when the server agrees, else why it does not
 */
export async function pairingServerVerdict(body: unknown, rejection: ApiErrorCode | null): Promise<string | null> {
  return withStub({}, async (stub) => {
    let sent = body;
    if (rejection === null && typeof body === "object" && body !== null) sent = { ...body, token: await stub.issueToken() };
    return verdictOf(await redeem(stub, sent), 201, rejection);
  });
}

async function requestFixtures(target: ScenarioModule): Promise<ScenarioFixture[]> {
  const out: ScenarioFixture[] = [];
  for (const [scenario, body, rejection] of PAIRING_REQUEST_ROWS) {
    const disagreement = await pairingServerVerdict(body, rejection);
    if (disagreement !== null) {
      throw new ContractToolError("SCENARIO_INVALID", `${GROUP}/${scenario}`, `the server disagrees with the fixture (${disagreement})`);
    }
    out.push(jsonFixture(target, scenario, "request", null, body, rejection === null ? {} : { expect: "reject", rejection }));
  }
  return out;
}

export const pushPairingScenarios: ScenarioModule = {
  group: GROUP,
  operation: `POST ${PUSH_PATHS.redeem}`,
  async build() {
    const fixtures = await requestFixtures(this);

    const redeemed = await withStub({}, async (stub) => {
      const token = await stub.issueToken();
      if (token !== PAIR_TOKEN_PLACEHOLDER) {
        throw new ContractToolError("SCENARIO_INVALID", `${GROUP}/redeemed`, "the seeded token is not the placeholder");
      }
      const body = await responseBody(await redeem(stub, TYPICAL), 201);
      assertRedeemResponse(body, `${GROUP}/redeemed`);
      return body satisfies PairingRedeemResponse;
    });

    const refused = await withStub({}, async (stub) => errorBody(await redeem(stub, TYPICAL), 403, "PAIRING_REFUSED", "pairing-refused"));

    const capReached = await withStub({ maxDevices: 1 }, async (stub) => {
      await stub.pair();
      const token = await stub.issueToken();
      return errorBody(await redeem(stub, { ...TYPICAL, token }), 409, "DEVICE_CAP_REACHED", "device-cap-reached");
    });

    const rateLimited = await withStub({}, async (stub) => {
      for (let i = 0; i < PUSH_LIMITS.limiterMaxFailures; i += 1) {
        await errorBody(await redeem(stub, TYPICAL), 403, "PAIRING_REFUSED", "rate-limited");
      }
      const res = await redeem(stub, TYPICAL);
      if (res.headers.get("retry-after") === null) {
        throw new ContractToolError("SCENARIO_INVALID", `${GROUP}/rate-limited`, "a 429 must carry Retry-After");
      }
      return errorBody(res, 429, "RATE_LIMITED", "rate-limited");
    });

    const invalidRequest = await withStub({}, async (stub) => errorBody(await redeem(stub, "{"), 400, "INVALID_REQUEST", "invalid-request"));

    const tooLarge = await withStub({}, async (stub) => {
      const body = JSON.stringify("a".repeat(CONTRACT_LIMITS.request.bodyBytes - 1)); // bodyBytes + 1 bytes
      return errorBody(await redeem(stub, body), 413, "PAYLOAD_TOO_LARGE", "payload-too-large");
    });

    const unavailable = await withStub({ state: "misconfigured" }, async (stub) =>
      errorBody(await redeem(stub, TYPICAL), 503, "PUSH_UNAVAILABLE", "push-unavailable"),
    );

    fixtures.push(
      jsonFixture(this, "redeemed", "response", 201, redeemed),
      jsonFixture(this, "pairing-refused", "error", 403, refused),
      jsonFixture(this, "device-cap-reached", "error", 409, capReached),
      jsonFixture(this, "rate-limited", "error", 429, rateLimited),
      jsonFixture(this, "invalid-request", "error", 400, invalidRequest),
      jsonFixture(this, "payload-too-large", "error", 413, tooLarge),
      jsonFixture(this, "push-unavailable", "error", 503, unavailable),
    );
    return fixtures;
  },
};
