# Mutation Foundation

Mutation Foundation is the Pulse web application's write path. It lets an operator who is signed in through the estate's forward-auth proxy take three kinds of action from the UI:

- **Silences.** Create and expire Alertmanager silences.
- **Acknowledgements (acks).** Mark a firing alert as owned.
- **Estate-edit proposals.** Submit a signed request to change declared estate facts.

Every action passes the same chain of guards. Every action that passes validation leaves an `attempted` audit record before it has any effect, and a `succeeded` or `failed` record after.

The write path is **dark by construction**. With `PULSE_WEB_AUTH_MODE=none`, the default, the server builds nothing write-related:
- every `POST` gets the router's `405`;
- every session capability is `false`;
- no action control renders.

It lights up only when a trusted identity header is available (`PULSE_WEB_AUTH_MODE=proxy-header`).

The feature spans three workspaces. None of them is a published package, except for the `@pulse/core/proposals` subpath.

| Workspace | What the feature adds |
|---|---|
| `@pulse/web` (`apps/web`) | Mutation registry and dispatcher, audit, write-path health, ack and proposal stores, the `/api/mutations/*` and `/api/proposals` routes, and the client dialogs and markers |
| `@pulse/core` (`packages/core`) | The proposal file format, canonical JSON, the HMAC signing and verification, and the proposable-field allowlist |
| `@pulse/cli` (`apps/cli`) | `pulse proposals list \| show \| apply \| reject`, the only path that turns a proposal into an estate commit |

## Quick Start

The dev entry (`bun run dev:web`) stays write-dark. To exercise the write path locally, run the server with a trusted loopback proxy, a data directory and a proposal secret:

```bash
(cd apps/web && bun run build)

PULSE_VM_URL=http://127.0.0.1:8428 \
PULSE_ALERTMANAGER_URL=http://127.0.0.1:9093 \
PULSE_GATUS_URL=http://127.0.0.1:8081 \
PULSE_VMALERT_URL=http://127.0.0.1:8880 \
PULSE_WEB_AUTH_MODE=proxy-header \
PULSE_WEB_TRUSTED_PROXIES=127.0.0.1/32 \
PULSE_WEB_DATA_DIR="$PWD/.pulse-web-data" \
PULSE_PROPOSAL_SECRET="$(openssl rand -base64 48)" \
bun apps/web/dist/server/index.js   # listens on :8080
```

Check what the write path thinks of itself:

```bash
curl -s -H 'Remote-User: alice' http://127.0.0.1:8080/api/session | jq .capabilities
curl -s http://127.0.0.1:8080/healthz | jq .writePath
```

Acknowledge a firing alert. The `Sec-Fetch-Site` header stands in for the browser's same-origin signal:

```bash
curl -s -X POST http://127.0.0.1:8080/api/mutations/acks \
  -H 'Remote-User: alice' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(openssl rand -hex 16)" \
  -d '{"fingerprint":"<alert-fingerprint>","note":"looking at it"}'
```

Decide the proposal from the estate repository:

```bash
export PULSE_PROPOSAL_SECRET=...   # the same secret the web app signs with
pulse proposals list --proposals-dir "$PWD/.pulse-web-data/proposals"
pulse proposals apply <proposal-id> --proposals-dir "$PWD/.pulse-web-data/proposals"
git show HEAD                      # review, then push yourself
```

For deployment, including the forward-auth proxy, the `/data` volume, backups and secret rotation, see the operator guide [Write path](../../operator/write-path.md).

## Key Concepts

### Mutations live in their own registry

Read routes stay GET-only, and their route type was never widened. Writes are `MutationDefinition`s in a separate `MutationRegistry`, reached through the router's existing non-GET dispatch hook.

Each definition declares:
- a `POST` path under `/api/mutations/`
- a capability
- an audit action
- a strict zod body schema
- an optional `validate` hook
- an audit target and audit details
- a handler that returns a `MutationOutcome`

The registry refuses to exist at all outside `proxy-header` mode.

### Capabilities

There are three capabilities: `silence`, `ack` and `proposeEstateEdit`. A capability is true only if all of these hold:
- the auth mode is `proxy-header`;
- the request has a trusted identity;
- every write-path store the capability depends on is healthy.

The dispatcher recomputes this for every request. The client reads it from `GET /api/session`. There are no per-user rules: anyone the proxy authenticates gets the same capabilities.

### Write-path stores

The write path tracks five stores, each with an ok/reason status:

| Store | What it is |
|---|---|
| `audit` | The JSONL audit log |
| `acks` | `acks.json` |
| `proposals` | The proposals directory |
| `secret` | The proposal HMAC secret |
| `alertmanager` | The Alertmanager write client |

A degraded store turns off only the capabilities that depend on it. It never changes `/healthz`'s top-level status or the read-only UI.

### Two-phase audit

The dispatcher appends an `attempted` event before the handler runs, and refuses the request (`503 audit-unavailable`) if that append fails. After the handler returns, it appends a `succeeded` or `failed` event with the same `requestId`. A failure to finalize is logged and counted, but it never changes the response the operator sees.

### Idempotency

Every mutation needs an `Idempotency-Key` header. Outcomes, both succeeded and failed, are cached for 24 hours in memory, keyed by identity subject, action and key. The same key with the same body replays the stored response. The same key with a different body is a `409`.

### Acks are Pulse-local

Acks never touch Alertmanager. They live in a single JSON file, ride on the alerts wire as `ActiveAlert.ack`, and clear themselves once a successful Alertmanager fetch no longer lists the alert.

### Proposals never edit the estate

