// Pairing redemption fixtures: the request bodies a client sends to redeem a pairing token.

import { PUSH_PATHS } from "../../../src/server/push/constants.js";
import { jsonFixture, utf8OfBytes } from "./common.js";
import type { ScenarioModule } from "./index.js";
import { DISPLAY_NAME_PLACEHOLDER, PAIR_TOKEN_PLACEHOLDER } from "./push-common.js";

const TYPICAL = { token: PAIR_TOKEN_PLACEHOLDER, displayName: DISPLAY_NAME_PLACEHOLDER } as const;

/** Request rows: scenario, body, and the error code the server answers for a rejected body (null: accepted). */
const REQUEST_ROWS: readonly (readonly [scenario: string, body: unknown, rejection: "INVALID_REQUEST" | null])[] = [
  ["typical", TYPICAL, null],
  ["max-length-name", { ...TYPICAL, displayName: utf8OfBytes(64) }, null],
  ["reject-name-too-long", { ...TYPICAL, displayName: utf8OfBytes(65) }, "INVALID_REQUEST"],
  ["reject-name-charset", { ...TYPICAL, displayName: `${DISPLAY_NAME_PLACEHOLDER}!` }, "INVALID_REQUEST"],
  ["reject-unknown-field", { ...TYPICAL, "future-field": "1" }, "INVALID_REQUEST"],
];

export const pushPairingScenarios: ScenarioModule = {
  group: "push-pairing",
  operation: `POST ${PUSH_PATHS.redeem}`,
  async build() {
    return REQUEST_ROWS.map(([scenario, body, rejection]) =>
      jsonFixture(this, scenario, "request", null, body, rejection === null ? {} : { expect: "reject", rejection }),
    );
  },
};
