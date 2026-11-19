/** announcement.test.ts — client announcement headers and the bounded handshake metric labels. */

import { afterEach, describe, expect, test } from "bun:test";
import {
  CLIENT_HEADER,
  CONTRACT_HEADER,
  KNOWN_CLIENTS,
  handshakeLabels,
  parseClientAnnouncement,
  type HandshakeLabels,
} from "../../src/contract/announcement.js";
import { __resetCapabilityProvidersForTest } from "../../src/contract/capabilities.js";
import { CONTRACT_VERSION } from "../../src/contract/version.js";

afterEach(() => {
  __resetCapabilityProvidersForTest();
});

/** Build request headers from optional client / contract values. */
function headers(client?: string, contract?: string): Headers {
  const h = new Headers();
  if (client !== undefined) h.set("X-Pulse-Client", client);
  if (contract !== undefined) h.set("X-Pulse-Contract", contract);
  return h;
}

const CLIENT_LABELS: readonly string[] = [...KNOWN_CLIENTS, "other", "none"];
const MAJOR_LABELS: readonly string[] = [
  ...Array.from({ length: CONTRACT_VERSION.major + 2 }, (_, i) => String(i)),
  "other",
  "none",
];
const OUTCOME_LABELS: readonly string[] = ["compatible", "server_too_old", "client_too_old", "not_announced"];

