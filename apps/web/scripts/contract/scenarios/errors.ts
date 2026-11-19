// Router-level error fixtures: the envelopes any contract route can answer with, and the body served
// for every bundle failure kind.

import { BUNDLE_ERROR_KINDS, bundleErrorBody, errorEnvelopeBody } from "../stub-context.js";
import { jsonFixture } from "./common.js";
import type { ScenarioModule } from "./index.js";

export const errorScenarios: ScenarioModule = {
  group: "errors",
  operation: "GET /api/*",
  async build() {
    const fixtures = [
      jsonFixture(this, "invalid-request", "error", 400, await errorEnvelopeBody("INVALID_REQUEST", 400)),
      jsonFixture(this, "api-not-found", "error", 404, await errorEnvelopeBody("API_NOT_FOUND", 404)),
      jsonFixture(this, "internal-error", "error", 500, await errorEnvelopeBody("INTERNAL_ERROR", 500)),
    ];
    for (const kind of BUNDLE_ERROR_KINDS) {
      fixtures.push(jsonFixture(this, `bundle-error-${kind}`, "error", 503, await bundleErrorBody(kind)));
    }
    return fixtures;
  },
};
