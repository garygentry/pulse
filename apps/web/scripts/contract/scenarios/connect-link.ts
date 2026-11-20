// Connect-link fixtures: links a client must accept, and links it must reject with a given reason.

import {
  buildConnectLink,
  PAIR_LINK_PARAM,
  PAIR_TOKEN_PATTERN,
  parseConnectLink,
  type ConnectLinkRejection,
} from "@pulse/web-data/contract";

import { ContractToolError } from "../errors.js";
import type { ConnectLinkFixture } from "../types.js";
import { jsonFixture, PLACEHOLDER } from "./common.js";
import type { ScenarioModule } from "./index.js";
import { PAIR_TOKEN_PLACEHOLDER } from "./push-common.js";

const BASE = PLACEHOLDER.baseUrl;
const ENCODED_BASE = encodeURIComponent(BASE);

/** A link built by the real builder; a refusal here is a generator defect. */
function built(scenario: string, base: string, extras: Readonly<Record<string, string>> = {}): ConnectLinkFixture {
  const result = buildConnectLink(base, extras);
  if (!result.ok) {
    throw new ContractToolError("SCENARIO_INVALID", `connect-link/${scenario}`, `link builder refused: ${result.refusal}`);
  }
  return { link: result.link, expect: "accept", baseUrl: result.baseUrl };
}

/** A link carrying a pairing token, which must match the token grammar. */
function pairLink(): ConnectLinkFixture {
  if (!PAIR_TOKEN_PATTERN.test(PAIR_TOKEN_PLACEHOLDER)) {
    throw new ContractToolError("SCENARIO_INVALID", "connect-link/with-pair-token", "the pairing token placeholder is malformed");
  }
  return built("with-pair-token", BASE, { [PAIR_LINK_PARAM]: PAIR_TOKEN_PLACEHOLDER });
}

function rejected(link: string, rejection: ConnectLinkRejection): ConnectLinkFixture {
  return { link, expect: "reject", rejection };
}

const ROWS: readonly (readonly [scenario: string, fixture: () => ConnectLinkFixture])[] = [
  ["basic", () => built("basic", `${BASE}/`)],
  ["with-path", () => built("with-path", `${BASE}/pulse/`)],
  ["unknown-param", () => built("unknown-param", BASE, { "future-param": "1" })],
  ["with-pair-token", () => pairLink()],
  ["wrong-scheme", () => rejected(`https://connect?v=1&url=${ENCODED_BASE}`, "wrong-scheme")],
  ["unsupported-version", () => rejected(`pulse://connect?v=2&url=${ENCODED_BASE}`, "unsupported-version")],
  ["missing-url", () => rejected("pulse://connect?v=1", "missing-url")],
  ["malformed-url", () => rejected("pulse://connect?v=1&url=not%20a%20url", "malformed-url")],
  ["http-url", () => rejected(`pulse://connect?v=1&url=${encodeURIComponent(BASE.replace("https:", "http:"))}`, "not-https")],
  // The https check comes before the loopback check, so a plain-http loopback link is `not-https`.
  ["http-loopback", () => rejected("pulse://connect?v=1&url=http%3A%2F%2Flocalhost", "not-https")],
];

/** The real parser must agree with the fixture before it is emitted. */
function assertParserAgrees(scenario: string, fixture: ConnectLinkFixture): void {
  const parsed = parseConnectLink(fixture.link);
  const agrees = parsed.ok
    ? fixture.expect === "accept" && parsed.baseUrl === fixture.baseUrl
    : fixture.expect === "reject" && parsed.rejection === fixture.rejection;
  if (!agrees) {
    throw new ContractToolError("SCENARIO_INVALID", `connect-link/${scenario}`, "the link parser disagrees with the fixture");
  }
}

export const connectLinkScenarios: ScenarioModule = {
  group: "connect-link",
  operation: "connect-link",
  async build() {
    return ROWS.map(([scenario, make]) => {
      const fixture = make();
      assertParserAgrees(scenario, fixture);
      return jsonFixture(this, scenario, "connect-link", null, fixture, {
        expect: fixture.expect,
        ...(fixture.rejection !== undefined ? { rejection: fixture.rejection } : {}),
      });
    });
  },
};
