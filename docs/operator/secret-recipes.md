---
title: Secret recipes
description: The two supported secret backends — env-var substitution and 1Password op:// — and the no-literal invariant.
slug: secret-recipes
---

# Secret recipes

**The load-bearing invariant, stated first:** a credential in your estate is always a
*reference*, never a literal value. The renderer emits a `SECRET_LITERAL` finding and
**refuses to render** a literal credential, so no secret value ever reaches the estate
file, the rendered tree, or git. The real value is supplied only at deploy/run time, into
the process environment, by one of the two recipes below.

Pulse v1 supports exactly **two** secret backends, each mapped to one of core-contract's
two SecretRef grammars:

| Grammar | Shape | Recipe |
|---------|-------|--------|
| `ENV_REF_RE` | `${UPPER_SNAKE}` — e.g. `${CHAT_WEBHOOK_URL}` | env-var substitution via a git-ignored `.env` (§ Recipe A) |
| `OP_REF_RE` | `op://vault/item/field` — e.g. `op://infra/hypervisor/token` | 1Password `op run` / `op inject` (§ Recipe B) |

The [reference estate](/getting-started/) declares credentials in both grammars — for
example the channel credential `${CHAT_WEBHOOK_URL}` and the hypervisor credential
`op://infra/hypervisor/token` — and those are the live worked examples the recipes below
resolve.

## Recipe A — environment-variable substitution

**Backend:** `ENV_REF_RE` (`${UPPER_SNAKE}`).

Docker Compose performs `${VAR}` substitution from a `.env` file in the compose project
directory at `up` time. stack-core ships a **committed, non-secret**
`stack/compose/.env.example`; you copy it to a **git-ignored** `.env` and fill in the real
values.

```bash
# 1. Copy the committed non-secret template to the git-ignored .env
cp stack/compose/.env.example stack/compose/.env

# 2. Edit stack/compose/.env — replace each placeholder with a real value.
#    An estate credential written "${CHAT_WEBHOOK_URL}" (matches ENV_REF_RE)
#    resolves from the env var of the same name:
#      CHAT_WEBHOOK_URL=<the real chat webhook URL>
#    Confirm .env is git-ignored (this MUST print the path — i.e. it IS ignored):
git check-ignore stack/compose/.env

# 3. Bring the stack up; compose substitutes ${CHAT_WEBHOOK_URL} etc. from .env
cd stack/compose && docker compose up --wait
```

**The mapping rule:** an estate credential written `"${CHAT_WEBHOOK_URL}"` is resolved to
the env var `CHAT_WEBHOOK_URL`, which you must define in `.env`. `.env.example` already
lists every stack-core key with a non-secret placeholder (e.g.
`PVE_TOKEN=placeholder-...`); you override the ones your estate actually uses.

**Guardrail:** `.env` MUST stay git-ignored — only `.env.example` (non-secret
placeholders) is ever committed. Verify with `git check-ignore stack/compose/.env`, never
by trusting that you "didn't add it."

## Recipe B — 1Password `op://`

**Backend:** `OP_REF_RE` (`op://vault/item/field`).

An estate credential written `"op://infra/hypervisor/token"` is resolved at run time by the
1Password CLI, which injects the secret into the process environment **without ever writing
plaintext to disk**. Two supported forms:

```bash
# Form 1 — op run: inject op:// refs into the environment for a single command.
#   Author a NON-SECRET template that maps env vars to op:// references. It is safe
#   to commit because it contains ONLY op:// refs, never a secret value:
#     stack/compose/.env.op
#       PVE_TOKEN=op://infra/hypervisor/token
#   Resolve them just-in-time for the up command:
cd stack/compose && op run --env-file=.env.op -- docker compose up --wait

# Form 2 — op inject: render a resolved .env once, into a git-ignored file.
#   (Use only when a long-lived .env is required; prefer Form 1.)
op inject -i stack/compose/.env.op -o stack/compose/.env
#   .env now holds resolved secrets → it MUST be git-ignored (verify as in Recipe A).
```

**Prefer Form 1 (`op run`):** the secret exists only in the child process's environment for
the life of the command — nothing plaintext is written to disk. Reach for Form 2 only when
a long-lived `.env` is genuinely required, and treat its output exactly like the Recipe A
`.env` (git-ignored, verified). Use fictional vault/item names throughout, matching the
credentials your estate declares.

## Channel options — non-secret config beside a credential (Telegram)

Some channel kinds need a **non-secret** configuration value alongside their credential. A
`telegram` channel is the worked example: the bot token is the secret (a SecretRef in
`credential`, resolved by Recipe A or B), while the destination **`chat_id`** is not a
secret and rides in the channel's generic `options` map:

```yaml
channels:
  - name: ops-telegram
    kind: telegram
    credential: ${TELEGRAM_BOT_TOKEN}   # secret — a ${ENV}/op:// reference, never a literal
    options:
      chat_id: -1002001002003           # NOT a secret — the numeric int64 chat id …
      # chat_id: "@ops_alerts"          # … or an "@channelname" string
```

This renders to an Alertmanager `telegram_configs` receiver whose `bot_token` is the
resolved `${TELEGRAM_BOT_TOKEN}` reference and whose `chat_id` is emitted verbatim. Rules of
the road:

- **`options` never carries a secret.** Only non-secret provider knobs (`chat_id`, and any
  other plain Telegram fields) belong there; the token stays in `credential`. Put a
  credential in `options` and you defeat the no-literal invariant — the value would be
  emitted into the rendered tree in the clear.
- **`kind: telegram` requires `options.chat_id`.** A telegram channel with no `chat_id`
  cannot address a destination, so the loader rejects it with a `missing_chat_id` finding.
- Define `TELEGRAM_BOT_TOKEN` in your git-ignored `.env` (Recipe A) or map it in `.env.op`
  (Recipe B), exactly like any other channel credential.

## No-literal guarantee & extending to other backends

Two layers enforce the no-literal invariant:

- **Render-time:** the renderer emits a `SECRET_LITERAL` finding and refuses to render a
  literal credential, so no secret can reach the golden tree.
- **Repo-time:** the secret-safety scan fails the build on an obviously-real
  secret/host/IP, or on a literal where a `${ENV}` / `op://` reference belongs.

**Extending to other backends (notes only).** HashiCorp Vault, `sops`, and cloud secret
managers are **out of scope for v1** — no recipe ships for them. The extension principle is
the same as the two recipes above: resolve the reference into the process environment at
run time, and never commit the value. Adding a third backend is a deliberate future change,
not something to improvise per-deploy.

## Where to go next

- **Stand up the stack** → the [bootstrap runbook](/bootstrap/).
- **Understand the running system** → [runtime posture](/runtime-posture/).
- **Back to onboarding** → [getting started](/getting-started/).
