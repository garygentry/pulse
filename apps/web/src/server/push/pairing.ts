// Pairing service: one-time pairing tokens (in memory only, keyed by their SHA-256 hash), redemption into a device
// record, and the server-wide redemption limiter. Nothing here is persisted except the device a redemption adds, so
// a restart invalidates every token and resets the limiter.

import {
  PAIR_LINK_PARAM,
  PAIR_TOKEN_PATTERN,
  buildConnectLink,
  normaliseBaseUrl,
} from "@pulse/web-data/contract";
import type { PairingRedeemRequest, PairingRedeemResponse, PairingTokenIssued } from "@pulse/web-data/wire";

import type { ExternalUrlState } from "../config.js";
import { log } from "../log.js";
import { recordPushPairingEvent } from "../routes/metrics.js";
import { PUSH_LIMITS } from "./constants.js";
import { newCredential, newDeviceId, newPairingToken, type Clock, type RandomSource } from "./ids.js";
import type { DeviceRecord } from "./registry/schema.js";
import type { DeviceStore, StoreMutateResult } from "./registry/store.js";
import { hashCredential } from "./secrets.js";

/** Which surface issued a pairing token. */
export type TokenSource = "web" | "cli";

/** In-memory record, keyed by hashCredential(token). The token itself is never stored. */
export interface PendingToken {
  /** Which surface issued the token. */
  readonly source: TokenSource;
  /** Issue time, epoch milliseconds. */
  readonly issuedAt: number;
  /** Expiry, epoch milliseconds (`issuedAt + tokenTtlMs`). */
  readonly expiresAt: number;
}

/** What redeem captured when it consumed a token, for the guarded restore. */
export interface ConsumedToken {
  /** Lowercase hex `hashCredential(token)`, the token-map key. */
  readonly hash: string;
  /** The pending record that was removed. */
  readonly record: PendingToken;
  /** Limiter-trip epoch at consumption; a restore requires it unchanged. */
  readonly voidEpoch: number;
  /** Web issue/cancel epoch at consumption; a web restore requires it unchanged. */
  readonly webEpoch: number;
}

/** Result of {@link PairingService.issue}. */
export type IssueResult =
  | {
      /** A token was issued. */
      readonly ok: true;
      /** The link and expiry to return (a secret). */
      readonly issued: PairingTokenIssued;
    }
  | {
      /** No token was issued. */
      readonly ok: false;
      /** Why no connect link could be built. */
      readonly refusal: "no-usable-address" | "address-too-long";
    };

/** Result of {@link PairingService.redeem}. */
export type RedeemResult =
  | {
      /** The device was paired. */
      readonly ok: true;
      /** The 201 body, including the one-time credential. */
      readonly response: PairingRedeemResponse;
    }
  | {
      /** The redemption was refused. */
      readonly ok: false;
      /** The refusal kind, mapped through `PUSH_REFUSAL_POLICY`. */
      readonly refusal: "rate-limited" | "pairing-refused" | "device-cap-reached" | "unavailable";
      /** Present for rate-limited: whole seconds for Retry-After. */
      readonly retryAfterSeconds?: number;
    };

/** The pairing service used by the pairing handlers, the status handler and the sweep. */
export interface PairingService {
  /** Issue a token; `base` is the fallback link base (request Origin or body baseUrl), `null` when absent. */
  issue(source: TokenSource, base: string | null): IssueResult;
  /** Cancel the outstanding web token(s). Returns true if one was removed. */
  cancelWeb(): boolean;
  /** Consume a token and pair a device. Never rejects for an expected refusal. */
  redeem(body: PairingRedeemRequest): Promise<RedeemResult>;
  /** The newest outstanding web token's expiry, or null. */
  outstandingWeb(): {
    /** Expiry, epoch milliseconds. */
    readonly expiresAt: number;
  } | null;
  /** Remove expired tokens (called by the sweep and lazily on every call). */
  gc(): void;
}

