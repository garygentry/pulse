// POST /api/push/alertmanager: availability, secret, media type, bounded read and parse, then a counter, one receipt
// log line and a hand-off to the serial intake. The reply never waits for planning or delivery.

import { log } from "../../log.js";
import { checkContentType, readBoundedJson } from "../../mutations/guards.js";
import { recordPushWebhook, type PushWebhookOutcome } from "../../routes/metrics.js";
import { authoriseSecret } from "../auth.js";
import { PUSH_CACHE_CONTROL, PUSH_LIMITS } from "../constants.js";
import type { Intake } from "../intake.js";
import { fromGuardReason, pushErrorResponse, type PushRefusal } from "../refusal.js";
import type { DeviceStore } from "../registry/store.js";
import type { PushSecret } from "../secrets.js";
import { parseAlertmanagerWebhook } from "../webhook.js";

/** 202 body. Not a contract root; Alertmanager ignores the body. */
export interface WebhookAccepted {
  /** Always true: the call was validated and handed to the intake. */
  readonly accepted: true;
}

/** Handler dependencies, built by bootstrap and passed by the push dispatcher. */
export type WebhookDeps =
  | {
      /** Push is misconfigured, or configured with the webhook surface off (secret unset or too short). */
      readonly available: false;
    }
  | {
      /** The webhook surface is on. */
      readonly available: true;
      /** The webhook shared secret. */
      readonly secret: PushSecret;
      /** Serial planner/enqueuer. */
      readonly intake: Intake;
      /** Used only to count devices for the receipt log line. */
      readonly store: DeviceStore;
    };

/** The request slice this handler reads. */
export interface WebhookRequestContext {
  /** The incoming request; the body is not yet consumed. */
  readonly request: Request;
  /** Peer IP; unused by the webhook (secret-only auth) but carried for uniformity. */
  readonly peerIp: string | null;
}

const ACCEPTED_BODY = JSON.stringify({ accepted: true } satisfies WebhookAccepted);

/**
 * Map a webhook refusal to its counter label. body-too-large → too_large; invalid-body and unsupported-version →
 * malformed; unavailable → unavailable; unauthorized → unauthorized. Anything else (internal included) is not
 * counted.
 *
 * @param refusal - The refusal the handler answers with.
 * @returns The outcome to count, or null.
 */
export function webhookOutcomeFor(refusal: PushRefusal): PushWebhookOutcome | null {
  switch (refusal) {
    case "body-too-large":
      return "too_large";
    case "invalid-body":
    case "unsupported-version":
      return "malformed";
    case "unavailable":
      return "unavailable";
    case "unauthorized":
      return "unauthorized";
    default:
      return null;
  }
}

function refuse(refusal: PushRefusal, fields?: string): Response {
  const outcome = webhookOutcomeFor(refusal);
  if (outcome !== null) recordPushWebhook(outcome);
  return pushErrorResponse(refusal, fields === undefined ? undefined : { fields });
}

/**
 * POST /api/push/alertmanager. Replies before any planning: after parsing, the only work is a counter, a log line and
 * `intake.submit`, which schedules and returns. A refused call counts exactly one outcome and never reaches the
 * intake.
 *
 * @param ctx - Request context from the push dispatcher.
 * @param deps - Availability and collaborators.
 * @returns 202 `{accepted: true}`, or an error response.
 */
export async function handleWebhook(ctx: WebhookRequestContext, deps: WebhookDeps): Promise<Response> {
  if (!deps.available) return refuse("unavailable");
  if (!authoriseSecret(ctx.request, deps.secret)) return refuse("unauthorized");

  const type = checkContentType(ctx.request.headers);
  if (!type.ok) return refuse(fromGuardReason(type.reason));

  const read = await readBoundedJson(ctx.request, PUSH_LIMITS.webhookMaxBytes);
  if (!read.ok) return refuse(fromGuardReason(read.reason));

  const parsed = parseAlertmanagerWebhook(read.value);
  if (!parsed.ok) return refuse(parsed.refusal, parsed.fields);

  const notification = parsed.notification;
  recordPushWebhook("accepted");
  let devices = 0;
  for (const device of deps.store.list()) if (device.apnsToken !== null) devices += 1;
  log({
    event: "push_webhook_received",
    ok: true,
    alerts: notification.alerts.length,
    truncatedAlerts: notification.truncatedAlerts,
    devices,
  });
  deps.intake.submit(notification);

  return new Response(ACCEPTED_BODY, {
    status: 202,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": PUSH_CACHE_CONTROL },
  });
}
