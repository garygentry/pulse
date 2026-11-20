// APNs HTTP/2 client: request and result types (the client itself is added alongside the JWT signer).

/** Built request: headers + serialised body (≤ 4096 bytes). */
export interface ApnsRequest {
  /** HTTP/2 request headers. */
  readonly headers: {
    /** Always "alert". */
    readonly "apns-push-type": "alert";
    /** The configured bundle id (`APNS_TOPIC_PATTERN`). */
    readonly "apns-topic": string;
    /** "10" for immediate delivery, "5" for power-considerate delivery. */
    readonly "apns-priority": "10" | "5";
    /** APNs expiration, epoch seconds as a decimal string. */
    readonly "apns-expiration": string;
    /** Collapse id; absent for a test notification. */
    readonly "apns-collapse-id"?: string;
  };
  /** UTF-8 JSON of the PushPayload. */
  readonly body: Uint8Array;
}

/** Raw result of one APNs request. */
export type ApnsResult =
  | {
      /** APNs answered. */
      readonly kind: "response";
      /** HTTP status APNs returned. */
      readonly status: number;
      /** Raw `reason` from the JSON error body; `null` for an empty, non-JSON or reason-less body. */
      readonly reason: string | null;
    }
  | {
      /** No usable answer arrived. */
      readonly kind: "error";
      /** Request timeout, connection failure, or HTTP/2 session failure. */
      readonly error: "timeout" | "connection" | "session";
    };