/** Dependencies of the pairing service. Every field except `limits` is required. */
export interface PairingServiceDeps {
  /** The registry; read for the cap fast path and mutated to add the device. */
  readonly store: DeviceStore;
  /** Time source for issue, expiry and the limiter window. */
  readonly clock: Clock;
  /** Entropy for tokens, credentials and device ids. */
  readonly random: RandomSource;
  /** The configured device cap (1..100). */
  readonly maxDevices: number;
  /** The parsed `PULSE_WEB_EXTERNAL_URL`. */
  readonly externalUrl: ExternalUrlState;
  /** Test override of the pairing bounds. Defaults to PUSH_LIMITS. */
  readonly limits?: Partial<
    Pick<typeof PUSH_LIMITS, "tokenTtlMs" | "maxOutstandingTokens" | "limiterMaxFailures" | "limiterWindowMs">
  >;
}

/** The PairingService plus a read-only state probe used only by tests. */
export interface PairingServiceForTest extends PairingService {
  /** Copy of the internal state, keyed by token hash. Never called by production code. */
  snapshotForTest(): {
    /** Outstanding tokens by hash. */
    readonly tokens: ReadonlyMap<string, PendingToken>;
    /** Limiter-trip epoch. */
    readonly voidEpoch: number;
    /** Web issue/cancel epoch. */
    readonly webEpoch: number;
    /** In-window limiter failure instants, oldest first. */
    readonly limiterFailures: readonly number[];
    /** Whether the limiter is currently tripped. */
    readonly limiterTripped: boolean;
  };
}

/** Server-wide sliding window over failed redemptions. Independent of the peer address. */
export interface RedemptionLimiter {
  /** null when redemption is allowed; else whole seconds until the oldest failure leaves the window (≥ 1). */
  retryAfterSeconds(nowMs: number): number | null;
  /**
   * Record one failure at nowMs. Must only be called when retryAfterSeconds(nowMs) === null.
   * @returns true exactly when this failure trips the limiter (the edge).
   */
  recordFailure(nowMs: number): boolean;
  /** Copy of the in-window failure timestamps, oldest first (tests). */
  failures(): readonly number[];
}

/**
 * Create a sliding-window limiter. A failure at `t` is in the window while `now - t < windowMs`; the limiter is
 * tripped while the window holds `maxFailures` entries. Failures are recorded only while not tripped, so attempts
 * against a tripped limiter never extend it.
 *
 * @param maxFailures - failures that trip the limiter (10 in production)
 * @param windowMs - window length in milliseconds (600 000 in production)
 */
export function createRedemptionLimiter(maxFailures: number, windowMs: number): RedemptionLimiter {
  const window: number[] = [];
  const prune = (now: number): void => {
    while (window.length > 0 && now - (window[0] as number) >= windowMs) window.shift();
  };
  return {
    retryAfterSeconds(nowMs) {
      prune(nowMs);
      if (window.length < maxFailures) return null;
      return Math.max(1, Math.ceil(((window[0] as number) + windowMs - nowMs) / 1000));
    },
    recordFailure(nowMs) {
      prune(nowMs);
      if (window.length >= maxFailures) return false;
      window.push(nowMs);
      return window.length === maxFailures;
    },
    failures() {
      return [...window];
    },
  };
}

/**
 * The base URL for a pairing link. A usable external URL wins; otherwise the request fallback when it normalises;
 * otherwise null. A refused external URL is treated like an unset one.
 */
function chooseBase(externalUrl: ExternalUrlState, fallback: string | null): string | null {
  if (externalUrl.state === "usable") return externalUrl.baseUrl;
  if (fallback === null) return null;
  const normalised = normaliseBaseUrl(fallback);
  return normalised.ok ? normalised.baseUrl : null;
}

interface PairingState {
  readonly tokens: Map<string, PendingToken>;
  voidEpoch: number;
  webEpoch: number;
}

