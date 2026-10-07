// packages/core/tests/findings-codes.test.ts
// Type-contract tests for the closed finding-code vocabulary. The four web-projection
// additions (rendered-model-v2, 03-web-safety-and-findings.md §3.1) must be present with
// exact keys and lowercase values, and every pre-existing code must remain available.
import { describe, expect, test } from "bun:test";

import { FINDING_CODES, type FindingCode } from "@pulse/core";

describe("FINDING_CODES web-projection additions", () => {
  test("exposes the four exact WEB_* keys and lowercase values", () => {
    expect(FINDING_CODES.WEB_URL_USERINFO_REMOVED).toBe("web_url_userinfo_removed");
    expect(FINDING_CODES.WEB_SENSITIVE_CHANNEL_OPTION_OMITTED).toBe(
      "web_sensitive_channel_option_omitted",
    );
    expect(FINDING_CODES.WEB_UNSAFE_PROVENANCE).toBe("web_unsafe_provenance");
    expect(FINDING_CODES.WEB_ARTIFACT_LEAK_DETECTED).toBe("web_artifact_leak_detected");
  });

  test("the four additions are assignable to FindingCode", () => {
    const codes: FindingCode[] = [
      FINDING_CODES.WEB_URL_USERINFO_REMOVED,
      FINDING_CODES.WEB_SENSITIVE_CHANNEL_OPTION_OMITTED,
      FINDING_CODES.WEB_UNSAFE_PROVENANCE,
      FINDING_CODES.WEB_ARTIFACT_LEAK_DETECTED,
    ];
    expect(codes).toHaveLength(4);
  });
});

describe("FINDING_CODES pre-existing vocabulary", () => {
  test("retains every existing shape/semantic/loader/version code", () => {
    // Snapshot of the codes that predate the web-projection additions; each must remain
    // available with its original lowercase value.
    const existing: Record<string, string> = {
      UNKNOWN_FIELD: "unknown_field",
      MISSING_FIELD: "missing_field",
      WRONG_TYPE: "wrong_type",
      INVALID_ENUM: "invalid_enum",
      MISSING_RATIONALE: "missing_rationale",
      SECRET_LITERAL: "secret_literal",
      INCOMPLETE_NAS_API: "incomplete_nas_api",
      MISSING_CHAT_ID: "missing_chat_id",
      DUPLICATE_COMMAND_SIGNAL: "duplicate_command_signal",
      BACKUP_COMMAND_HOST: "backup_command_host",
      HOST_LOCAL_PROBE_HOST: "host_local_probe_host",
      INERT_ALERT_BINDING: "inert_alert_binding",
      UNRESOLVED_HOST: "unresolved_host",
      UNRESOLVED_CHANNEL: "unresolved_channel",
      DUPLICATE_IDENTITY: "duplicate_identity",
      DUPLICATE_ESTATE: "duplicate_estate",
      INVALID_LAYER: "invalid_layer",
      MISSING_TIMEZONE: "missing_timezone",
      INVALID_TIMEZONE: "invalid_timezone",
      MALFORMED_YAML: "malformed_yaml",
      UNSUPPORTED_VERSION: "unsupported_version",
      MISSING_VERSION: "missing_version",
    };
    for (const [key, value] of Object.entries(existing)) {
      expect<string>(FINDING_CODES[key as keyof typeof FINDING_CODES]).toBe(value);
    }
  });

  test("all code values are unique and lowercase snake_case", () => {
    const values = Object.values(FINDING_CODES);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("FINDING_CODES proposal additions (REQ-PROP-07..10)", () => {
  test("exposes the eight exact PROPOSAL_* keys and lowercase values", () => {
    expect(FINDING_CODES.PROPOSAL_NOT_FOUND).toBe("proposal_not_found");
    expect(FINDING_CODES.PROPOSAL_SIGNATURE_INVALID).toBe("proposal_signature_invalid");
    expect(FINDING_CODES.PROPOSAL_STALE).toBe("proposal_stale");
    expect(FINDING_CODES.PROPOSAL_DIRTY_TREE).toBe("proposal_dirty_tree");
    expect(FINDING_CODES.PROPOSAL_OVERLAY_AMBIGUOUS).toBe("proposal_overlay_ambiguous");
    expect(FINDING_CODES.PROPOSAL_CANNOT_CLEAR_BASE).toBe("proposal_cannot_clear_base");
    expect(FINDING_CODES.PROPOSAL_INVALID_ESTATE).toBe("proposal_invalid_estate");
    expect(FINDING_CODES.PROPOSAL_ALREADY_DECIDED).toBe("proposal_already_decided");
  });

  test("the eight additions are assignable to FindingCode", () => {
    const codes: FindingCode[] = [
      FINDING_CODES.PROPOSAL_NOT_FOUND,
      FINDING_CODES.PROPOSAL_SIGNATURE_INVALID,
      FINDING_CODES.PROPOSAL_STALE,
      FINDING_CODES.PROPOSAL_DIRTY_TREE,
      FINDING_CODES.PROPOSAL_OVERLAY_AMBIGUOUS,
      FINDING_CODES.PROPOSAL_CANNOT_CLEAR_BASE,
      FINDING_CODES.PROPOSAL_INVALID_ESTATE,
      FINDING_CODES.PROPOSAL_ALREADY_DECIDED,
    ];
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
  });
});
