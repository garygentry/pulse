---
title: Incumbent retirement
description: The narrative for cutting over from an existing monitoring system — plan for overlap, prove coverage parity, keep backups and alerting continuous.
slug: incumbent-retirement
---

# Incumbent retirement

This is the **narrative** for cutting over from an existing monitoring system to Pulse:
*why* and *what to plan for*, not the executable steps. When you are ready to run the
cutover, the [retirement checklist](/retirement-checklist/) has the step-by-step, verified
mechanics — this page never duplicates its commands.

## Plan for overlap, not a hard swap

Do not flip from the incumbent to Pulse in a single step. Stand Pulse up alongside the
existing system and run both in parallel until Pulse has *proven* it covers everything the
incumbent watched. The shape of the cutover is:

1. Stand Pulse up (the [bootstrap runbook](/bootstrap/)).
2. Verify `pulse coverage` is clean — every declared host and service is monitored or
   explicitly suppressed.
3. Watch both systems for a soak period, comparing what each sees.
4. Only then retire the incumbent.

A hard swap trades a known-good system for an unproven one with no fallback; the overlap
window is what lets you catch a gap while the old system is still watching.

## Coverage parity before retirement

Cut over only once **every host and service the incumbent watched is declared in your
estate** and `pulse coverage` exits `0`. A clean coverage run means every target is either
actively monitored or carries an explicit, rationale-bearing suppression — nothing is
silently unwatched. Retiring the incumbent before parity opens a blind spot exactly where
you can least afford one: the targets you forgot to migrate.

Treat the incumbent's target list as the checklist. Walk it against the estate, declare
what is missing, and re-run `pulse coverage` until it is clean. Parity is a coverage
property, not a feeling.

## Never run without backups

A newly bootstrapped stack must have **backups enrolled on day one**, before the incumbent
goes away. Retiring the old system while Pulse's own data is unprotected means a single
stack loss takes your monitoring history with it and leaves nothing to fall back to.

Enroll backups as part of standing Pulse up — see the [backup enrollment
runbook](/backup-enrollment/) for the procedure. Do not defer it past the cutover.

## Alerting continuity

There must be **no window in which neither system pages.** Before you silence the
incumbent's alerting, confirm Pulse's alert channels and deadman switch are live and shaken
down (the [rollout session](/rollout-session/) covers the shakedown). Send a synthetic
alert through each channel and confirm it arrives; confirm the deadman is reporting. Only
once Pulse is demonstrably paging should the incumbent's alerting be turned off — and turn
it off *after* Pulse's, never before.

> **Boundary:** the executable, step-by-step retirement steps — decommission commands,
> per-step content-verification, and rollback — live in the [retirement
> checklist](/retirement-checklist/). This page is the narrative and links there; it never
> restates those commands.

## Where to go next

- **The executable cutover steps** → the [retirement checklist](/retirement-checklist/).
- **Enroll backups first** → the [backup enrollment runbook](/backup-enrollment/).
- **Shake down alerting** → the [rollout session](/rollout-session/).
- **Full runbook index** → [runbooks](/runbooks/).
