# `severity-taxonomy` — Pulse alerting severity levels

> Human-readable companion to `severity-taxonomy.json`, which is the
> **language-neutral, machine-readable** artifact. Both are published views of
> `SEVERITY_TAXONOMY` in `src/taxonomy.ts` (the TypeScript source of truth). If the
> three views ever disagree, the conformance test (`tests/contract.test.ts`) fails.

## Contract version: 1

`severity-taxonomy.json.contractVersion` equals `SEVERITY_TAXONOMY_VERSION` (both
`1` today). Any change to the taxonomy shape or values bumps both in lockstep.

## 1. Purpose

Pulse's alert severity is defined by the **required operator response**, not by a
component's internal notion of badness. There are exactly three response-oriented
severities — `critical`, `warning`, `info` — and each carries a fixed routing
semantics (channels, repeat cadence, grouping window, quiet-hours behavior,
resolved-notification behavior, and webhook-mirror policy).

This file and `severity-taxonomy.json` are the two published views of the same data
(`SEVERITY_TAXONOMY`). Downstream consumers — notably `agent-kit`'s alert-triage
skill — read these stable artifacts to classify an incident's required response and
explain its routing, **without inferring behavior from implementation files**.

## 2. Severity table

Severity is always named in text (never encoded by color alone).

| Severity   | Response                  | Channels                        | Repeat | Group window | Bypasses quiet hours | Sends resolved | Webhook mirror |
|------------|---------------------------|---------------------------------|--------|--------------|----------------------|----------------|----------------|
| `critical` | immediate human action    | critical-human + webhook-mirror | `30m`  | —            | yes                  | yes            | `always`       |
| `warning`  | timely investigation      | non-paging ops                  | —      | `15m`        | no                   | yes            | `if-selected`  |
| `info`     | digest-only awareness     | daily digest 09:00 estate-tz    | —      | —            | no                   | no             | `never`        |

- **Response** is the defining axis (REQ-SEV-01): what an operator is expected to do.
- **Channels** are human-readable route descriptions; the concrete Alertmanager
  receivers that realize them are defined in `04-alertmanager-config.md`. `agent-kit`
  uses these strings to explain routing, not to make routing decisions.
- **Repeat / group window** are `null` (shown as `—`) where the severity does not
  repeat or batch (REQ-SEV-06, REQ-SEV-03).
- **Bypasses quiet hours** — only `critical` pages through quiet hours (REQ-ROUTE-03).
- **Sends resolved** — `critical` and `warning` send a resolved notification when the
  alert clears; `info` does not (REQ-SEV-05).

## 3. Webhook-mirror policy

Each severity's `webhookMirror` field states whether an alert of that severity is
mirrored to the automation-webhook receiver (`pulse-webhook-mirror`, REQ-HOOK-01):

- `critical` → **`always`** — every critical is mirrored.
- `warning` → **`if-selected`** — mirrored only when the estate opts the warning in.
- `info` → **`never`** — informational alerts are never mirrored.

## 4. Stability & versioning

- `contractVersion` (in `severity-taxonomy.json`) and `SEVERITY_TAXONOMY_VERSION` (in
  `src/taxonomy.ts`) are `1` today and **bump together on ANY change** to the taxonomy
  shape or values. The conformance test fails if a value changes without a version
  bump, or if the JSON and the TypeScript disagree.
- The **alert-name convention** (PascalCase — `HostDown`, `DeepHealthProbeFailed`,
  `BackupStale`, `DeadMansSwitch`, …) is a **separate** stable convention (REQ-RULE-02)
  consumers may key on; it is not versioned by this contract.

## 5. Non-goals

- **`deadman` is not a human severity.** It is an internal DeadMansSwitch label
  (`DEADMAN_SEVERITY`, `00-core-definitions.md §6`), never a routable human severity
  (REQ-DEAD-03). It is intentionally absent from this taxonomy.
- **This file describes response semantics, not the concrete route tree.** The actual
  Alertmanager route/receiver realization lives in `04-alertmanager-config.md`.
