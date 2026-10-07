---
title: Rollout session
description: The supervised session skeleton that wires alert channels and the deadman, transforms the rendered routing into a native Alertmanager config, resolves its SecretRefs into a git-ignored config Alertmanager can read, mounts it and the rendered vmalert rules via an override, and shakes down alerting with amtool, promtool, and a synthetic v2 alert — verified by content at every step.
slug: rollout-session
---

# Rollout session

This runbook is the **operator-supervised session** you run once per estate to wire alert
channels, hook up the deadman, point Alertmanager and vmalert at the *inventory-derived*
alerting artifacts, and shake the whole path down against the rule library. It is executed
after the [bootstrap](/bootstrap/) has the engine up and [agents](/agent-install/) are
reporting.

Two facts about the committed stack tree shape this session, and this runbook **resolves both
without ever editing the base compose tree** — every change is layered through an
operator-authored, git-ignored `docker-compose.override.yml` (the same mechanism the
[bootstrap runbook](/bootstrap/) uses to expose host ports):

- **Alertmanager boots from a bootstrap config, not the rendered routing.** Alertmanager
  starts with `--config.file=/etc/alertmanager/alertmanager.yml`, which the base tree fills
  from `./config/alertmanager/alertmanager.bootstrap.yml`. The rendered
  `rendered/alertmanager/routing.yaml` is an **abstract `{name, config}` slot Alertmanager
  cannot read** — the compose tree mounts it as a placeholder only. You must run the alerting
  transform to emit a **native** Alertmanager config and remount that onto the config path.
- **vmalert mounts only the static rule glob.** vmalert reads `-rule=/etc/vmalert/rules/*.yml`
  over the static mount `./config/vmalert/rules:/etc/vmalert/rules:ro`. The **rendered** rules
  (`rendered/vmalert/rules/{deep-health,backup}.yml`, produced by the same transform) are
  **not** mounted. You add them through the override so vmalert loads them.
- **Alertmanager does not resolve secrets in its config file.** The native
  `alertmanager.yml` the transform emits carries every channel credential as an **unresolved**
  SecretRef verbatim — `${CHAT_WEBHOOK_URL}`, `${SMTP_PASSWORD}`, `${TELEGRAM_BOT_TOKEN}`,
  `op://infra/pager/routing-key`, and so on (the transform never resolves a ref, and refuses a
  literal). Alertmanager does **not** env-expand its config file, and compose substitution
  templates only the compose file — never a bind-mounted file's contents. So you must
  **materialize a resolved config** (Step 3) and mount *that*; mounting the raw rendered
  `alertmanager.yml` would send Alertmanager literal `${…}` strings and no alert would deliver.

The worked estate is the committed reference fixture at `examples/reference/`; its channels
(`ops-chat`/chat, `ops-email`/email, `oncall-push`/push, `mirror-hook`/webhook), its
`routing_overrides` for `critical` and `warning`, and its `deadman_hook` are the live
example. Substitute your own estate directory and channels throughout.

## About the exit contract

The `pulse render` step below branches on the stable exit contract: **`0`** clean, **`1`**
findings or drift (fix the estate or re-render, then re-run), **`2`** a tool fault — an I/O
error or an unreadable config, which you fix in the environment and **never** by editing the
estate. `bun run alerting:render` is a sibling transform, not a `pulse` verb; it is
**whole-or-nothing** — a single `error`-severity finding blanks all three of its outputs, so
you verify its outputs are non-empty by content, never by exit code alone.

## Steps

#### Step 1 — Populate the deadman and per-channel credentials in `.env`

The deadman and every channel resolve their SecretRefs from the git-ignored
`stack/compose/.env`. `PULSE_DEADMANSSWITCH_URL` is the deadman receiver URL;
`PULSE_WEBHOOK_MIRROR_URL` is the webhook-mirror receiver; each channel's credential
(`${CHAT_WEBHOOK_URL}`, `${SMTP_PASSWORD}`, `op://infra/pager/routing-key`,
`${WEBHOOK_MIRROR_TOKEN}` in the reference estate) is supplied the same way. See
[secret recipes](/secret-recipes/) for how the `${ENV}` and `op://` grammars resolve.

**Command**

```bash
cd stack/compose
# Edit .env (created in the bootstrap runbook, Step 4) and set at least:
#   PULSE_DEADMANSSWITCH_URL=...        # deadman receiver URL (a SecretRef value)
#   PULSE_WEBHOOK_MIRROR_URL=...        # webhook-mirror receiver URL
#   CHAT_WEBHOOK_URL=...                # ops-chat channel credential
#   SMTP_PASSWORD=...                   # ops-email channel credential
#   WEBHOOK_MIRROR_TOKEN=...            # mirror-hook channel credential
# op:// references (e.g. oncall-push) resolve via `op run` — see /secret-recipes/.
```

