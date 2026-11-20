---
title: Push gateway
description: What the push gateway alerts mean (PushGatewayMisconfigured, PushDeliveryFailing, PushWebhookRefused) and how to diagnose and recover phone notifications.
slug: push
---

# Push gateway

This runbook is where the `runbook_url` on the **push** family lands. The push gateway in the web
service sends alert notifications to paired iPhones through Apple's push notification service. The
alerts below reach you through the existing human channels (email/Telegram), which **never depend on
push**: a broken push gateway never hides an incident from those channels.

The rules are `stack/compose/config/vmalert/rules/push.yml` (group `push-gateway`). Every rule is
silent while push is disabled, which is the shipped default.

## When this fires

- **PushGatewayMisconfigured** (warning) — `pulse_web_push_state{state="misconfigured"} == 1` for
  10 minutes. Push is off; monitoring is unaffected. The cause is in the web log's `config_warning`
  lines. The alert carries the scrape labels (`job`, `instance`), so it names the web instance.
- **PushDeliveryFailing** (critical) — devices are paired, notifications failed or were dropped in
  the last 30 minutes, and Apple's push service has accepted nothing for 30 minutes (or nothing since
  the server started), sustained for 15 minutes.
- **PushWebhookRefused** (warning) — devices are paired and Alertmanager's calls to the push webhook
  were refused (unauthorized, malformed or too large) in the last 30 minutes, sustained for 15
  minutes. Alertmanager does not retry a refused call, so those notifications are lost.

## Triage

Work from "what state is the gateway in" toward "which device or credential is wrong". Every step
here is read-only.

**Verify (content):** read the push series from `/metrics` inside the compose network:

```bash
cd stack/compose
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- http://web:8080/metrics | grep pulse_web_push_"
```

| Series pattern | Points at |
|----------------|-----------|
| `pulse_web_push_state{state="misconfigured"} 1` | Configuration, key mount, data directory or a corrupt registry — read the log (Step 1, Step 2). |
| `pulse_web_push_devices 0` while configured | No phone is paired; the delivery rules cannot fire. |
| `pulse_web_push_webhook_total{outcome="unauthorized"}` rising | The Alertmanager credential differs from `PULSE_PUSH_WEBHOOK_SECRET` (Step 4). |
| `pulse_web_push_webhook_total{outcome="too_large"}` or `"malformed"` rising | Alertmanager receiver settings or a proxy rewriting the body (see item 5 below). |
| `pulse_web_push_notifications_total{outcome="failed"}` rising | Apple's push service refuses the requests — read the reason in the log (Step 3). |
| `pulse_web_push_notifications_total{outcome="dropped"}` rising | Transient failures past the 5-minute retry window — usually outbound connectivity (Step 5). |
| `pulse_web_push_last_success_timestamp_seconds` absent or stale | Nothing accepted since start, or not for a long time. |

**Verify (content):** read the push events from the web log:

```bash
cd stack/compose
docker compose logs --since 1h web | grep -E '"event":"(config_warning|push_[a-z_]+)"'
```

| Event | Meaning |
|-------|---------|
| `config_warning` `{envVar, reason}` | A push variable is missing or invalid; the gateway is misconfigured. |
| `push_apns_auth_failed` | Apple's push service refused the provider key (logged once per failure streak). |
| `push_delivery_failed` `{classification, status, reason}` | One delivery failed; at most one line per device per minute. |
| `push_delivery_dropped` `{cause}` | A queued notification was dropped (`deadline` or `overflow`). |
| `push_registry_corrupt` | The device registry file failed validation and was preserved untouched. |
| `push_registry_write_failed` / `push_registry_degraded` / `push_registry_recovered` | Writes to the data directory are failing, or recovered. |
| `push_device_removed` `{reason}` | A device left the registry (`revoked`, `expired`, `dead-token`, `self`, `superseded`). |
| `push_pairing` `{pairingEvent}` | Pairing activity (issued, redeemed, refused, rate-limited, …). |

**Verify (content):** send a test notification to every paired device. With
`PULSE_PUSH_OPERATOR_SECRET` set in your shell:

```bash
pulse push test --server https://pulse.example.com
```

It prints one line per device: `delivered`, `rejected <reason>`, `token-removed` or `unreachable`. It
exits `1` if any device failed or none is paired.

The reasons Apple's push service returns, and what they mean:

- **BadDeviceToken** — the device registered the wrong environment (a development build against
  production, or the reverse) or a bad token. The device is kept and corrects itself on its next
  refresh. If it repeats, check the app build and pair the phone again.
