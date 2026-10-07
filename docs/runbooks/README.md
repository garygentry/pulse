---
title: Runbooks
description: The operator-executed runbook suite — materialize the stack, enroll agents, wire alerting, enroll backups, and retire an incumbent. Every mutating step carries Command, Verify-by-content, and Rollback.
slug: runbooks
---

# Runbooks

These runbooks take you from a fresh Linux host to a running, alerting Pulse stack, and
onward through agent enrollment, alert shakedown, backup enrollment, and cutover from an
incumbent monitoring system. They are the operator's executable counterpart to the
[operator guides](/getting-started/), which explain the *why*; the runbooks are the *how*.

## Render ≠ deploy

Every runbook here is **operator-executed Markdown prose** — copy-pasteable commands *you*
run on *your* host. This suite ships **no installer, no SSH wrapper, and no auto-runner**:
Pulse code never touches a monitored machine. `pulse render` only writes files into your
repository's `rendered/` tree; standing those files up as a running stack is always a
separate, deliberate, operator-driven step. That separation — render produces repo
artifacts, an operator applies them — is the invariant the whole suite is built around.

## The step template

Every **mutating** step is written to a fixed three-part shape: **Command** (the exact,
copy-pasteable command — never elided), **Verify (content)** (inspect the resulting host or
file state to prove the step took), and **Rollback** (how to undo it). Success is judged by
**content, never by an exit code**: a `docker compose ps` that shows `healthy`, an HTTP
probe whose *body* matches, a rendered file that *exists with the expected content* — never
a bare `$?` of `0`, because the shell is treated as hostile. Read-only inspection steps keep
the Verify and may omit the Rollback.

Every Pulse invocation in this suite uses only the documented verbs — `init`, `validate`,
`render` (optionally `--check`), and `coverage` — and branches on the stable exit contract:

| Exit | Meaning | What to do |
|------|---------|-----------|
| `0` | clean — no findings, no drift, no coverage gap | proceed |
| `1` | findings / outcome — a validation finding, a coverage gap, or `--check` drift | fix the estate or re-render, then re-run |
| `2` | tool fault — I/O error, missing/unreadable `--config`, internal error | fix the environment; **never** "fix" the estate for a `2` |

## Prerequisites

- A **Linux host** with **Docker Engine** and **Docker Compose v2** (`docker compose`, not
  the legacy `docker-compose`).
- The **`pulse` binary**, fetched and checksum-verified as the first step of the
  [bootstrap runbook](/bootstrap/).
- A **git repository** to commit the rendered tree into — the rendered tree is data you
  review in `git diff` and apply by mount, never something Pulse pushes to a host.

## The suite, in order

| Order | Runbook | When to run |
|-------|---------|-------------|
| 1 | [Bootstrap](/bootstrap/) | Materialize the stack-tree on a fresh host and bring the engine up healthy. |
| 2 | [Agent install](/agent-install/) | Deliver and enroll the host-agent bundle on each monitored host. |
| 3 | [Rollout session](/rollout-session/) | Wire alert channels, hook up the deadman, and shake down alerting. |
| 4 | [Backup enrollment](/backup-enrollment/) | Declare backup freshness on day one and confirm the rules wire. |
| — | [Retirement checklist](/retirement-checklist/) | Cut over from an incumbent monitoring system, gated on coverage parity. |

Run 1 → 2 → 3 → 4 for a fresh estate; the retirement checklist runs whenever you are
replacing an existing monitoring system and depends on the first four being complete.

## Per-alert runbooks

The suite above is **setup**; these are **incident** runbooks — one per alert family, reached by the
`runbook_url` an operator follows from a fired alert. Each covers *when it fires*, *triage* (read-only
Verify-by-content), and *remediate* (Command / Verify / Rollback). They are **not** run in order;
open the one whose slug matches the paged alert. See [alerting](/alerting/) for how `runbook_url`
resolves to these pages.

| Slug | Runbook | Fires for |
|------|---------|-----------|
| `availability` | [Availability](/availability/) | HostDown, DeepHealthProbeFailed, DeepHealthProbeStale |
| `capacity` | [Capacity](/capacity/) | HighCPU, HighMemory, LowDisk, CriticalDisk |
| `churn` | [Container churn](/churn/) | ContainerRestarting, ContainerChurn |
| `deep-health` | [Deep health](/deep-health/) | DeepHealthFailed (per-service functional) |
| `backup-freshness` | [Backup freshness](/backup-freshness/) | BackupStale, BackupCritical, BackupNoData |
| `engine` | [Engine self-monitoring](/engine/) | AlertPathDown, AncillaryDown |
| `pipeline-health` | [Pipeline health](/pipeline-health/) | AlertRuleEvalErrors, AlertNotificationsFailing, AlertNotificationLatencyHigh, AlertRemoteWriteBacklog |
| `deadman` | [Dead man's switch](/deadman/) | DeadMansSwitch (absence is the alarm) |
| `canary` | [Alert-path canary](/canary/) | PulseAlertPathCanary (absence is the alarm) |

## The worked estate

Every runbook uses the committed **reference fixture** at `examples/reference/` as its worked
example — a complete estate exercising all five collection classes, deep-health,
backup-freshness, all four channel kinds, and both secret grammars. Substitute your own
estate directory wherever a command names `examples/reference/`.

## Related operator guides

The runbooks link to these narrative guides for context rather than duplicating them:

- **Start here** → [getting started](/getting-started/).
- **Size the disk** → [sizing](/sizing/).
- **Supply real credentials** → [secret recipes](/secret-recipes/).
- **Adopt a new revision** → [upgrade path](/upgrade-path/).
- **Understand the running stack** → [runtime posture](/runtime-posture/).
- **Plan an incumbent cutover** → [incumbent retirement](/incumbent-retirement/) (the
  narrative behind the [retirement checklist](/retirement-checklist/)).
