# automation-webhook event contract

> Human-readable companion to `webhook-event.schema.json`, the machine-validatable
> (JSON Schema draft 2020-12) form of this contract.

## 1. Purpose

Pulse's automation-webhook mirror is an Alertmanager `webhook_configs` receiver
(`pulse-webhook-mirror`); Pulse builds no bespoke delivery runtime
(off-the-shelf-first). The **exposed event is therefore Alertmanager's native webhook
JSON payload**, pinned here as a stable contract so consumers do not re-derive it from
the Alertmanager version. `contract/webhook-event.schema.json` is the machine-validatable
form; this file is its human companion.

The contract constrains only the subset of the native payload Pulse guarantees.
`additionalProperties: true` on the envelope and per-alert objects preserves forward
compatibility with Alertmanager fields Pulse does not contract on.

## 2. Envelope

The top-level object. Required: `version`, `status`, `groupKey`, `commonLabels`,
`alerts`.

| Field               | Type              | Notes                                                                 |
|---------------------|-------------------|-----------------------------------------------------------------------|
| `version`           | string            | Alertmanager webhook schema version, pinned to `"4"` (v0.27.0 native).|
| `status`            | `firing`\|`resolved` | Group-level lifecycle state (REQ-HOOK-02).                          |
| `groupKey`          | string            | Stable key of the group grouped by `[estate, host, service, alertname]` (REQ-ROUTE-02). |
| `receiver`          | string            | Emitting receiver name; the mirror is `pulse-webhook-mirror`.         |
| `commonLabels`      | object<string>    | Labels common to every alert in the group.                            |
| `commonAnnotations` | object<string>    | Annotations common to every alert (optional).                         |
| `externalURL`       | string            | Alertmanager base URL — no credential material (optional).            |
| `alerts`            | array (≥1)        | The per-alert objects (§3).                                           |

## 3. Per-alert object

Each element of `alerts[]`. Required: `status`, `labels`, `annotations`, `startsAt`,
`fingerprint`.

- **`fingerprint`** — the retry-stable per-identity **event ID / idempotency key**
  (REQ-HOOK-04). Alertmanager computes it deterministically from the alert's identifying
  label set, so redeliveries reuse it.
- **`status`** — `firing` | `resolved` (REQ-HOOK-02).
- **`labels`** — structured alert identity/context. Required: `alertname` (PascalCase,
  REQ-RULE-02), `severity` (`critical` | `warning` | `info`; never `deadman` on the
  mirror), `estate` (engine-injected identity). Optional: `host`, `service`.
- **`annotations`** — human-readable text. Required: `summary`; optional: `description`.
- **`startsAt`** — RFC 3339 firing timestamp.
- **`endsAt`** — RFC 3339 resolve timestamp; the zero time `0001-01-01T00:00:00Z`
  while firing (optional; corroborates `status`).
- **`generatorURL`** — source query URL (vmalert/Gatus); no credential material (optional).

**Human ⇄ structured parity (REQ-A11Y-02).** Every human-readable field
(`annotations.summary`, `annotations.description`) has a structured equivalent in
`labels` (`severity`, `alertname`, `estate`, `host`, `service`) and `status`. An agent
that never renders the prose still receives the complete essential state.

## 4. Guarantees

The contract documents exactly two lifecycle guarantees:

- **Firing-before-resolved per identity (REQ-HOOK-03).** For a given stable identity
  (a given `groupKey` / `fingerprint`), Alertmanager delivers `firing` before
  `resolved`. A consumer never sees a `resolved` for an identity it has not first seen
  `firing`.
- **Retry-stable `fingerprint` (REQ-HOOK-04).** A delivery retry of the same event
  reuses the same `alerts[].fingerprint`. Consumers MUST key deduplication on
  `(fingerprint, status)` so a retried `firing` or `resolved` is processed
  at-most-once in effect.
- **No total ordering across unrelated alerts.** Events for different
  identities/groups may interleave arbitrarily (REQ-CONC-02); consumers must not assume
  a global stream order.

`endsAt` distinguishes lifecycle state alongside `status`: the zero time while firing,
the real end timestamp on resolve. Treat `status` as authoritative and `endsAt` as the
corroborating timestamp.

## 5. Secret safety

The event carries **operational metadata only**: estate/entity names, labels, `status`,
timestamps, and human summaries. It MUST NOT contain (REQ-SEC-01/02):

- credential literals or resolved secret values — the mirror/deadman receiver URLs are
  `${VAR}` references resolved at runtime, never in the payload;
- secret-reference strings themselves (`${...}` / `op://...` tokens);
- raw probe response bodies or sensitive response data — the `pulse_deep_health` series
  carries only the mapped numeric value, never the JSON body, so no body reaches the
  event.

## 6. Worked example

One firing payload and its matching resolved payload for a single identity. Both share
one `alerts[].fingerprint`; the firing `endsAt` is the zero time, the resolved `endsAt`
is a real RFC 3339 timestamp.

### Firing

```json
{
  "version": "4",
  "status": "firing",
  "receiver": "pulse-webhook-mirror",
  "groupKey": "{}:{estate=\"north\", host=\"db-01\", service=\"postgres\", alertname=\"DeepHealthFailed\"}",
  "commonLabels": {
    "alertname": "DeepHealthFailed",
    "severity": "critical",
    "estate": "north"
  },
  "alerts": [
    {
      "status": "firing",
      "fingerprint": "a1b2c3d4e5f60718",
      "labels": {
        "alertname": "DeepHealthFailed",
        "severity": "critical",
        "estate": "north",
        "host": "db-01",
        "service": "postgres"
      },
      "annotations": {
        "summary": "Deep-health probe failed for postgres on db-01",
        "description": "The functional deep-health check for service postgres returned a failing value."
      },
      "startsAt": "2026-08-21T09:14:00Z",
      "endsAt": "0001-01-01T00:00:00Z"
    }
  ]
}
```

### Resolved

```json
{
  "version": "4",
  "status": "resolved",
  "receiver": "pulse-webhook-mirror",
  "groupKey": "{}:{estate=\"north\", host=\"db-01\", service=\"postgres\", alertname=\"DeepHealthFailed\"}",
  "commonLabels": {
    "alertname": "DeepHealthFailed",
    "severity": "critical",
    "estate": "north"
  },
  "alerts": [
    {
      "status": "resolved",
      "fingerprint": "a1b2c3d4e5f60718",
      "labels": {
        "alertname": "DeepHealthFailed",
        "severity": "critical",
        "estate": "north",
        "host": "db-01",
        "service": "postgres"
      },
      "annotations": {
        "summary": "Deep-health probe failed for postgres on db-01",
        "description": "The functional deep-health check for service postgres returned a failing value."
      },
      "startsAt": "2026-08-21T09:14:00Z",
      "endsAt": "2026-08-21T09:31:00Z"
    }
  ]
}
```

The shared `fingerprint` (`a1b2c3d4e5f60718`) lets a consumer correlate the resolve
with the original firing and deduplicate idempotent retries.