/**
 * Create the pairing service. Pure construction: no timer, no I/O. GC runs lazily on each call and from the sweep.
 *
 * @param deps - see PairingServiceDeps
 * @returns the service; production code keeps it typed as PairingService
 */
export function createPairingService(deps: PairingServiceDeps): PairingServiceForTest {
  const { store, clock, random, maxDevices, externalUrl } = deps;
  const tokenTtlMs = deps.limits?.tokenTtlMs ?? PUSH_LIMITS.tokenTtlMs;
  const maxOutstandingTokens = deps.limits?.maxOutstandingTokens ?? PUSH_LIMITS.maxOutstandingTokens;
  const limiter = createRedemptionLimiter(
    deps.limits?.limiterMaxFailures ?? PUSH_LIMITS.limiterMaxFailures,
    deps.limits?.limiterWindowMs ?? PUSH_LIMITS.limiterWindowMs,
  );
  const state: PairingState = { tokens: new Map(), voidEpoch: 0, webEpoch: 0 };

  function gc(now: number = clock.nowMs()): void {
    for (const [hash, record] of state.tokens) {
      if (record.expiresAt <= now) state.tokens.delete(hash);
    }
  }

  function issue(source: TokenSource, base: string | null): IssueResult {
    gc();
    const chosen = chooseBase(externalUrl, base);
    if (chosen === null) return { ok: false, refusal: "no-usable-address" };
    const token = newPairingToken(random);
    const built = buildConnectLink(chosen, { [PAIR_LINK_PARAM]: token });
    if (!built.ok) {
      return { ok: false, refusal: built.refusal === "too-long" ? "address-too-long" : "no-usable-address" };
    }
    if (source === "web") {
      for (const [hash, record] of state.tokens) {
        if (record.source === "web") state.tokens.delete(hash);
      }
      state.webEpoch += 1;
    }
    const now = clock.nowMs();
    state.tokens.set(hashCredential(token), Object.freeze({ source, issuedAt: now, expiresAt: now + tokenTtlMs }));
    while (state.tokens.size > maxOutstandingTokens) {
      let oldestHash: string | null = null;
      let oldestAt = Infinity;
      for (const [hash, record] of state.tokens) {
        if (record.issuedAt < oldestAt) {
          oldestAt = record.issuedAt;
          oldestHash = hash;
        }
      }
      if (oldestHash === null) break;
      state.tokens.delete(oldestHash);
    }
    recordPushPairingEvent("issued");
    log({ event: "push_pairing", ok: true, pairingEvent: "issued", source });
    return { ok: true, issued: { link: built.link, expiresAt: new Date(now + tokenTtlMs).toISOString() } };
  }

  function cancelWeb(): boolean {
    gc();
    let removed = false;
    for (const [hash, record] of state.tokens) {
      if (record.source === "web") {
        state.tokens.delete(hash);
        removed = true;
      }
    }
    state.webEpoch += 1;
    if (removed) {
      recordPushPairingEvent("cancelled");
      log({ event: "push_pairing", ok: true, pairingEvent: "cancelled", source: "web" });
    }
    return removed;
  }

  function outstandingWeb(): { readonly expiresAt: number } | null {
    gc();
    let newest: number | null = null;
    for (const record of state.tokens.values()) {
      if (record.source === "web" && (newest === null || record.expiresAt > newest)) newest = record.expiresAt;
    }
    return newest === null ? null : { expiresAt: newest };
  }

  /** A redemption miss: one limiter failure; on the trip edge, void every token. */
  function refused(now: number): void {
    recordPushPairingEvent("refused");
    log({ event: "push_pairing", ok: false, pairingEvent: "refused" });
    if (limiter.recordFailure(now)) {
      state.tokens.clear();
      state.voidEpoch += 1;
      log({ event: "push_pairing_rate_limited", ok: false });
      recordPushPairingEvent("rate_limited");
    }
  }

  function capReached(source: TokenSource): void {
    recordPushPairingEvent("cap_reached");
    log({ event: "push_pairing", ok: false, pairingEvent: "cap_reached", source });
  }

  function redeemed(source: TokenSource, deviceId: string, displayName: string): void {
    recordPushPairingEvent("redeemed");
    log({ event: "push_pairing", ok: true, pairingEvent: "redeemed", source, deviceId, displayName });
  }

  /**
   * Put a consumed token back so the phone can retry, but only when that cannot revive a token voided by a
   * limiter trip, replaced or cancelled on the web, expired meanwhile, or crowded out by newer tokens.
   * The record keeps its original instants, so a restore never extends a token's life.
   */
  function restoreIfSafe(c: ConsumedToken): boolean {
    const now = clock.nowMs();
    if (c.record.expiresAt <= now) return false;
    if (state.voidEpoch !== c.voidEpoch) return false;
    if (c.record.source === "web" && state.webEpoch !== c.webEpoch) return false;
    if (state.tokens.size >= maxOutstandingTokens) return false;
    state.tokens.set(c.hash, c.record);
    return true;
  }

  async function redeem(body: PairingRedeemRequest): Promise<RedeemResult> {
    // Everything up to the first await runs as one synchronous segment, which makes the consume atomic.
    const now = clock.nowMs();
    gc(now);

    const retry = limiter.retryAfterSeconds(now);
    if (retry !== null) return { ok: false, refusal: "rate-limited", retryAfterSeconds: retry };

    const hash = PAIR_TOKEN_PATTERN.test(body.token) ? hashCredential(body.token) : null;
    const record = hash === null ? undefined : state.tokens.get(hash);
    if (hash === null || record === undefined) {
      refused(now);
      return { ok: false, refusal: "pairing-refused" };
    }

    if (store.list().length >= maxDevices) {
      capReached(record.source);
      return { ok: false, refusal: "device-cap-reached" };
    }

    state.tokens.delete(hash);
    const consumed: ConsumedToken = { hash, record, voidEpoch: state.voidEpoch, webEpoch: state.webEpoch };

    const credential = newCredential(random);
    const instant = new Date(now).toISOString();
    const device: DeviceRecord = {
      id: newDeviceId(random),
      displayName: body.displayName.trim(),
      credentialHash: hashCredential(credential),
      apnsToken: null,
      environment: null,
      preferences: { critical: true, warning: true, info: true },
      pairedAt: instant,
      seenAt: instant,
      lastDelivery: null,
    };

    let outcome: StoreMutateResult<"added" | "cap" | "id-collision">;
    try {
      outcome = await store.mutate<"added" | "cap" | "id-collision">((devices) => {
        if (devices.length >= maxDevices) return { kind: "abort", result: "cap" };
        if (devices.some((d) => d.id === device.id)) return { kind: "abort", result: "id-collision" };
        return { kind: "commit", devices: [...devices, device], result: "added" };
      });
    } catch (err) {
      restoreIfSafe(consumed);
      throw err;
    }

    if (!outcome.ok) {
      restoreIfSafe(consumed);
      return { ok: false, refusal: "unavailable" };
    }
    if (outcome.result === "cap") {
      restoreIfSafe(consumed);
      capReached(record.source);
      return { ok: false, refusal: "device-cap-reached" };
    }
    if (outcome.result === "id-collision") {
      restoreIfSafe(consumed);
      return { ok: false, refusal: "unavailable" };
    }

    redeemed(record.source, device.id, device.displayName);
    return { ok: true, response: { deviceId: device.id, credential } };
  }

  return {
    issue,
    cancelWeb,
    redeem,
    outstandingWeb,
    gc: () => gc(),
    snapshotForTest() {
      const now = clock.nowMs();
      return {
        tokens: new Map(state.tokens),
        voidEpoch: state.voidEpoch,
        webEpoch: state.webEpoch,
        limiterFailures: limiter.failures(),
        limiterTripped: limiter.retryAfterSeconds(now) !== null,
      };
    },
  };
}
