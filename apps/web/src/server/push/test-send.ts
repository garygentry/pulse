// Operator test send: one test notification per target device, sent concurrently and outside the per-device
// queues, with one reported outcome per device. It never touches the notified memory.

import type { LastDelivery, PushTestOutcome, PushTestResult } from "@pulse/web-data/wire";

import { recordPushNotification } from "../routes/metrics.js";
import type { ApnsClient, ApnsRequest, ApnsResult } from "./apns/client.js";
import type { ProviderTokenSigner } from "./apns/jwt.js";
import { PUSH_LIMITS } from "./constants.js";
import { classifyApnsResponse } from "./dispatch/classify.js";
import type { DeliveryMonitor, Timers } from "./dispatch/queue.js";
import type { Clock } from "./ids.js";
import { buildTestPayload } from "./payload.js";
import type { DeviceRecord } from "./registry/schema.js";
import type { RegistryStore } from "./registry/store.js";
import { removeDevice } from "./registry/summary.js";

/** Dependencies of the test send. bootstrap.ts injects them. */
export interface TestSendDeps {
  /** APNs client shared with the queues. */
  readonly apns: ApnsClient;
  /** The concrete registry (dead-token removal needs the reason-carrying mutate). */
  readonly store: RegistryStore;
  /** Provider-token signer, invalidated on ExpiredProviderToken. */
  readonly signer?: ProviderTokenSigner;
  /** Shared delivery monitor (last success, auth latch, failure logs). */
  readonly monitor: DeliveryMonitor;
  /** Time source for the payload expiration and lastDelivery instants. */
  readonly clock: Clock;
  /** Waits between retries (fake in tests). */
  readonly timers: Timers;
  /** Current badge, or null. Read once per call. */
  readonly badge: () => number | null;
  /** The configured APNs topic. */
  readonly topic: string;
}

/** Result of {@link runTestSend}. */
export type TestSendResult =
  | {
      /** The send ran. */
      readonly ok: true;
      /** Per-device outcomes in target order. */
      readonly result: PushTestResult;
    }
  | {
      /** The send did not run. */
      readonly ok: false;
      /** The given deviceId names no device. */
      readonly refusal: "not-found";
    };

type ResultEntry = PushTestResult["results"][number];

const MAX_RETRIES = PUSH_LIMITS.testRetryDelaysMs.length;

function entry(device: DeviceRecord, outcome: PushTestOutcome, reason: string | null): ResultEntry {
  return Object.freeze({
    deviceId: device.id,
    displayName: device.displayName,
    outcome,
    ...(reason !== null ? { reason } : {}),
  });
}

type SendableDevice = DeviceRecord & {
  readonly apnsToken: string;
  readonly environment: NonNullable<DeviceRecord["environment"]>;
};

/** A device can be sent to once it has registered both a token and an environment. */
function sendable(device: DeviceRecord): device is SendableDevice {
  return device.apnsToken !== null && device.environment !== null;
}

function wait(timers: Timers, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    timers.setTimeout(resolve, ms);
  });
}

/** Reason reported for an exhausted transient result. */
function unreachableReason(result: ApnsResult, transientReason: string | null): string {
  if (result.kind === "error") return result.error === "timeout" ? "timeout" : "connection";
  return transientReason ?? "ExpiredProviderToken";
}

async function testOne(initial: DeviceRecord, request: ApnsRequest, deps: TestSendDeps): Promise<ResultEntry> {
  if (!sendable(initial)) return entry(initial, "unreachable", "unregistered");
  let device: SendableDevice = initial;
  const id = device.id;

  const ld = (outcome: LastDelivery["outcome"], reason: string | null): void => {
    deps.store.touchSoft(id, {
      lastDelivery: { outcome, at: new Date(deps.clock.nowMs()).toISOString(), reason },
    });
  };

  for (let retries = 0; ; retries += 1) {
    const token = device.apnsToken;
    const result = await deps.apns.send(device.environment, token, request);
    const c = classifyApnsResponse(result);
    const status = result.kind === "response" ? result.status : null;

    switch (c.kind) {
      case "delivered": {
        recordPushNotification("test", "delivered");
        deps.monitor.noteSuccess(deps.clock.nowMs());
        ld("delivered", null);
        return entry(device, "delivered", null);
      }
      case "dead-token": {
        const removed = await removeDevice(deps.store, id, "dead-token", { expectedApnsToken: token });
        if (removed === "removed") {
          // The store logs the removal and counts removed_dead.
          recordPushNotification("test", "token_removed");
          return entry(device, "token-removed", c.reason);
        }
        recordPushNotification("test", "failed");
        if (removed === "write-failed") {
          ld("failed", c.reason);
          deps.monitor.logFailed(id, "test", "dead-token-unremoved", 410, c.reason);
        }
        return entry(device, "rejected", c.reason);
      }
      case "permanent": {
        recordPushNotification("test", "failed");
        if (status !== null && status !== 403) deps.monitor.noteTokenAccepted();
        ld("failed", c.reason);
        deps.monitor.logFailed(id, "test", "permanent", status, c.reason);
        return entry(device, "rejected", c.reason);
      }
      case "auth-failed": {
        recordPushNotification("test", "failed");
        deps.monitor.noteAuthFailed(403, c.reason);
        ld("failed", c.reason);
        deps.monitor.logFailed(id, "test", "auth-failed", 403, c.reason);
        return entry(device, "rejected", c.reason);
      }
      case "transient":
      case "auth-expired": {
        const transientReason = c.kind === "transient" ? c.reason : null;
        if (retries >= MAX_RETRIES) {
          const reason = unreachableReason(result, transientReason);
          recordPushNotification("test", "dropped");
          ld("dropped", reason);
          deps.monitor.logFailed(id, "test", "transient-exhausted", status, reason);
          return entry(device, "unreachable", reason);
        }
        if (c.kind === "auth-expired") deps.signer?.invalidate();
        await wait(deps.timers, PUSH_LIMITS.testRetryDelaysMs[retries] ?? 0);
        const current = deps.store.get(id);
        if (current === undefined || !sendable(current)) return entry(device, "unreachable", "unregistered");
        device = current;
        break;
      }
    }
  }
}

/**
 * Send one test notification to each target, bypassing the queues, and report the per-device outcome. Targets are
 * `deviceId`'s device, or, when absent, every device with a non-null apnsToken, in `store.list()` order. All
 * targets are sent concurrently, and `results` keeps the target order. Never throws for expected conditions.
 *
 * @param input - Optional device id; absent means every registered device.
 * @param deps - Injected dependencies.
 * @returns `not-found` when `deviceId` is given and unknown. Otherwise the results, which are empty when no
 *   device is registered.
 */
export async function runTestSend(input: { readonly deviceId?: string }, deps: TestSendDeps): Promise<TestSendResult> {
  let targets: readonly DeviceRecord[];
  if (input.deviceId !== undefined) {
    const device = deps.store.get(input.deviceId);
    if (device === undefined) return { ok: false, refusal: "not-found" };
    targets = [device];
  } else {
    targets = deps.store.list().filter((d) => d.apnsToken !== null);
  }
  if (targets.length === 0) return { ok: true, result: Object.freeze({ results: Object.freeze([]) }) };

  const { request } = buildTestPayload(deps.badge(), deps.clock.nowMs(), deps.topic);
  const results = await Promise.all(targets.map((device) => testOne(device, request, deps)));
  return { ok: true, result: Object.freeze({ results: Object.freeze(results) }) };
}
