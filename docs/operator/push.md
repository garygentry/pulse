---
title: Push notifications
description: How to turn on the optional push gateway in the web service — the variables, the .p8 key mount, wiring Alertmanager, pairing phones, the `pulse push` CLI, metrics, accepted risks and a manual live check.
slug: push-gateway
---

# Push notifications

The web service can send alert notifications to paired iPhones through Apple's push notification
service. This page is the operator guide: how to configure it, wire Alertmanager to it, pair phones
and check it. When one of its alerts fires, go to the [push runbook](/push/).

## What it is

- **Outbound only.** The web service opens connections to Apple's push notification service. Nothing
  new is exposed to the internet: the Alertmanager webhook is internal-network only, and the phone
  reaches only the pairing and device routes through the same reverse proxy that already serves the
  web UI.
- **In addition to email and Telegram, never instead.** Alertmanager offers each notification to push
  as an extra child route with `continue: true`, so existing routing is unchanged. A broken push
  gateway never hides an incident from the human channels.
- **Off until configured.** With none of the four `PULSE_PUSH_APNS_*` variables set (the shipped
  default), push is `disabled`: every `/api/push/*` path behaves exactly like an unknown path, no
  log line is written, and `/metrics` shows only the state gauge.

## Variables

Set these on the **web** service (the shipped `docker-compose.yml` passes each one through with an
empty default, and an empty value counts as unset).

| Variable | Rule |
|---|---|
| `PULSE_PUSH_APNS_KEY_FILE` | Absolute in-container path to the APNs auth key (`.p8`). Must be readable and be a PKCS#8 EC P-256 private key. Use `/run/secrets/apns.p8` with the mount below. |
| `PULSE_PUSH_APNS_KEY_ID` | The key id: 10 upper-case letters or digits. |
| `PULSE_PUSH_APNS_TEAM_ID` | The Apple Developer team id: 10 upper-case letters or digits. |
| `PULSE_PUSH_APNS_TOPIC` | The app bundle id, for example `com.example.pulse` (at most 155 bytes). |
| `PULSE_PUSH_WEBHOOK_SECRET` | Optional. At least 32 bytes, no control characters. Shared with Alertmanager. Unset → the webhook is off (503). |
| `PULSE_PUSH_OPERATOR_SECRET` | Optional. At least 32 bytes, no control characters. Used by the `pulse push` CLI. Unset → `/api/push/admin/*` is off (503). |
| `PULSE_PUSH_MAX_DEVICES` | Optional integer 1–100, default 20. |
| `PULSE_WEB_DATA_DIR` | Existing variable (`/data` in the shipped compose file). **Required whenever push is configured, in every auth mode.** Push stores its device registry in `<data dir>/push/devices.json`. |

The four `PULSE_PUSH_APNS_*` variables activate push: once any one of them is set, all four must
be valid. Generate the two secrets with `openssl rand -base64 48`; see
[secret recipes](/secret-recipes/). Never commit them.

## States

```
                 any PULSE_PUSH_APNS_* set
  disabled  ──────────────────────────────►  all valid, data dir writable,
  (default)                                   registry readable?
                                               │yes                │no
                                               ▼                   ▼
                                           configured         misconfigured
```

| | `disabled` | `misconfigured` | `configured` |
|---|---|---|---|
| `/metrics` | `pulse_web_push_state{state="disabled"} 1` only | state gauge `misconfigured` plus the other push families | state gauge `configured` plus the other push families |
| `/api/push/*` | behaves as an unknown path (404 for GET, 405 otherwise) | `GET /api/push/status` answers `{state: "misconfigured"}`; every other push route answers 503 `PUSH_UNAVAILABLE` | the full route table |
| "Connect a phone" screen | no push sections | no push sections | pairing and device list shown |
| `push` capability in `/api/session` | not advertised | not advertised | advertised |

Within `configured`, the two optional surfaces are independent: an unset or too-short webhook
secret turns only the webhook off, and an unset or too-short operator secret turns only the
operator (CLI) routes off. Each off surface answers 503 `PUSH_UNAVAILABLE`, and each is named once
in a `config_warning` log line.

Every problem is logged once at start as a `config_warning` line naming the variable and a reason.
The value itself is never logged.