**Verify (content):** each key is present and non-empty —
`grep -E '^PULSE_DEADMANSSWITCH_URL=..' .env` prints a line with a value after the `=`
(repeat for each key you set) — and `git check-ignore stack/compose/.env` prints the path,
confirming no credential is ever committed.

**Rollback:** re-edit `.env` to blank the keys you added (or `git checkout` is not applicable
— `.env` is git-ignored and was never committed); no service has re-read them until Step 5.

#### Step 2 — Transform rendered routing into a native Alertmanager config (resolves warning A)

The alerting transform reads the estate and the rendered tree and emits a native Alertmanager
config plus the rendered vmalert rule families.

**Command**

```bash
bun run alerting:render examples/reference/estate examples/reference/rendered
```

**Verify (content):** the transform wrote a **non-empty** native config —
`test -s examples/reference/rendered/alertmanager/alertmanager.yml` succeeds (the
whole-or-nothing transform blanks every output on any error finding, so a non-empty file is
the proof it succeeded). Then validate it *as* an Alertmanager config:

```bash
amtool check-config examples/reference/rendered/alertmanager/alertmanager.yml
```

confirm it prints `SUCCESS` and lists the parsed receivers — including `pulse-deadman` and
the estate's channel receivers. The sibling rule files also appear:
`ls examples/reference/rendered/vmalert/rules/` lists `deep-health.yml` and `backup.yml`.

**Rollback:** `git checkout -- examples/reference/rendered/alertmanager/alertmanager.yml
examples/reference/rendered/vmalert/rules/` restores the prior transform outputs. The
transform stages temps and renames atomically, so a failed run never truncates a file.

#### Step 3 — Resolve the config secrets, then point Alertmanager and vmalert at the rendered artifacts (override; resolves warnings A + B)

First **materialize a resolved Alertmanager config**. The native `alertmanager.yml` carries
unresolved SecretRefs (the third fact above), and Alertmanager will not expand them — so
resolve them into a git-ignored file *beside* the rendered config and mount **that**, never the
raw one. Resolution uses the same `${ENV}` / `op://` grammars as everything else — see
[secret recipes](/secret-recipes/).

**Command**

```bash
# Run from the repo root (the next command block writes stack/compose/… relative to it).
NATIVE=examples/reference/rendered/alertmanager/alertmanager.yml
RESOLVED=examples/reference/rendered/alertmanager/alertmanager.resolved.yml

# Recipe A — every credential is a ${ENV} ref, resolved from the git-ignored stack/compose/.env:
set -a; . stack/compose/.env; set +a
envsubst < "$NATIVE" > "$RESOLVED"

# Recipe B — if any credential is an op:// ref (e.g. oncall-push in the reference estate),
# resolve op:// AND ${ENV} in one streamed pass — no intermediate plaintext file to leak or
# forget (op inject writes to stdout; envsubst finishes the ${ENV} refs):
#   set -a; . stack/compose/.env; set +a
#   op inject -i "$NATIVE" | envsubst > "$RESOLVED"

# The resolved file holds PLAINTEXT secrets — the *.resolved.yml .gitignore pattern keeps it
# untracked. Confirm before it exists on disk with real secrets in a shared checkout:
git check-ignore "$RESOLVED"
```

Then layer an operator-authored `docker-compose.override.yml` that (A) remounts the **resolved**
Alertmanager config onto the config path, and (B) mounts the rendered vmalert rule files
**flat** into the static rules directory so the existing `-rule=/etc/vmalert/rules/*.yml`
single-level glob reaches them — no flag change, no edit to the committed tree.

**Command**

```bash
cat > stack/compose/docker-compose.override.yml <<'YAML'
services:
  alertmanager:
    volumes:
      # RESOLVED native AM config (secrets expanded) — NOT the raw rendered alertmanager.yml
      - ../../examples/reference/rendered/alertmanager/alertmanager.resolved.yml:/etc/alertmanager/alertmanager.yml:ro
  vmalert:
    volumes:
      # rendered rules mounted FLAT so the base `*.yml` glob picks them up (a bare dir path
      # would be read as a single file and fatal vmalert — mount each file, not the dir):
      - ../../examples/reference/rendered/vmalert/rules/backup.yml:/etc/vmalert/rules/rendered-backup.yml:ro
      - ../../examples/reference/rendered/vmalert/rules/deep-health.yml:/etc/vmalert/rules/rendered-deep-health.yml:ro
YAML
cd stack/compose && docker compose up --wait --wait-timeout 180
```

