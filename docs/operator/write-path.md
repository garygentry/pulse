---
title: Write path
description: The web app's write path — silences, acknowledgements and estate-edit proposals — its forward-auth prerequisite, environment, /data volume layout, audit log growth and retention, backups, the proposal secret, degraded reasons and how to read its health.
slug: write-path
---

# Write path

## What the write path is

The web app can take three kinds of action on behalf of a signed-in operator:

- **Silences.** Create and expire Alertmanager silences.
- **Acknowledgements (acks).** A Pulse-local "someone is on it" marker per firing alert. Acks
  never touch Alertmanager; they are stored in the app's data volume and clear themselves when
  the alert stops firing.
- **Estate-edit proposals.** A signed request to change a small set of declared estate facts.
  The web app only *records* proposals; an operator applies or rejects them with the
  `pulse proposals` CLI, which commits to the estate repository.

The write path is active **only** when `PULSE_WEB_AUTH_MODE=proxy-header`. In the default mode
`none` it is dark: no mutation route exists (`POST /api/mutations/*` returns `405`),
`/api/session` reports every capability as `false`, and `/healthz` reports every write-path
entry as `auth-mode-none`. Every variable on this page is ignored in `none` mode, apart from one
`config_warning` log line that names (never echoes) any that are set.

## Prerequisite: forward-auth

The app has no login of its own. It trusts an identity header set by a forward-auth reverse
proxy in front of it:

- The identity header (`PULSE_WEB_AUTH_HEADER`, default `Remote-User`) is honoured only when the
  request arrives from a peer inside `PULSE_WEB_TRUSTED_PROXIES`. From any other peer the request
  is anonymous, and every mutation is refused as `untrusted-identity`.
- The proxy chain **must preserve `Host`**. This is the default for Caddy and oauth2-proxy. Every
  mutation passes a same-origin check. When the browser sends `Sec-Fetch-Site`, that header
  alone decides, and only `same-origin` passes. When it is absent, the check compares the
  request's `Origin` with `Host`, so a proxy that rewrites `Host` makes those requests refuse as
  `cross-origin`. Modern browsers always send `Sec-Fetch-Site`, but scripted clients and older
  browsers may not.
- Do not switch `PULSE_WEB_AUTH_MODE` to `proxy-header` until the forward-auth proxy is live and
  is the only way to reach `web:8080`.

## Environment

| Env | Default (proxy-header) | Validation | On invalid |
|---|---|---|---|
| `PULSE_WEB_DATA_DIR` | unset → no data root | trimmed; no control characters; absolute path | start-up fails with a config error naming the variable |
| `PULSE_WEB_AUDIT_PATH` | `$PULSE_WEB_DATA_DIR/audit/audit.jsonl`, else none | same | start-up fails |
| `PULSE_WEB_ACK_STORE_PATH` | `$PULSE_WEB_DATA_DIR/acks.json`, else none | same | start-up fails |
| `PULSE_WEB_PROPOSALS_DIR` | `$PULSE_WEB_DATA_DIR/proposals`, else none | same | start-up fails |
| `PULSE_PROPOSAL_SECRET` | unset → `secret-missing` | at least 32 UTF-8 bytes | not an error: proposals are disabled (`secret-missing` / `secret-too-short`) |

- An explicit path always wins over the `PULSE_WEB_DATA_DIR` default. A store with no path is
  reported as `not-configured`; it never stops start-up.
- A **malformed** path (relative, or containing a control character) stops start-up. The error
  names the variable and the rule, never the value.
- A missing or short secret disables **only** proposals. Silences and acks keep working.
- Auth mode `none` ignores all of these with a single warning.
- Changing the secret or the Alertmanager URL needs a restart.

The shipped compose file sets `PULSE_WEB_DATA_DIR: /data` and
`PULSE_PROPOSAL_SECRET: ${PULSE_PROPOSAL_SECRET:-}` on the `web` service and leaves
`PULSE_WEB_AUTH_MODE` unset, so a default deployment stays in `none` mode.

## Volume and layout

- The named volume `pulse-web-data` is mounted at `/data`. The image creates `/data` owned by the
  non-root `bun` user, so a fresh volume inherits writable ownership.
- Files under `/data`:
  - `/data/audit/audit.jsonl` — the audit log;
  - `/data/acks.json` — the current acknowledgements;
  - `/data/proposals/<id>.proposal.json` — signed proposals, plus a `<id>.result.json` sidecar
    written by the CLI once a proposal is applied or rejected.
- The rendered tree stays mounted read-only at `/rendered`.
- **Run a single replica only.** Idempotency, the ack store's write chain and health state are
  process-local. Do not scale the `web` service and do not share the volume between containers.

## Audit log

- **Location.** `/data/audit/audit.jsonl` by default (`PULSE_WEB_AUDIT_PATH` overrides it).
- **Format.** Append-only JSON Lines; every line is flushed to disk (fsync) before the action
  proceeds. Fields: `at`, `actor {subject, displayName, source}`, `action`, `target`, `outcome`,
  `requestId`, `correlationId` (always `null`), `details`, `capability`.
- **Records.** Each mutation writes an `attempted` record before it runs and one final record
  (`succeeded` or `failed`) after. If the `attempted` record cannot be written, the action does
  not run. Refused requests (bad origin, no identity, invalid body, …) are never audited; they are
  counted in metrics instead.
