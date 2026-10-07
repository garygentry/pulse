/** findings.test.ts — findings machinery (05-findings.md, 07 §3.1 findings).
 *
 *  Asserts: zodIssueToFindings maps each Zod code per the §5.1 table; a multi-key
 *  unrecognized_keys yields one finding per key with keys SORTED; toSnakeYamlPath normalizes
 *  camel + numeric segments; compareFindings is a total order; formatFindings is pure. */

import { expect, test, describe } from "bun:test";
import type { ZodIssue } from "zod";

import { toSnakeYamlPath, zodIssueToFindings } from "../src/findings/from-zod.js";
import { compareFindings, sortFindings } from "../src/findings/collect.js";
import { formatFindings } from "../src/findings/format.js";
import { FINDING_CODES } from "../src/findings/codes.js";
import type { Finding } from "../src/findings/index.js";
import type { ProvenanceIndex } from "../src/loader/index.js";

/** A deterministic stub ProvenanceIndex: echoes the queried path with a fixed file/line/col. */
const prov: ProvenanceIndex = {
  lookup: (path: string) => ({ file: "estate.yaml", path, line: 1, col: 1 }),
};

/** Build a ZodIssue-shaped object (tests are transpiled, not type-checked; the cast documents
 *  the intent that these fields mirror the real issue surface). */
function issue(o: Record<string, unknown>): ZodIssue {
  return o as unknown as ZodIssue;
}

describe("toSnakeYamlPath", () => {
  test("camel + numeric segments → hosts[2].exporter_ports", () => {
    expect(toSnakeYamlPath(["hosts", 2, "exporterPorts"])).toBe("hosts[2].exporter_ports");
  });
  test("an already-snake segment is unchanged", () => {
    expect(toSnakeYamlPath(["estate", "schema_version"])).toBe("estate.schema_version");
  });
  test("a leading numeric segment renders as [n] with no leading dot", () => {
    expect(toSnakeYamlPath([0, "name"])).toBe("[0].name");
  });
  test("empty path → \"\"", () => {
    expect(toSnakeYamlPath([])).toBe("");
  });
});

describe("zodIssueToFindings — §5.1 code mapping", () => {
  test("unrecognized_keys → one UNKNOWN_FIELD finding per key, keys SORTED", () => {
    const out = zodIssueToFindings(
      issue({ code: "unrecognized_keys", path: ["hosts", 0], keys: ["zeta", "alpha", "mid"] }),
      prov,
    );
    expect(out.length).toBe(3);
    expect(out.every((f) => f.code === FINDING_CODES.UNKNOWN_FIELD)).toBe(true);
    expect(out.map((f) => f.path)).toEqual([
      "hosts[0].alpha",
      "hosts[0].mid",
      "hosts[0].zeta",
    ]);
    expect(out.every((f) => f.severity === "error")).toBe(true);
  });

  test("invalid_type received \"undefined\" → MISSING_FIELD", () => {
    const out = zodIssueToFindings(
      issue({ code: "invalid_type", path: ["exporter_ports"], expected: "array", received: "undefined" }),
      prov,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.MISSING_FIELD);
  });

  test("invalid_type received something-else → WRONG_TYPE", () => {
    const out = zodIssueToFindings(
      issue({ code: "invalid_type", path: ["managed"], expected: "boolean", received: "string" }),
      prov,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.WRONG_TYPE);
  });

  test("too_small → MISSING_FIELD", () => {
    const out = zodIssueToFindings(
      issue({ code: "too_small", path: ["addresses"], minimum: 1, type: "array" }),
      prov,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.MISSING_FIELD);
  });

  test("invalid_enum_value → INVALID_ENUM", () => {
    const out = zodIssueToFindings(
      issue({ code: "invalid_enum_value", path: ["kind"], received: "sms", options: ["chat", "email"] }),
      prov,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.INVALID_ENUM);
  });

  test("invalid_union_discriminator → INVALID_ENUM", () => {
    const out = zodIssueToFindings(
      issue({ code: "invalid_union_discriminator", path: ["collection_class"], options: ["managed-linux"] }),
      prov,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.INVALID_ENUM);
  });

  test("an unmapped code still yields exactly one WRONG_TYPE finding (no issue dropped)", () => {
    const out = zodIssueToFindings(
      issue({ code: "custom", path: ["ingress_url"], message: "Invalid url" }),
      prov,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.WRONG_TYPE);
    expect(out[0]!.message).toBe("Invalid url"); // reuses Zod's own message verbatim
  });

  test("every mapped finding carries a file, a path, and a fix", () => {
    const out = zodIssueToFindings(
      issue({ code: "invalid_type", path: ["hosts", 0, "exporterPorts"], expected: "array", received: "undefined" }),
      prov,
    );
    const f = out[0]!;
    expect(f.file).toBe("estate.yaml");
    expect(f.path).toBe("hosts[0].exporter_ports");
    expect(f.fix.length).toBeGreaterThan(0);
  });
});