> If you already have a `docker-compose.override.yml` from the bootstrap runbook (host-port
> exposure), **merge** these `services:` blocks into it rather than overwriting the file.

**Verify (content):** the merge is layered and the base tree is untouched —
`docker compose config` shows the `alertmanager` service's config volume resolving to the
`alertmanager.resolved.yml` and the two `vmalert` rule mounts under `/etc/vmalert/rules/`,
and `git check-ignore stack/compose/docker-compose.override.yml` prints the path. Confirm the
resolved config carries **no** leftover `${…}`/`op://` reference —
`! grep -Eq '\$\{|op://' ../../examples/reference/rendered/alertmanager/alertmanager.resolved.yml`
succeeds. Then confirm each engine actually loaded the artifacts by content:

```bash
# Alertmanager parsed the native config — its status shows the estate receivers:
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- http://alertmanager:9093/api/v2/status | grep -o 'pulse-deadman'"

# vmalert loaded the rendered rules — the backup family is live:
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- http://vmalert:8880/api/v1/rules | grep -o 'BackupNoData'"
```

`pulse-deadman` and `BackupNoData` appearing in the responses proves the override wired both
artifacts into the running engine — state, not the `up --wait` exit code.

**Rollback:** `rm stack/compose/docker-compose.override.yml && cd stack/compose && docker
compose up --wait` (or remove just these two `services:` blocks if the file also carries your
host-port exposure), then `rm -f examples/reference/rendered/alertmanager/alertmanager.resolved.yml`
to shred the plaintext-secret config. The stack returns to the bootstrap slot mounts; no
committed file changed.

#### Step 4 — Verify routing sends each severity to the intended receiver

**Command**

```bash
amtool config routes test \
  --config.file examples/reference/rendered/alertmanager/alertmanager.yml \
  severity=critical
```

**Verify (content):** the printed receiver matches the estate's `routing_overrides` for
`critical` — in the reference estate, the `oncall-push` / `ops-chat` receivers. Repeat with
`severity=warning` and confirm it resolves to the warning override's receiver. Inspect the
**resolved receiver name**, not the exit code.

**Rollback:** none — this is a read-only check against the rendered config.

#### Step 5 — Lint the vmalert rules (static + rendered)

**Command**

```bash
promtool check rules \
  stack/compose/config/vmalert/rules/*.yml \
  examples/reference/rendered/vmalert/rules/*.yml
```

**Verify (content):** promtool prints `SUCCESS: N rules found` with **no** `FAILED` line, and
the output includes `BackupStale`, `BackupCritical`, `BackupNoData`, and the deep-health rule
names — confirming both the static library and the rendered families parse.

**Rollback:** none — this is a read-only lint.

#### Step 6 — Fire a synthetic alert and confirm delivery (deadman + channels)

Post one synthetic alert into Alertmanager's v2 API and confirm it lands and that the
notification pipeline advanced — the end-to-end proof channels and the deadman deliver.

**Command**

```bash
docker compose -f stack/compose/docker-compose.yml run --rm --entrypoint sh alertmanager -c '
  wget -qO- --header="Content-Type: application/json" \
    --post-data="[{\"labels\":{\"alertname\":\"PulseShakedown\",\"severity\":\"warning\"}}]" \
    http://alertmanager:9093/api/v2/alerts'
```

**Verify (content):** the alert is registered and the notification counter advanced —

```bash
# the synthetic alert is present:
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- http://alertmanager:9093/api/v2/alerts | grep -o 'PulseShakedown'"

# the deadman receiver has delivered at least once:
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- 'http://victoriametrics:8428/api/v1/query?query=alertmanager_notifications_total' | grep -o 'pulse-deadman'"
```

`PulseShakedown` appearing in the alert list and the `pulse-deadman` receiver appearing in
the notification-counter series prove delivery by state, not by the POST's exit code.

**Rollback:** the synthetic alert auto-resolves after its `endsAt`; to clear it immediately,
POST the same alert with an `endsAt` timestamp in the past. No configuration was mutated, so
there is nothing else to undo.

## Where to go next

- **Enroll backups on day one** → [backup enrollment](/backup-enrollment/).
- **Supply real channel credentials** → [secret recipes](/secret-recipes/).
- **Understand the running stack and the override mechanism** → [runtime posture](/runtime-posture/).
- **Full runbook index** → [runbooks](/runbooks/).