| Reason | Meaning | Fix |
|---|---|---|
| `missing` | A required variable is unset (or an optional secret is unset, which turns its surface off). | Set it, or leave all four `PULSE_PUSH_APNS_*` unset to keep push disabled. |
| `invalid` | The value does not match its rule (key id, team id, topic, device cap), or the key file is not a P-256 PKCS#8 key. | Correct the value; re-download the key if needed. |
| `unreadable` | The key file cannot be read by the container user. | Check the mount and the host file mode (0400, readable by the container user). |
| `not-absolute` | `PULSE_PUSH_APNS_KEY_FILE` or `PULSE_WEB_DATA_DIR` is a relative path. | Use an absolute in-container path. |
| `too-short` | A webhook or operator secret is shorter than 32 bytes. Only its surface turns off. | Generate a new one with `openssl rand -base64 48`. |
| `data-dir-missing` | `PULSE_WEB_DATA_DIR` is unset while push is configured. | Set it (the shipped compose file sets `/data`). |
| `data-dir-unwritable` | `<data dir>/push` cannot be created or written. | Fix the volume's ownership and permissions. |
| `registry-corrupt` | `push/devices.json` exists but cannot be read or parsed. The file is left untouched. | Restore it from backup or move it aside; see the [runbook](/push/). |

A misconfiguration never stops the server: the overview, the rest of the API and the web UI keep
working, and only push stays off.

## Why the no-auth `config_warning` still names `PULSE_WEB_DATA_DIR`

In auth mode `none`, the write path (acknowledgements, proposals, audit) is off and ignores the
write-path variables. It still logs its existing `config_warning` listing them, including
`PULSE_WEB_DATA_DIR`. Push reads the same variable independently, in every auth mode, to store
`push/devices.json`. That warning is about the write path only; push is unaffected, so the two do
not contradict each other.

## The `.p8` key mount

1. Put the key on the host with file mode 0400, owned so that the web container's user can read it.
2. In `stack/compose/docker-compose.yml`, uncomment the web service line
   `# - ${PULSE_PUSH_APNS_KEY_HOST_PATH}:/run/secrets/apns.p8:ro` (or add it in your
   `docker-compose.override.yml`).
3. Set `PULSE_PUSH_APNS_KEY_HOST_PATH` to the host path and
   `PULSE_PUSH_APNS_KEY_FILE=/run/secrets/apns.p8`.
4. Restart the web service.

The key is read once at start; replacing it needs a restart. Never put the key's contents in `.env`
and never commit it.

## Sandbox versus production

Each device states its push environment when it registers. Development builds of the app use
Apple's sandbox push service; TestFlight and App Store builds use Apple's production push service.
One key serves both, and the server picks the service per device. A device that repeatedly fails
with `BadDeviceToken` most likely registered the wrong environment: reinstall the right build and
pair it again.

## Wiring Alertmanager

The shipped Alertmanager configuration is not changed. `examples/alertmanager/push-receiver.yml` is a
snippet to merge into yours:

1. Add the `pulse-push` receiver to `receivers:`. It posts to `http://web:8080/api/push/alertmanager`
   on the compose network with `send_resolved: true`, `max_alerts: 500` and a bearer credential read
   from `credentials_file: /etc/alertmanager/secrets/pulse-push-webhook`.
2. Add the `pulse-push` route as the **first** child route of `route.routes:`, with no matchers and
   `continue: true`, so every alert group is offered to push and then routed exactly as before.
3. Add a catch-all `- receiver: <your root receiver>` as the **last** child route. Once the push route
   has matched, Alertmanager no longer falls back to the root receiver, so without this entry an alert
   that no other child route matches would reach push only.
4. Mount the credentials file into the Alertmanager container through an operator-owned
   `docker-compose.override.yml`, for example a read-only bind of a host file to
   `/etc/alertmanager/secrets/pulse-push-webhook`. Its content must equal
   `PULSE_PUSH_WEBHOOK_SECRET`, with no trailing newline (see [secret recipes](/secret-recipes/)).
5. Reload Alertmanager and check its log for a rejected configuration.

`max_alerts: 500` keeps a storm inside the webhook's limits: Alertmanager truncates the call and
reports the number left out, and when a group carries more than five alerts the phone gets one
summary notification instead of one per alert.

**Alertmanager does not retry a 4xx answer**, so a refused call (wrong credential, malformed or too
large) is lost. That is what the `PushWebhookRefused` alert is for.

The webhook is internal-network only: never route `/api/push/alertmanager` through the reverse proxy
(see [exposure](/exposure/)). Without `PULSE_PUSH_WEBHOOK_SECRET` it answers 503 and nothing is sent.

## Pairing a phone

