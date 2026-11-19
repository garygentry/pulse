/** Generator/check failure codes. */
export type ContractToolErrorCode =
  /** The generator refused to overwrite a frozen shape snapshot with different content. */
  | "SNAPSHOT_FROZEN"
  /** A shape root or path cannot be classified, or is absent from the snapshot. */
  | "SHAPE_UNSUPPORTED_TYPE"
  /** A fixture or operation builder produced invalid or ambiguous output. */
  | "SCENARIO_INVALID"
  /** CONTRACT.md generated markers are missing, duplicated, misordered, nested or unknown. */
  | "MARKER_MISSING";

/** Thrown by the contract generator and the shape extractor. The CLI prints `code: message` and exits 1. */
export class ContractToolError extends Error {
  /** Stable code. */
  readonly code: ContractToolErrorCode;
  /** Repo-relative path, shape path or type name the error concerns. */
  readonly subject: string;

  constructor(code: ContractToolErrorCode, subject: string, message: string) {
    super(message);
    this.name = "ContractToolError";
    this.code = code;
    this.subject = subject;
  }
}
