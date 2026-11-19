// Shared deterministic values for every fixture builder: the fixed clock, the fixed process generation and
// the public-safe network placeholders. Builders take every host, address, URL and path from here.

import type { ApiErrorCode } from "@pulse/web-data/wire";

import { ContractToolError } from "../errors.js";
import type { FixtureGroup, FixtureIndexEntry, FixtureKind, ScenarioFixture } from "../types.js";

/** 2026-01-01T00:00:00.000Z. Every fixture timestamp is an offset from it. */
export const FIXED_EPOCH_MS = 1_767_225_600_000;
/** Fixed process generation, a valid version-4 UUID. */
export const GENERATION = "00000000-0000-4000-8000-000000000001";
/** `appVersion` carried by overview and the tick observation. */
export const APP_VERSION = "0.0.0-fixture";

/** "001".."999". */
export function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

/** Public-safe network placeholders (reserved documentation names and ranges). The only addresses builders may use. */
export const PLACEHOLDER = {
  baseUrl: "https://pulse.example.com",
  grafanaUrl: "https://grafana.example.com",
  hostName: (n: number): string => `host-${pad3(n)}.example.net`,
  /** `n` in 1..254. */
  ipv4: (n: number): string => `192.0.2.${n}`,
  ipv6: (n: number): string => `2001:db8::${n.toString(16)}`,
  /** In-container path; never a home path. */
  bundleDir: "/var/lib/pulse/rendered",
  estateName: "example-estate",
  timezone: "UTC",
} as const;

/**
 * A string of exactly `bytes` UTF-8 bytes: ASCII filler, then "é" (2 bytes) as the final code point, so
 * max-size fixtures exercise the multi-byte boundary.
 *
 * @throws {RangeError} when `bytes` is not an integer of at least 2
 */
export function utf8OfBytes(bytes: number): string {
  if (!Number.isInteger(bytes) || bytes < 2) throw new RangeError("utf8OfBytes needs an integer of at least 2");
  return `${"a".repeat(bytes - 2)}é`;
}

/** ISO timestamp at `FIXED_EPOCH_MS + offsetSeconds`. */
export function at(offsetSeconds: number): string {
  return new Date(atMs(offsetSeconds)).toISOString();
}

/** Epoch milliseconds at `FIXED_EPOCH_MS + offsetSeconds`. */
export function atMs(offsetSeconds: number): number {
  return FIXED_EPOCH_MS + offsetSeconds * 1000;
}

/** Fixture slug for an error code: lower-case with `_` → `-`, for example `source-timeout`. */
export function errorSlug(code: ApiErrorCode): string {
  return code.toLowerCase().replaceAll("_", "-");
}

/** Index members a JSON fixture may add to the defaults (`expect: "accept"`, `webValidator: null`). */
export type JsonFixtureExtras = Partial<
  Pick<FixtureIndexEntry, "expect" | "webValidator" | "client" | "expectedOutcome" | "rejection">
>;

/** Build one JSON fixture. `status` is the HTTP status for `response`/`error` kinds and null otherwise. */
export function jsonFixture(
  target: { readonly group: FixtureGroup; readonly operation: string },
  scenario: string,
  kind: Exclude<FixtureKind, "stream">,
  status: number | null,
  body: unknown,
  extras: JsonFixtureExtras = {},
): ScenarioFixture {
  return {
    entry: {
      group: target.group,
      operation: target.operation,
      scenario,
      kind,
      status,
      expect: "accept",
      webValidator: null,
      ...extras,
    },
    body,
  };
}

/**
 * Narrow a decoded JSON value to a mutable object, for the forward-compatibility edits that add or remove members.
 *
 * @throws {ContractToolError} SCENARIO_INVALID when the value is not a plain JSON object
 */
export function jsonObject(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractToolError("SCENARIO_INVALID", subject, "expected a JSON object");
  }
  return value as Record<string, unknown>;
}
