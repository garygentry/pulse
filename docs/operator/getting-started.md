---
title: Getting started
description: What Pulse is and the five-minute onboarding path from the minimal fixture.
slug: getting-started
---

# Getting started

## What Pulse is

Pulse is **config-as-code observability**: you declare your estate once — every host,
service, channel, and suppression — as a single YAML inventory, and `pulse render` turns
that declaration into a complete monitoring configuration deterministically. There is no
UI to click through and no per-target drift to reconcile by hand; the estate file is the
source of truth and the rendered tree is a pure function of it.

The governing invariant, which the rest of these docs lean on: **render produces repo
artifacts; an operator applies them — no Pulse code ever touches a host.** `pulse render`
only writes files into your repository's `rendered/` directory. Standing those files up as
a running stack is a separate, operator-driven step (the [bootstrap runbook](/bootstrap/)),
and Pulse itself never reaches out to a monitored machine.

## The five-minute path

The fastest way to see the loop is the **minimal fixture** that ships in this repo at
`examples/minimal/` — the smallest valid estate (one `managed-linux` host, no
services or channels). Run every verb **with the fixture directory as your working
directory**: the CLI resolves `estateDir` and `outputRoot` relative to `process.cwd()`, so
running from inside the fixture auto-discovers its `pulse.config.yaml` — you never pass
`--config`.

```bash
cd examples/minimal      # run WITH the fixture dir as cwd — estateDir/outputRoot
                         # resolve against process.cwd(), not a --config path
pulse validate           # exit 0 = the estate is schema- and semantically clean
pulse render             # emits the rendered/ tree deterministically
pulse coverage           # exit 0 = every declared host is monitored or suppressed
```

Every verb branches on the same exit contract:

| Exit | Meaning | What to do |
|------|---------|------------|
| `0` | clean / success | continue |
| `1` | findings, coverage gap, or render drift | stop and fix the estate |
| `2` | tool fault (I/O error, bad config) | stop and fix the environment |

**Never apply a tree that did not validate.** A non-zero `pulse validate` exit (`1` =
findings, `2` = tool fault) means the estate has a problem — fix `estate.yaml` before you
`render`, and never bring up a stack from a tree that failed to validate.

## Where to go next

- **Stand up the stack** → the [bootstrap runbook](/bootstrap/).
- **Size the host first** → [sizing](/sizing/).
- **Wire real credentials** → [secret recipes](/secret-recipes/).
- **Understand the running system** → [runtime posture](/runtime-posture/).
- **Full runbook index** → [runbooks](/runbooks/).
