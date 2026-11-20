// APNs HTTP/2 client: request, result, classification and dependency types (the client factory is added later).

import type { PushEnvironment } from "@pulse/web-data/wire";
import type { Timers } from "../dispatch/queue.js";
import type { Clock } from "../ids.js";

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

/** Classification of an ApnsResult: what the queue or test send does next. */
export type ApnsClassification =
  | {
      /** APNs accepted the request. */
      readonly kind: "delivered";
    }
  | {
      /** Retry with backoff until the deadline. */
      readonly kind: "transient";
      /** Sanitised reason. */
      readonly reason: string;
    }
  | {
      /** Fail without retry. */
      readonly kind: "permanent";
      /** Sanitised reason. */
      readonly reason: string;
    }
  | {
      /** The token is dead; the device is removed. */
      readonly kind: "dead-token";
      /** Sanitised reason; "Unregistered" when APNs gave none. */
      readonly reason: string;
    }
  | {
      /** Re-sign the provider JWT and resend (403 ExpiredProviderToken). */
      readonly kind: "auth-expired";
    }
  | {
      /** Provider authentication failed (403 Invalid/MissingProviderToken); not retried. */
      readonly kind: "auth-failed";
      /** Sanitised reason. */
      readonly reason: string;
    };

/** Test/override seam. Production uses the fixed APNs origins and the system CA. */
export interface ApnsDeps {
  /** HTTPS origin per APNs environment. */
  readonly origins: Readonly<Record<PushEnvironment, string>>;
  /** Extra trusted CA (tests); absent uses the system CA. */
  readonly ca?: string | Buffer;
  /** Time source for JWT refresh and timeouts. */
  readonly clock: Clock;
  /** Timer source for timeouts, pings and idle close. */
  readonly timers: Timers;
}

/** An APNs HTTP/2 client with one session per environment. */
export interface ApnsClient {
  /** Send one request to `deviceToken` (`APNS_TOKEN_PATTERN`); never rejects, failures are `kind: "error"`. */
  send(environment: PushEnvironment, deviceToken: string, request: ApnsRequest): Promise<ApnsResult>;
  /** Close every HTTP/2 session. */
  close(): Promise<void>;
}
