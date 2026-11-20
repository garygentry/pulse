/** capabilities.test.ts — the server capability registry. */

import { afterEach, describe, expect, test } from "bun:test";
import {
  KNOWN_SERVER_CAPABILITIES,
  SERVER_CAPABILITY_PATTERN,
  __resetCapabilityProvidersForTest,
  __seedCapabilityProviderForTest,
  currentServerCapabilities,
  registerCapabilityProvider,
  unregisterCapabilityProvider,
} from "../../src/contract/capabilities.js";
import { ContractError } from "../../src/contract/errors.js";

afterEach(() => {
  __resetCapabilityProvidersForTest();
});

/** Run `fn` and return the ContractError it throws. */
function thrown(fn: () => void): ContractError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("expected a ContractError");
}

describe("registerCapabilityProvider", () => {
  test("every known capability matches the grammar, and the list is frozen", () => {
    expect([...KNOWN_SERVER_CAPABILITIES]).toEqual(["push"]);
    expect(Object.isFrozen(KNOWN_SERVER_CAPABILITIES)).toBe(true);
    for (const name of KNOWN_SERVER_CAPABILITIES) expect(SERVER_CAPABILITY_PATTERN.test(name)).toBe(true);
  });

  test("a well-formed name outside the known list throws CAPABILITY_UNKNOWN", () => {
    const error = thrown(() => registerCapabilityProvider("future-thing", () => true));
    expect(error.code).toBe("CAPABILITY_UNKNOWN");
    expect(error.subject).toBe("future-thing");
    expect(error.name).toBe("ContractError");
    expect(error).toBeInstanceOf(Error);
    expect(currentServerCapabilities()).toEqual([]);
  });

  test("a known name registers, reports while available, and unregisters", () => {
    let available = true;
    registerCapabilityProvider("push", () => available);
    expect(currentServerCapabilities()).toEqual(["push"]);
    available = false;
    expect(currentServerCapabilities()).toEqual([]);
    unregisterCapabilityProvider("push");
    available = true;
    expect(currentServerCapabilities()).toEqual([]);
  });

  for (const bad of ["", "Push", "1push", "-push", "push_gateway", "push gateway", "a".repeat(33)]) {
    test(`invalid name ${JSON.stringify(bad.slice(0, 16))} throws CAPABILITY_INVALID_NAME before the known check`, () => {
      const error = thrown(() => registerCapabilityProvider(bad, () => true));
      expect(error.code).toBe("CAPABILITY_INVALID_NAME");
      expect(error.subject).toBe(bad);
    });
  }
});

describe("currentServerCapabilities", () => {
  test("an empty registry yields a frozen empty list", () => {
    const caps = currentServerCapabilities();
    expect(caps).toEqual([]);
    expect(Object.isFrozen(caps)).toBe(true);
  });

  test("output is sorted regardless of registration order", () => {
    for (const name of ["zeta", "alpha", "mid-1", "beta"]) __seedCapabilityProviderForTest(name, () => true);
    const caps = currentServerCapabilities();
    expect(caps).toEqual(["alpha", "beta", "mid-1", "zeta"]);
    expect(Object.isFrozen(caps)).toBe(true);
  });

  test("a throwing provider reports false and never propagates", () => {
    __seedCapabilityProviderForTest("alpha", () => true);
    __seedCapabilityProviderForTest("beta", () => {
      throw new Error("provider failure");
    });
    expect(currentServerCapabilities()).toEqual(["alpha"]);
  });

  test("only a strict `true` counts as available", () => {
    __seedCapabilityProviderForTest("alpha", () => false);
    __seedCapabilityProviderForTest("beta", (() => 1) as unknown as () => boolean);
    __seedCapabilityProviderForTest("gamma", (() => "yes") as unknown as () => boolean);
    __seedCapabilityProviderForTest("delta", () => true);
    expect(currentServerCapabilities()).toEqual(["delta"]);
  });

  test("providers are consulted on every call, and re-seeding replaces", () => {
    let available = false;
    __seedCapabilityProviderForTest("alpha", () => available);
    expect(currentServerCapabilities()).toEqual([]);
    available = true;
    expect(currentServerCapabilities()).toEqual(["alpha"]);
    __seedCapabilityProviderForTest("alpha", () => false);
    expect(currentServerCapabilities()).toEqual([]);
  });

  test("reset removes every provider", () => {
    __seedCapabilityProviderForTest("alpha", () => true);
    __resetCapabilityProvidersForTest();
    expect(currentServerCapabilities()).toEqual([]);
  });
});

describe("unregisterCapabilityProvider", () => {
  test("removes a seeded provider and leaves the others", () => {
    __seedCapabilityProviderForTest("alpha", () => true);
    __seedCapabilityProviderForTest("beta", () => true);
    unregisterCapabilityProvider("alpha");
    expect(currentServerCapabilities()).toEqual(["beta"]);
  });

  test("is idempotent: repeated, unknown and invalid names are no-ops that never throw", () => {
    __seedCapabilityProviderForTest("alpha", () => true);
    unregisterCapabilityProvider("alpha");
    expect(() => unregisterCapabilityProvider("alpha")).not.toThrow();
    expect(() => unregisterCapabilityProvider("never-registered")).not.toThrow();
    expect(() => unregisterCapabilityProvider("Not A Name")).not.toThrow();
    expect(currentServerCapabilities()).toEqual([]);
  });
});
