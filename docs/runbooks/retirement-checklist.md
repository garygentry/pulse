---
title: Retirement checklist
description: The executable cutover checklist from an incumbent monitoring system to Pulse — gated on Pulse being live and alerting, coverage clean, and a parallel-soak parity window, with a content-verified check and rollback at every step.
slug: retirement-checklist
---

# Retirement checklist

This is the **executable checklist** for cutting over from an existing monitoring system to
Pulse. It is gated on three things, in order: Pulse must be **live and alerting**, `pulse
coverage` must be **clean** (every incumbent-monitored host declared and covered), and a
**parallel-soak parity window** must show both systems firing on the same conditions. You
only decommission the incumbent after all three pass.

> **This is the *how*; the [incumbent retirement](/incumbent-retirement/) guide is the
> *why*.** That narrative covers planning for overlap rather than a hard swap, how long to
> soak, what to inventory, and the never-run-without-backups principle. Read it first; this
> checklist executes it and does not duplicate it. Backups in particular must be enrolled
> before you retire the incumbent's backup monitoring — see
> [backup enrollment](/backup-enrollment/).

The worked estate is the committed reference fixture at `examples/reference/`; substitute
your own estate directory and incumbent-specific commands throughout.

## About the exit contract

The `pulse render` and `pulse coverage` steps branch on the stable exit contract: **`0`**
clean, **`1`** findings or a coverage gap (resolve, then re-run), **`2`** a tool fault you fix
in the environment and **never** by editing the estate. The gates below verify by content —
a coverage report body, a delivered alert — so a stray `0` never advances the cutover.

## Steps

#### Step 1 — Gate: confirm Pulse is live and alerting before touching the incumbent

Do not proceed while Pulse is unproven. This gate is the whole safety basis of the cutover.

**Command**

```bash
docker compose -f stack/compose/docker-compose.yml ps --format '{{.Service}} {{.Health}}'
```

**Verify (content):** every default-profile service reports `healthy` (as in the
[bootstrap runbook](/bootstrap/), Step 5), **and** a synthetic alert has been delivered
end-to-end (the [rollout session](/rollout-session/), Step 6). Both must hold before you
touch the incumbent.

**Rollback:** none — this is a gate. If Pulse is not proven live and alerting, **stop** and
return to bootstrap / rollout; do not advance.

#### Step 2 — Enroll every incumbent-monitored host and gate on clean coverage

Declare every host the incumbent watches into the estate under its correct collection class,
then render and prove coverage is clean.

**Command**

```bash
# Add each incumbent-monitored host to examples/reference/estate/estate.yaml under its
# correct collection class (managed-linux / hypervisor-api / nas-api / probe-only / excluded),
# then, from the estate directory:
( cd examples/reference && "$PULSE_BIN" render )
( cd examples/reference && "$PULSE_BIN" coverage )
```

**Verify (content):** `pulse coverage` exits `0` — every declared thing is monitored or
explicitly suppressed, with **no gap**. On **exit `1`**, read the coverage report body: it
lists the uncovered targets; declare or suppress each and re-run until the body shows no gaps.
Inspect the report, not just the exit code. (**Exit `2`** is a tool fault to resolve in the
environment.)

**Rollback:** restore the estate and its rendered tree with
`git checkout -- examples/reference/estate/estate.yaml examples/reference/rendered/`, then
re-render to return to the prior estate.

#### Step 3 — Run Pulse and the incumbent in parallel (soak for parity)

Run both systems side by side for the soak window from the narrative. This step mutates
nothing in Pulse — it is an observation gate.

**Command**

```bash
# No Pulse mutation. Keep BOTH systems running for the full soak window and, for a
# representative alert condition, deliberately trigger it and observe both systems.
```

**Verify (content):** for the representative condition, **both** systems fire. Compare the
Pulse alert against the incumbent's:

```bash
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- http://alertmanager:9093/api/v2/alerts | grep -o '<your-alertname>'"
```

confirm the Pulse alert is present and matches the incumbent's for the same condition.
**Parity across the full soak window is the content proof cutover is safe.** A missed or
divergent alert means stay in parallel — do not advance.

**Rollback:** none — this is observation only; the incumbent remains authoritative
throughout the soak.

#### Step 4 — Decommission the incumbent (only after parity holds)

Only once Steps 1–3 all pass: disable the incumbent's alerting integrations, then stop its
agents and services (incumbent-specific — see the narrative guide).

**Command**

```bash
# Incumbent-specific: disable its alerting integrations first, then stop its agents/services.
# (These commands belong to the incumbent system — see /incumbent-retirement/.)
```

**Verify (content):** the incumbent's receiver **no longer delivers** — send it a test alert
and confirm nothing arrives — **and** Pulse remains the sole alerting path: repeat Step 1's
synthetic alert and confirm Pulse alone delivers it. Cutover is complete only when Pulse
alerts and the incumbent is silent.

**Rollback:** re-enable the incumbent's integrations and restart its agents. The parallel
soak of Step 3 is the safety margin that makes this reversible — because you never destroyed
the incumbent, only stopped it, you can fall back to it at any point.

## Where to go next

- **The planning narrative behind this checklist** → [incumbent retirement](/incumbent-retirement/).
- **Enroll backups before retiring incumbent backup monitoring** → [backup enrollment](/backup-enrollment/).
- **Full runbook index** → [runbooks](/runbooks/).
