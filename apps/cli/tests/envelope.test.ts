/** envelope.test.ts — the `--json` envelope builders and invariants (00 §5, REQ-CLI-04).
 *
 *  Asserts buildEnvelope: ok === (exitCode === 0), findings copied verbatim (no re-sort),
 *  meta.schemaMajors deep-equals [...SUPPORTED_SCHEMA_MAJORS], meta.envelopeVersion ===
 *  ENVELOPE_VERSION, and meta carries no clock/PID/host value; serializeEnvelope round-trips. */

import { expect, test, describe } from "bun:test";

import type { Finding } from "@pulse/core";
import { SUPPORTED_SCHEMA_MAJORS } from "@pulse/core";

import {
  buildEnvelope,
  serializeEnvelope,
  ENVELOPE_VERSION,
  type ValidateData,
} from "../src/envelope.js";
import { PULSE_VERSION } from "../src/version.js";

function finding(overrides: Partial<Finding>): Finding {
  return {
    severity: "error",
    code: "secret_literal",
    file: "estate/estate.yaml",
    path: "",
    message: "m",
    fix: "f",
    ...overrides,
  };
}

describe("buildEnvelope", () => {
  test("ok === (exitCode === 0)", () => {
    expect(
      buildEnvelope<ValidateData>({ command: "validate", exitCode: 0, findings: [], data: null }).ok,
    ).toBe(true);
    for (const exitCode of [1, 2] as const) {
      expect(
        buildEnvelope<ValidateData>({ command: "validate", exitCode, findings: [], data: null }).ok,
      ).toBe(false);
    }
  });

  test("findings copied verbatim, in order, without re-sorting", () => {
    // Deliberately NOT in core sort order (z-file before a-file): the builder must preserve it.
    const input: Finding[] = [
      finding({ file: "z.yaml", code: "secret_literal" }),
      finding({ file: "a.yaml", code: "invalid_enum" }),
    ];
    const env = buildEnvelope({ command: "validate", exitCode: 1, findings: input, data: null });
    expect(env.findings.map((f) => f.file)).toEqual(["z.yaml", "a.yaml"]);
    expect(env.findings).toEqual(input);
  });

  test("findings is a fresh array (copy, not the same reference)", () => {
    const input: Finding[] = [finding({})];
    const env = buildEnvelope({ command: "validate", exitCode: 1, findings: input, data: null });
    expect(env.findings).not.toBe(input);
    input.push(finding({ file: "extra.yaml" }));
    expect(env.findings.length).toBe(1); // copy is unaffected by later mutation
  });

  test("meta.schemaMajors deep-equals [...SUPPORTED_SCHEMA_MAJORS]", () => {
    const env = buildEnvelope({ command: "validate", exitCode: 0, findings: [], data: null });
    expect(env.meta.schemaMajors).toEqual([...SUPPORTED_SCHEMA_MAJORS]);
    // a fresh copy, not the core readonly array reference
    expect(env.meta.schemaMajors).not.toBe(SUPPORTED_SCHEMA_MAJORS as unknown as number[]);
  });

  test("meta carries the version stamps and no clock/PID/host value", () => {
    const env = buildEnvelope({ command: "coverage", exitCode: 0, findings: [], data: null });
    expect(env.meta.envelopeVersion).toBe(ENVELOPE_VERSION);
    expect(ENVELOPE_VERSION).toBe(1);
    expect(env.meta.pulseVersion).toBe(PULSE_VERSION);
    expect(Object.keys(env.meta).sort()).toEqual([
      "envelopeVersion",
      "pulseVersion",
      "schemaMajors",
    ]);
  });

  test("carries command and data through unchanged", () => {
    const data = { covered: [], gaps: [], suppressed: [] };
    const env = buildEnvelope({ command: "coverage", exitCode: 0, findings: [], data });
    expect(env.command).toBe("coverage");
    expect(env.data).toBe(data);
  });
});

describe("serializeEnvelope", () => {
  test("emits 2-space JSON with exactly one trailing newline and round-trips", () => {
    const env = buildEnvelope({ command: "validate", exitCode: 1, findings: [finding({})], data: null });
    const text = serializeEnvelope(env);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).toContain("\n  \"ok\":"); // 2-space indent
    expect(JSON.parse(text)).toEqual(env);
  });
});
