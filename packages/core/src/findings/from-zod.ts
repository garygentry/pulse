/**
 * The Zod-issue → {@link Finding} mapper (05-findings.md §5). Turns each `ZodIssue` from the
 * shape layer into one or more uniform, agent-actionable findings. No I/O, no clock/PID reads
 * (REQ-OBS-01); locale-free path/key handling (REQ-DET-01).
 */
import type { Finding } from "./index.js";
import { FINDING_CODES } from "./codes.js";
import type { ZodIssue } from "zod";
import type { ProvenanceIndex } from "../loader/index.js";
import { compareString } from "./collect.js";

/**
 * Convert a Zod issue path (`(string | number)[]`) to the snake_case YAML dotted path used in
 * `Finding.path` (e.g. `hosts[2].exporter_ports`). String segments are lower-snake-cased (a
 * segment already in snake_case is unchanged); numeric segments become `[n]` array indices
 * with no leading dot. Locale-independent (REQ-DET-01). Empty path → `""`.
 */
export function toSnakeYamlPath(path: readonly (string | number)[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else {
      const snake = camelToSnake(seg);
      out += out.length === 0 ? snake : `.${snake}`;
    }
  }
  return out;
}

/**
 * ASCII camelCase → snake_case. Deterministic and locale-free — maps only A–Z via an explicit
 * code-point shift (never locale-sensitive case mapping), inserting a leading `_` (REQ-DET-01).
 */
function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => {
    const lower = c.charCodeAt(0) + 32;
    return `_${lower <= 122 ? String.fromCharCode(lower) : c}`;
  });
}

/**
 * Map one Zod issue to one or more agent-actionable findings (§5.1). Returns an array so a
 * single `unrecognized_keys` issue (which can name several unknown keys) becomes one finding
 * per key — each pointed at exactly one editable field (REQ-VAL-03). Every other code yields
 * exactly one finding. No issue is ever dropped (the `default` branch maps unknowns to
 * `WRONG_TYPE` using Zod's own message), so the finding set is a total function of the issue
 * set (REQ-VAL-05).
 */
export function zodIssueToFindings(issue: ZodIssue, prov: ProvenanceIndex): Finding[] {
  const base = toSnakeYamlPath(issue.path);
  const file = prov.lookup(base).file;

  switch (issue.code) {
    case "unrecognized_keys": {
      // Sort keys so output is stable regardless of Zod's internal key order (REQ-DET-01).
      const keys = [...issue.keys].sort(compareString);
      return keys.map((key) => {
        const snake = camelToSnake(key);
        const path = base.length === 0 ? snake : `${base}.${snake}`;
        return {
          severity: "error",
          code: FINDING_CODES.UNKNOWN_FIELD,
          file,
          path,
          message: `Unknown field "${key}" is not part of the schema.`,
          fix: `Remove "${key}", or rename it to the intended schema field (check for a typo).`,
        } satisfies Finding;
      });
    }

    case "invalid_type": {
      if (issue.received === "undefined") {
        return [
          {
            severity: "error",
            code: FINDING_CODES.MISSING_FIELD,
            file,
            path: base,
            message: `Required field is missing (expected ${issue.expected}).`,
            fix: `Add "${base}" with a ${issue.expected} value.`,
          },
        ];
      }
      return [
        {
          severity: "error",
          code: FINDING_CODES.WRONG_TYPE,
          file,
          path: base,
          message: `Expected ${issue.expected} but got ${issue.received}.`,
          fix: `Change "${base}" to a ${issue.expected} value.`,
        },
      ];
    }

    case "too_small": {
      return [
        {
          severity: "error",
          code: FINDING_CODES.MISSING_FIELD,
          file,
          path: base,
          message: `Value is too small (minimum ${issue.minimum} for ${issue.type}); a required entry is missing.`,
          fix: `Provide at least ${issue.minimum} ${issue.type === "array" ? "item(s)" : "character(s)"} at "${base}".`,
        },
      ];
    }

    case "invalid_enum_value": {
      return [
        {
          severity: "error",
          code: FINDING_CODES.INVALID_ENUM,
          file,
          path: base,
          message: `Value "${issue.received}" is not one of: ${issue.options.join(", ")}.`,
          fix: `Change "${base}" to one of: ${issue.options.join(", ")}.`,
        },
      ];
    }

    case "invalid_union_discriminator": {
      const opts = issue.options.map(String).join(", ");
      return [
        {
          severity: "error",
          code: FINDING_CODES.INVALID_ENUM,
          file,
          path: base,
          message: `Missing or invalid discriminator; expected one of: ${opts}.`,
          fix: `Set "${base}" to one of: ${opts}.`,
        },
      ];
    }

    default: {
      // Total-function guarantee: never drop an issue. Reuse Zod's message verbatim.
      return [
        {
          severity: "error",
          code: FINDING_CODES.WRONG_TYPE,
          file,
          path: base,
          message: issue.message,
          fix: `Correct the value at "${base}" to satisfy the schema.`,
        },
      ];
    }
  }
}