describe("parseClientAnnouncement", () => {
  test("header names are the lower-case forms", () => {
    expect(CLIENT_HEADER).toBe("x-pulse-client");
    expect(CONTRACT_HEADER).toBe("x-pulse-contract");
  });

  test("parses a well-formed announcement into a frozen result", () => {
    const a = parseClientAnnouncement(headers("ios", "1.3"));
    expect(a).toEqual({ name: "ios", requirement: { major: 1, minMinor: 3 } });
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.requirement)).toBe(true);
  });

  test("absent headers give nulls", () => {
    expect(parseClientAnnouncement(headers())).toEqual({ name: null, requirement: null });
  });

  test("client name grammar: no case folding, bounded length, safe charset", () => {
    expect(parseClientAnnouncement(headers("my-app-2")).name).toBe("my-app-2");
    expect(parseClientAnnouncement(headers("a".repeat(32))).name).toBe("a".repeat(32));
    for (const bad of ["iOS", "a".repeat(33), "ios widget", "ios_widget", "ios/1.0", "ios;x", "", "ïos"]) {
      expect(parseClientAnnouncement(headers(bad)).name).toBeNull();
    }
  });

  test("contract header grammar", () => {
    for (const bad of ["01.0", "1", "1.0.0", "v1.0", "1.x", "10000.0", ""]) {
      expect(parseClientAnnouncement(headers("ios", bad)).requirement).toBeNull();
    }
    expect(parseClientAnnouncement(headers("ios", "9999.9999")).requirement).toEqual({ major: 9999, minMinor: 9999 });
  });

  test("the two headers are independent", () => {
    expect(parseClientAnnouncement(headers("ios", "nope"))).toEqual({ name: "ios", requirement: null });
    expect(parseClientAnnouncement(headers("iOS", "1.0"))).toEqual({ name: null, requirement: { major: 1, minMinor: 0 } });
    expect(parseClientAnnouncement(headers(undefined, "1.0"))).toEqual({ name: null, requirement: { major: 1, minMinor: 0 } });
  });

  test("a duplicate header is comma-joined by Headers and counts as not announced", () => {
    const h = new Headers();
    h.append("X-Pulse-Client", "ios");
    h.append("X-Pulse-Client", "ios");
    h.append("X-Pulse-Contract", "1.0");
    h.append("X-Pulse-Contract", "1.0");
    expect(h.get(CONTRACT_HEADER)).toBe("1.0, 1.0");
    expect(parseClientAnnouncement(h)).toEqual({ name: null, requirement: null });
    expect(handshakeLabels(parseClientAnnouncement(h))).toEqual({
      client: "none",
      contractMajor: "none",
      outcome: "not_announced",
    });
  });

  test("oversize values are rejected by the length guard, not the regex", () => {
    const huge = "a".repeat(1024 * 1024);
    const hugeDigits = "1".repeat(1024 * 1024);
    const started = performance.now();
    for (let i = 0; i < 200; i += 1) {
      expect(parseClientAnnouncement(headers(huge, hugeDigits))).toEqual({ name: null, requirement: null });
    }
    // 200 parses of two 1 MiB values; generous bound that only an O(n) regex scan per call would approach.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("handshakeLabels", () => {
  type Row = readonly [client: string | undefined, contract: string | undefined, labels: HandshakeLabels];
  const TABLE: readonly Row[] = [
    ["ios", "1.0", { client: "ios", contractMajor: "1", outcome: "compatible" }],
    ["ios-widget", "1.3", { client: "ios-widget", contractMajor: "1", outcome: "server_too_old" }],
    ["ios", "2.0", { client: "ios", contractMajor: "2", outcome: "server_too_old" }],
    ["ios", "0.4", { client: "ios", contractMajor: "0", outcome: "client_too_old" }],
    ["my-app", "9999.0", { client: "other", contractMajor: "other", outcome: "server_too_old" }],
    ["iOS", "1.0", { client: "none", contractMajor: "1", outcome: "compatible" }],
    ["ios", undefined, { client: "ios", contractMajor: "none", outcome: "not_announced" }],
    ["ios", "01.0", { client: "ios", contractMajor: "none", outcome: "not_announced" }],
    ["ios", "1.0, 1.0", { client: "ios", contractMajor: "none", outcome: "not_announced" }],
    [undefined, undefined, { client: "none", contractMajor: "none", outcome: "not_announced" }],
  ];

  for (const [client, contract, labels] of TABLE) {
    test(`${client ?? "(absent)"} / ${contract ?? "(absent)"}`, () => {
      const result = handshakeLabels(parseClientAnnouncement(headers(client, contract)));
      expect(result).toEqual(labels);
      expect(Object.isFrozen(result)).toBe(true);
    });
  }

  test("hostile announcements only ever produce labels from the closed sets (≤ 80 tuples)", () => {
    // Deterministic PRNG so a failure reproduces.
    let seed = 0x2f6e2b1;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const randomText = (length: number): string => {
      let out = "";
      // Printable Latin-1 without CR/LF/NUL, which Headers refuses outright.
      for (let i = 0; i < length; i += 1) out += String.fromCharCode(0x20 + (next() % 0xdf));
      return out;
    };

    const clients: (string | undefined)[] = [
      undefined, "", "ios", "ios-widget", "iOS", "IOS", "other", "none", "my-app", "a".repeat(32), "a".repeat(33),
      "ios, ios", "ios,ios-widget", "ios\tx", "a".repeat(10 * 1024), 'ios"} 1\npulse', "{client=\"x\"}",
    ];
    const contracts: (string | undefined)[] = [
      undefined, "", "1.0", "1.0, 1.0", "01.0", "1.00", "1", "1.0.0", "-1.0", "1.-0", "1e3.0", "0x1.0", "١.٠",
      "10000.0", "1.10000", "1".repeat(10 * 1024), "none", "other",
    ];
    for (let major = 0; major <= 9999; major += 1) contracts.push(`${major}.0`);
    for (const minor of [1, 9, 10, 9999]) for (const major of [0, 1, 2, 3, 9999]) contracts.push(`${major}.${minor}`);
    for (let i = 0; i < 300; i += 1) {
      clients.push(randomText(1 + (next() % 48)));
      contracts.push(randomText(1 + (next() % 12)));
    }

    const tuples = new Set<string>();
    const record = (client: string | undefined, contract: string | undefined): void => {
      let h: Headers;
      try {
        h = headers(client, contract);
      } catch {
        return; // Headers itself refused the value; it can never reach the parser.
      }
      const labels = handshakeLabels(parseClientAnnouncement(h));
      expect(CLIENT_LABELS).toContain(labels.client);
      expect(MAJOR_LABELS).toContain(labels.contractMajor);
      expect(OUTCOME_LABELS).toContain(labels.outcome);
      tuples.add(`${labels.client}|${labels.contractMajor}|${labels.outcome}`);
    };
    for (const contract of contracts) for (const client of clients.slice(0, 17)) record(client, contract);
    for (const client of clients) for (const contract of contracts.slice(0, 18)) record(client, contract);

    // Repeated headers.
    const repeated = new Headers();
    repeated.append("X-Pulse-Client", "ios");
    repeated.append("X-Pulse-Client", "my-app");
    repeated.append("X-Pulse-Contract", "1.0");
    repeated.append("X-Pulse-Contract", "2.0");
    const labels = handshakeLabels(parseClientAnnouncement(repeated));
    tuples.add(`${labels.client}|${labels.contractMajor}|${labels.outcome}`);
    expect(labels).toEqual({ client: "none", contractMajor: "none", outcome: "not_announced" });

    const bound = CLIENT_LABELS.length * MAJOR_LABELS.length * OUTCOME_LABELS.length;
    expect(bound).toBe(80);
    expect(tuples.size).toBeLessThanOrEqual(bound);
    expect(tuples.size).toBeGreaterThan(8); // the hostile set genuinely exercises several branches
  });

  test("labels never echo an unrecognised announced value", () => {
    const labels = handshakeLabels({ name: "my-app", requirement: { major: 7, minMinor: 0 } });
    expect(labels).toEqual({ client: "other", contractMajor: "other", outcome: "server_too_old" });
  });
});