- **DeviceTokenNotForTopic** — `PULSE_PUSH_APNS_TOPIC` does not match the app's bundle id. Affects
  every device.
- **InvalidProviderToken** / **MissingProviderToken** (with `push_apns_auth_failed`) — the key id,
  team id and `.p8` key do not belong together, or the key was revoked in the Apple developer
  account.
- **ExpiredProviderToken** — handled automatically (the gateway signs again). Persistent occurrences
  mean the host clock is wrong.
- **Unregistered** / **ExpiredToken** (status 410) — the app was uninstalled. The device is removed
  automatically (`removed_dead`).
- **TooManyRequests**, a 5xx status, a timeout or a connection error — transient. Retried for up to 5
  minutes, then dropped. Check the host's outbound HTTPS (port 443) to Apple's push service.

When the webhook is refused:

- **unauthorized** — the Alertmanager credentials file differs from `PULSE_PUSH_WEBHOOK_SECRET`
  (watch for a trailing newline);
- **too_large** — `max_alerts` is missing from the receiver or above 500;
- **malformed** — an Alertmanager version that does not send webhook version 4, or a proxy rewriting
  the body.

## Remediate

#### Step 1 — Fix a misconfiguration (variables, key mount, data directory)

**Command**

```bash
cd stack/compose
$EDITOR .env                                   # fix the PULSE_PUSH_* values the config_warning names
docker compose up -d --wait web
```

**Verify (content):** `/metrics` shows `pulse_web_push_state{state="configured"} 1`, and the web log
holds a `push_started` line with `"state":"configured"`.

**Rollback:** restore the prior `.env` and restart `web`. Push returns to its earlier state;
monitoring is unaffected.

#### Step 2 — Restore or remove a corrupt device registry (registry-corrupt)

The file `/data/push/devices.json` (on the `pulse-web-data` volume) failed validation and was
preserved untouched. The gateway stays misconfigured until you act. If the web image has no shell,
use a helper container that mounts the same volume.

**Command (restore)**

```bash
cd stack/compose
docker compose stop web
# copy the last good devices.json from your volume backup into /data/push/
# (keep mode 0600 and the web user's ownership)
docker compose up -d --wait web
```

**Command (remove)** — every phone must then pair again (issue new codes from **Connect a phone** in
the web UI or with `pulse push pair`):

```bash
cd stack/compose
docker compose stop web
# move the file aside as devices.json.corrupt-YYYY-MM-DD (never delete it first)
docker compose up -d --wait web
```

**Verify (content):** the state is `configured`, and `pulse push devices` lists the expected devices
(restore) or none (remove).

**Rollback:** move the preserved file back and restart `web` (the gateway returns to misconfigured).

#### Step 3 — Fix the provider key or topic (InvalidProviderToken, DeviceTokenNotForTopic)

**Command**

```bash
cd stack/compose
$EDITOR .env                                   # PULSE_PUSH_APNS_KEY_ID / TEAM_ID / TOPIC, or replace the mounted .p8
docker compose up -d --wait web
```

**Verify (content):** `pulse push test --server https://pulse.example.com` reports `delivered` for
every device, and `pulse_web_push_last_success_timestamp_seconds` advances.

**Rollback:** restore the previous values and restart `web`.

#### Step 4 — Fix the webhook credential

Write the same value to the Alertmanager credentials file and to `PULSE_PUSH_WEBHOOK_SECRET`. Use
`printf '%s'` when writing the file so no newline is added.

**Command**

```bash
cd stack/compose
$EDITOR .env                                   # PULSE_PUSH_WEBHOOK_SECRET, matching the credentials file
docker compose up -d --wait alertmanager web
```

**Verify (content):** `pulse_web_push_webhook_total{outcome="accepted"}` increases on the next alert
group, and `outcome="unauthorized"` stops increasing.

**Rollback:** restore both values together and restart both services.

#### Step 5 — Outbound connectivity to Apple's push service

**Command:** check egress from the `web` container on port 443 (firewall, proxy, DNS).

**Verify (content):** transient failures stop, `outcome="dropped"` stops increasing, and
`pulse_web_push_last_success_timestamp_seconds` advances.

**Rollback:** n/a.

## Where to go next

- **Set up, pair and operate push** → [push notifications](/push-gateway/).
- **The human channels are failing too** → [pipeline-health](/pipeline-health/).
- **How alerts are routed** → [alerting](/alerting/).
- **Full runbook index** → [runbooks](/runbooks/).