- **From the web UI.** Open "Connect a phone" and choose "Pair a device". The screen shows a QR code
  valid for 10 minutes. A new code replaces any earlier one, and "Cancel" voids it. Scan it with the
  Pulse app.
- **From the CLI.** `pulse push pair` prints the same kind of link and QR code (see below).

A link that carries a pairing code (`pair=`) **is a secret**: it pairs one device. Do not paste it into
chat, tickets or logs. A plain connect link without a pairing code is still not a secret.

When the device cap (`PULSE_PUSH_MAX_DEVICES`) is reached, pairing is refused: revoke a device on the
screen or with `pulse push revoke <id>` and try again. In `proxy-header` auth mode, issuing a code from
the web UI is a gated write that needs a trusted identity and a same-origin request.

## The CLI

`pulse push` drives the operator routes (`/api/push/admin/*`) from a shell:

```
pulse push pair                      # issue a pairing link and print it with a QR code
pulse push devices                   # list paired devices
pulse push revoke <id>               # revoke one device, for example dev_AbCdEfGhIjK
pulse push test [--device <id>]      # send a test notification to every device, or to one
```

Common flags: `--server <url>`, `--json`, `--quiet`, `--verbose` and `--insecure-local`.

**Address precedence.** The server address is the first source that is set:

1. `--server`, for example `--server https://pulse.example.com`;
2. `PULSE_SERVER_URL`;
3. `server` in `pulse.config.yaml`;
4. `PULSE_WEB_EXTERNAL_URL`;
5. `externalUrl` in `pulse.config.yaml`.

Blank values count as unset. Each source is normalised (`https://pulse.example.com/` becomes
`https://pulse.example.com`) and must be https and not loopback. If the chosen source is refused, the
CLI reports `PUSH_SERVER_MISSING` naming that source and does not fall through to a lower one.

**`--insecure-local`** is for development only. It is accepted only together with `--server`, and only
for `http://127.0.0.1:<port>` or `http://localhost:<port>`. It sends the operator secret unencrypted
and prints a warning on stderr even with `--quiet`. `pair` over `--insecure-local` works only when the
server has a usable `PULSE_WEB_EXTERNAL_URL`, because a plain-HTTP address never goes into a link.

**The operator secret** is read only from `PULSE_PUSH_OPERATOR_SECRET` in the CLI's environment, with
the same value as the server's. It is never a flag and never a config key: a key whose name contains
`secret` in `pulse.config.yaml` is rejected. Generate it with `openssl rand -base64 48`.

**The pair link is a secret.** `pulse push pair` prints it to stderr, and with `--json` also to stdout
in the envelope. Do not log, share or persist it. It pairs one device and expires after 10 minutes.

**Timeouts.** Each request has a 10 s timeout, except `test`, which waits up to 60 s while the server
retries Apple's push service.

**Findings.** Failures are reported as error findings:

| Code | Meaning |
|---|---|
| `PUSH_SERVER_MISSING` | No server address is set, or the chosen address was refused (not https, loopback, or malformed). |
| `PUSH_OPERATOR_SECRET_MISSING` | `PULSE_PUSH_OPERATOR_SECRET` is unset, empty or not usable in a header. |
| `PUSH_SERVER_UNREACHABLE` | Network, DNS or TLS failure, a redirect, a timeout, or an unexpected status or body. |
| `PUSH_OPERATOR_REFUSED` | The server answered 401: the operator secret does not match. |
| `PUSH_NOT_CONFIGURED` | The server answered 404 or 405: push is disabled there, or the server predates push. |
| `PUSH_MISCONFIGURED` | The server answered 503 `PUSH_UNAVAILABLE`: push is misconfigured, or its operator routes are off. |
| `PUSH_PAIR_NO_ADDRESS` | `pair` only: the server has no usable https address for the link, or the link would be too long. |
| `PUSH_DEVICE_NOT_FOUND` | No paired device has the given id. |
| `PUSH_NO_DEVICES` | `test` only: no device is paired. |
| `PUSH_TEST_FAILED` | `test` only: at least one device did not report `delivered`. |

**Exit codes** stay those of every `pulse` command: 0 on success, 1 when a finding is reported, and 2
for a usage error (unknown sub-command or flag, a malformed id, `--insecure-local` misuse), a malformed
`pulse.config.yaml`, or an unexpected error.

## Badge

