import { describe, expect, test } from "bun:test";

import { currentBadge } from "../../src/server/push/badge.js";
import type { ServerRuntime } from "../../src/server/refresh.js";

type SourceState = "current" | "stale" | "unavailable" | "not-configured";

interface StubOptions {
  readonly cycle?: boolean;
  readonly modelError?: boolean;
  readonly alertmanager?: SourceState;
  readonly alerts?: number;
  readonly throwOn?: "getContext" | "getStatus";
}

/** A ServerRuntime stub exposing only what the badge reads. */
function stubRuntime(opts: StubOptions = {}): ServerRuntime {
  const alerts = Array.from({ length: opts.alerts ?? 3 }, (_, i) => ({ fingerprint: String(i) }));
  const cycle =
    opts.cycle === false
      ? null
      : {
          observation: { sources: { "alertmanager-alerts": { state: opts.alertmanager ?? "current" } } },
          overview: { value: { alerts } },
        };
  const stub = {
    getContext: () => {
      if (opts.throwOn === "getContext") throw new Error("boom");
      return { cycle };
    },
    getStatus: () => {
      if (opts.throwOn === "getStatus") throw new Error("boom");
      return { model: { loaded: true, formatVersion: 2, error: opts.modelError === true ? { code: "X" } : null } };
    },
  };
  return stub as unknown as ServerRuntime;
}

describe("currentBadge", () => {
  test("null runtime", () => {
    expect(currentBadge(null)).toBeNull();
  });

  test("no cycle yet", () => {
    expect(currentBadge(stubRuntime({ cycle: false }))).toBeNull();
  });

  test("model error", () => {
    expect(currentBadge(stubRuntime({ modelError: true }))).toBeNull();
  });

  for (const state of ["stale", "unavailable", "not-configured"] as const) {
    test(`alertmanager-alerts ${state}`, () => {
      expect(currentBadge(stubRuntime({ alertmanager: state }))).toBeNull();
    });
  }

  test("a throwing getContext or getStatus", () => {
    expect(currentBadge(stubRuntime({ throwOn: "getContext" }))).toBeNull();
    expect(currentBadge(stubRuntime({ throwOn: "getStatus" }))).toBeNull();
  });

  test("otherwise the overview strip length", () => {
    expect(currentBadge(stubRuntime({ alerts: 3 }))).toBe(3);
    expect(currentBadge(stubRuntime({ alerts: 0 }))).toBe(0);
    expect(currentBadge(stubRuntime({ alerts: 1024 }))).toBe(1024);
  });
});
