/** barrel.test.ts — the `@pulse/web-data/contract` barrel exposes exactly the documented runtime exports.
 *
 *  The barrel is imported from source; `clean-build.test.ts` proves the `./contract` subpath of the built package
 *  resolves to this same module. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as contract from "../../src/contract/index.js";

type Kind = "function" | "object" | "string" | "number" | "regexp" | "class";

/** Every runtime (value) export of the barrel, with its kind. Type-only exports leave no runtime trace. */
const RUNTIME_EXPORTS: Readonly<Record<string, Kind>> = {
  // version
  CONTRACT_VERSION: "object",
  CONTRACT_VERSION_PATTERN: "regexp",
  decideCompatibility: "function",
  formatContractVersion: "function",
  parseContractVersion: "function",
  // capabilities
  KNOWN_SERVER_CAPABILITIES: "object",
  SERVER_CAPABILITY_PATTERN: "regexp",
  currentServerCapabilities: "function",
  registerCapabilityProvider: "function",
  __resetCapabilityProvidersForTest: "function",
  // limits
  CONTRACT_LIMITS: "object",
  capList: "function",
  truncateUtf8: "function",
  // enums
  ENUM_FALLBACKS: "object",
  // announcement
  CLIENT_HEADER: "string",
  CLIENT_NAME_PATTERN: "regexp",
  CONTRACT_HEADER: "string",
  KNOWN_CLIENTS: "object",
  handshakeLabels: "function",
  parseClientAnnouncement: "function",
  // connect link
  CONNECT_LINK_FORMAT_VERSION: "number",
  CONNECT_LINK_HOST: "string",
  CONNECT_LINK_MAX_LENGTH: "number",
  CONNECT_LINK_SCHEME: "string",
  KNOWN_LINK_PARAMS: "object",
  LINK_PARAM_NAME_PATTERN: "regexp",
  RESERVED_LINK_PARAMS: "object",
  buildConnectLink: "function",
  isLoopbackHost: "function",
  normaliseBaseUrl: "function",
  parseConnectLink: "function",
  // qr
  encodeQrMatrix: "function",
  // errors
  ContractError: "class",
};

function kindOf(value: unknown): string {
  if (value instanceof RegExp) return "regexp";
  if (typeof value === "function") return /^class\s/.test(Function.prototype.toString.call(value)) ? "class" : "function";
  return typeof value;
}

describe("@pulse/web-data/contract barrel", () => {
  const exported = contract as Record<string, unknown>;

  test.each(Object.entries(RUNTIME_EXPORTS))("exports %s as a %s", (name, kind) => {
    expect(exported[name]).toBeDefined();
    expect(kindOf(exported[name])).toBe(kind);
  });

  test("exports nothing else", () => {
    expect(Object.keys(exported).sort()).toEqual(Object.keys(RUNTIME_EXPORTS).sort());
  });

  test("the exports work together through the barrel", () => {
    const built = contract.buildConnectLink("https://pulse.example.com");
    if (!built.ok) throw new Error(`expected ok, got ${built.refusal}`);
    expect(contract.parseConnectLink(built.link).ok).toBe(true);
    expect(contract.encodeQrMatrix(built.link).size).toBe(33);
    expect(() => contract.buildConnectLink("https://pulse.example.com", { v: "2" })).toThrow(contract.ContractError);
  });

  test("the package maps ./contract to this barrel", () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8")) as {
      exports: Record<string, { types: string; import: string }>;
      dependencies: Record<string, string>;
    };
    expect(pkg.exports["./contract"]).toEqual({ types: "./dist/contract/index.d.ts", import: "./dist/contract/index.js" });
    // The QR encoder is pinned to an exact version: the matrix for a given text must not drift.
    expect(pkg.dependencies["qrcode-generator"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