The app badge equals the overview's firing-alert count, excluding the heartbeat alert, so it matches
the web UI. It may trail by one refresh. It is omitted while Alertmanager data is not current, and it
caps at 1024, the overview's list limit, exactly as the web UI does.

## Accepted risks

- **Notification text leaves the network.** Alert names and target labels appear in notification text,
  and so pass through Apple's push service. Nothing else is sent: no annotations, no URLs and no other
  labels.
- **Pairing in no-auth mode.** In auth mode `none`, anyone who can reach the web UI can pair a device.
  - A device paired from inside the network keeps receiving alert names and target labels after it
    leaves, until it is revoked or expires (90 days unseen).
  - Users on the network can fill the device cap and block new pairings.

  Mitigation: review `pulse push devices` or the screen's device list and revoke what you do not
  recognise, or use `proxy-header` mode, where issuing a code is gated.
- **Limiter denial.** Any caller that can reach the redeem route can make 10 failed attempts in 10
  minutes. That trips the server-wide limiter and voids outstanding codes. This applies in
  `proxy-header` mode too, because redeeming is unauthenticated by design. Mitigation: issue a fresh
  code once the window clears. It is accepted for the same reason as the previous risk.

## Metrics and the alert rules

| Family | Type | Labels |
|---|---|---|
| `pulse_web_push_state` | gauge | `state` (`disabled`, `configured`, `misconfigured`); 1 on the current state |
| `pulse_web_push_devices` | gauge | none |
| `pulse_web_push_webhook_total` | counter | `outcome` (`accepted`, `unauthorized`, `malformed`, `too_large`, `unavailable`) |
| `pulse_web_push_notifications_total` | counter | `kind` (`firing`, `resolved`, `repeat`, `summary`, `test`) × `outcome` (`delivered`, `failed`, `dropped`, `filtered`, `token_removed`) |
| `pulse_web_push_last_success_timestamp_seconds` | gauge | none; present once Apple's push service has accepted a notification |
| `pulse_web_push_pairing_events_total` | counter | `event` (`issued`, `redeemed`, `refused`, `cap_reached`, `rate_limited`, `cancelled`, `revoked`, `expired`, `removed_dead`) |
| `pulse_web_push_admin_refusals_total` | counter | none; operator calls refused for the secret |

While push is disabled only the three `pulse_web_push_state` series appear. Otherwise there are 44
series (45 once a notification has been delivered).

`stack/compose/config/vmalert/rules/push.yml` ships three rules, silent while push is disabled:

- **PushGatewayMisconfigured** (warning): the state gauge reads `misconfigured` for 10 minutes.
- **PushDeliveryFailing** (critical): devices are paired, notifications failed or were dropped in the
  last 30 minutes, and nothing was accepted for 30 minutes, sustained for 15 minutes.
- **PushWebhookRefused** (warning): devices are paired and webhook calls were refused (unauthorized,
  malformed or too large) in the last 30 minutes, sustained for 15 minutes.

They page through the existing email/Telegram routes. Diagnosis and recovery are in the
[runbook](/push/).

## Manual live round trip (outside CI)

CI uses a fake push service. Before relying on push, check one real round trip:

- [ ] An Apple Developer Program team, an APNs auth key (`.p8`) with its key id, the team id, and the
      app bundle id.
- [ ] Set the variables and the key mount, restart, and confirm `pulse_web_push_state{state="configured"} 1`.
- [ ] Set the webhook and operator secrets, and wire Alertmanager as in [Wiring Alertmanager](#wiring-alertmanager).
- [ ] Install a development build on a device, pair it with the QR code, and confirm it is listed with
      environment `sandbox`.
- [ ] `pulse push test` reports `delivered`, and the notification appears on the phone.
- [ ] Fire a test alert (for example a temporary rule or `amtool alert add`): the notification is
      audible with the badge set, a repeat is quiet, and the resolution replaces it.
- [ ] Mute `info` on the phone, fire an info alert, and confirm nothing arrives.
- [ ] Repeat with a TestFlight build (environment `production`).
- [ ] Revoke the device and confirm the next `pulse push test` reports `PUSH_NO_DEVICES`.
- [ ] Remove the test alert and rule.

## Where to go next

- [Secret recipes](/secret-recipes/) — generating and storing the push secrets.
- [Exposure](/exposure/) — which push routes may pass through the reverse proxy.
- [Alerting](/alerting/) — how push fits beside the existing routes.
- [Push runbook](/push/) — what the push alerts mean and how to recover.
- [Web overview](/web-overview/) — the web service and its configuration.
