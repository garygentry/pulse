// apps/web/src/client/store/session-expiry.ts — whether the auth proxy's sign-in session expired
// (GitHub #64), read from the published connection state. No UI imports, so the shell and the views
// share one reading.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether any view's latest fetch failed with `SESSION_EXPIRED` (an auth proxy answered in Pulse's
 * place). Live-state clears those failures on the next successful Pulse answer for any view.
 * Tolerant of any input: an unrecognised shape is `false`.
 */
export function isSessionExpired(connection: unknown): boolean {
  const views = isRecord(connection) ? connection["views"] : undefined;
  if (!isRecord(views)) return false;
  return Object.values(views).some((view) => {
    const failure = isRecord(view) ? view["failure"] : undefined;
    return isRecord(failure) && failure["code"] === "SESSION_EXPIRED";
  });
}
