// src/server/app-version.ts — the version-skew reload key a server stamps on every snapshot.
//
// The client reloads exactly once when `appVersion` changes under it (REQ-LIVE-06: poll.ts and
// store/live-state.ts compare the whole string). Keying on the release version alone misses a
// rebuild at the same version, so the key is `<WEB_APP_VERSION>+<client buildId>`: any new client
// bundle (a new release, or a rebuild of the same one) changes it. With no client manifest
// (fallback mode) the key is the version alone.

/** Compose the reload key from the baked web-app version and the served client build id. */
export function composeAppVersion(version: string, buildId: string | null | undefined): string {
  return buildId === null || buildId === undefined || buildId.length === 0 ? version : `${version}+${buildId}`;
}