describe("compareFindings — total order", () => {
  const mk = (over: Partial<Finding>): Finding => ({
    severity: "error",
    code: FINDING_CODES.WRONG_TYPE,
    file: "a.yaml",
    path: "x",
    message: "m",
    fix: "f",
    ...over,
  });

  const sample: Finding[] = [
    mk({ file: "b.yaml", path: "hosts[1]" }),
    mk({ file: "a.yaml", path: "hosts[0]", code: FINDING_CODES.MISSING_FIELD }),
    mk({ file: "a.yaml", path: "hosts[0]", code: FINDING_CODES.UNKNOWN_FIELD }),
    mk({ file: "a.yaml", path: "estate.timezone", code: FINDING_CODES.MISSING_TIMEZONE }),
  ];

  test("reflexive: compareFindings(a, a) === 0", () => {
    for (const f of sample) expect(compareFindings(f, f)).toBe(0);
  });

  test("antisymmetric: sign flips when arguments swap", () => {
    // Normalize -0 → 0 so Object.is-based toBe treats the equal-elements case cleanly.
    const norm = (n: number) => (n === 0 ? 0 : Math.sign(n));
    for (let i = 0; i < sample.length; i++) {
      for (let j = 0; j < sample.length; j++) {
        const ab = compareFindings(sample[i]!, sample[j]!);
        const ba = compareFindings(sample[j]!, sample[i]!);
        expect(norm(ab)).toBe(norm(-ba));
      }
    }
  });

  test("sorting is insertion-order-independent", () => {
    const forward = sortFindings(sample);
    const reversed = sortFindings([...sample].reverse());
    expect(forward).toEqual(reversed);
  });
});

describe("formatFindings — pure", () => {
  const findings: Finding[] = [
    {
      severity: "error",
      code: FINDING_CODES.MISSING_FIELD,
      file: "estate.yaml",
      path: "hosts[0].exporter_ports",
      message: "Required field is missing.",
      fix: "Add it.",
    },
    {
      severity: "error",
      code: FINDING_CODES.MALFORMED_YAML,
      file: "estate.yaml",
      path: "", // file-level finding
      message: "Malformed YAML.",
      fix: "Fix syntax.",
    },
  ];

  test("same input → same string (referentially transparent)", () => {
    expect(formatFindings(findings)).toBe(formatFindings(findings));
  });

  test("an empty array → \"\"", () => {
    expect(formatFindings([])).toBe("");
  });

  test("omits :path for an empty-path finding, includes it otherwise", () => {
    const out = formatFindings(findings);
    expect(out).toContain("estate.yaml:hosts[0].exporter_ports");
    // The file-level block renders the file WITHOUT a trailing ":" path segment.
    expect(out).toContain("estate.yaml [malformed_yaml]");
    expect(out).not.toContain("estate.yaml: [malformed_yaml]");
  });
});
