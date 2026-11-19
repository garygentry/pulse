// src/shared/connect-link.ts — the body of `GET /api/connect-link`, shared by the server route and the
// web connect view. Web-only: it is not part of the client API contract.

/** Reasons an external address is refused for connect links without stopping the server. */
export type ExternalUrlSoftRefusal = "not-https" | "loopback" | "too-long";

/** Body of `GET /api/connect-link`. Exactly one of three states holds: `configured` set; `refusal`
 *  set; or both null (use the browsing address). Never both set. */
export interface ConnectLinkPayload {
  /** Link built from `PULSE_WEB_EXTERNAL_URL` when usable; otherwise null. */
  readonly configured: {
    /** The connect link. */
    readonly link: string;
    /** The normalised base URL the link points at. */
    readonly baseUrl: string;
  } | null;
  /** Set when `PULSE_WEB_EXTERNAL_URL` is configured but refused. */
  readonly refusal: {
    /** Why the address was refused. */
    readonly reason: ExternalUrlSoftRefusal;
    /** The variable to fix. */
    readonly envVar: "PULSE_WEB_EXTERNAL_URL";
  } | null;
}
