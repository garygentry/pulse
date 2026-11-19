// Session fixtures. Every session body is the real `/api/session` handler's output.

import type { AuthMode, Identity } from "@pulse/web-data/identity";

import { setWritePathProvider } from "../../../src/server/mutations/session-provider.js";
import type { WritePathSnapshot } from "../../../src/server/mutations/write-path.js";
import { sessionRoute } from "../../../src/server/routes/session.js";
import { ContractToolError } from "../errors.js";
import { errorEnvelopeBody, responseBody, stubContext, stubRouteRequest } from "../stub-context.js";
import { jsonFixture, jsonObject, utf8OfBytes } from "./common.js";
import type { ScenarioModule } from "./index.js";

/** Identity header values are bounded at this many UTF-8 bytes by the identity resolver. */
const IDENTITY_VALUE_MAX_BYTES = 256;

const STORE_OK = { ok: true, reason: null } as const;
/** Every write-path store healthy: the state in which a trusted identity holds every capability. */
const HEALTHY_WRITE_PATH = {
  audit: STORE_OK,
  acks: STORE_OK,
  proposals: STORE_OK,
  secret: STORE_OK,
  alertmanager: STORE_OK,
} satisfies WritePathSnapshot;

const OPERATOR = {
  subject: "user-0001",
  displayName: "Example Operator",
  source: "proxy-header",
} satisfies Identity;

const LONGEST_IDENTITY = {
  subject: utf8OfBytes(IDENTITY_VALUE_MAX_BYTES),
  displayName: utf8OfBytes(IDENTITY_VALUE_MAX_BYTES),
  source: "proxy-header",
} satisfies Identity;

/** What one session call is made with. */
export interface SessionCall {
  /** Default null. */
  readonly identity?: Identity | null;
  /** Default "none". */
  readonly authMode?: AuthMode;
  /** Install a healthy write path for the call, so capabilities are granted. Default false. */
  readonly healthyWritePath?: boolean;
}

/** Call the real session handler and return its decoded 200 body. */
export async function sessionBody(call: SessionCall = {}): Promise<unknown> {
  if (call.healthyWritePath === true) setWritePathProvider(() => HEALTHY_WRITE_PATH);
  try {
    const context = stubContext({
      identity: call.identity ?? null,
      ...(call.authMode !== undefined ? { authMode: call.authMode } : {}),
    });
    return await responseBody(await sessionRoute.handler(stubRouteRequest("/api/session"), context), 200);
  } finally {
    setWritePathProvider(null);
  }
}

/** Guard: the trusted, healthy call must grant every capability, or the fixture would mislabel itself. */
function assertAllCapabilities(body: unknown, scenario: string): void {
  const flags = Object.values(jsonObject(jsonObject(body, `session/${scenario}`).capabilities, `session/${scenario}`));
  if (flags.length === 0 || flags.some((flag) => flag !== true)) {
    throw new ContractToolError("SCENARIO_INVALID", `session/${scenario}`, "expected every session capability to be true");
  }
}

export const sessionScenarios: ScenarioModule = {
  group: "session",
  operation: "GET /api/session",
  async build() {
    const trusted = { authMode: "proxy-header", healthyWritePath: true } as const;
    const empty = await sessionBody();
    const typical = await sessionBody({ ...trusted, identity: OPERATOR });
    // The session payload has no optional members; all-optional is typical with every nullable member set.
    const allOptional = await sessionBody({ ...trusted, identity: OPERATOR });
    const maxSize = await sessionBody({ ...trusted, identity: LONGEST_IDENTITY });
    assertAllCapabilities(typical, "typical");
    assertAllCapabilities(maxSize, "max-size");

    const unknownCapability = structuredClone(typical);
    jsonObject(jsonObject(unknownCapability, "session/unknown-capability").contract, "session/unknown-capability").capabilities =
      ["future-capability"];

    return [
      jsonFixture(this, "empty", "response", 200, empty),
      jsonFixture(this, "typical", "response", 200, typical),
      jsonFixture(this, "all-optional", "response", 200, allOptional),
      jsonFixture(this, "max-size", "response", 200, maxSize),
      jsonFixture(this, "error-invalid-request", "error", 400, await errorEnvelopeBody("INVALID_REQUEST", 400)),
      jsonFixture(this, "unknown-capability", "response", 200, unknownCapability),
    ];
  },
};
