/** Usage-failure error hierarchy for the loader (00-core-definitions.md §4).
 *
 *  Per the findings-vs-exception boundary (03 §4.3): config **content** problems are
 *  Findings; caller/**usage** failures throw. `ConfigIoError` is the ONLY exception type
 *  in the contract — internal errors must never leak. */

/** Stable codes for usage failures (misuse, not config the agent authored). */
export type ConfigIoErrorCode =
  | "DIR_NOT_FOUND" // the estate directory does not exist
  | "NOT_A_DIRECTORY" // the path exists but is not a directory
  | "UNREADABLE" // a path could not be read (permissions, I/O)
  | "INVALID_ARG"; // non-string / invalid argument to loadAndValidate

/** Thrown for usage failures only (REQ-OBS-01, tech spec §3.8). Never used for config
 *  content — every content problem is a Finding. Extends Error with a typed `code`. */
export class ConfigIoError extends Error {
  /** Machine-stable failure code. */
  readonly code: ConfigIoErrorCode;
  /** The offending path, when the failure concerns one. */
  readonly path?: string;

  constructor(code: ConfigIoErrorCode, message: string, path?: string) {
    super(message);
    this.name = "ConfigIoError";
    this.code = code;
    if (path !== undefined) this.path = path;
    // Restore the prototype chain for instanceof across the ESM boundary.
    Object.setPrototypeOf(this, ConfigIoError.prototype);
  }
}