The web app only writes signed `<id>.proposal.json` files. The `pulse proposals apply` CLI verifies the signature and the freshness of each `seen` value, then edits one overlay file, re-validates and re-renders the estate, and makes one local commit. It never pushes; you review and push the commit yourself.

### Honest pending state

A successful action is not reflected in live data until the next refresh cycle. Until then the client shows a "pending" marker. If live data hasn't caught up after 30 seconds, the marker changes to a dismissable "not yet reflected" badge instead of pretending success.

## Package Exports

| Export / Entry Point | Description |
|---|---|
| `@pulse/core/proposals` | Browser-safe barrel: proposal types and zod schemas, `PROPOSABLE_FIELDS`, `fieldApplies`, `readCoreValue`, `canonicalProposalJson`, id helpers and constants |
| `@pulse/core/proposals/sign` | Node-only: `signProposal`, `verifyProposal`, `ProposalSecretError` |
| `apps/web/src/shared/mutations.ts` | Wire types for request and response envelopes, `MutationReason`, and the shared limits (browser-bundled, type-only imports) |
| `apps/web/src/server/mutations/**` | Server internals: registry, dispatcher, guards, audit, write path, stores and handlers |
| `apps/web/src/client/mutations/**` | Client internals: session and gating, `postMutation`, the pending tracker, lazy dialogs and markers |
| `apps/cli/src/commands/proposals/**` | The `pulse proposals` verb |

Client code imports `@pulse/core/proposals` **as types only**. A build-budget test forbids core or zod code in any client chunk, so the dialog mirrors the allowlist and validators locally, and tests pin each mirror to its core original.

## HTTP Surface

| Method and path | Capability | Audit action | Success |
|---|---|---|---|
| `POST /api/mutations/silences` | `silence` | `silence.create` | `201 {silenceId, endsAt}` |
| `POST /api/mutations/silences/expire` | `silence` | `silence.expire` | `200 {silenceId}` |
| `POST /api/mutations/acks` | `ack` | `ack.set` | `200 {fingerprint, at}` |
| `POST /api/mutations/acks/remove` | `ack` | `ack.remove` | `200 {fingerprint, removed}` |
| `POST /api/mutations/proposals` | `proposeEstateEdit` | `proposal.create` | `201 {proposalId}` |
| `GET /api/proposals?kind=&id=` | (read) | none | `200 ProposalListBody` |
| `GET /api/session` | (read) | none | Identity display name, auth mode, capabilities |

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `PULSE_WEB_AUTH_MODE` | `none` | `proxy-header` enables the write path |
| `PULSE_WEB_AUTH_HEADER` | `Remote-User` | Identity header set by the forward-auth proxy |
| `PULSE_WEB_TRUSTED_PROXIES` | empty (deny all) | Comma-separated CIDRs whose identity header is honored |
| `PULSE_WEB_DATA_DIR` | unset | Base directory for the audit log, acks and proposals |
| `PULSE_WEB_AUDIT_PATH` | `$PULSE_WEB_DATA_DIR/audit/audit.jsonl` | Absolute override |
| `PULSE_WEB_ACK_STORE_PATH` | `$PULSE_WEB_DATA_DIR/acks.json` | Absolute override |
| `PULSE_WEB_PROPOSALS_DIR` | `$PULSE_WEB_DATA_DIR/proposals` | Absolute override |
| `PULSE_PROPOSAL_SECRET` | unset | HMAC key of at least 32 bytes; shared with the CLI |

Notes on these variables:
- In `none` mode every write-path variable is ignored, and a single `config_warning` names any that are set.
- In `proxy-header` mode a relative path is a fatal config error. A missing or short secret is not fatal: it only degrades `proposeEstateEdit`.
- Alertmanager writes reuse `PULSE_ALERTMANAGER_URL`.
- The CLI reads the proposals directory from `--proposals-dir`, `PULSE_PROPOSALS_DIR` or `proposalsDir` in `pulse.config.yaml`. Note the missing `WEB_`.

## When to Use

Use the write path to:

- silence a noisy alert with a required reason and an expiry of at most 7 days, from its detail pane;
- expire any active silence, including silences created outside Pulse;
- tell the room, and the wallboard, that a firing alert has an owner;
- propose a change to an entity's declared churn, scrape class, cAdvisor or heartbeat flag, or suppression, and route it through review;
- give auditors one append-only record of who attempted what, when, and with what result.

## When Not to Use

Do not use the write path to:

- edit Alertmanager matchers by hand. The UI builds exact-match matchers from the alert's allowlisted labels only; use Alertmanager itself for regex or negative matchers;
- change estate facts outside the five proposable fields, or change the estate without review. Edit the estate repository directly;
- run more than one web replica against the same `/data`. The ack store and idempotency cache are single-process;
- enable writes before forward-auth is the only way to reach the app. The trusted-proxy check is the whole authentication story;
- expect per-user authorization. Every authenticated operator has the same capabilities.

## Further Reading

- [Architecture](./architecture.md): the request lifecycle, write-path health, the acks cycle, the proposal trust chain and the design rationale
- [API Reference](./api-reference.md): server, core, CLI and client contracts
- [Integration Guide](./guides/integration.md): adding a mutation, gating an affordance, the proposal workflow, testing and troubleshooting
- [Write path (operator guide)](../../operator/write-path.md): deployment, the volume, the audit log, backups and health
- [Alert Triage](../alert-triage/README.md): the alerts view that hosts the silence and ack action slots
- [Web Data Tier](../web-data-tier/README.md): the identity seam, the audit writer and the Alertmanager write client
