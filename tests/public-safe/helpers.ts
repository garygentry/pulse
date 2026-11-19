/**
 * Fragment builders. Every firing sample in these tests is assembled at runtime, so the test sources never
 * contain a literal the lint itself would flag.
 */

/** Join labels with "." — builds hostnames and IPv4 literals without writing them literally. */
export const dot = (...parts: string[]): string => parts.join(".");
/** Join with ":" — builds IPv6 literals. */
export const colon = (...parts: string[]): string => parts.join(":");
/** Join with "/" — builds POSIX paths. */
export const slash = (...parts: string[]): string => parts.join("/");
