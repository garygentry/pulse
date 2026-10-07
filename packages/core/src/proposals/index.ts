/** `@pulse/core/proposals` — the browser-safe proposal format: no Node built-ins, no YAML, no loader.
 *  HMAC signing is the separate node-only subpath `@pulse/core/proposals/sign`, never re-exported here. */

export * from "./constants.js";
export { PROPOSABLE_FIELDS, PROPOSABLE_FIELD_NAMES, fieldSpec, fieldApplies } from "./fields.js";
export {
  proposalValueSchema, fieldValueSchema, fieldSeenSchema, proposalChangeSchema, proposalPayloadSchema,
  proposalFileSchema, proposalResultSchema, checkProposalChanges, proposableFieldSchema, storedRationaleSchema,
  ANY_CONTROL_RE, CONTROL_EXCEPT_LF_RE, SIGNATURE_VALUE_RE, codePointBounded,
} from "./schema.js";
export type {
  ProposableField, ProposableFieldSpec, ProposalValue, SuppressionMarkValue, ProposalChange, ProposalPayload,
  ProposalFileV1, ProposalResultV1, ProposalState, ChangeIssue,
} from "./schema.js";
export { newProposalId, PROPOSAL_ID_RE, PROPOSAL_FILE_RE, RESULT_FILE_RE, proposalFileName, resultFileName, parseProposalFileName } from "./ids.js";
export { canonicalProposalJson, proposalValuesEqual } from "./canonical.js";
export { readCoreValue, type CurrentValue } from "./current-value.js";