- **Growth estimate.** Tens of actions per day × about 2 records × at most about 4 KB per record
  (details are capped at 32 entries of at most 256 bytes) is at most about **400 KB/day**, or about
  **150 MB/year** worst case. Typical records are under 1 KB, which gives about **35 MB/year**.
- **No in-app rotation.** The app never rotates, truncates or expires the audit log; it is retained
  indefinitely. If you rotate it externally, do so with the app stopped, or rename the file and
  restart the app so it opens a fresh file.

## Backups

- Back up `/data` with the host's volume backup (for example restic). Daily is recommended.
- The audit file is the compliance record: keep its backups for as long as you need the history.
- `acks.json` is convenience state; losing it only clears current acknowledgements.
- Proposals are durable until they are decided; back them up with the rest of `/data`.
- After a restore, check that the last line of `audit.jsonl` parses as JSON. A torn final line
  from a crash mid-write can be removed.

## Proposal secret

- Generate it with `openssl rand -base64 48` (at least 32 bytes).
- Keep it only in the compose env file, as `PULSE_PROPOSAL_SECRET`. It is never logged, never
  written into a proposal file and never returned by any route.
- Configure the **same** secret for the `pulse proposals` CLI (also via `PULSE_PROPOSAL_SECRET`),
  which verifies each proposal's signature before applying or rejecting it.
- Rotating the secret invalidates every unapplied proposal: they no longer verify and are listed
  as invalid. Decide outstanding proposals before rotating.

## Deciding proposals with the CLI

Proposals are decided outside the web app, from a checkout of the estate repository:

```sh
pulse proposals list   [--state pending|applied|rejected] [--proposals-dir <dir>] [--json]
pulse proposals show   <id>                               [--proposals-dir <dir>] [--json]
pulse proposals apply  <id> [--overlay <file>]            [--proposals-dir <dir>] [--json]
pulse proposals reject <id> --reason "<10–500 chars>"     [--proposals-dir <dir>] [--json]
```

- **Proposals directory.** `--proposals-dir` wins over `PULSE_PROPOSALS_DIR`, which wins over
  `proposalsDir` in `pulse.config.yaml`. Point it at the web app's proposals directory
  (`/data/proposals` inside the container, or wherever the volume is mounted on the host). It does
  not need to be inside the git repository.
- **Secret.** The CLI reads `PULSE_PROPOSAL_SECRET` from its environment only (never from
  `pulse.config.yaml`), and it must be the same value the web app uses. A missing or short secret
  exits 2.
- `list` and `show` are read-only. `list` reports tampered or unverifiable files as invalid and
  still exits 0. `show` never prints the contents of a file that fails verification.
- `apply` verifies the signature, checks that the entity still has the value the proposer saw,
  edits the overlay file, re-validates and re-renders, then makes **one local commit** (it never
  pushes). It refuses a dirty estate or rendered tree and rolls every file back on failure. Push
  the commit yourself after review.
- `reject` records the reason in a `<id>.result.json` sidecar and does not need git.
- Deciding an already-decided proposal again changes nothing and exits 0.
- A reason that starts with a dash must be written as `--reason=-…` (joined with `=`); as a
  separate argument it is read as a flag.
- Exit codes: 0 success, 1 a refused proposal (not found, invalid signature, stale, dirty tree,
  ambiguous overlay, invalid estate), 2 a usage, configuration or git fault.

## Degraded write path

Each capability depends on a set of stores (audit, acks, proposals, secret, Alertmanager). When a
store fails, the affected capabilities turn off and report a reason; reads keep working.

| reason | Meaning | Fix |
|---|---|---|
| `not-configured` | No path and no `PULSE_WEB_DATA_DIR` (or no Alertmanager write client) | Set the env var / mount the volume |
| `missing` | Directory absent and not creatable | Mount the volume |
| `unwritable` | Write access / open-for-append failed | Check ownership, read-only mounts, a full disk |
| `corrupt` | `acks.json` is invalid; it is preserved untouched and the state **persists until restart** | Repair or move the file aside, then restart |
| `secret-missing` / `secret-too-short` | Secret unset / shorter than 32 bytes | Set it, then restart |
| `write-failed` | A live write just failed | Clears on the next good slow-cycle probe; check the disk |
| `auth-mode-none` | Auth mode is `none` | Expected until forward-auth is live |

## Reading health

- **`/healthz`.** The body carries `writePath.<capability>.{ok, reason}` for `silence`, `ack` and
  `proposeEstateEdit`. The top-level `status` is **not** affected by write-path problems, so the
  container healthcheck never restarts the app over a full disk.
- **Metrics** (on `/metrics`):
  - `pulse_web_write_path_status{store,reason}` — one series per store; alert on
    `reason!="ok"`. Present only in proxy-header mode.
  - `pulse_web_mutations_total{action,outcome}` — actions taken (including idempotent replays).
  - `pulse_web_mutation_refusals_total{action,reason}` — requests refused before running.
  - `pulse_web_audit_write_failures_total{phase}` — any increase needs attention. A `finalize`
    failure means an action happened without its final audit line.
  - `pulse_web_ack_auto_clears_total` — acks cleared because their alert stopped firing.
- **Logs.** JSON lines on stdout: `write_path_degraded` / `write_path_recovered` edges, and
  `mutation_succeeded` / `mutation_failed` / `mutation_refused` / `mutation_internal_error` lines
  whose `requestId` matches the audit record and the response's `X-Request-Id` header.
