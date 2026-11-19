// Handshake fixtures: one per row of the compatibility decision, written against CONTRACT_VERSION.

import {
  CONTRACT_VERSION,
  decideCompatibility,
  type ClientRequirement,
  type CompatibilityOutcome,
} from "@pulse/web-data/contract";
import type { ContractHandshake } from "@pulse/web-data/wire";

import { ContractToolError } from "../errors.js";
import type { HandshakeFixture } from "../types.js";
import { jsonFixture, jsonObject } from "./common.js";
import type { ScenarioModule } from "./index.js";
import { sessionBody } from "./session.js";

interface HandshakeRow {
  readonly scenario: string;
  readonly client: ClientRequirement;
  /** True for a server that predates the contract: its session has no `contract` member. */
  readonly withoutContract?: true;
  readonly expectedOutcome: CompatibilityOutcome;
}

const { major, minor } = CONTRACT_VERSION;

const ROWS: readonly HandshakeRow[] = [
  { scenario: "compatible", client: { major, minMinor: minor }, expectedOutcome: "compatible" },
  { scenario: "server-too-old-major", client: { major: major + 1, minMinor: 0 }, expectedOutcome: "server-too-old" },
  { scenario: "server-too-old-minor", client: { major, minMinor: minor + 1 }, expectedOutcome: "server-too-old" },
  {
    scenario: "server-too-old-absent",
    client: { major, minMinor: minor },
    withoutContract: true,
    expectedOutcome: "server-too-old",
  },
  { scenario: "client-too-old", client: { major: major - 1, minMinor: 0 }, expectedOutcome: "client-too-old" },
];

export const handshakeScenarios: ScenarioModule = {
  group: "handshake",
  operation: "handshake",
  async build() {
    const session = await sessionBody();
    return ROWS.map((row) => {
      const subject = `handshake/${row.scenario}`;
      const served = jsonObject(structuredClone(session), subject);
      if (row.withoutContract === true) delete served.contract;
      const contract = served.contract as Pick<ContractHandshake, "major" | "minor"> | undefined;
      const decided = decideCompatibility(row.client, contract);
      if (decided !== row.expectedOutcome) {
        throw new ContractToolError("SCENARIO_INVALID", subject, `decision is ${decided}, expected ${row.expectedOutcome}`);
      }
      const body = {
        client: row.client,
        session: served,
        expectedOutcome: row.expectedOutcome,
      } satisfies HandshakeFixture;
      return jsonFixture(this, row.scenario, "handshake", null, body, {
        client: row.client,
        expectedOutcome: row.expectedOutcome,
      });
    });
  },
};
