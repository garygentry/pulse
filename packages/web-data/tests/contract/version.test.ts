/** version.test.ts — contract version grammar and the handshake decision table. */

import { describe, expect, test } from "bun:test";
import {
  CONTRACT_VERSION,
  CONTRACT_VERSION_PATTERN,
  decideCompatibility,
  formatContractVersion,
  parseContractVersion,
  type ClientRequirement,
  type CompatibilityOutcome,
} from "../../src/contract/version.js";

describe("CONTRACT_VERSION", () => {
  test("is frozen and equals 1.1", () => {
    expect(CONTRACT_VERSION).toEqual({ major: 1, minor: 1 });
    expect(Object.isFrozen(CONTRACT_VERSION)).toBe(true);
    expect(formatContractVersion(CONTRACT_VERSION)).toBe("1.1");
  });

  test("the grammar pattern is stateless", () => {
    expect(CONTRACT_VERSION_PATTERN.flags).toBe("");
    expect(CONTRACT_VERSION_PATTERN.test("1.0")).toBe(true);
    expect(CONTRACT_VERSION_PATTERN.test("1.0")).toBe(true);
  });
});

describe("decideCompatibility", () => {
  type Row = readonly [
    client: ClientRequirement,
    server: { major: number; minor: number } | undefined,
    outcome: CompatibilityOutcome,
  ];
  const c = (major: number, minMinor: number): ClientRequirement => ({ major, minMinor });
  const s = (major: number, minor: number) => ({ major, minor });

  // The full decision table, row for row. An undefined server is a pre-contract server whose
  // session body has no `contract` member.
  const TABLE: readonly Row[] = [
    [c(1, 0), undefined, "server-too-old"],
    [c(1, 0), s(1, 0), "compatible"],
    [c(1, 0), s(1, 7), "compatible"],
    [c(1, 2), s(1, 2), "compatible"],
    [c(1, 2), s(1, 1), "server-too-old"],
    [c(1, 2), s(1, 0), "server-too-old"],
    [c(1, 0), s(2, 0), "client-too-old"],
    [c(1, 5), s(2, 0), "client-too-old"],
    [c(2, 0), s(1, 9), "server-too-old"],
    [c(0, 3), s(1, 0), "client-too-old"],
    [c(0, 0), undefined, "server-too-old"],
  ];

  for (const [client, server, outcome] of TABLE) {
    const label = server === undefined ? "absent" : `${server.major}.${server.minor}`;
    test(`client ${client.major}.${client.minMinor} vs server ${label} → ${outcome}`, () => {
      expect(decideCompatibility(client, server)).toBe(outcome);
    });
  }

  test("accepts a full handshake object and ignores its capabilities", () => {
    const handshake = { major: 1, minor: 0, capabilities: ["future-thing"] };
    expect(decideCompatibility(c(1, 0), handshake)).toBe("compatible");
  });
});

describe("parseContractVersion", () => {
  test("accepts well-formed versions", () => {
    expect(parseContractVersion("1.0")).toEqual({ major: 1, minor: 0 });
    expect(parseContractVersion("0.0")).toEqual({ major: 0, minor: 0 });
    expect(parseContractVersion("9999.9999")).toEqual({ major: 9999, minor: 9999 });
    expect(Object.isFrozen(parseContractVersion("1.0"))).toBe(true);
  });

  for (const bad of ["01.0", "1.00", "1", "1.0.0", " 1.0", "1.0 ", "10000.0", "1.10000", "-1.0", "+1.0", "1,0", "a.b", "", "1.0, 1.0"]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(parseContractVersion(bad)).toBeNull();
    });
  }

  test("rejects a 10 KiB string and non-string input without throwing", () => {
    expect(parseContractVersion("1".repeat(10 * 1024))).toBeNull();
    expect(parseContractVersion(undefined as unknown as string)).toBeNull();
    expect(parseContractVersion(10 as unknown as string)).toBeNull();
  });

  test("format/parse round trip", () => {
    for (const major of [0, 1, 9, 10, 999, 9999]) {
      for (const minor of [0, 1, 42, 9999]) {
        const v = { major, minor };
        expect(parseContractVersion(formatContractVersion(v))).toEqual(v);
      }
    }
  });
});
