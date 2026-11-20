// Device registration fixtures: the request bodies a paired client sends to register for push notifications.

import type { DeviceRegistrationRequest } from "@pulse/web-data/wire";

import { PUSH_PATHS } from "../../../src/server/push/constants.js";
import { jsonFixture } from "./common.js";
import type { ScenarioModule } from "./index.js";
import { APNS_TOKEN_PLACEHOLDER } from "./push-common.js";

const TYPICAL = {
  apnsToken: APNS_TOKEN_PLACEHOLDER,
  environment: "production",
  preferences: { critical: true, warning: true, info: true },
} as const satisfies DeviceRegistrationRequest;

const { preferences: _omitted, ...WITHOUT_PREFERENCES } = TYPICAL;

/** Request rows: scenario, body, and the error code the server answers for a rejected body (null: accepted). */
const REQUEST_ROWS: readonly (readonly [scenario: string, body: unknown, rejection: "INVALID_REQUEST" | null])[] = [
  ["typical", TYPICAL, null],
  ["all-muted", { ...TYPICAL, preferences: { critical: false, warning: false, info: false } }, null],
  ["sandbox", { ...TYPICAL, environment: "sandbox" }, null],
  ["reject-token-format", { ...TYPICAL, apnsToken: "g".repeat(64) }, "INVALID_REQUEST"],
  ["reject-missing-preferences", WITHOUT_PREFERENCES, "INVALID_REQUEST"],
  ["reject-unknown-environment", { ...TYPICAL, environment: "staging" }, "INVALID_REQUEST"],
];

export const pushDeviceScenarios: ScenarioModule = {
  group: "push-device",
  operation: `PUT ${PUSH_PATHS.device}`,
  async build() {
    return REQUEST_ROWS.map(([scenario, body, rejection]) =>
      jsonFixture(this, scenario, "request", null, body, rejection === null ? {} : { expect: "reject", rejection }),
    );
  },
};
