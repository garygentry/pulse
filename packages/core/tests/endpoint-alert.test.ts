// packages/core/tests/endpoint-alert.test.ts — the shared endpoint-alert timing (@pulse/core/endpoint-alert).
// stack/alerting renders the GatusCheckFailed rule from these values and the web describes bindings
// from them; pin them to the documented behaviour (docs/operator/alerting.md).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ENDPOINT_ALERT_TIMING, endpointAlertClearWindowSeconds } from "../src/endpoint-alert/index.js";

describe("endpoint-alert timing", () => {
  test("defaults: 60s checks, F = 3, S = 2, clear factor 1.5", () => {
    expect(ENDPOINT_ALERT_TIMING).toEqual({
      checkIntervalSeconds: 60,
      defaultFailureThreshold: 3,
      defaultSuccessThreshold: 2,
      clearWindowFactor: 1.5,
    });
  });

  test("the clear window is ceil(1.5·S)·I + I (4m for S = 2, 3m for S = 1)", () => {
    expect(endpointAlertClearWindowSeconds(2)).toBe(240);
    expect(endpointAlertClearWindowSeconds(1)).toBe(180);
    expect(endpointAlertClearWindowSeconds(3)).toBe(360);
  });

  test("the package exports the subpath from dist", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as {
      exports: Record<string, { import: string }>;
    };
    expect(pkg.exports["./endpoint-alert"]?.import).toBe("./dist/endpoint-alert/index.js");
  });
});
