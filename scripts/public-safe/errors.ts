/** Lint configuration failures (distinct from violations, which are results). */
export type PublicSafeErrorCode = "EXCEPTIONS_UNREADABLE" | "EXCEPTIONS_INVALID";

/** Thrown when public-safe-exceptions.json is unreadable or fails its schema; the lint exits 2. */
export class PublicSafeConfigError extends Error {
  /** Stable code. */ readonly code: PublicSafeErrorCode;
  /** Repo-relative path of the offending file (never absolute, so CI logs carry no home path). */ readonly file: string;
  constructor(code: PublicSafeErrorCode, file: string, message: string) {
    super(message);
    this.name = "PublicSafeConfigError";
    this.code = code;
    this.file = file;
  }
}
