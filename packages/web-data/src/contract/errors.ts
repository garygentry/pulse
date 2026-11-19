// packages/web-data/src/contract/errors.ts — the contract runtime's only error class. Browser-safe.
// Thrown for caller misuse only; validation of external input (headers, URLs, links) returns results.

/** Programming-error codes raised by the contract runtime module. Input-validation outcomes are results, never throws. */
export type ContractErrorCode = "CAPABILITY_UNKNOWN" | "CAPABILITY_INVALID_NAME" | "LINK_PARAM_INVALID";

/** Thrown only for caller misuse (registering an undefined capability, an invalid link-parameter name). */
export class ContractError extends Error {
  /** Stable code. */ readonly code: ContractErrorCode;
  /** The offending name (a code identifier, never user input). */ readonly subject: string;
  constructor(code: ContractErrorCode, subject: string, message: string) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.subject = subject;
  }
}
