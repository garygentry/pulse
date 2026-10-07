---
title: Upgrade path
description: Adopting a new Pulse stack revision — re-render, diff-review in git, re-apply idempotently.
slug: upgrade-path
---

# Upgrade path

Adopting a new Pulse revision is the **same three moves every time** — there is no bespoke
per-version migration tool. Because the renderer is pure and deterministic, an upgrade is a
reviewable git change, not a mystery migration: you re-render against your unchanged estate,
read the diff, and re-apply idempotently.

## 1. Re-render

Pull the new Pulse version, then re-run the render against your existing, unchanged estate:

```bash
pulse render            # overwrites rendered/ deterministically
```

The renderer takes no clock, PID, hostname, or random input and emits keys in a canonical
order, so re-rendering the same estate with the same Pulse version reproduces the same tree
byte-for-byte. When the tree *does* change, the only changes are the ones the new version
intends — nothing incidental.

## 2. Diff-review in git

The re-rendered tree is a normal, reviewable change. Inspect every managed file before you
apply anything:

```bash
git diff -- rendered/    # inspect every changed managed file
```

Read the diff the way you would read any code change: a new scrape target, a changed alert
threshold, a reworked routing tree should each be explicable by the version bump. If a
change is surprising, stop and understand it before applying.

### The `formatVersion` signal

Watch `rendered/.rendered-manifest.json` in that diff. Its `formatVersion` field is the
render tree's structural contract — it is `1` today. **If `formatVersion` changed, the
stack's mount wiring may need re-checking**: a bumped format can move, rename, or add files
the compose stack mounts, so re-read the bootstrap runbook's mount step and confirm the
override wiring still points at the right paths before you re-apply. A `formatVersion` that
is unchanged means the mount contract is stable and step 3 is a plain re-apply.

## 3. Re-apply via the idempotent runbook

Adopt the reviewed tree with the same idempotent bring-up the bootstrap runbook documents:

```bash
cd stack/compose && docker compose up --wait    # re-apply; safe on re-run
```

This is safe to re-run. The idempotency rests on two properties:

- **Atomic-replace deterministic render.** Each re-render replaces `rendered/` as a whole,
  so the stack always mounts a complete, self-consistent tree — never a half-written one.
- **Durable named volumes.** The VictoriaMetrics and Grafana data volumes survive
  `docker compose up` re-runs and `docker compose down`, so re-applying never touches your
  metric history or dashboards.

**Never `down -v`.** That flag destroys the durable volumes and with them all metric
history and Grafana state. A plain `docker compose up --wait` is the only re-apply an
upgrade needs — see [runtime posture](/runtime-posture/) for why the volumes are durable.

> **Boundary:** the *mechanics* of the idempotent re-apply — the exact commands, per-step
> content-verification, and rollback — live in the [bootstrap runbook](/bootstrap/). This
> page is the narrative; it links there and never restates those steps.

## Where to go next

- **The executable re-apply steps** → the [bootstrap runbook](/bootstrap/).
- **Why the volumes are durable** → [runtime posture](/runtime-posture/).
- **Full runbook index** → [runbooks](/runbooks/).
