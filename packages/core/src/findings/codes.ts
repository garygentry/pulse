/** The stable, machine-consumable finding codes (REQ-VAL-05). Callers (e.g. pulse-cli)
 *  may key on `code`; codes are part of the public contract and change only under the
 *  compatibility policy. Grouped by producing layer. */
export const FINDING_CODES = {
  // shape layer (Zod) — 02-inventory-schema.md
  UNKNOWN_FIELD: "unknown_field",
  MISSING_FIELD: "missing_field",
  WRONG_TYPE: "wrong_type",
  INVALID_ENUM: "invalid_enum",
  // semantic layer — 04-validation-and-normalization.md
  MISSING_RATIONALE: "missing_rationale",
  SECRET_LITERAL: "secret_literal",
  INCOMPLETE_NAS_API: "incomplete_nas_api",
  MISSING_CHAT_ID: "missing_chat_id",
  DUPLICATE_COMMAND_SIGNAL: "duplicate_command_signal",
  BACKUP_COMMAND_HOST: "backup_command_host",
  HOST_LOCAL_PROBE_HOST: "host_local_probe_host",
  INERT_ALERT_BINDING: "inert_alert_binding",
  GATUS_UNSAFE_NAME: "gatus_unsafe_name",
  UNRESOLVED_HOST: "unresolved_host",
  UNRESOLVED_CHANNEL: "unresolved_channel",
  DUPLICATE_IDENTITY: "duplicate_identity",
  DUPLICATE_ESTATE: "duplicate_estate",
  INVALID_LAYER: "invalid_layer",
  MISSING_TIMEZONE: "missing_timezone",
  INVALID_TIMEZONE: "invalid_timezone",
  // loader — 03-loader-and-pipeline.md
  MALFORMED_YAML: "malformed_yaml",
  // version — 06-versioning-and-compat.md
  UNSUPPORTED_VERSION: "unsupported_version",
  MISSING_VERSION: "missing_version",
  // web projection (rendered-model-v2) — 03-web-safety-and-findings.md §3.1
  WEB_URL_USERINFO_REMOVED: "web_url_userinfo_removed",
  WEB_SENSITIVE_CHANNEL_OPTION_OMITTED: "web_sensitive_channel_option_omitted",
  WEB_UNSAFE_PROVENANCE: "web_unsafe_provenance",
  WEB_ARTIFACT_LEAK_DETECTED: "web_artifact_leak_detected",
  // estate-edit proposals — `pulse proposals` CLI
  PROPOSAL_NOT_FOUND: "proposal_not_found",
  PROPOSAL_SIGNATURE_INVALID: "proposal_signature_invalid",
  PROPOSAL_STALE: "proposal_stale",
  PROPOSAL_DIRTY_TREE: "proposal_dirty_tree",
  PROPOSAL_OVERLAY_AMBIGUOUS: "proposal_overlay_ambiguous",
  PROPOSAL_CANNOT_CLEAR_BASE: "proposal_cannot_clear_base",
  PROPOSAL_INVALID_ESTATE: "proposal_invalid_estate",
  PROPOSAL_ALREADY_DECIDED: "proposal_already_decided",
} as const;

/** A finding code value — the type of `Finding.code` at the type level. */
export type FindingCode = (typeof FINDING_CODES)[keyof typeof FINDING_CODES];
